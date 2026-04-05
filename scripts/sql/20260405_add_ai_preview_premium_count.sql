-- Add premium AI preview counter for 2-tier free preview system
-- Standard preview: gpt-4o-mini (10 times/month)
-- Premium preview: gpt-4o (5 times/month for analysis/explain questions)
ALTER TABLE user_monthly_usage
  ADD COLUMN ai_preview_premium_count INT NOT NULL DEFAULT 0
  AFTER ai_preview_count;
