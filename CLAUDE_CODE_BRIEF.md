# Brief for Claude Code — Pivot to PPE + Asset-Status Detection

## Context

The detection model is being retrained on a new class set. The old project assumed three generic classes (`person`, `forklift`, `box`) and used drawn-polygon zones to flag violations (e.g. a `person` inside a `RESTRICTED` forklift lane). That zone-driven design is no longer the primary signal.

The new model emits 8 classes that already encode the safety state directly:

| id | class                       | meaning                            |
|----|-----------------------------|------------------------------------|
| 0  | `worker_with_helmet`        | compliant worker (head PPE)        |
| 1  | `worker_no_helmet`          | **PPE violation** — missing helmet |
| 2  | `worker_with_reflective`    | compliant worker (vest)            |
| 3  | `worker_no_reflective_vest` | **PPE violation** — missing vest   |
| 4  | `pallet_filled`             | inventory state                    |
| 5  | `pallet_empty`              | inventory state                    |
| 6  | `forklift_with_boxes`       | forklift carrying load             |
| 7  | `forklift_no_carry`         | forklift idle/empty                |

The model is **not finished training yet** — keep the new pipeline runnable against mock detections so the dashboard can be developed in parallel.

## Conceptual change

- Violations are now **classification-driven**, not zone-driven. Any detection of `worker_no_helmet` or `worker_no_reflective_vest` is a violation on its own — no polygon required.
- Pallet and forklift sub-classes are **state/telemetry**, not violations. They feed inventory + utilization counters.
- Keep the zone tables in place but treat zone violations as an **optional secondary signal** (e.g. flag a worker without a vest who is *also* inside a high-risk zone as a higher-severity event).

---

## Files to change

### 1. `ml/classes.py` (NEW — single source of truth)

Create this file. Every other module should import from it. Do not hardcode class strings anywhere else.

```python
CLASS_NAMES = [
    "worker_with_helmet",
    "worker_no_helmet",
    "worker_with_reflective",
    "worker_no_reflective_vest",
    "pallet_filled",
    "pallet_empty",
    "forklift_with_boxes",
    "forklift_no_carry",
]

PPE_VIOLATION_CLASSES = {"worker_no_helmet", "worker_no_reflective_vest"}
WORKER_CLASSES        = {"worker_with_helmet", "worker_no_helmet",
                         "worker_with_reflective", "worker_no_reflective_vest"}
PALLET_CLASSES        = {"pallet_filled", "pallet_empty"}
FORKLIFT_CLASSES      = {"forklift_with_boxes", "forklift_no_carry"}

VIOLATION_SEVERITY = {
    "worker_no_helmet":          "danger",
    "worker_no_reflective_vest": "warning",
}
```

### 2. `ml/detect.py`

- Import from `ml.classes`. Remove any inline references to `"person"`, `"forklift"`, `"box"`.
- Add `check_ppe_violations(detections) -> list` — returns one violation dict per detection whose `class` is in `PPE_VIOLATION_CLASSES`. Shape:
  ```python
  {"class": ..., "bbox": ..., "confidence": ..., "alert_level": VIOLATION_SEVERITY[class]}
  ```
- Add `summarize_inventory(detections) -> dict`:
  ```python
  {
      "pallets_filled":     int,
      "pallets_empty":      int,
      "forklifts_carrying": int,
      "forklifts_idle":     int,
      "workers_total":      int,
      "workers_compliant":  int,   # has helmet AND vest (heuristic — see note)
  }
  ```
  Note: model emits per-attribute classes, so `workers_compliant` cannot be computed exactly from class counts alone (a single worker can be detected as both `worker_with_helmet` and `worker_with_reflective`). For the first pass, approximate as `min(with_helmet, with_reflective)` and leave a `# TODO: associate per-worker` comment. We'll improve this once we have a tracker.
- Keep `check_violations` (zone logic) but it should now match against the new class set and only fire if zones with those `object_class` values exist. It returns `zone_violations` separately.
- `analyze_image` should return:
  ```python
  {
      "detections":      [...],
      "ppe_violations":  [...],
      "zone_violations": [...],
      "inventory":       { ... summarize_inventory ... },
      "total_objects":   int,
      "total_violations": len(ppe_violations) + len(zone_violations),
  }
  ```
- `save_detection_log` should write `ppe_violations + zone_violations` into the existing `detection_logs.violations` JSONB and store `inventory` in a new column (see schema change below).

### 3. `ml/server.py`

