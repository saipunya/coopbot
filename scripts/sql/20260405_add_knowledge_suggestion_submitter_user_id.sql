ALTER TABLE chatbot_knowledge_suggestions
  ADD COLUMN submitted_by_user_id INT NULL AFTER submitted_by,
  ADD INDEX idx_chatbot_knowledge_suggestions_submitter_user_status (submitted_by_user_id, status);