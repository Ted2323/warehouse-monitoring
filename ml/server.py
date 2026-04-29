"""
Warehouse Detection — FastAPI Service
--------------------------------------
Wraps detect.py as an HTTP microservice.
The Next.js API route calls POST /detect when DETECTION_SERVICE_URL is set.

Local usage (cwd = ml/):
    pip install -r requirements.txt
    uvicorn server:app --host 0.0.0.0 --port 8000

    # parallel-frontend dev (no model required)
    USE_MOCK=1 uvicorn server:app --host 0.0.0.0 --port 8000
    # or pass --mock when launching via `python server.py`

Container usage (cwd = /app, ml/ is a package):
    uvicorn ml.server:app --host 0.0.0.0 --port 8000
"""

import os
import json
import logging
import sys
import tempfile
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

# detect.py lives next to this file. When uvicorn loads us as `ml.server`
# (Docker / Render), the relative import works. When loaded as plain `server`
# (local `cd ml && uvicorn server:app`), the relative import has no parent
# package, so we fall back to the absolute name.
try:
    from .detect import (
        check_ppe_violations,
        check_violations,
        get_zones,
        load_model,
        run_inference,
        save_detection_log,
        summarize_compliance,
        summarize_inventory,
    )
except ImportError:
    from detect import (  # type: ignore[no-redef]
        check_ppe_violations,
        check_violations,
        get_zones,
        load_model,
        run_inference,
        save_detection_log,
        summarize_compliance,
        summarize_inventory,
    )

# In dev the .env sits at the repo root (one level above ml/). In production
# every value comes from the platform's env config and this call is a no-op.
load_dotenv("../.env")

log = logging.getLogger("warehouse.server")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

app = FastAPI(title="Warehouse Detection Service", version="2.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

# ─── ENV ─────────────────────────────────────────────────────
MODEL_PATH      = os.environ.get("MODEL_PATH", "./best.pt")

# `MOCK_MODE` is the canonical deploy-time switch (set by render.yaml). The
# older `USE_MOCK` env var and the `--mock` CLI flag are kept as aliases so
# pre-section-11 muscle memory still works.
MOCK_MODE       = (
    os.environ.get("MOCK_MODE", "").strip().lower() == "true"
    or os.environ.get("USE_MOCK", "0") == "1"
)
MOCK_PATH       = Path(__file__).parent / "fixtures" / "mock_detection.json"
SERVICE_TOKEN   = os.environ.get("DETECTION_SERVICE_TOKEN", "")
PUBLIC_PATHS    = {"/health"}

# Supabase Storage source for the model weight (used when not in mock mode).
SUPABASE_URL          = os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "")
SUPABASE_SERVICE_KEY  = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
MODEL_BUCKET          = os.environ.get("MODEL_BUCKET", "models")
MODEL_OBJECT          = os.environ.get("MODEL_OBJECT", "best.pt")


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


# ─── STARTUP HOOK ────────────────────────────────────────────
def _download_model_from_supabase(dest: Path) -> None:
    """Pull MODEL_BUCKET/MODEL_OBJECT to `dest` using the service role key."""
    if not (SUPABASE_URL and SUPABASE_SERVICE_KEY):
        raise RuntimeError(
            "Cannot download model: NEXT_PUBLIC_SUPABASE_URL and "
            "SUPABASE_SERVICE_ROLE_KEY must both be set."
        )

    from supabase import create_client  # local import — heavy dep

    log.info("Downloading model from Supabase Storage: %s/%s", MODEL_BUCKET, MODEL_OBJECT)
    sb = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    blob = sb.storage.from_(MODEL_BUCKET).download(MODEL_OBJECT)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(blob)
    size_mb = dest.stat().st_size / (1024 * 1024)
    log.info("Model written to %s (%.1f MB)", dest, size_mb)


@app.on_event("startup")
def ensure_model_available() -> None:
    """
    Resolve the inference source before the first request lands:
      * MOCK_MODE=true   → require ml/fixtures/mock_detection.json
      * otherwise         → require best.pt; download from Supabase if missing
    Failing here makes the container exit instead of serving a broken instance.
    """
    if MOCK_MODE:
        if not MOCK_PATH.exists():
            log.error("MOCK_MODE is on but mock fixture is missing: %s", MOCK_PATH)
            raise RuntimeError(f"Mock fixture missing: {MOCK_PATH}")
        log.info("Starting in MOCK_MODE — serving fixture from %s", MOCK_PATH)
        return

    model = Path(MODEL_PATH)
    if not model.exists():
        try:
            _download_model_from_supabase(model)
        except Exception as exc:
            log.exception("Failed to download model from Supabase Storage")
            # Fail loudly: we are not in mock mode and have no weights. The brief
            # explicitly says fail, don't fall back silently.
            raise RuntimeError(
                f"No model available. MOCK_MODE is off, MODEL_PATH={MODEL_PATH} does "
                f"not exist, and the Supabase Storage download failed: {exc}"
            ) from exc
    else:
        log.info("Model present at %s — skipping download", model)

    # Warm the YOLO model into memory so the first /detect call doesn't pay
    # ~3-10s of CPU-torch instantiation while Vercel's 60s budget is ticking.
    # Failure here is loud: a model that won't load is no better than no model.
    log.info("Warming YOLO model from %s", model)
    load_model(str(model))
    log.info("YOLO model warmed and cached")