- Update the `/detect` response to include `ppe_violations`, `zone_violations`, `inventory`. Additive only — don't remove keys until the frontend consumer is updated in the same change.

### 4. `ml/train.py`

- No code change required, but:
  - Bump `CONFIG["name"]` to `warehouse_monitor_v2` so old runs aren't clobbered.
  - Add a comment that the new `data.yaml` declares `nc: 8` and the names must match `ml/classes.py:CLASS_NAMES` exactly (order matters — class IDs come from the YAML).

### 5. `data/download_dataset.py`

- Update the docstring + the Roboflow project/version to point at the new dataset (the user will supply the workspace + project slug — leave a clearly marked TODO if not provided).
- Update the print line that says `Classes: boxes, forklifts, persons`.

### 6. `database/schema.sql`

This file gets two sets of changes — the class migration **and** the auth setup from section 9. Apply them together so we don't run two migrations against Supabase.

**Class-migration changes:**

- Drop the old seed data for `warehouse_zones` (the old `object_class` values no longer exist).
- Add a column to `detection_logs`:
  ```sql
  ALTER TABLE detection_logs
      ADD COLUMN inventory JSONB DEFAULT '{}'::jsonb;
  ```
- Add a `ppe_violations` view for fast dashboard queries:
  ```sql
  CREATE OR REPLACE VIEW ppe_violation_events AS
  SELECT
      l.id            AS log_id,
      l.camera_id,
      l.detected_at,
      l.image_url,
      v->>'class'      AS violation_class,
      (v->>'confidence')::float AS confidence,
      v->'bbox'        AS bbox
  FROM detection_logs l,
       jsonb_array_elements(l.violations) v
  WHERE v->>'class' IN ('worker_no_helmet','worker_no_reflective_vest');
  ```
- Update the seed `warehouse_zones` rows to use the new class strings if any zones are still wanted (e.g. an `ALLOWED` zone for `forklift_with_boxes`, a `RESTRICTED` zone for any `worker_*` class in a forklift lane). Keep the seed minimal — one camera, one or two zones — so the migration is easy to reason about.

**Auth changes (from section 9 — apply in the same file):**

- Add the `app_users` table:
  ```sql
  CREATE TABLE IF NOT EXISTS app_users (
      id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
      email       TEXT UNIQUE NOT NULL,
      role        TEXT NOT NULL DEFAULT 'viewer'
                  CHECK (role IN ('admin','viewer')),
      created_at  TIMESTAMPTZ DEFAULT NOW()
  );
  ```
- Enable RLS and add policies for `detection_logs`, `warehouse_zones`, `cameras`:
  ```sql
  ALTER TABLE detection_logs   ENABLE ROW LEVEL SECURITY;
  ALTER TABLE warehouse_zones  ENABLE ROW LEVEL SECURITY;
  ALTER TABLE cameras          ENABLE ROW LEVEL SECURITY;

  CREATE POLICY "authenticated read logs" ON detection_logs
      FOR SELECT USING (auth.role() = 'authenticated');

  CREATE POLICY "authenticated read zones" ON warehouse_zones
      FOR SELECT USING (auth.role() = 'authenticated');
  CREATE POLICY "admin write zones" ON warehouse_zones
      FOR ALL USING (
          EXISTS (SELECT 1 FROM app_users
                  WHERE id = auth.uid() AND role = 'admin')
      );

  CREATE POLICY "authenticated read cameras" ON cameras
      FOR SELECT USING (auth.role() = 'authenticated');
  CREATE POLICY "admin write cameras" ON cameras
      FOR ALL USING (
          EXISTS (SELECT 1 FROM app_users
                  WHERE id = auth.uid() AND role = 'admin')
      );
  ```
- The FastAPI service writes to `detection_logs` using the `SUPABASE_SERVICE_ROLE_KEY`, which bypasses RLS — that's fine and intentional. No insert policy needed for service-role writes.
- Seed the first admin user via the Supabase dashboard (Auth → Users → Add user), then in SQL:
  ```sql
  INSERT INTO app_users (id, email, role)
  SELECT id, email, 'admin'
  FROM auth.users
  WHERE email = '<your-admin-email>'
  ON CONFLICT (id) DO NOTHING;
  ```
  Leave `<your-admin-email>` as a placeholder with a clear `-- TODO` comment — don't hardcode an email.

### 7. `frontend/` (dashboard)

