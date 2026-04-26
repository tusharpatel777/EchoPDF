import os
import json
import time
import base64
import asyncio
import fitz  # PyMuPDF
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request, BackgroundTasks
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
from google import genai as google_genai
from google.genai import types as genai_types

load_dotenv()

# ── Setup ─────────────────────────────────────────────────────────────────────
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

pc        = Pinecone(api_key=os.getenv("PINECONE_API_KEY"))
index_name = os.getenv("PINECONE_INDEX")
redis     = Redis(url=os.getenv("UPSTASH_REDIS_REST_URL"), token=os.getenv("UPSTASH_REDIS_REST_TOKEN"))
groq_client = Groq(api_key=os.getenv("GROQ_API_KEY"))

# Gemini Vision — new google-genai SDK
gemini_client = google_genai.Client(api_key=os.getenv("GEMINI_API_KEY", ""))

RATE_LIMIT  = 20
RATE_WINDOW = 60

# ── Lazy model loading ────────────────────────────────────────────────────────
# NOTE: BGE-large uses 1024 dims. Your Pinecone index must be created with
# dimension=1024. If you were using all-MiniLM-L6-v2 (384 dims), create a
# new index. Change PINECONE_INDEX in your .env to the new index name.
_embeddings   = None
_vector_store = None  # rebuilt per namespace; cached by user_id
_vs_cache: dict = {}
_ranker       = None

def get_embeddings():
    global _embeddings
    if _embeddings is None:
        _embeddings = HuggingFaceEmbeddings(model_name="BAAI/bge-large-en-v1.5")
    return _embeddings

def get_vector_store(user_id: str):
    if user_id not in _vs_cache:
        _vs_cache[user_id] = PineconeVectorStore(
            index_name=index_name,
            embedding=get_embeddings(),
            namespace=user_id,   # full isolation per user
        )
    return _vs_cache[user_id]

def get_ranker():
    global _ranker
    if _ranker is None:
        _ranker = Ranker(model_name="ms-marco-TinyBERT-L-2-v2", cache_dir="/tmp")
    return _ranker

# bm25_store[user_id][filename] = {bm25, chunks, metadatas}
bm25_store: dict[str, dict] = {}

# ── Helpers ───────────────────────────────────────────────────────────────────
def check_rate_limit(ip: str):
    key = f"rate:{ip}:{int(time.time() // RATE_WINDOW)}"
    try:
        count = redis.incr(key)
        if count == 1:
            redis.expire(key, RATE_WINDOW)
        if count > RATE_LIMIT:
            raise HTTPException(429, "Rate limit exceeded. Please wait a minute.")
    except HTTPException:
        raise
    except Exception:
        pass

def rewrite_query(query: str) -> str:
    try:
        resp = groq_client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[
                {"role": "system", "content": "Rewrite the user question into a concise search query for document retrieval. Return ONLY the rewritten query."},
                {"role": "user", "content": query},
            ],
            max_tokens=120, temperature=0.2,
        )
        return resp.choices[0].message.content.strip()
    except Exception:
        return query

def describe_image_with_gemini(image_b64: str, mime_type: str, page_num: int) -> str:
    try:
        image_bytes = base64.b64decode(image_b64)
        resp = gemini_client.models.generate_content(
            model="gemini-2.5-flash",
            contents=[
                f"This image is from page {page_num} of a PDF. Describe all visible text, data, charts, tables, diagrams and figures in detail so the description can answer questions about the image content.",
                genai_types.Part.from_bytes(data=image_bytes, mime_type=mime_type),
            ],
        )
        return resp.text
    except Exception:
        return ""

# ── Background PDF indexing ───────────────────────────────────────────────────
def _index_pdf_task(content: bytes, fname: str, user_id: str):
    try:
        redis.set(f"idx:{user_id}:{fname}", "indexing")
        doc = fitz.open(stream=content, filetype="pdf")
        chunks, metadatas = [], []

        for page_num, page in enumerate(doc):
            # Text chunks
            text = page.get_text()
            splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=150)
            for chunk in splitter.split_text(text):
                chunks.append(chunk)
                metadatas.append({"page": page_num + 1, "source": fname, "type": "text"})

            # Image chunks — describe each image on the page
            for img_info in page.get_images(full=True):
                try:
                    xref = img_info[0]
                    base_img = doc.extract_image(xref)
                    img_b64  = base64.b64encode(base_img["image"]).decode()
                    mime     = f"image/{base_img['ext']}"
                    desc     = describe_image_with_gemini(img_b64, mime, page_num + 1)
                    if desc:
                        chunks.append(f"[Image on page {page_num + 1}]: {desc}")
                        metadatas.append({"page": page_num + 1, "source": fname, "type": "image"})
                except Exception:
                    pass

        if not chunks:
            redis.set(f"idx:{user_id}:{fname}", "error:no_text")
            return

        get_vector_store(user_id).add_texts(chunks, metadatas=metadatas)

        bm25_store.setdefault(user_id, {})[fname] = {
            "bm25": BM25Okapi([c.split() for c in chunks]),
            "chunks": chunks,
            "metadatas": metadatas,
        }

        # Generate summary + questions
        sample = "\n---\n".join(chunks[:8])
        summary, questions = "", []
        try:
            meta_resp = groq_client.chat.completions.create(
                model="llama-3.3-70b-versatile",
                messages=[
                    {"role": "system", "content": 'Return JSON with "summary" (2-3 sentences) and "questions" (4 questions array). ONLY valid JSON.'},
                    {"role": "user", "content": sample},
                ],
                response_format={"type": "json_object"},
                max_tokens=500, temperature=0.3,
            )
            meta = json.loads(meta_resp.choices[0].message.content)
            summary   = meta.get("summary", "")
            questions = meta.get("questions", [])[:4]
        except Exception:
            pass

        # Persist to Redis
        redis.sadd(f"pdfs:{user_id}", fname)
        redis.set(f"meta:{user_id}:{fname}", json.dumps({"summary": summary, "questions": questions}))
        redis.set(f"idx:{user_id}:{fname}", "ready")

    except Exception as e:
        redis.set(f"idx:{user_id}:{fname}", f"error:{str(e)[:100]}")

# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.post("/upload_pdf")
async def upload(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    user_id: str = Form(...),
):
    fname   = file.filename or "document.pdf"
    content = await file.read()
    if not content:
        raise HTTPException(400, "Uploaded file is empty")

    # Return immediately — indexing happens in background
    redis.set(f"idx:{user_id}:{fname}", "indexing")
    background_tasks.add_task(_index_pdf_task, content, fname, user_id)
    return {"filename": fname, "status": "indexing"}


@app.get("/index_status/{user_id}/{filename}")
async def index_status(user_id: str, filename: str):
    raw = redis.get(f"idx:{user_id}:{filename}")
    if raw is None:
        return {"status": "not_found"}
    status = raw if isinstance(raw, str) else raw.decode()
    if status == "ready":
        meta_raw = redis.get(f"meta:{user_id}:{filename}")
        meta = json.loads(meta_raw) if meta_raw else {}
        return {"status": "ready", "summary": meta.get("summary",""), "questions": meta.get("questions",[])}
    return {"status": status}


@app.get("/my_pdfs/{user_id}")
async def my_pdfs(user_id: str):
    members = redis.smembers(f"pdfs:{user_id}")
    files = []
    for m in (members or []):
        name   = m if isinstance(m, str) else m.decode()
        status = redis.get(f"idx:{user_id}:{name}")
        status = (status if isinstance(status, str) else (status.decode() if status else "unknown"))
        files.append({"name": name, "status": status})
    return {"files": files}


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
        raise HTTPException(500, f"Transcription failed: {str(e)}")


@app.post("/ask_image")
async def ask_image(
    request: Request,
    image: UploadFile = File(...),
    question: str = Form(...),
    user_id: str = Form(...),
):
    ip = request.headers.get("x-forwarded-for", request.client.host).split(",")[0].strip()
    check_rate_limit(ip)
    try:
        img_bytes = await image.read()
        mime      = image.content_type or "image/jpeg"
        resp = gemini_client.models.generate_content(
            model="gemini-2.5-flash",
            contents=[
                question,
                genai_types.Part.from_bytes(data=img_bytes, mime_type=mime),
            ],
        )
        return {"answer": resp.text}
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/chat_stream")
async def chat(
    request: Request,
    text_query: str = Form(None),
    filename:   str = Form(None),
    user_id:    str = Form(...),
    history:    str = Form(None),
):
    ip = request.headers.get("x-forwarded-for", request.client.host).split(",")[0].strip()
    check_rate_limit(ip)

    user_query = text_query
    if not user_query:
        raise HTTPException(400, "No query provided")

    chat_history = []
    if history:
        try:
            chat_history = json.loads(history)
        except Exception:
            pass

    cache_key = f"cache:{user_id}:{user_query.lower().strip()}"
    if not chat_history:
        try:
            cached = redis.get(cache_key)
            if cached:
                return {"reply": cached, "source": "cache"}
        except Exception:
            pass

    search_query = rewrite_query(user_query) if not chat_history else user_query

    vector_results = get_vector_store(user_id).similarity_search(search_query, k=10)

    bm25_results = []
    user_bm25 = bm25_store.get(user_id, {})
    if filename and filename in user_bm25:
        tokenized = search_query.split()
        scores    = user_bm25[filename]["bm25"].get_scores(tokenized)
        top_n     = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)[:5]
        for i in top_n:
            bm25_results.append({
                "id":   i,
                "text": user_bm25[filename]["chunks"][i],
                "meta": user_bm25[filename]["metadatas"][i],
            })

    candidates = [
        {"id": d.metadata.get("page"), "text": d.page_content, "meta": d.metadata}
        for d in vector_results
    ] + bm25_results

    try:
        top_docs = get_ranker().rerank(RerankRequest(query=search_query, passages=candidates))[:5]
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
            "You are EchoPDF, an advanced AI assistant for PDF documents. "
            "Answer using ONLY the provided document context. "
            "If the answer is not in the context, say so — never fabricate.\n\n"
            f"Document context:\n{context}"
        )

        llm_msgs = [{"role": "system", "content": system_prompt}]
        for msg in chat_history[-6:]:
            llm_msgs.append({"role": msg["role"], "content": msg["content"]})
        llm_msgs.append({"role": "user", "content": user_query})

        stream = groq_client.chat.completions.create(
            model=os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile"),
            messages=llm_msgs,
            stream=True,
        )
        for chunk in stream:
            content = chunk.choices[0].delta.content
            if content:
                full_reply += content
                yield content

        if citation_pages:
            yield f"\n[CITATIONS]{json.dumps(citation_pages)}"

        if not chat_history:
            try:
                redis.setex(cache_key, 3600, full_reply)
            except Exception:
                pass

    return StreamingResponse(stream_and_cache(), media_type="text/plain")
