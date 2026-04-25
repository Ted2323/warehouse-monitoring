import { NextRequest, NextResponse } from "next/server";
import {
  CLASS_NAMES,
  PPE_VIOLATION_CLASSES,
  VIOLATION_SEVERITY,
  isPpeViolation,
} from "@/lib/classes";

// ─── SUPABASE (optional) ──────────────────────────────────────
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasSupabase  = !!(SUPABASE_URL && SUPABASE_KEY);

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

// ─── MOCK DETECTIONS (demo mode — uses new 8-class set) ─────
const MOCK_DETECTIONS = [
  { class: "worker_with_helmet",     confidence: 0.92, bbox: [120, 220, 200, 410], cx: 160, cy: 315 },
  { class: "worker_no_helmet",       confidence: 0.88, bbox: [340, 230, 420, 420], cx: 380, cy: 325 },
  { class: "worker_with_reflective", confidence: 0.91, bbox: [120, 220, 200, 410], cx: 160, cy: 315 },
  { class: "pallet_filled",          confidence: 0.95, bbox: [520, 110, 700, 280], cx: 610, cy: 195 },
  { class: "pallet_empty",           confidence: 0.93, bbox: [720, 130, 880, 290], cx: 800, cy: 210 },
  { class: "forklift_with_boxes",    confidence: 0.94, bbox: [60,  300, 280, 520], cx: 170, cy: 410 },
];

// ─── INVENTORY SUMMARY (mirrors ml/detect.py:summarize_inventory) ─
function summarizeInventory(detections: any[]) {
  const c: Record<string, number> = {};
  for (const n of CLASS_NAMES) c[n] = 0;
  for (const d of detections) if (c[d.class] !== undefined) c[d.class] += 1;

  // Approximate; see TODO in ml/detect.py — needs a tracker for exact per-worker compliance.
  const workersCompliant = Math.min(c["worker_with_helmet"], c["worker_with_reflective"]);
  const workersTotal     = c["worker_with_helmet"] + c["worker_no_helmet"]
                         + c["worker_with_reflective"] + c["worker_no_reflective_vest"];

  return {
    pallets_filled:     c["pallet_filled"],
    pallets_empty:      c["pallet_empty"],
    forklifts_carrying: c["forklift_with_boxes"],
    forklifts_idle:     c["forklift_no_carry"],
    workers_total:      workersTotal,
    workers_compliant:  workersCompliant,
  };
}

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

    // 1. Upload to Supabase Storage (skip if not configured)
    if (hasSupabase) {
      const supabase  = getSupabase();
      const filename  = `detections/${Date.now()}-${file.name}`;
      const arrayBuf  = await file.arrayBuffer();
      const { error: uploadError } = await supabase.storage
        .from("warehouse-images")
        .upload(filename, arrayBuf, { contentType: file.type });

      if (uploadError) throw uploadError;

      const { data: { publicUrl } } = supabase.storage
        .from("warehouse-images")
        .getPublicUrl(filename);

      imageUrl = publicUrl;
    }

    // 2. Run detection (real service or mock)
    let detections: any[]    = [];
    let ppeViolations: any[]  = [];
    let zoneViolations: any[] = [];
    let inventory: any        = {};

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
      const res = await fetch(`${detectionServiceUrl}/detect`, {
        method:  "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${serviceToken}`,
        },
        body: JSON.stringify({ image_url: imageUrl, camera_id: cameraId }),
      });
      const result = await res.json();
      detections     = result.detections     ?? [];
      ppeViolations  = result.ppe_violations  ?? [];
      zoneViolations = result.zone_violations ?? [];
      inventory      = result.inventory       ?? summarizeInventory(detections);
    } else {
      // Demo mock
      detections    = MOCK_DETECTIONS;
      inventory     = summarizeInventory(detections);
      ppeViolations = detections
        .filter(d => isPpeViolation(d.class))
        .map(d => ({
          class:       d.class,
          bbox:        d.bbox,
          confidence:  d.confidence,
          alert_level: VIOLATION_SEVERITY[d.class],
        }));

      if (hasSupabase) {
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
      }
    }

    // Merge for legacy `violations` key (so older consumers still see something).
    const violations = [...ppeViolations, ...zoneViolations];

    // 3. Save to detection_logs (skip if not configured)
    if (hasSupabase) {
      const supabase = getSupabase();
      await supabase.from("detection_logs").insert({
        camera_id:        cameraId,
        image_url:        imageUrl,
        detections,
        violations,
        inventory,
        total_objects:    detections.length,
        total_violations: violations.length,
      });
    }

    return NextResponse.json({
      image_url:        imageUrl,
      detections,
      ppe_violations:   ppeViolations,
      zone_violations:  zoneViolations,
      violations,                       // legacy: PPE + zone merged
      inventory,
      total_objects:    detections.length,
      total_violations: violations.length,
    });

  } catch (err: any) {
    console.error("Detection error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
