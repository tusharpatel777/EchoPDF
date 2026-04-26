import os
import json
import time
import fitz  # PyMuPDF
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from groq import Groq
from upstash_redis import Redis
from pinecone import Pinecone
from langchain_pinecone import PineconeVectorStore
from langchain_huggingface import HuggingFaceEmbeddings
from langchain_text_splitters import RecursiveCharacterTextSplitter
from flashrank import Ranker, RerankRequest
from rank_bm25 import BM25Okapi
from dotenv import load_dotenv

load_dotenv()
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

pc = Pinecone(api_key=os.getenv("PINECONE_API_KEY"))
index_name = os.getenv("PINECONE_INDEX")
redis = Redis(url=os.getenv("UPSTASH_REDIS_REST_URL"), token=os.getenv("UPSTASH_REDIS_REST_TOKEN"))
groq_client = Groq(api_key=os.getenv("GROQ_API_KEY"))

RATE_LIMIT = 20   # requests per window per IP
RATE_WINDOW = 60  # seconds

# ── Lazy model loading ────────────────────────────────────────────────────────
_embeddings = None
_vector_store = None
_ranker = None

def get_embeddings():
    global _embeddings
    if _embeddings is None:
        _embeddings = HuggingFaceEmbeddings(model_name="all-MiniLM-L6-v2")
    return _embeddings

def get_vector_store():
    global _vector_store
    if _vector_store is None:
        _vector_store = PineconeVectorStore(index_name=index_name, embedding=get_embeddings())
    return _vector_store

def get_ranker():
    global _ranker
    if _ranker is None:
        _ranker = Ranker(model_name="ms-marco-TinyBERT-L-2-v2", cache_dir="/tmp")
    return _ranker

bm25_store = {}

# ── Helpers ───────────────────────────────────────────────────────────────────
def check_rate_limit(ip: str):
    key = f"rate:{ip}:{int(time.time() // RATE_WINDOW)}"
    try:
        count = redis.incr(key)
        if count == 1:
            redis.expire(key, RATE_WINDOW)
        if count > RATE_LIMIT:
            raise HTTPException(status_code=429, detail="Rate limit exceeded. Please wait a minute.")
    except HTTPException:
        raise
    except Exception:
        pass  # don't block if Redis is unavailable

def rewrite_query(query: str) -> str:
    try:
        resp = groq_client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[
                {"role": "system", "content": (
                    "Rewrite the following user question into a concise, specific search query "
                    "optimised for document retrieval. Return ONLY the rewritten query, nothing else."
                )},
                {"role": "user", "content": query},
            ],
            max_tokens=120,
            temperature=0.2,
        )
        return resp.choices[0].message.content.strip()
    except Exception:
        return query  # fall back to original on failure

# ── Upload PDF ────────────────────────────────────────────────────────────────
@app.post("/upload_pdf")
async def upload(file: UploadFile = File(...)):
    try:
        fname = file.filename or "document.pdf"
        content = await file.read()
        if not content:
            raise HTTPException(status_code=400, detail="Uploaded file is empty")

        doc = fitz.open(stream=content, filetype="pdf")
        full_text_chunks, metadatas = [], []

        for page_num, page in enumerate(doc):
            text = page.get_text()
            splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=150)
            for chunk in splitter.split_text(text):
                full_text_chunks.append(chunk)
                metadatas.append({"page": page_num + 1, "source": fname})

        if not full_text_chunks:
            raise HTTPException(status_code=422, detail="No text could be extracted from this PDF")

        get_vector_store().add_texts(full_text_chunks, metadatas=metadatas)

        tokenized_corpus = [c.split(" ") for c in full_text_chunks]
        bm25_store[fname] = {
            "bm25": BM25Okapi(tokenized_corpus),
            "chunks": full_text_chunks,
            "metadatas": metadatas,
        }

        # Generate summary + suggested questions from the first 8 chunks
        sample_text = "\n---\n".join(full_text_chunks[:8])
        summary, questions = "", []
        try:
            meta_resp = groq_client.chat.completions.create(
                model="llama-3.3-70b-versatile",
                messages=[
                    {"role": "system", "content": (
                        "Analyse these document excerpts and return a JSON object with exactly two keys: "
                        '"summary" (2-3 sentence overview of the document) and '
                        '"questions" (array of exactly 4 insightful questions a user might ask). '
                        "Return ONLY valid JSON, no extra text."
                    )},
                    {"role": "user", "content": sample_text},
                ],
                response_format={"type": "json_object"},
                max_tokens=500,
                temperature=0.3,
            )
            meta = json.loads(meta_resp.choices[0].message.content)
            summary = meta.get("summary", "")
            questions = meta.get("questions", [])[:4]
        except Exception:
            pass  # non-fatal; upload still succeeds

        return {"filename": fname, "summary": summary, "questions": questions}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ── Transcribe audio ──────────────────────────────────────────────────────────
