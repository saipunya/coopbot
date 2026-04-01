CREATE TABLE IF NOT EXISTS law_chatbot_answer_cache (
  id int(11) NOT NULL AUTO_INCREMENT,
  question_hash char(64) NOT NULL,
  normalized_question text NOT NULL,
  original_question text NOT NULL,
  target varchar(20) NOT NULL DEFAULT 'all',
  answer_text longtext NOT NULL,
  metadata_json longtext DEFAULT NULL,
  hit_count int(11) NOT NULL DEFAULT 0,
  created_at timestamp NULL DEFAULT current_timestamp(),
  updated_at timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_law_chatbot_answer_cache_question_hash (question_hash),
  KEY idx_law_chatbot_answer_cache_target (target)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
