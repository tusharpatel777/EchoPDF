FROM python:3.10-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    ffmpeg \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# HuggingFace Spaces requires port 7860; Render uses $PORT (defaults to 8000)
EXPOSE 7860
CMD uvicorn app:app --host 0.0.0.0 --port ${PORT:-7860}