@app.post("/transcribe")
async def transcribe(audio: UploadFile = File(...)):
    try:
        audio_content = await audio.read()
        transcription = groq_client.audio.transcriptions.create(
            file=("temp.wav", audio_content),
            model="whisper-large-v3-turbo",
            response_format="json",
        )
        return {"text": transcription.text}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")

# ── Chat stream ───────────────────────────────────────────────────────────────
@app.post("/chat_stream")
async def chat(
    request: Request,
    audio: UploadFile = File(None),
    text_query: str = Form(None),
    filename: str = Form(None),
    history: str = Form(None),   # JSON: [{role, content}, ...]
):
    ip = request.headers.get("x-forwarded-for", request.client.host).split(",")[0].strip()
    check_rate_limit(ip)

    if audio:
        try:
            audio_content = await audio.read()
            transcription = groq_client.audio.transcriptions.create(
                file=("temp.wav", audio_content),
                model="whisper-large-v3-turbo",
                response_format="json",
            )
            user_query = transcription.text
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Voice transcription failed: {str(e)}")
    else:
        user_query = text_query

    if not user_query:
        raise HTTPException(status_code=400, detail="No query provided")

    # Parse conversation history
    chat_history = []
    if history:
        try:
            chat_history = json.loads(history)
        except Exception:
            pass

    # Cache only for standalone (no history) queries
    cache_key = f"cache:{user_query.lower().strip()}"
    if not chat_history:
        try:
            cached = redis.get(cache_key)
            if cached:
                return {"reply": cached, "source": "cache"}
        except Exception:
            pass

    # Rewrite query for better retrieval on first turn only
    search_query = rewrite_query(user_query) if not chat_history else user_query

    # Hybrid retrieval
    vector_results = get_vector_store().similarity_search(search_query, k=10)

    bm25_results = []
    if filename in bm25_store:
        tokenized_query = search_query.split(" ")
        scores = bm25_store[filename]["bm25"].get_scores(tokenized_query)
        top_n = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)[:5]
        for i in top_n:
            bm25_results.append({
                "id": i,
                "text": bm25_store[filename]["chunks"][i],
                "meta": bm25_store[filename]["metadatas"][i],
            })

    candidates = [
        {"id": d.metadata.get("page"), "text": d.page_content, "meta": d.metadata}
        for d in vector_results
    ] + bm25_results

    try:
        rerank_request = RerankRequest(query=search_query, passages=candidates)
        top_docs = get_ranker().rerank(rerank_request)[:5]
    except Exception:
        top_docs = candidates[:5]

    context = "\n".join([d["text"] for d in top_docs])
    citation_pages = sorted({
        d["meta"].get("page")
        for d in top_docs
        if isinstance(d.get("meta"), dict) and d["meta"].get("page")
    })

    async def stream_and_cache():
        full_reply = ""
        system_prompt = (
            "You are EchoPDF, an advanced AI assistant that answers questions about PDF documents. "
            "Use ONLY the document context below. "
            "If the information is not present in the context, say so clearly — never fabricate.\n\n"
            f"Document context:\n{context}"
        )

        llm_messages = [{"role": "system", "content": system_prompt}]
        for msg in chat_history[-6:]:   # last 3 exchanges = 6 messages
            llm_messages.append({"role": msg["role"], "content": msg["content"]})
        llm_messages.append({"role": "user", "content": user_query})

        stream = groq_client.chat.completions.create(
            model=os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile"),
            messages=llm_messages,
            stream=True,
        )
        for chunk in stream:
            content = chunk.choices[0].delta.content
            if content:
                full_reply += content
                yield content

        # Append citation page numbers as a machine-readable suffix
        if citation_pages:
            yield f"\n[CITATIONS]{json.dumps(citation_pages)}"

        if not chat_history:
            try:
                redis.setex(cache_key, 3600, full_reply)
            except Exception:
                pass

    return StreamingResponse(stream_and_cache(), media_type="text/plain")
