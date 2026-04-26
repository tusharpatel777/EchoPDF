import os
import fitz  # PyMuPDF
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
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

# All heavy models lazy-loaded on first use to keep startup RAM under 512MB
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

@app.post("/upload_pdf")
async def upload(file: UploadFile = File(...)):
    try:
        content = await file.read()
        doc = fitz.open(stream=content, filetype="pdf")

        full_text_chunks = []
        metadatas = []

        for page_num, page in enumerate(doc):
            text = page.get_text()
            splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=150)
            chunks = splitter.split_text(text)
            for chunk in chunks:
                full_text_chunks.append(chunk)
                metadatas.append({"page": page_num + 1, "source": file.filename})

        get_vector_store().add_texts(full_text_chunks, metadatas=metadatas)

        tokenized_corpus = [chunk.split(" ") for chunk in full_text_chunks]
        bm25_store[file.filename] = {
            "bm25": BM25Okapi(tokenized_corpus),
            "chunks": full_text_chunks,
            "metadatas": metadatas
        }

        return {"message": "Advanced Cloud Indexing Complete!", "filename": file.filename}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/chat_stream")
async def chat(audio: UploadFile = File(None), text_query: str = Form(None), filename: str = Form(None)):
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

    cache_key = f"cache:{user_query.lower().strip()}"
    try:
        cached_res = redis.get(cache_key)
        if cached_res:
            return {"reply": cached_res, "source": "cache"}
    except Exception:
        pass

    vector_results = get_vector_store().similarity_search(user_query, k=10)

    bm25_results = []
    if filename in bm25_store:
        tokenized_query = user_query.split(" ")
        bm25_scores = bm25_store[filename]["bm25"].get_scores(tokenized_query)
        top_n = sorted(range(len(bm25_scores)), key=lambda i: bm25_scores[i], reverse=True)[:5]
        for i in top_n:
            bm25_results.append({
                "id": i,
                "text": bm25_store[filename]["chunks"][i],
                "meta": bm25_store[filename]["metadatas"][i]
            })

    candidates = []
    for doc in vector_results:
        candidates.append({"id": doc.metadata.get("page"), "text": doc.page_content, "meta": doc.metadata})
    for doc in bm25_results:
        candidates.append(doc)

    try:
        ranker = get_ranker()
        rerank_request = RerankRequest(query=user_query, passages=candidates)
        results = ranker.rerank(rerank_request)
        top_docs = results[:5]
    except Exception:
        top_docs = candidates[:5]

    context = "\n".join([d['text'] for d in top_docs])

    async def stream_and_cache():
        full_reply = ""
        system_prompt = f"You are EchoPDF, an advanced AI assistant. Use the following context to answer the user query. Context: {context}"

        stream = groq_client.chat.completions.create(
            model=os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile"),
            messages=[{"role": "system", "content": system_prompt},
                      {"role": "user", "content": user_query}],
            stream=True
        )
        for chunk in stream:
            content = chunk.choices[0].delta.content
            if content:
                full_reply += content
                yield content

        try:
            redis.setex(cache_key, 3600, full_reply)
        except Exception:
            pass

    return StreamingResponse(stream_and_cache(), media_type="text/plain")
