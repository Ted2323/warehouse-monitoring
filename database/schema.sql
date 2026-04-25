-- ============================================================
-- STEP 3 — SUPABASE SCHEMA (v2 — PPE + asset-status detection)
-- Warehouse Monitor: zones (secondary) + detection logs + inventory
-- Run this in Supabase SQL Editor
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── CAMERAS ────────────────────────────────────────────────
CREATE TABLE cameras (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        VARCHAR(100) NOT NULL,           -- "Dock Camera A"
    location    VARCHAR(200),                    -- "Loading Bay, North Wall"
    stream_url  TEXT,                            -- optional RTSP/HLS stream
    is_active   BOOLEAN DEFAULT true,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── ZONES (secondary signal) ───────────────────────────────
-- Zones are no longer the primary violation source — PPE is classification-driven.
-- We keep zones for optional severity boosts (e.g. a worker without a vest who
-- is also inside a high-risk zone) and for the dashboard's zone editor overlay.
-- `object_class` must match a value from ml/classes.py:CLASS_NAMES.
CREATE TABLE warehouse_zones (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    camera_id    UUID REFERENCES cameras(id) ON DELETE CASCADE,
    zone_name    VARCHAR(100) NOT NULL,          -- "Forklift Lane A"
    object_class VARCHAR(50)  NOT NULL,          -- one of CLASS_NAMES
    rule_type    VARCHAR(20)  NOT NULL           -- "ALLOWED" | "RESTRICTED"
                 CHECK (rule_type IN ('ALLOWED', 'RESTRICTED')),
    polygon      JSONB        NOT NULL,          -- [[x1,y1],[x2,y2],...]  pixel coords
    alert_level  VARCHAR(20)  DEFAULT 'warning'
                 CHECK (alert_level IN ('info', 'warning', 'danger')),
    color        VARCHAR(7)   DEFAULT '#FF0000', -- hex for UI overlay
    is_active    BOOLEAN DEFAULT true,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ─── DETECTION LOGS ─────────────────────────────────────────
CREATE TABLE detection_logs (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    camera_id    UUID REFERENCES cameras(id) ON DELETE SET NULL,
    image_url    TEXT,                           -- Supabase Storage path
    detected_at  TIMESTAMPTZ DEFAULT NOW(),
    detections   JSONB NOT NULL,
    -- detections schema:
    -- [{ class: "worker_no_helmet", confidence: 0.92, bbox: [x1,y1,x2,y2], cx: 320, cy: 240 }]
    violations   JSONB DEFAULT '[]',
    -- violations schema (PPE + zone, merged):
    -- PPE:  { class: "worker_no_helmet", bbox: [...], confidence: 0.92, alert_level: "danger" }
    -- Zone: { class: "...", zone_id: "...", zone_name: "...", alert_level: "warning", bbox, confidence }
    inventory    JSONB DEFAULT '{}'::jsonb,
    -- inventory schema:
    -- { pallets_filled, pallets_empty, forklifts_carrying, forklifts_idle,
    --   workers_total, workers_compliant }
    total_objects    INT DEFAULT 0,
    total_violations INT DEFAULT 0
);

-- ─── SEED DATA — minimal: one camera, two zones ─────────────
INSERT INTO cameras (id, name, location)
VALUES (
    'a0000000-0000-0000-0000-000000000001',
    'Dock Camera A',
    'Loading Bay, North Wall'
);

-- Forklift lane: loaded forklifts ALLOWED here; any worker in this lane is RESTRICTED.
-- (Worker subclasses are still primary PPE-violation indicators on their own;
-- a zone hit is an *additional* signal that may bump severity in the UI.)
INSERT INTO warehouse_zones (camera_id, zone_name, object_class, rule_type, polygon, alert_level, color)
VALUES
(
    'a0000000-0000-0000-0000-000000000001',
    'Forklift Lane A',
    'forklift_with_boxes',
    'ALLOWED',
    '[[50,200],[400,200],[400,480],[50,480]]',
    'info',
    '#00FF88'
),
(
    'a0000000-0000-0000-0000-000000000001',
    'Forklift Lane A',
    'worker_no_helmet',
    'RESTRICTED',
    '[[50,200],[400,200],[400,480],[50,480]]',
    'danger',
    '#FF2244'
);

-- ─── INDEXES ────────────────────────────────────────────────
CREATE INDEX idx_zones_camera     ON warehouse_zones(camera_id);
CREATE INDEX idx_zones_class      ON warehouse_zones(object_class);
CREATE INDEX idx_logs_camera      ON detection_logs(camera_id);
CREATE INDEX idx_logs_detected_at ON detection_logs(detected_at DESC);

-- ─── PPE VIOLATION VIEW ─────────────────────────────────────
-- Flattens the JSONB `violations` array into one row per PPE violation,
-- so the dashboard can run fast `SELECT ... ORDER BY detected_at DESC LIMIT N`
-- queries without unwrapping JSON in the client.
CREATE OR REPLACE VIEW ppe_violation_events AS
SELECT
    l.id            AS log_id,
    l.camera_id,
    l.detected_at,
    l.image_url,
    v->>'class'                AS violation_class,
    (v->>'confidence')::float  AS confidence,
    v->'bbox'                  AS bbox
FROM detection_logs l,
     jsonb_array_elements(l.violations) v
WHERE v->>'class' IN ('worker_no_helmet', 'worker_no_reflective_vest');

-- ─── APP USERS + ROLES ──────────────────────────────────────
-- One row per Supabase auth user that is allowed into the app. Admins create
-- users via the Supabase dashboard; this table holds their app-level role.
CREATE TABLE IF NOT EXISTS app_users (
    id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email       TEXT UNIQUE NOT NULL,
    role        TEXT NOT NULL DEFAULT 'viewer'
                CHECK (role IN ('admin', 'viewer')),
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── ROW LEVEL SECURITY ─────────────────────────────────────
-- The dashboard talks to Supabase as the signed-in user (anon key + JWT),
-- so RLS gates direct table access. Server-side code that uses the service
-- role key bypasses RLS, which is what we want for the FastAPI/inference path.
ALTER TABLE app_users        ENABLE ROW LEVEL SECURITY;
ALTER TABLE cameras          ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse_zones  ENABLE ROW LEVEL SECURITY;
ALTER TABLE detection_logs   ENABLE ROW LEVEL SECURITY;

-- Anyone signed in can read their own row from app_users (used by the UI to
-- decide if the "admin" controls render).
CREATE POLICY "self read" ON app_users
    FOR SELECT USING (auth.uid() = id);

-- Cameras: any authenticated user reads; only admins write.
CREATE POLICY "auth read cameras" ON cameras
    FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "admin write cameras" ON cameras
    FOR ALL USING (
        EXISTS (SELECT 1 FROM app_users WHERE id = auth.uid() AND role = 'admin')
    );

-- Zones: same shape — read for any user, write for admins (zone editor).
CREATE POLICY "auth read zones" ON warehouse_zones
    FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "admin write zones" ON warehouse_zones
    FOR ALL USING (
        EXISTS (SELECT 1 FROM app_users WHERE id = auth.uid() AND role = 'admin')
    );

-- Detection logs: any authenticated user reads (dashboard feed). Inserts
-- come from the server with the service role key, which bypasses RLS, so
-- there is intentionally no insert policy here.
CREATE POLICY "auth read logs" ON detection_logs
    FOR SELECT USING (auth.role() = 'authenticated');
