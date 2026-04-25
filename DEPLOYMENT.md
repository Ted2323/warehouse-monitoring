# Deployment

Three pieces, all on free tiers, total ongoing cost $0:

| Component | Host | What lives there |
|---|---|---|
| Frontend (Next.js + auth gate) | **Vercel** | `frontend/` |
| Inference service (FastAPI + YOLOv8) | **Render** (Docker, free) | `ml/Dockerfile` |
| Database, auth, model storage | **Supabase** | `database/schema.sql` + Storage bucket |

`DETECTION_SERVICE_TOKEN` is the shared bearer that gates Vercel→Render
calls. It must be **identical** in both projects, or every `/detect` request
401s.

---

## 1 — Required env vars

Copy these into the respective dashboards (never into git).

### Vercel project (frontend)
| Variable | Value | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<ref>.supabase.co` | from Supabase → Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `sb_publishable_…` | same place |
| `SUPABASE_SERVICE_ROLE_KEY` | `sb_secret_…` | same place — **server-only**, never `NEXT_PUBLIC_` |
| `DETECTION_SERVICE_URL` | `https://warehouse-detection.onrender.com` | the Render service URL after first deploy |
| `DETECTION_SERVICE_TOKEN` | random 32+ char string | same value as Render |

### Render service (`warehouse-detection`)
| Variable | Value | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<ref>.supabase.co` | needed for the model download |
| `SUPABASE_SERVICE_ROLE_KEY` | `sb_secret_…` | reads `models/best.pt` from Storage |
| `DETECTION_SERVICE_TOKEN` | (same value as Vercel) | |
| `MOCK_MODE` | `true` initially → `false` after model upload | declared in `render.yaml` |
| `MODEL_BUCKET` | `models` | declared in `render.yaml` |
| `MODEL_OBJECT` | `best.pt` | declared in `render.yaml` |

`MOCK_MODE`, `MODEL_BUCKET`, `MODEL_OBJECT` come from `render.yaml` defaults
on first sync; the three secrets must be filled in via the Render dashboard
(`sync: false` keeps them out of the YAML).

---

## 2 — First-time deploy

### Vercel
1. **Import Git Repository** → pick this repo.
2. **Root Directory** → `frontend`.
3. Framework preset auto-detects Next.js; leave the build command at default.
4. Add the env vars from the Vercel table above.
5. Deploy. The first build will fail-fast if `DETECTION_SERVICE_TOKEN` is
   missing on a `/api/detect` call — that's expected; it just means the
   frontend is live and waiting on the backend.

### Render
1. **New → Blueprint** → point at this repo. Render reads `render.yaml`.
2. Confirm the service name (`warehouse-detection`) and free plan.
3. Fill in the three `sync: false` secrets in the Render dashboard.
4. Apply. The first build pulls `python:3.11-slim`, installs deps, and
   starts uvicorn. With `MOCK_MODE=true` the startup hook skips the model
   download and serves `ml/fixtures/mock_detection.json` from `/detect`.
5. Copy the assigned URL (e.g. `https://warehouse-detection.onrender.com`)
   and paste it into Vercel's `DETECTION_SERVICE_URL`.

### Supabase
1. SQL Editor → run `database/schema.sql` once on the project.
2. **Storage → New bucket** named `models`. Private (default). This is where
   `best.pt` will live once training is done.
3. **Auth → Users → Add user** to create your first admin. Then in SQL:
   ```sql
   INSERT INTO app_users (id, email, role)
   SELECT id, email, 'admin' FROM auth.users WHERE email = 'you@example.com';
   ```
4. **Auth → URL Configuration** — see step 4 below.

### 4 — Allow the Vercel domain in Supabase Auth
Once Vercel has assigned a URL (e.g. `warehouse-monitor.vercel.app`):

