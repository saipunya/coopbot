CREATE TABLE IF NOT EXISTS chatbot_suggested_questions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  target ENUM('all', 'coop', 'group') NOT NULL DEFAULT 'all',
  question_text VARCHAR(255) NOT NULL,
  normalized_question VARCHAR(255) NOT NULL,
  answer_text TEXT NOT NULL,
  source_reference TEXT DEFAULT NULL,
  display_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_chatbot_suggested_questions_active_order (is_active, display_order, id),
  KEY idx_chatbot_suggested_questions_target_active (target, is_active),
  KEY idx_chatbot_suggested_questions_normalized (normalized_question)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
