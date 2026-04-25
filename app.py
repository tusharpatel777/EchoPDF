import os
import base64
import whisper
from fastapi import FastAPI, UploadFile, File, Form
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse
from groq import Groq
from PyPDF2 import PdfReader
from langchain_community.vectorstores import FAISS
from langchain_huggingface import HuggingFaceEmbeddings
from langchain_text_splitters import RecursiveCharacterTextSplitter
from gtts import gTTS
from io import BytesIO
from dotenv import load_dotenv

load_dotenv()
app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")

# Models Setup
whisper_model = whisper.load_model("base")
embeddings = HuggingFaceEmbeddings(model_name="all-MiniLM-L6-v2")
client = Groq(api_key=os.getenv("GROQ_API_KEY"))
vector_db = None

@app.get("/")
async def root():
    from fastapi.responses import FileResponse
    return FileResponse('static/index.html')

@app.post("/upload_pdf")
async def upload_pdf(file: UploadFile = File(...)):
    global vector_db
    content = await file.read()
    pdf_reader = PdfReader(BytesIO(content))
    text = "".join([page.extract_text() for page in pdf_reader.pages])
    
    splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=200)
    chunks = splitter.split_text(text)
    vector_db = FAISS.from_texts(chunks, embeddings)
    return {"message": "PDF Ready!"}

@app.post("/chat")
async def chat(audio: UploadFile = File(...)):
    global vector_db
    # 1. Save Audio & Transcribe
    with open("temp_audio.wav", "wb") as f:
        f.write(await audio.read())
    
    result = whisper_model.transcribe("temp_audio.wav")
    user_query = result["text"]

    # 2. RAG & Groq
    docs = vector_db.similarity_search(user_query, k=3)
    context = "\n".join([d.page_content for d in docs])
    
    completion = client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[{"role": "system", "content": f"Answer based on context: {context}"},
                  {"role": "user", "content": user_query}]
    )
    ai_reply = completion.choices[0].message.content

    # 3. TTS to Base64
    tts = gTTS(ai_reply)
    mp3_fp = BytesIO()
    tts.write_to_fp(mp3_fp)
    mp3_fp.seek(0)
    audio_base64 = base64.b64encode(mp3_fp.read()).decode('utf-8')

    return {"reply": ai_reply, "audio_base64": audio_base64}