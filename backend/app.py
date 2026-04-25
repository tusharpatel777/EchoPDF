import os
import whisper
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
from io import BytesIO
from dotenv import load_dotenv

load_dotenv()
app = FastAPI()

# Enable CORS for Next.js frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# 1. Initialization
pc = Pinecone(api_key=os.getenv("PINECONE_API_KEY"))
index_name = os.getenv("PINECONE_INDEX")
embeddings = HuggingFaceEmbeddings(model_name="all-MiniLM-L6-v2")
vector_store = PineconeVectorStore(index_name=index_name, embedding=embeddings)

redis = Redis(url=os.getenv("UPSTASH_REDIS_URL"), token=os.getenv("UPSTASH_REDIS_TOKEN"))
groq_client = Groq(api_key=os.getenv("GROQ_API_KEY"))
whisper_model = whisper.load_model("base")
ranker = Ranker()

# Store BM25 instances in memory for hybrid search (simplified for demo)
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

        # 1. Cloud Indexing (Pinecone)
        vector_store.add_texts(full_text_chunks, metadatas=metadatas)
        
        # 2. Local BM25 for Hybrid Search
        tokenized_corpus = [doc.split(" ") for doc in full_text_chunks]
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
    # A. Input Handling (Voice or Text)
    if audio:
        with open("temp.wav", "wb") as f: f.write(await audio.read())
        user_query = whisper_model.transcribe("temp.wav")["text"]
    else:
        user_query = text_query

    if not user_query:
        raise HTTPException(status_code=400, detail="No query provided")

    # B. Redis Caching
    cache_key = f"cache:{user_query.lower().strip()}"
    cached_res = redis.get(cache_key)
    if cached_res:
        return {"reply": cached_res.decode(), "source": "cache"}

    # C. Advanced RAG (Hybrid + Reranking)
    # 1. Vector Search
    vector_results = vector_store.similarity_search(user_query, k=10)
    
    # 2. BM25 Search (if filename provided and indexed)
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

    # Combine and Rerank
    candidates = []
    for doc in vector_results:
        candidates.append({"id": doc.metadata.get("page"), "text": doc.page_content, "meta": doc.metadata})
    for doc in bm25_results:
        candidates.append(doc)

    # Dedup and Rerank with FlashRank
    rerank_request = RerankRequest(query=user_query, passages=candidates)
    results = ranker.rerank(rerank_request)
    
    # Take top 5 reranked results
    top_docs = results[:5]
    context = "\n".join([d['text'] for d in top_docs])
    sources = [{"page": d['meta']['page'], "snippet": d['text'][:100] + "..."} for d in top_docs]

    # D. Streaming Response
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
        
        # Save to Redis
        redis.setex(cache_key, 3600, full_reply)

    return StreamingResponse(stream_and_cache(), media_type="text/plain")