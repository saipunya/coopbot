ALTER TABLE knowledge_drafts
  ADD COLUMN approved_record_type enum('knowledge', 'suggested_question') DEFAULT NULL AFTER approved_target,
  ADD KEY idx_knowledge_drafts_approved_record_type_id (approved_record_type, approved_record_id);
