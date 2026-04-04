CREATE TABLE IF NOT EXISTS guest_monthly_usage (
  id int(11) NOT NULL AUTO_INCREMENT,
  identity_type varchar(30) NOT NULL,
  identity_hash char(64) NOT NULL,
  usage_month char(7) NOT NULL,
  question_count int(11) NOT NULL DEFAULT 0,
  last_used_at timestamp NULL DEFAULT current_timestamp(),
  created_at timestamp NULL DEFAULT current_timestamp(),
  updated_at timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_guest_monthly_usage_identity_month (identity_type, identity_hash, usage_month),
  KEY idx_guest_monthly_usage_month (usage_month),
  KEY idx_guest_monthly_usage_last_used_at (last_used_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;