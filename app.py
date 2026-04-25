import os
import whisper
import base64
from fastapi import FastAPI, UploadFile, File, Form
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from groq import Groq
from PyPDF2 import PdfReader
from upstash_redis import Redis
from pinecone import Pinecone
from langchain_pinecone import PineconeVectorStore
from langchain_huggingface import HuggingFaceEmbeddings
from langchain_text_splitters import RecursiveCharacterTextSplitter
from gtts import gTTS
from io import BytesIO
from dotenv import load_dotenv

load_dotenv()
app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")

# 1. Initialization
pc = Pinecone(api_key=os.getenv("PINECONE_API_KEY"))
index_name = os.getenv("PINECONE_INDEX")
embeddings = HuggingFaceEmbeddings(model_name="all-MiniLM-L6-v2")
vector_store = PineconeVectorStore(index_name=index_name, embedding=embeddings)

redis = Redis(url=os.getenv("UPSTASH_REDIS_URL"), token=os.getenv("UPSTASH_REDIS_TOKEN"))
groq_client = Groq(api_key=os.getenv("GROQ_API_KEY"))
whisper_model = whisper.load_model("base")

# 2. Endpoints
@app.post("/upload_pdf")
async def upload(file: UploadFile = File(...)):
    content = await file.read()
    pdf = PdfReader(BytesIO(content))
    text = "".join([page.extract_text() for page in pdf.pages])
    
    splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=200)
    chunks = splitter.split_text(text)
    
    # Cloud indexing (Pinecone)
    vector_store.add_texts(chunks)
    return {"message": "Cloud Indexing Complete!"}

@app.post("/chat_stream")
async def chat(audio: UploadFile = File(...)):
    # A. Whisper (Speech to Text)
    with open("temp.wav", "wb") as f: f.write(await audio.read())
    user_query = whisper_model.transcribe("temp.wav")["text"]

    # B. Redis Caching (Check if already answered)
    cache_key = f"cache:{user_query.lower().strip()}"
    cached_res = redis.get(cache_key)
    if cached_res:
        return {"reply": cached_res.decode(), "source": "cache"}

    # C. RAG (Pinecone Search)
    docs = vector_store.similarity_search(user_query, k=3)
    context = "\n".join([d.page_content for d in docs])

    # D. Streaming Response from Groq
    async def stream_and_cache():
        full_reply = ""
        stream = groq_client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[{"role": "system", "content": f"Context: {context}"},
                      {"role": "user", "content": user_query}],
            stream=True
        )
        for chunk in stream:
            content = chunk.choices[0].delta.content
            if content:
                full_reply += content
                yield content
        
        # Save to Redis for future
        redis.setex(cache_key, 3600, full_reply) # 1 hour cache

    return StreamingResponse(stream_and_cache(), media_type="text/plain")