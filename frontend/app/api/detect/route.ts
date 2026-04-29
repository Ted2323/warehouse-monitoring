import { NextRequest, NextResponse } from "next/server";
import { MIN_CONFIDENCE } from "@/lib/classes";

// Filter helpers — drop anything the model emitted below MIN_CONFIDENCE so
// (a) the UI never draws a low-confidence bbox and (b) detection_logs only
// stores entries we'd be willing to act on as a security violation.
const meetsMinConfidence = (x: { confidence?: number } | null | undefined) =>
  typeof x?.confidence === "number" && x.confidence >= MIN_CONFIDENCE;

// NOTE on imports: when DETECTION_SERVICE_URL is set, this route is a thin
// proxy and the FastAPI service does all class-aware work. The mock path
// below uses hardcoded base-class detections + pre-derived violations so we
// don't have to mirror the association rules from ml/associate.py here.

// Vercel function budget — Render free-tier cold start can take ~30-60s.
// Hobby plan caps at 60s; we use the full budget so a cold boot + a single
// /detect attempt fit inside one invocation. The cold-start path below is
// bounded so we always leave room for the real /detect call.
export const maxDuration = 60;

// ─── COLD-START RETRY HELPERS ────────────────────────────────
// Render's free tier spins the container down after ~15 min idle. The first
// request after idle gets a 502/503 HTML page from Render's edge proxy in
// ~100-200ms while the container boots (~30-60s). On detecting that, we
// poll /health until it returns 200 (with a hard budget), then issue the
// real /detect call. Polling beats a fixed sleep: warm boots return in a
// few seconds and we don't burn the whole budget on a guess.
const COLD_START_STATUSES = new Set([502, 503, 504]);
const HEALTH_POLL_BUDGET_MS   = 45_000;
const HEALTH_POLL_INTERVAL_MS = 1_500;
const HEALTH_POLL_TIMEOUT_MS  = 4_000;

async function waitForHealthy(serviceUrl: string): Promise<boolean> {
  const deadline = Date.now() + HEALTH_POLL_BUDGET_MS;
  while (Date.now() < deadline) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), HEALTH_POLL_TIMEOUT_MS);
      const res = await fetch(`${serviceUrl}/health`, { signal: ctrl.signal });
      clearTimeout(timer);
      res.body?.cancel().catch(() => {});
      if (res.ok) return true;
    } catch {
      // Connection refused / aborted while container boots — keep polling.
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
  }
  return false;
}

