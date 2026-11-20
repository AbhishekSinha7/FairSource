# Build from the repo root: docker build -f services/worker/Dockerfile -t worker .
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PROMPTS_DIR=/app/prompts
WORKDIR /app
COPY services/worker/pyproject.toml ./
COPY services/worker/src ./src
COPY prompts /app/prompts
RUN pip install .
USER nobody
# Production: GOOGLE_GENAI_USE_VERTEXAI=true, GOOGLE_CLOUD_LOCATION=asia-south1, and
# GEMMA_API_KEY from Secret Manager (Gemma runs on the Gemini API; without it, Flash is used).
CMD ["functions-framework", "--target=pubsub", "--source=src/worker/main.py", "--port=8080"]
