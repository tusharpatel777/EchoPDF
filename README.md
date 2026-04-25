# EchoPDF

EchoPDF is an advanced RAG (Retrieval-Augmented Generation) and Voice AI platform designed for high-performance interaction with PDF documents. It combines semantic search, hybrid retrieval, and real-time voice interaction to provide a seamless document analysis experience.

## Technical Architecture

The project is built with a decoupled architecture:
- **Frontend**: Next.js 14 with TypeScript, Tailwind CSS, and Framer Motion.
- **Backend**: FastAPI (Python 3.10+) utilizing Groq for LLM inference and Whisper for speech-to-text.
- **Vector Database**: Pinecone (Serverless) for document indexing and retrieval.
- **Caching Layer**: Upstash Redis for response caching and session management.

## Project Structure

```text
.
├── backend/            # FastAPI server and RAG logic
└── frontend/           # Next.js application and UI components
```

## Setup Instructions

### Prerequisites
- Python 3.10+
- Node.js 18+
- API keys for Groq, Pinecone, and Upstash.

### Backend Setup
1. Navigate to the `backend` directory.
2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```
3. Create a `.env` file with the following keys:
   - `GROQ_API_KEY`
   - `PINECONE_API_KEY`
   - `PINECONE_INDEX`
   - `UPSTASH_REDIS_URL`
   - `UPSTASH_REDIS_TOKEN`
4. Start the server:
   ```bash
   uvicorn app:app --reload
   ```

### Frontend Setup
1. Navigate to the `frontend` directory.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the development server:
   ```bash
   npm run dev
   ```

## Key Features
- **Hybrid Retrieval**: Combines Pinecone semantic search with BM25 keyword matching.
- **Advanced Reranking**: Uses FlashRank to improve response relevance.
- **Voice Interaction**: Integrated speech-to-text and real-time voice visualization.
- **Streamed Responses**: Real-time response streaming from Groq models.
- **Dark Glassmorphism UI**: A professional, high-fidelity design system.