- Add `frontend/lib/classes.ts` mirroring `ml/classes.py` (same class list, same severity map). Centralize.
- Update the detection legend / overlay colors:
  - `worker_with_helmet`, `worker_with_reflective` → green
  - `worker_no_helmet`, `worker_no_reflective_vest` → red
  - `pallet_filled` → blue, `pallet_empty` → gray
  - `forklift_with_boxes` → orange, `forklift_no_carry` → yellow
- Replace the existing zone-violation feed with a **Safety Violations** feed sourced from the new `ppe_violation_events` view. Show class, camera, timestamp, image thumbnail.
- Add three KPI cards near the top:
  - PPE violations (last 24h)
  - Pallets filled / empty
  - Forklifts carrying / idle
- Keep the zone editor — it's still useful for future overlays — but mark it secondary in the nav.

### 8. Mock fixture for parallel frontend dev

The model isn't ready. Add `ml/fixtures/mock_detection.json` that returns a realistic response with the new shape (a couple of workers — one compliant, one missing a helmet — a filled and empty pallet, one loaded forklift). Add a `--mock` flag to `ml/server.py` that returns this fixture instead of running inference, so the dashboard can be wired up before `best.pt` lands.

---

## What NOT to do

- **Don't delete `warehouse_zones`** — we still want zone overlays as a secondary signal, and the dashboard's zone editor depends on it.
- **Don't hardcode the 8 class strings in more than one place.** They go in `ml/classes.py` and `frontend/lib/classes.ts`, nowhere else.
- **Don't break the existing `/detect` response shape** — extend it. The frontend consumer needs to be updated in the same PR.
- **Don't wait for `best.pt` to land** before doing the dashboard work. Use the mock fixture.
- **Don't infer per-worker compliance from class counts as if it's exact** — leave the TODO comment so we remember to plug in a tracker later.

---

## 9. Simple username + password login (NEW — independent of the class migration)

Add a basic auth gate so the dashboard isn't open to anyone who knows the URL. Keep it simple — this is an internal tool, not a public product. Do this work **after** sections 1–8, or in parallel by another pass; it should not block the class migration.

### Approach

Use **Supabase Auth with email + password** (we already have a Supabase project, so no new infra). If Supabase Auth feels heavyweight, fall back to a single shared password held in an env var with an HMAC-signed cookie — but prefer Supabase Auth so we get per-user audit trails on detection events later.

### Backend / DB

- Enable Email provider in the Supabase dashboard (Settings → Auth → Providers). Disable signup — admins create users manually for now.
- All schema changes for auth (the `app_users` table, RLS, policies, admin seed) live in `database/schema.sql` alongside the class-migration changes — see **section 6** for the exact SQL. Apply once, in one migration.
- Create the first admin user via the Supabase dashboard (Auth → Users → Add user) before running the `INSERT INTO app_users ...` statement from section 6.

### Frontend (`frontend/`)

- Install `@supabase/auth-helpers-nextjs` and `@supabase/supabase-js` if not already present.
- Create `frontend/lib/supabase.ts` exporting a browser client and a server client (auth-helpers handles the cookie wiring).
- Add `frontend/app/login/page.tsx`:
  - Email + password fields, a submit button, basic error display.
  - On submit: `supabase.auth.signInWithPassword({ email, password })`. On success, redirect to `/dashboard`.
  - No "sign up" link. No "forgot password" yet (admins reset via the Supabase dashboard).
- Add `frontend/middleware.ts`:
  ```ts
  import { createMiddlewareClient } from "@supabase/auth-helpers-nextjs";
  import { NextResponse } from "next/server";
  import type { NextRequest } from "next/server";

  export async function middleware(req: NextRequest) {
    const res = NextResponse.next();
    const supabase = createMiddlewareClient({ req, res });
    const { data: { session } } = await supabase.auth.getSession();

    const isAuthRoute = req.nextUrl.pathname.startsWith("/login");
    if (!session && !isAuthRoute) {
      return NextResponse.redirect(new URL("/login", req.url));
    }
    if (session && isAuthRoute) {
      return NextResponse.redirect(new URL("/dashboard", req.url));
    }
    return res;
  }

  export const config = {
    matcher: ["/((?!_next/static|_next/image|favicon.ico|api/public).*)"],
  };
  ```
- Add a small "Logout" button in the dashboard header → `supabase.auth.signOut()` then push to `/login`.
- The existing `app/page.tsx` redirect to `/dashboard` is fine — middleware will bounce unauthenticated users to `/login` first.

### Backend service (`ml/server.py`)

