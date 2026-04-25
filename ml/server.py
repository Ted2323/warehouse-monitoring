"""
Warehouse Detection — FastAPI Service
--------------------------------------
Wraps detect.py as an HTTP microservice.
The Next.js API route calls POST /detect when DETECTION_SERVICE_URL is set.

Usage:
    pip install -r requirements.txt
    uvicorn server:app --host 0.0.0.0 --port 8000

    # parallel-frontend dev (no model required)
    USE_MOCK=1 uvicorn server:app --host 0.0.0.0 --port 8000
    # or pass --mock when launching via `python server.py`
"""

import os
import json
import tempfile
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from detect import (
    check_ppe_violations,
    check_violations,
    get_zones,
    run_inference,
    save_detection_log,
    summarize_inventory,
)

load_dotenv("../.env")   # load NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY

app = FastAPI(title="Warehouse Detection Service", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

MODEL_PATH      = os.environ.get("MODEL_PATH", "./best.pt")
USE_MOCK        = os.environ.get("USE_MOCK", "0") == "1"
MOCK_PATH       = Path(__file__).parent / "fixtures" / "mock_detection.json"
SERVICE_TOKEN   = os.environ.get("DETECTION_SERVICE_TOKEN", "")
PUBLIC_PATHS    = {"/health"}


# ─── BEARER TOKEN GATE ───────────────────────────────────────
# This is a server-to-server microservice; the Next.js API route is the only
# legitimate caller. A static bearer token is enough — user-level auth lives
# in the dashboard. /health is left open for liveness probes.
@app.middleware("http")
async def require_token(request: Request, call_next):
    if request.url.path in PUBLIC_PATHS:
        return await call_next(request)
    if not SERVICE_TOKEN:
        return JSONResponse(
            {"detail": "DETECTION_SERVICE_TOKEN is not configured"},
            status_code=500,
        )
    if request.headers.get("authorization") != f"Bearer {SERVICE_TOKEN}":
        return JSONResponse({"detail": "unauthorized"}, status_code=401)
    return await call_next(request)


# ─── SCHEMAS ─────────────────────────────────────────────────
class DetectRequest(BaseModel):
    image_url: str
    camera_id: str
    model_path: str = MODEL_PATH


# ─── ROUTES ──────────────────────────────────────────────────
@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_PATH, "mock": USE_MOCK}


@app.post("/detect")
async def detect(req: DetectRequest):
    # ── Mock mode: serve fixture, skip download + inference ──
    if USE_MOCK:
        if not MOCK_PATH.exists():
            raise HTTPException(status_code=500, detail=f"Mock fixture missing: {MOCK_PATH}")
        with open(MOCK_PATH) as f:
            return json.load(f)

    # 1. Download image to a temp file
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(req.image_url)
        if resp.status_code != 200:
            raise HTTPException(status_code=400, detail=f"Could not fetch image: {resp.status_code}")

    ext = "." + req.image_url.split(".")[-1].split("?")[0]
    if ext not in (".jpg", ".jpeg", ".png", ".webp"):
        ext = ".jpg"

    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
        tmp.write(resp.content)
        tmp_path = tmp.name

    try:
        # 2. Run YOLOv8 inference
        detections = run_inference(tmp_path, req.model_path)

        # 3. PPE (classification-driven) + inventory + zone (secondary)
        ppe_violations = check_ppe_violations(detections)
        inventory      = summarize_inventory(detections)
        zones          = get_zones(req.camera_id)
        zone_violations = check_violations(detections, zones)

        # 4. Persist
        save_detection_log(
            req.camera_id, req.image_url,
            detections, ppe_violations, zone_violations, inventory,
        )

        return {
            "detections":       detections,
            "ppe_violations":   ppe_violations,
            "zone_violations":  zone_violations,
            "inventory":        inventory,
            "total_objects":    len(detections),
            "total_violations": len(ppe_violations) + len(zone_violations),
        }
    finally:
        os.unlink(tmp_path)


# ─── CLI ENTRYPOINT ──────────────────────────────────────────
if __name__ == "__main__":
    import argparse
    import uvicorn

    parser = argparse.ArgumentParser(description="Warehouse Detection FastAPI server")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--mock", action="store_true",
                        help="Serve the mock fixture instead of running inference")
    args = parser.parse_args()

    if args.mock:
        os.environ["USE_MOCK"] = "1"
        USE_MOCK = True

    uvicorn.run(app, host=args.host, port=args.port)
