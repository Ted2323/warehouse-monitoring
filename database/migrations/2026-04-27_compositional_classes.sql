-- ============================================================
-- Migration: stateful → compositional class set
-- Date:       2026-04-27
-- ============================================================
--
-- The detection model now emits compositional base classes
--   (worker, helmet, vest, pallet, box, forklift)
-- instead of stateful classes
--   (worker_with_helmet, worker_no_helmet, worker_with_reflective,
--    worker_no_reflective_vest, pallet_filled, pallet_empty,
--    forklift_with_boxes, forklift_no_carry).
--
-- PPE state and asset state are now derived server-side via bbox association
-- (see ml/associate.py). Derived violation strings (worker_no_helmet,
-- worker_no_vest) do NOT appear in detection_logs.detections — they only
-- appear in detection_logs.violations.
--
-- This migration:
--   1. Rewrites warehouse_zones.object_class from old → new.
--   2. Recreates the ppe_violation_events view with the new derived class set.
--   3. Leaves detection_logs rows untouched (historical). Pre-migration logs
--      use the old class strings; the dashboard renders unknown classes with
--      the fallback stroke / unlabeled chip — this is acceptable for history.
-- ============================================================

BEGIN;

-- 1. warehouse_zones.object_class — collapse stateful → base
UPDATE warehouse_zones SET object_class = 'worker'
 WHERE object_class IN (
     'worker_with_helmet',
     'worker_no_helmet',
     'worker_with_reflective',
     'worker_no_reflective_vest'
 );

UPDATE warehouse_zones SET object_class = 'pallet'
 WHERE object_class IN ('pallet_filled', 'pallet_empty');

UPDATE warehouse_zones SET object_class = 'forklift'
 WHERE object_class IN ('forklift_with_boxes', 'forklift_no_carry');

-- 2. Recreate the PPE-violation view with the new derived class set.
--    `worker_no_reflective_vest` → `worker_no_vest`.
DROP VIEW IF EXISTS ppe_violation_events;

CREATE VIEW ppe_violation_events AS
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
WHERE v->>'class' IN ('worker_no_helmet', 'worker_no_vest');

COMMIT;
