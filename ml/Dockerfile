FROM python:3.11-slim

WORKDIR /app

# OpenCV (pulled in by ultralytics) needs libgl + glib at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Install CPU-only PyTorch first. The default torch wheel on PyPI pulls
# ~3 GB of NVIDIA CUDA libraries (cublas, cudnn, nccl, etc.) that are
# completely unused on Render free tier (no GPU) and would blow the 512 MB
# memory ceiling at startup. The `+cpu` local-version suffix forces pip to
# pick the CPU wheel from PyTorch's CPU index instead.
RUN pip install --no-cache-dir \
        torch==2.4.1+cpu torchvision==0.19.1+cpu \
        --extra-index-url https://download.pytorch.org/whl/cpu

COPY ml/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY ml/ ./ml/

ENV PYTHONUNBUFFERED=1 \
    MODEL_PATH=/app/ml/best.pt

EXPOSE 8000
CMD ["uvicorn", "ml.server:app", "--host", "0.0.0.0", "--port", "8000"]
