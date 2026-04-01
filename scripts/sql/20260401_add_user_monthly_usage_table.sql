CREATE TABLE IF NOT EXISTS user_monthly_usage (
  id int(11) NOT NULL AUTO_INCREMENT,
  user_id int(11) NOT NULL,
  usage_month char(7) NOT NULL,
  question_count int(11) NOT NULL DEFAULT 0,
  last_used_at timestamp NULL DEFAULT current_timestamp(),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_user_monthly_usage_user_month (user_id, usage_month),
  KEY idx_user_monthly_usage_user_id (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