- The FastAPI service is called server-to-server from the Next.js API routes, not from the browser. Don't add user-level auth to it. Instead, require a shared bearer token:
  ```python
  SERVICE_TOKEN = os.environ["DETECTION_SERVICE_TOKEN"]

  @app.middleware("http")
  async def require_token(request, call_next):
      if request.url.path == "/health":
          return await call_next(request)
      if request.headers.get("authorization") != f"Bearer {SERVICE_TOKEN}":
          return JSONResponse({"detail": "unauthorized"}, status_code=401)
      return await call_next(request)
  ```
- The Next.js API route adds the header when calling `/detect`. Token lives in `.env` only.

### Env vars to add

- `NEXT_PUBLIC_SUPABASE_URL` (already present)
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` (already present, used by browser client)
- `SUPABASE_SERVICE_ROLE_KEY` (already present, server-only)
- `DETECTION_SERVICE_TOKEN` — random 32+ char string, shared by Next.js and the FastAPI service

### What NOT to do

- **Don't roll your own password hashing.** Use Supabase Auth. If for some reason that's off the table, raise it — don't reach for `bcrypt` and a custom users table without a conversation.
- **Don't enable public signup.** Admins create users.
- **Don't gate the FastAPI service with user JWTs** — it's a backend microservice. Bearer token is enough.
- **Don't put `SUPABASE_SERVICE_ROLE_KEY` anywhere a browser can see it.** Server-only.

### Definition of done (auth)

- Visiting `/dashboard` while logged out redirects to `/login`.
- Logging in with the seeded admin user lands on `/dashboard`.
- Logging out returns to `/login` and `/dashboard` is no longer accessible.
- RLS is on for `detection_logs`, `warehouse_zones`, `cameras`, and an unauthenticated request to those tables returns zero rows.
- The FastAPI `/detect` endpoint returns 401 without the bearer token and works with it.

---

## Definition of done

- `ml/classes.py` and `frontend/lib/classes.ts` exist and are the only places class strings live.
- `database/schema.sql` runs cleanly on a fresh Supabase instance, including the `inventory` column and `ppe_violation_events` view.
- `python ml/detect.py --image samples/x.jpg --camera_id <uuid>` returns the new response shape (use the mock fixture if `best.pt` isn't present).
- `uvicorn ml.server:app` with `--mock` returns the fixture; without `--mock` it runs real inference.
- Dashboard renders the three KPI cards + Safety Violations feed against the mock data.
- Old `person` / `forklift` / `box` strings are gone from the codebase (`grep` clean).

---

## 10. UI redesign — Claude theme (NEW, presentational only)

Restyle the existing UI to match the warm, paper-like aesthetic of Anthropic's Claude products. This is a **presentational** pass — do not change auth flow, data fetching, RLS, or component logic. Move colors out of components and into design tokens, swap fonts, tighten spacing.

### Design tokens

Add CSS variables to `frontend/app/globals.css` under `:root` (light) and `.dark` (dark mode). These are the only color values allowed in the codebase — no raw hex in component files.

**Light mode (primary — this is the Claude look):**

```css
:root {
  /* Surfaces */
  --bg:           #F0EEE6;  /* page — warm cream/paper */
  --bg-elevated:  #FAF9F5;  /* cards, modals */
  --bg-sunken:    #E8E6DD;  /* inputs, table rows */

  /* Text */
  --fg:           #1F1E1D;  /* primary text — warm near-black */
  --fg-muted:     #5A5651;  /* secondary text */
  --fg-subtle:    #8C8779;  /* captions, placeholders */

  /* Lines */
  --border:       #D9D6CB;
  --border-strong:#BFBBAE;

  /* Accent — Claude coral */
  --accent:       #C15F3C;
  --accent-hover: #A94F2F;
  --accent-fg:    #FFFFFF;

  /* Semantic — muted, earthy, not neon */
  --success:      #3F7D58;
  --warning:      #B07F2A;
  --danger:       #A93B2C;
}
```

**Dark mode:**

```css
.dark {
  --bg:           #262624;
  --bg-elevated:  #30302D;
  --bg-sunken:    #1F1E1D;

  --fg:           #F0EEE6;
  --fg-muted:     #A8A39A;
  --fg-subtle:    #6E6A62;

  --border:       #3A3935;
  --border-strong:#52504B;

  --accent:       #D87C5B;
  --accent-hover: #E08F70;
  --accent-fg:    #1F1E1D;

  --success:      #5DA078;
  --warning:      #D1A24A;
  --danger:       #C8584A;
}
```

### Tailwind wiring

Update `tailwind.config.ts` to reference the variables:

```ts
theme: {
  extend: {
    colors: {
      bg:      { DEFAULT: 'var(--bg)', elevated: 'var(--bg-elevated)', sunken: 'var(--bg-sunken)' },
      fg:      { DEFAULT: 'var(--fg)', muted: 'var(--fg-muted)', subtle: 'var(--fg-subtle)' },
      border:  { DEFAULT: 'var(--border)', strong: 'var(--border-strong)' },
      accent:  { DEFAULT: 'var(--accent)', hover: 'var(--accent-hover)', fg: 'var(--accent-fg)' },
      success: 'var(--success)',
      warning: 'var(--warning)',
      danger:  'var(--danger)',
    },
    fontFamily: {
      serif: ['"Source Serif 4"', 'Georgia', 'serif'],
      sans:  ['Inter', 'system-ui', 'sans-serif'],
      mono:  ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
    },
    borderRadius: {
      DEFAULT: '6px',
      lg: '10px',
    },
  },
},
darkMode: 'class',
```

### Typography

- Load **Source Serif 4** and **Inter** via `next/font/google` in `app/layout.tsx`. Both are free, good Tiempos/Styrene substitutes.
- Headings, KPI numbers, brand wordmark → `font-serif`.
- Body, buttons, inputs, table content → `font-sans`.
- Timestamps, IDs, bbox coords → `font-mono`, slightly smaller, `text-fg-muted`.

### Component primitives

Create reusable wrappers in `frontend/components/`:

- **`<Card>`** — `bg-bg-elevated border border-border rounded p-6`. No drop shadow.
- **`<Button variant="primary|secondary|ghost|danger">`** — primary = `bg-accent text-accent-fg hover:bg-accent-hover`; secondary = `bg-transparent border border-border-strong text-fg hover:bg-bg-sunken`; ghost = `hover:bg-bg-sunken`; danger = `bg-danger text-white`. All `rounded px-4 py-2 font-medium`.
- **`<Input>`** — `bg-bg-sunken border border-border rounded px-3 py-2 focus:border-accent focus:ring-2 focus:ring-accent/20 outline-none`.
- **`<Chip variant="success|warning|danger|neutral">`** — `rounded-full text-xs px-2 py-0.5 font-medium`. Use for PPE class labels in the feed.
- **`<StatDot>`** — 8px dot (active = success, idle = subtle).

### Page guidance (light touch — keep existing layout, just restyle)

- **Login:** centered card max-w-sm, brand wordmark in serif at top, two `<Input>` fields, primary `<Button>` "Sign in," small `text-fg-subtle` line below. Page bg = `bg`, card = `bg-elevated`.
- **Dashboard header:** wordmark left, user email + dark-mode toggle + sign-out right. Border-bottom only, no shadow. `py-4 px-8`.
- **Dashboard body:** keep existing layout. KPI numbers in `font-serif text-4xl`, labels above in `text-xs uppercase tracking-wider text-fg-muted`.
- **Violations feed:** rows separated by `border-b border-border`, no zebra striping. Thumbnail 96×72, `<Chip variant="danger">`, camera name, mono timestamp, "view" ghost button.

### Dark mode toggle

`Sun`/`Moon` icon from `lucide-react` in the header. Persist in a **cookie** (not localStorage). Inline `<script>` in `layout.tsx` reads the cookie before hydration to prevent flash-of-wrong-theme.

### Don'ts

- **No neon colors.** No electric blue, bright purple, Slack-yellow. Muted and earthy. If it looks "techy," it's wrong.
- **No heavy drop shadows.** 1px borders carry structure. `shadow-sm` only on hovered interactive cards.
- **No pill / fully-rounded buttons.** `rounded` (6px) only.
- **No gradients** anywhere — except possibly a very subtle cream→deeper-cream on the login bg.
- **No new fonts.** Serif + sans + mono. Three fonts total.
- **Don't change component logic while restyling.** Bugs found go on a TODO list, not into this PR.
- **No hex literals in JSX/TSX.** Every color through a Tailwind class. `grep -rE "#[0-9A-Fa-f]{6}" frontend/app frontend/components` should be empty after this pass.

### Definition of done (UI)

- `globals.css` has the full token set under `:root` and `.dark`.
- `tailwind.config.ts` references tokens; `bg-bg`, `text-fg`, `border-border`, `bg-accent` etc. all work.
- Source Serif 4 and Inter load via `next/font/google`. No FOUT.
- The five primitives exist in `frontend/components/` and are used by login + dashboard.
- Dark mode toggle works, persists via cookie, no flash on reload.
- `grep -rE "#[0-9A-Fa-f]{6}" frontend/app frontend/components` returns nothing.
- Auth flow, data fetching, RLS behavior unchanged from before this section.

---

## 11. Deployment — demo target (NEW)

Ship a working demo that anyone with a link can log into. Stack: **Vercel** (frontend) + **Render** free tier (FastAPI inference service) + existing **Supabase**. CPU-only, cold starts are acceptable, total cost $0 on free tiers.

### What Claude Code needs to add

**`ml/Dockerfile`** — Python 3.11-slim base, install from `requirements.txt`, copy source, run uvicorn:

```dockerfile
FROM python:3.11-slim

