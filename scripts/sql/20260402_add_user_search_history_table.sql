CREATE TABLE IF NOT EXISTS user_search_history (
  id int(11) NOT NULL AUTO_INCREMENT,
  user_id int(11) NOT NULL,
  plan_code varchar(50) NOT NULL DEFAULT 'free',
  target varchar(20) NOT NULL DEFAULT 'all',
  question_text text NOT NULL,
  answer_preview text DEFAULT NULL,
  created_at timestamp NULL DEFAULT current_timestamp(),
  expires_at timestamp NULL DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_user_search_history_user_id_created_at (user_id, created_at),
  KEY idx_user_search_history_expires_at (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
