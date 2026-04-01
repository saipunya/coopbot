ALTER TABLE users
  ADD COLUMN plan_started_at timestamp NULL DEFAULT current_timestamp(),
  ADD COLUMN plan_expires_at timestamp NULL DEFAULT NULL;

ALTER TABLE user_monthly_usage
  ADD COLUMN created_at timestamp NULL DEFAULT current_timestamp(),
  ADD COLUMN updated_at timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp();

UPDATE users
SET plan_started_at = COALESCE(plan_started_at, created_at, CURRENT_TIMESTAMP),
    plan_expires_at = CASE
      WHEN plan_expires_at IS NOT NULL THEN plan_expires_at
      WHEN premium_expires_at IS NOT NULL THEN premium_expires_at
      ELSE NULL
    END
WHERE plan_started_at IS NULL
   OR (plan_expires_at IS NULL AND premium_expires_at IS NOT NULL);

UPDATE user_monthly_usage
SET created_at = COALESCE(created_at, last_used_at, CURRENT_TIMESTAMP),
    updated_at = COALESCE(updated_at, last_used_at, CURRENT_TIMESTAMP)
WHERE created_at IS NULL OR updated_at IS NULL;