# ─── SCHEMAS ─────────────────────────────────────────────────
class DetectRequest(BaseModel):
    image_url: str
    camera_id: str
    model_path: str = MODEL_PATH


# ─── ROUTES ──────────────────────────────────────────────────
@app.get("/health")
def health():
    return {
        "status":     "ok",
        "model_path": MODEL_PATH,
        "model_present": Path(MODEL_PATH).exists(),
        "mock_mode":  MOCK_MODE,
    }


@app.post("/detect")
async def detect(req: DetectRequest):
    # ── Mock mode: serve fixture, skip download + inference ──
    if MOCK_MODE:
        if not MOCK_PATH.exists():
            raise HTTPException(status_code=500, detail=f"Mock fixture missing: {MOCK_PATH}")
        with open(MOCK_PATH) as f:
            return json.load(f)

    # Per-phase timing — Vercel keeps surfacing 504s and the only way to size
    # the next fix is to know which step actually eats the budget. Logged at
    # INFO so it shows up in the default Render log stream.
    import time as _time
    timings: dict[str, float] = {}
    def _phase(name: str, t0: float) -> float:
        elapsed = _time.monotonic() - t0
        timings[name] = elapsed
        log.info("[/detect] %-14s %6.2fs", name, elapsed)
        return _time.monotonic()

    t = _time.monotonic()

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

    t = _phase("fetch_image", t)

    try:
        # Downscale large images before YOLO. On Render free tier (0.5 CPU,
        # 512 MB RAM) a 4000x3000 stock photo decompresses to ~108 MB of RGB
        # pixels, eating half the RAM budget and 30-60s of preprocessing
        # before YOLO even runs (YOLO itself works at 640x640 internally).
        # 1280px max preserves plenty of headroom for accuracy while turning
        # tens-of-seconds requests into sub-10s ones.
        try:
            from PIL import Image
            with Image.open(tmp_path) as im:
                w, h = im.size
                if max(w, h) > 1280:
                    im.thumbnail((1280, 1280), Image.LANCZOS)
                    im.convert("RGB").save(tmp_path, "JPEG", quality=85, optimize=False)
                    log.info("Downscaled input %dx%d -> %dx%d for inference", w, h, *im.size)
        except Exception as exc:
            log.warning("Image downscale skipped (%s) — proceeding at original size", exc)

        t = _phase("downscale", t)

        # 2. Run YOLOv8 inference
        detections = run_inference(tmp_path, req.model_path)
        t = _phase("inference", t)

        # 3. PPE (association-driven) + inventory + zone (secondary)
        ppe_violations     = check_ppe_violations(detections)
        inventory          = summarize_inventory(detections)
        compliance_summary = summarize_compliance(detections, ppe_violations)
        t = _phase("associate", t)

        zones              = get_zones(req.camera_id)
        t = _phase("get_zones", t)
        zone_violations    = check_violations(detections, zones)

        # 4. Persist
        save_detection_log(
            req.camera_id, req.image_url,
            detections, ppe_violations, zone_violations, inventory,
            compliance_summary=compliance_summary,
        )
        t = _phase("persist", t)

        log.info("[/detect] TOTAL          %6.2fs  (n_det=%d)",
                 sum(timings.values()), len(detections))

        return {
            "detections":         detections,
            "ppe_violations":     ppe_violations,
            "zone_violations":    zone_violations,
            "inventory":          inventory,
            "compliance_summary": compliance_summary,
            "total_objects":      len(detections),
            "total_violations":   len(ppe_violations) + len(zone_violations),
            "timings_s":          {k: round(v, 3) for k, v in timings.items()},
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
        # Set both names so the startup hook + middleware see consistent state.
        os.environ["MOCK_MODE"] = "true"
        os.environ["USE_MOCK"]  = "1"
        MOCK_MODE = True

    uvicorn.run(app, host=args.host, port=args.port)
