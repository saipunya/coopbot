ALTER TABLE user_monthly_usage
ADD COLUMN ai_preview_count int(11) NOT NULL DEFAULT 0 AFTER question_count;
