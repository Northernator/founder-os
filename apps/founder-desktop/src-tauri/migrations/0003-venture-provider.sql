-- 0003 — per-venture provider override
--
-- `default_provider` is nullable; NULL means "use global active_provider".
-- When a venture has a value, it wins over app_settings.active_provider for
-- chat / fix-suggestion calls. This lets the user, e.g., use Claude for a
-- business venture and Kimi for one with long-doc workloads.
ALTER TABLE ventures ADD COLUMN default_provider TEXT;
