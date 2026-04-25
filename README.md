# Warehouse Monitor — PPE + Asset Status

YOLOv8-powered detection for warehouse PPE compliance and asset status —
upload an image or video, get a timestamped audit log of safety violations,
pallet inventory, and forklift utilization.

**Stack:** Python · FastAPI · YOLOv8 · Supabase · Next.js 14

---

## How It Works

```
Upload image / video
        ↓
Frames extracted (video: every 2s via canvas)
        ↓
YOLOv8 detects 8 classes (see ml/classes.py):
  worker_with_helmet · worker_no_helmet
  worker_with_reflective · worker_no_reflective_vest
  pallet_filled · pallet_empty
  forklift_with_boxes · forklift_no_carry
        ↓
Classification-driven PPE violations (primary)
+ optional zone overlap (secondary)
        ↓
Violations + inventory snapshot logged to Supabase
        ↓
Dashboard — KPIs, Safety Violations feed, audit history
```

---

## Project Structure

```
warehouse-monitor/
├── data/
│   └── download_dataset.py       # Download labeled dataset from Roboflow
│
├── ml/
│   ├── detect.py                 # YOLOv8 inference + zone violation engine
│   ├── train.py                  # Model training pipeline
│   ├── server.py                 # FastAPI service wrapping detect.py
│   └── requirements.txt          # Python dependencies
│
├── database/
│   └── schema.sql                # Supabase tables: cameras · zones · detection_logs
│
└── frontend/                     # Next.js 14 app
    ├── app/
    │   ├── dashboard/page.tsx    # Main UI — upload + audit log
    │   ├── api/detect/route.ts   # POST /api/detect
    │   └── api/logs/route.ts     # GET  /api/logs
    └── .env.local.example
```

---

## Setup

### 1 — Supabase

1. Create a project at [supabase.com](https://supabase.com)
2. Open **SQL Editor** → paste `database/schema.sql` → Run
3. Go to **Storage** → create a bucket named `warehouse-images` (public)
4. Copy your credentials from **Settings → API**

### 2 — Frontend

```bash
cd frontend
cp .env.local.example .env.local   # fill in Supabase credentials
npm install
npm run dev                         # http://localhost:3000
```

**Environment variables** (`frontend/.env.local`):

| Variable | Where |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API |
| `DETECTION_SERVICE_URL` | Optional — URL of the FastAPI service |

Without `DETECTION_SERVICE_URL` the app runs in **demo mode** with mock detections — no GPU required.

### 3 — ML Service (optional, for real inference)

**Train the model first:**

```bash
# Download dataset (needs Roboflow API key)
cd data
ROBOFLOW_API_KEY=your_key python download_dataset.py

# Train (GPU recommended — use Google Colab or Kaggle for free GPU)
cd ../ml
pip install -r requirements.txt
python train.py
# Produces ml/runs/warehouse_monitor/weights/best.pt
# Automatically copied to ml/best.pt
```

**Run the detection service:**

```bash
cd ml
uvicorn server:app --host 0.0.0.0 --port 8000
```

Then set `DETECTION_SERVICE_URL=http://localhost:8000` in `frontend/.env.local`.

---

## Zone Rules (secondary signal)

PPE violations are now classification-driven — any detection of
`worker_no_helmet` or `worker_no_reflective_vest` is a violation on its own,
no zone required. Zones are kept as an *optional* secondary signal: a worker
without a vest who is *also* in a high-risk zone can be surfaced with higher
severity. `object_class` must be one of the 8 names from `ml/classes.py`.

| Zone | Object | Rule | Alert |
|---|---|---|---|
| Forklift Lane A | forklift_with_boxes | ALLOWED | info |
| Forklift Lane A | worker_no_helmet | RESTRICTED | danger |

Edit zones in the `warehouse_zones` Supabase table.

---

## Audit Log

Every processed frame appears as a row in the audit log:

- **Timestamp** — when the frame was analyzed
- **Source** — filename or `video.mp4 — frame 4.0s`
- **Object count** — total detections in that frame
- **Violations** — count + zone names, expandable
- **Alert badge** — DANGER / WARNING / INFO / CLEAR

Click any row to see that frame's bounding box overlay on the left.
Use the **CSV** button to export the full log.

---

## Deploy to Vercel

```bash
cd frontend
npx vercel
```

Add the same environment variables in the Vercel dashboard under **Settings → Environment Variables**.
