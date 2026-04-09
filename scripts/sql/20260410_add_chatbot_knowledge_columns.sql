ALTER TABLE chatbot_knowledge
  ADD COLUMN domain enum('legal', 'general', 'mixed') NOT NULL DEFAULT 'general' AFTER id,
  ADD COLUMN source_id int(11) DEFAULT NULL AFTER source_note,
  ADD COLUMN review_status enum('approved', 'archived') NOT NULL DEFAULT 'approved' AFTER source_id,
  ADD KEY idx_chatbot_knowledge_domain_review_status (domain, review_status),
  ADD KEY idx_chatbot_knowledge_source_id (source_id);
