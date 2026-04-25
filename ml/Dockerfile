FROM python:3.11-slim

WORKDIR /app

# OpenCV (pulled in by ultralytics) needs libgl + glib at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY ml/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY ml/ ./ml/

ENV PYTHONUNBUFFERED=1 \
    MODEL_PATH=/app/ml/best.pt

EXPOSE 8000
CMD ["uvicorn", "ml.server:app", "--host", "0.0.0.0", "--port", "8000"]