async function fetchWithColdStartRetry(
  serviceUrl: string,
  serviceToken: string,
  body: unknown,
): Promise<Response> {
  const url  = `${serviceUrl}/detect`;
  const opts: RequestInit = {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${serviceToken}`,
    },
    body: JSON.stringify(body),
  };

  const res = await fetch(url, opts);
  if (!COLD_START_STATUSES.has(res.status)) return res;

  // Cold start signature — drain the response body so the socket can be
  // reused, then wait for /health before retrying. If the container never
  // becomes healthy within budget, return the original 502 so the caller
  // can surface the cold-start hint without us blowing past maxDuration.
  res.body?.cancel().catch(() => {});
  const healthy = await waitForHealthy(serviceUrl);
  if (!healthy) return res;

  return fetch(url, opts);
}

function looksLikeRenderColdStart(status: number, body: string): boolean {
  // Render's edge serves a branded HTML page on 502/503 during cold boot.
  // Anything starting with `<` is HTML rather than a FastAPI JSON error,
  // which strongly implies the container never received the request.
  return COLD_START_STATUSES.has(status) && body.trimStart().startsWith("<");
}

// ─── SUPABASE (optional) ──────────────────────────────────────
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasSupabase  = !!(SUPABASE_URL && SUPABASE_KEY);

// Set SKIP_DETECTION_PERSIST=true in .env.local to bypass Supabase Storage
// uploads and detection_logs inserts. Useful in dev to avoid hitting free-tier
// rate limits when analyzing videos (each frame would otherwise upload a JPG).
const SKIP_PERSIST = process.env.SKIP_DETECTION_PERSIST === "true";

function getSupabase() {
  const { createClient } = require("@supabase/supabase-js");
  return createClient(SUPABASE_URL, SUPABASE_KEY);
}

// ─── ZONE HELPER ─────────────────────────────────────────────
function pointInPolygon(cx: number, cy: number, polygon: number[][]): boolean {
  let inside = false;
  const n = polygon.length;
  let j = n - 1;
  for (let i = 0; i < n; i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if ((yi > cy) !== (yj > cy) && cx < ((xj - xi) * (cy - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
    j = i;
  }
  return inside;
}

// ─── MOCK FIXTURE (demo mode — base-class detections + derived violations) ─
// Mirrors ml/fixtures/mock_detection.json. Three workers exercising all three
// PPE compliance states:
//   A @ [120,80,220,380]  — compliant (helmet + vest associated)
//   B @ [400,90,500,390]  — partial   (vest only)        → worker_no_helmet (danger)
//   C @ [80,300,180,460]  — unsafe    (neither)          → worker_unsafe    (critical)
// Pallet is filled (box inside). Forklift is operating because worker C's
// center sits inside the forklift bbox (phase-2 worker-association rule).
const MOCK_DETECTIONS = [
  { class: "worker",   confidence: 0.91, bbox: [120, 80, 220, 380],  cx: 170, cy: 230 },
  { class: "helmet",   confidence: 0.88, bbox: [150, 85, 200, 130],  cx: 175, cy: 107 },
  { class: "vest",     confidence: 0.82, bbox: [120, 180, 220, 310], cx: 170, cy: 245 },
  { class: "worker",   confidence: 0.86, bbox: [400, 90, 500, 390],  cx: 450, cy: 240 },
  { class: "vest",     confidence: 0.79, bbox: [410, 180, 495, 290], cx: 452, cy: 235 },
  { class: "worker",   confidence: 0.84, bbox: [80, 300, 180, 460],  cx: 130, cy: 380 },
  { class: "pallet",   confidence: 0.83, bbox: [600, 300, 750, 420], cx: 675, cy: 360 },
  { class: "box",      confidence: 0.77, bbox: [615, 310, 700, 390], cx: 657, cy: 350 },
  { class: "forklift", confidence: 0.92, bbox: [50, 280, 280, 470],  cx: 165, cy: 375 },
];

const MOCK_PPE_VIOLATIONS = [
  { class: "worker_no_helmet", bbox: [400, 90, 500, 390], confidence: 0.86, alert_level: "danger"   },
  { class: "worker_unsafe",    bbox: [80, 300, 180, 460], confidence: 0.84, alert_level: "critical" },
];

const MOCK_INVENTORY = {
  pallets_filled:      1,
  pallets_empty:       0,
  forklifts_operating: 1,
  forklifts_idle:      0,
  workers_total:       3,
  workers_compliant:   1,
};

const MOCK_COMPLIANCE_SUMMARY = {
  workers_total:     3,
  workers_compliant: 1,
  workers_partial:   1,
  workers_unsafe:    1,
  critical_count:    1,
  danger_count:      1,
  warning_count:     0,
};

// ─── POST /api/detect ────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file     = formData.get("image") as File;
    const cameraId = formData.get("camera_id") as string;

    if (!file || !cameraId) {
      return NextResponse.json({ error: "image and camera_id required" }, { status: 400 });
    }

    let imageUrl = "";

    // 1. Upload to Supabase Storage (skip if not configured or persistence disabled).
    // Failures here (e.g. rate limits during heavy video analysis) are non-fatal —
    // detection still runs and returns boxes; we just lose the persisted thumbnail.
    if (hasSupabase && !SKIP_PERSIST) {
      try {
        const supabase  = getSupabase();
        // Supabase Storage rejects keys with spaces, em-dashes, and most non-ASCII.
        // Strip everything outside [a-zA-Z0-9._-] so video frame names like
        // "clip.mp4 — frame 0s" don't blow up the upload.
        const ext  = (file.name.match(/\.([a-zA-Z0-9]+)$/)?.[1] ?? "bin").toLowerCase();
        const safe = file.name
          .replace(/\.[a-zA-Z0-9]+$/, "")
          .replace(/[^a-zA-Z0-9._-]+/g, "_")
          .replace(/_+/g, "_")
          .slice(0, 80);
        const filename  = `detections/${Date.now()}-${safe}.${ext}`;
        const arrayBuf  = await file.arrayBuffer();
        const { error: uploadError } = await supabase.storage
          .from("warehouse-images")
          .upload(filename, arrayBuf, { contentType: file.type });

        if (uploadError) throw uploadError;

        const { data: { publicUrl } } = supabase.storage
          .from("warehouse-images")
          .getPublicUrl(filename);

        imageUrl = publicUrl;
      } catch (err: any) {
        console.warn("Storage upload skipped:", err?.message ?? err);
      }
    }

    // 2. Run detection (real service or mock)
    let detections: any[]            = [];
    let ppeViolations: any[]         = [];
    let zoneViolations: any[]        = [];
    let inventory: any               = {};
    let complianceSummary: any       = null;

    const detectionServiceUrl = process.env.DETECTION_SERVICE_URL;

    if (detectionServiceUrl) {
      // Real FastAPI detection service — gated by a shared bearer token so
      // it can't be hit from the open internet even if exposed publicly.
      const serviceToken = process.env.DETECTION_SERVICE_TOKEN;
      if (!serviceToken) {
        return NextResponse.json(
          { error: "DETECTION_SERVICE_TOKEN missing on server" },
          { status: 500 },
        );
      }
      // The service fetches the image from `image_url`. If our storage upload
      // failed (rate limit, invalid key, etc.) the URL is empty and the service
      // will 500 — short-circuit with a clear error so the user knows why.
      if (!imageUrl) {
        return NextResponse.json(
          { error: "Image upload failed; cannot reach detection service without an image URL." },
          { status: 502 },
        );
      }
      const res = await fetchWithColdStartRetry(
        detectionServiceUrl,
        serviceToken,
        { image_url: imageUrl, camera_id: cameraId },
      );
      // Don't blindly JSON.parse — FastAPI errors come back as plain text
      // ("Internal Server Error") and would crash the route.
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const userMsg = looksLikeRenderColdStart(res.status, text)
          ? "Detection service is waking up (free-tier cold start). Wait ~30 seconds and retry — the next request will be fast."
          : `Detection service ${res.status}: ${text.slice(0, 300) || res.statusText}`;
        return NextResponse.json({ error: userMsg }, { status: 502 });
      }
      const result = await res.json();
      detections        = result.detections         ?? [];
      ppeViolations     = result.ppe_violations     ?? [];
      zoneViolations    = result.zone_violations    ?? [];
      inventory         = result.inventory          ?? {};
      complianceSummary = result.compliance_summary ?? null;
    } else {
      // Demo mock — base-class detections with pre-derived PPE violations.
      detections        = MOCK_DETECTIONS;
      inventory         = MOCK_INVENTORY;
      ppeViolations     = MOCK_PPE_VIOLATIONS;
      complianceSummary = MOCK_COMPLIANCE_SUMMARY;

      if (hasSupabase && !SKIP_PERSIST) {
        try {
          const supabase = getSupabase();
          const { data: zones } = await supabase
            .from("warehouse_zones")
            .select("*")
            .eq("camera_id", cameraId)
            .eq("is_active", true);

          if (zones) {
            for (const det of detections) {
              for (const zone of zones) {
                if (zone.object_class !== det.class) continue;
                if (zone.rule_type   !== "RESTRICTED") continue;
                const poly = typeof zone.polygon === "string"
                  ? JSON.parse(zone.polygon) : zone.polygon;
                if (pointInPolygon(det.cx, det.cy, poly)) {
                  zoneViolations.push({
                    class:       det.class,
                    zone_id:     zone.id,
                    zone_name:   zone.zone_name,
                    alert_level: zone.alert_level,
                    bbox:        det.bbox,
                    confidence:  det.confidence,
                  });
                }
              }
            }
          }
        } catch (err: any) {
          console.warn("Zone lookup skipped:", err?.message ?? err);
        }
      }
    }

    // Confidence gate — drop sub-MIN_CONFIDENCE entries before they reach the
    // UI or the audit log. The Python service may use a lower YOLO threshold
    // for inventory accuracy, but anything we draw or persist as a violation
    // must clear MIN_CONFIDENCE.
    detections     = detections.filter(meetsMinConfidence);
    ppeViolations  = ppeViolations.filter(meetsMinConfidence);
    zoneViolations = zoneViolations.filter(meetsMinConfidence);

    // Merge for legacy `violations` key (so older consumers still see something).
    const violations = [...ppeViolations, ...zoneViolations];

    // 3. Save to detection_logs (skip if not configured or persistence disabled).
    // Non-fatal on error — same reasoning as the upload above. Phase-2:
    // compliance_summary is persisted nested inside the inventory JSONB so we
    // don't need a column-level migration to read it back.
    const inventoryForLog = complianceSummary
      ? { ...inventory, compliance_summary: complianceSummary }
      : inventory;

    if (hasSupabase && !SKIP_PERSIST) {
      try {
        const supabase = getSupabase();
        const { error: insertError } = await supabase.from("detection_logs").insert({
          camera_id:        cameraId,
          image_url:        imageUrl,
          detections,
          violations,
          inventory:        inventoryForLog,
          total_objects:    detections.length,
          total_violations: violations.length,
        });
        if (insertError) throw insertError;
      } catch (err: any) {
        console.warn("Log insert skipped:", err?.message ?? err);
      }
    }

    return NextResponse.json({
      image_url:          imageUrl,
      detections,
      ppe_violations:     ppeViolations,
      zone_violations:    zoneViolations,
      violations,                       // legacy: PPE + zone merged
      inventory,
      compliance_summary: complianceSummary,
      total_objects:      detections.length,
      total_violations:   violations.length,
    });

  } catch (err: any) {
    console.error("Detection error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