1. Supabase → **Authentication → URL Configuration**.
2. **Site URL** → `https://warehouse-monitor.vercel.app`.
3. **Redirect URLs** → add the same URL plus any preview-deployment domains
   you want to allow (`https://*.vercel.app` covers all previews; only
   enable that if previews don't get prod data).

Without this step, Supabase blocks the OAuth/redirect handshake and
`signInWithPassword` returns a 400.

---

## 3 — Uploading `best.pt` after training

Section 2 of the brief produces `ml/best.pt` locally. Push it to the
`models` bucket — the inference service downloads it on next start.

### From the Supabase dashboard
**Storage → models → Upload file** → select `ml/best.pt` → confirm the
object key is exactly `best.pt`.

### From the CLI (Supabase JS / curl)
```bash
# curl — replace <ref> and <SERVICE_ROLE_KEY>
curl -X POST \
  "https://<ref>.supabase.co/storage/v1/object/models/best.pt" \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @ml/best.pt
```

Verify it landed:
```bash
curl -I \
  "https://<ref>.supabase.co/storage/v1/object/models/best.pt" \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>"
# expect HTTP/2 200
```

---

## 4 — Flipping `MOCK_MODE` to `false`

Once `best.pt` is in the bucket:

1. Render → service `warehouse-detection` → **Environment** → change
   `MOCK_MODE` from `true` to `false`. Save.
2. Render redeploys. On startup, `ml/server.py:ensure_model_available()`
   sees `MOCK_MODE=false`, sees no local `/app/ml/best.pt`, and downloads
   from `models/best.pt` using the service role key.
3. Watch the deploy logs for:
   ```
   Downloading model from Supabase Storage: models/best.pt
   Model written to /app/ml/best.pt (XX.X MB)
   ```
4. Sanity check:
   ```bash
   curl https://warehouse-detection.onrender.com/health
   # → {"status":"ok","model_path":"/app/ml/best.pt","model_present":true,"mock_mode":false}
   ```

If the download fails (bad bucket name, missing object, expired key) the
service raises on startup and Render reports the container as unhealthy —
intentional, so we don't quietly serve broken inference.

To roll back: set `MOCK_MODE=true` again and redeploy. Mock fixture comes
back, no model required.

---

## 5 — Continuous deploys

Pushing to `main` triggers both:
- **Vercel** rebuilds the frontend automatically.
- **Render** rebuilds the Docker image because `render.yaml` is in the
  repo and the Blueprint is wired to this branch.

Model updates are decoupled from code — re-uploading `best.pt` to Storage
takes effect on the next Render restart (or after a manual "Redeploy").

---

## 6 — Don'ts

- **Don't** bake `best.pt` into the image (`.dockerignore` excludes `*.pt`).
- **Don't** commit any secret. `.gitignore` covers `.env`, `.env.local`,
  `.env.*.local`, `**/*.pt`, `**/*.onnx`.
- **Don't** point Vercel preview deploys at prod Supabase without thinking
  — preview URLs can leak. For a real customer, give previews their own
  Supabase project. (Demo: fine.)
- **Don't** set Render's health check timeout below 30s. Free-tier cold
  starts take 30–60s; an aggressive check restart-loops the service.
- **Don't** mismatch `DETECTION_SERVICE_TOKEN` across Vercel and Render —
  the frontend will look fine but every detection request will 401.

---

## 7 — Verification checklist

After both services are live and `MOCK_MODE=true`:

1. `curl https://warehouse-detection.onrender.com/health` →
   `{"status":"ok",…,"mock_mode":true}`.
2. Visit your Vercel URL in incognito → 307 redirect to `/login`.
3. Sign in with the admin user → land on `/dashboard`.
4. Drop any image into the upload zone → mock detection appears in the
   "Safety Violations" feed within ~1s.
5. Click "Sign out" → back to `/login`. Manually visiting `/dashboard`
   redirects to `/login` again.

After flipping `MOCK_MODE=false` and uploading the model, repeat step 4 —
the detection should now reflect actual classes from the uploaded image.
