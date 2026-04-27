-- ============================================================
-- Migration: critical severity tier + worker_unsafe in PPE view
-- Date:       2026-04-27 (phase 2 — business rules)
-- ============================================================
--
-- Phase 2 of the business-rules layer (CLAUDE_CODE_BUSINESS_RULES.md):
--   1. Allow 'critical' as a fourth alert level on warehouse_zones.
--   2. Refresh ppe_violation_events to include the new derived class
--      `worker_unsafe` (compound — neither helmet nor vest associated).
--
-- This is additive only. Pre-existing rows in detection_logs are untouched —
-- they reference `worker_no_vest` (warning) or `worker_no_helmet` (danger)
-- and remain readable through the view.
-- ============================================================

BEGIN;

-- 1. Allow 'critical' as a fourth alert level.
ALTER TABLE warehouse_zones
    DROP CONSTRAINT IF EXISTS warehouse_zones_alert_level_check;
ALTER TABLE warehouse_zones
    ADD CONSTRAINT warehouse_zones_alert_level_check
    CHECK (alert_level IN ('info', 'warning', 'danger', 'critical'));

-- 2. Refresh the PPE violation view to include worker_unsafe and to expose
--    alert_level on each row (so dashboards can sort/filter without
--    re-deriving severity).
DROP VIEW IF EXISTS ppe_violation_events;

CREATE VIEW ppe_violation_events AS
SELECT
    l.id            AS log_id,
    l.camera_id,
    l.detected_at,
    l.image_url,
    v->>'class'                AS violation_class,
    v->>'alert_level'          AS alert_level,
    (v->>'confidence')::float  AS confidence,
    v->'bbox'                  AS bbox
FROM detection_logs l,
     jsonb_array_elements(l.violations) v
WHERE v->>'class' IN ('worker_no_helmet', 'worker_no_vest', 'worker_unsafe');

COMMIT;
