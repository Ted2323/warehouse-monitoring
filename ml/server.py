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
from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
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

    # Warm the YOLO model into memory + run one dummy forward pass so the
    # first real /detect doesn't pay ~50-70s of JIT graph compilation. The
    # load alone (~10s) gets weights into RAM; the dummy inference compiles
    # the torch graph and primes any internal caches. We saw 73s on the
    # first request and 21s on the second — the delta is what this fixes.
    log.info("Warming YOLO model from %s", model)
    yolo = load_model(str(model))
    try:
        import numpy as _np  # numpy is already a torch dep — free import
        dummy = _np.zeros((640, 640, 3), dtype=_np.uint8)
        yolo(dummy, verbose=False)
        log.info("YOLO model warmed and cached (forward pass complete)")
    except Exception as exc:
        log.warning("YOLO warmup forward pass skipped (%s) — first request will be slow", exc)


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


# Mirrors frontend MIN_CONFIDENCE (lib/classes.ts). Applied here at the
# persist boundary so detection_logs only ever contains entries we'd be
# willing to draw — independent of whether the caller is the sync mock path
# or the async background pipeline. 0.25 because the current model goes
# silent at 0.5 (mAP <=0.5); raise once the model improves.
MIN_CONFIDENCE = 0.25


def _filter_min_conf(items: list) -> list:
    return [x for x in items if isinstance(x, dict) and x.get("confidence", 0) >= MIN_CONFIDENCE]


def _run_pipeline_sync(image_url: str, camera_id: str, model_path: str) -> None:
    """Background pipeline: fetch → inference → persist.

    Runs in FastAPI's threadpool after /detect has returned 202 to the caller.
    Errors are logged but don't surface to the user — by design, since the
    response has already been sent. The dashboard polls /api/logs by
    image_url and surfaces a timeout if no row appears.

    Render free tier inference is ~80-100s for a single image on the warmed
    YOLOv8n model; the threadpool serializes background tasks per worker, so
    sequential uploads queue. That's acceptable for the demo's scale.
    """
    import time as _time
    timings: dict[str, float] = {}

    def _phase(name: str, t0: float) -> float:
        elapsed = _time.monotonic() - t0
        timings[name] = elapsed
        log.info("[/detect] %-14s %6.2fs", name, elapsed)
        return _time.monotonic()

    t = _time.monotonic()

    # 1. Fetch image (sync httpx — we're already in a threadpool worker, so
    #    blocking I/O is fine and avoids the asyncio bridge from sync code).
    try:
        with httpx.Client(timeout=30) as client:
            resp = client.get(image_url)
        if resp.status_code != 200:
            log.error("[/detect] fetch_image failed: HTTP %s for %s", resp.status_code, image_url)
            return
    except Exception:
        log.exception("[/detect] fetch_image raised for %s", image_url)
        return

    ext = "." + image_url.split(".")[-1].split("?")[0]
    if ext not in (".jpg", ".jpeg", ".png", ".webp"):
        ext = ".jpg"

    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
        tmp.write(resp.content)
        tmp_path = tmp.name
    t = _phase("fetch_image", t)

    try:
        # 2. Downscale (defense in depth — browser already does this for the
        #    happy path, but raw API callers might ship 4000x3000 images).
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

        # 3. Inference
        detections = run_inference(tmp_path, model_path)
        t = _phase("inference", t)

        # Diagnostic — surface what the model actually produced before we
        # filter. If we keep seeing n_det=0 in TOTAL even after dropping
        # DETECT_CONF, the model itself isn't firing on this image.
        if detections:
            top = max(d.get("confidence", 0) for d in detections)
            classes = ", ".join(sorted(set(d["class"] for d in detections)))
            log.info("[/detect] raw_yolo: n=%d top_conf=%.2f classes=%s",
                     len(detections), top, classes)
        else:
            log.info("[/detect] raw_yolo: n=0  (model emitted no detections)")

        # 4. Association (PPE) + inventory + compliance
        ppe_violations     = check_ppe_violations(detections)
        inventory          = summarize_inventory(detections)
        compliance_summary = summarize_compliance(detections, ppe_violations)
        t = _phase("associate", t)

        zones              = get_zones(camera_id)
        t = _phase("get_zones", t)
        zone_violations    = check_violations(detections, zones)

        # 5. Confidence gate before persist — detection_logs must only ever
        #    contain entries the dashboard would render.
        detections      = _filter_min_conf(detections)
        ppe_violations  = _filter_min_conf(ppe_violations)
        zone_violations = _filter_min_conf(zone_violations)

        # 6. Persist
        save_detection_log(
            camera_id, image_url,
            detections, ppe_violations, zone_violations, inventory,
            compliance_summary=compliance_summary,
        )
        t = _phase("persist", t)

        log.info("[/detect] TOTAL          %6.2fs  (n_det=%d)",
                 sum(timings.values()), len(detections))
    except Exception:
        log.exception("[/detect] pipeline failed for %s", image_url)
    finally:
        try:
            os.unlink(tmp_path)
        except FileNotFoundError:
            pass


@app.post("/detect")
async def detect(req: DetectRequest, background: BackgroundTasks):
    """
    Mock mode: returns the fixture synchronously (200) so demos stay snappy.

    Real mode: schedules `_run_pipeline_sync` as a background task and
    returns 202 immediately with the image_url. The dashboard polls
    /api/logs?image_url=... until the row materialises. This pattern
    bypasses Vercel's 60s function ceiling, which the previous synchronous
    shape exceeded on Render free tier (~80-100s per inference).
    """
    if MOCK_MODE:
        if not MOCK_PATH.exists():
            raise HTTPException(status_code=500, detail=f"Mock fixture missing: {MOCK_PATH}")
        with open(MOCK_PATH) as f:
            return json.load(f)

    background.add_task(_run_pipeline_sync, req.image_url, req.camera_id, req.model_path)
    return JSONResponse(
        {"status": "queued", "image_url": req.image_url, "camera_id": req.camera_id},
        status_code=202,
    )


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
