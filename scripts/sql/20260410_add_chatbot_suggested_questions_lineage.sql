ALTER TABLE chatbot_suggested_questions
  ADD COLUMN domain enum('legal', 'general', 'mixed') NOT NULL DEFAULT 'general' AFTER id,
  ADD COLUMN source_id int(11) DEFAULT NULL AFTER source_reference,
  ADD COLUMN draft_id int(11) DEFAULT NULL AFTER source_id,
  ADD KEY idx_chatbot_suggested_questions_domain (domain),
  ADD KEY idx_chatbot_suggested_questions_source_id (source_id),
  ADD KEY idx_chatbot_suggested_questions_draft_id (draft_id);