WORKDIR /app
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
```

**`ml/.dockerignore`** — exclude `__pycache__`, `.venv`, `*.pt` (model is downloaded at runtime, not baked in), `runs/`, `.pytest_cache`.

**`render.yaml`** at repo root — declarative Render service:

```yaml
services:
  - type: web
    name: warehouse-detection
    runtime: docker
    dockerfilePath: ./ml/Dockerfile
    plan: free
    healthCheckPath: /health
    envVars:
      - key: NEXT_PUBLIC_SUPABASE_URL
        sync: false
      - key: SUPABASE_SERVICE_ROLE_KEY
        sync: false
      - key: DETECTION_SERVICE_TOKEN
        sync: false
      - key: MOCK_MODE
        value: "true"   # use mock fixture until best.pt is uploaded
      - key: MODEL_BUCKET
        value: "models"
      - key: MODEL_OBJECT
        value: "best.pt"
```

**`ml/server.py` startup hook** — on `@app.on_event("startup")`, if `MOCK_MODE != "true"` and `MODEL_PATH` doesn't exist locally, download `best.pt` from Supabase Storage (`MODEL_BUCKET` / `MODEL_OBJECT`) using the service role key. If `MOCK_MODE == "true"`, skip the download and serve from `ml/fixtures/mock_detection.json` (already in the brief from section 2). Fail loudly if neither is available.

**`frontend/vercel.json`** — only needed if Vercel doesn't autodetect the Next.js project. Probably skip; Vercel handles `frontend/` as the root via project settings.

**`DEPLOYMENT.md`** at repo root — short runbook covering:
- Required env vars for each service.
- How to upload `best.pt` to Supabase Storage when training finishes (`models/best.pt` in the bucket).
- How to flip `MOCK_MODE` from `true` to `false` once the real model is in place.
- The Supabase Auth → URL Configuration step for adding the Vercel domain to allowed redirects.

### Required env vars (for the deploy step itself, not code)

- **Vercel project:** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DETECTION_SERVICE_TOKEN`, `DETECTION_SERVICE_URL` (= the Render URL).
- **Render service:** `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DETECTION_SERVICE_TOKEN` (same value as Vercel — that's the shared secret), `MOCK_MODE`, `MODEL_BUCKET`, `MODEL_OBJECT`.

`DETECTION_SERVICE_TOKEN` must be **identical** in both projects, or the Next.js → FastAPI bearer check fails.

### Don'ts

- **Don't bake `best.pt` into the Docker image.** The image needs to redeploy when only code changes; the model needs to update without rebuilding. Download at startup from Supabase Storage.
- **Don't commit any secrets to git.** All four env vars stay in Vercel/Render dashboards only. `.env` is gitignored already — keep it that way.
- **Don't enable Vercel preview deployments to use prod Supabase** without thinking — preview URLs can leak. For a demo it's fine; flag it as TODO if this ever sees a real customer.
- **Don't tighten Render's free tier with health-check timeouts under 30s.** Cold starts on free tier take 30-60s; an aggressive health check will keep restarting the service. The `healthCheckPath: /health` plus default timeout is correct.

### Definition of done (deploy)

- `Dockerfile`, `.dockerignore`, `render.yaml`, `DEPLOYMENT.md` exist at the right paths.
- `ml/server.py` has a startup hook that respects `MOCK_MODE` and downloads from Supabase Storage when not mocked.
- Pushing to `main` triggers both Vercel and Render to rebuild.
- A logged-out user visiting the Vercel URL is redirected to `/login`; logging in lands on `/dashboard`.
- The dashboard shows mock detection data (because `MOCK_MODE=true`) and the live `/health` ping to the Render service succeeds.
