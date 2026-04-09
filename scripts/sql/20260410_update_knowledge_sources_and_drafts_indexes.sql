ALTER TABLE knowledge_sources
  ADD KEY idx_knowledge_sources_target_status (target, status);

ALTER TABLE knowledge_drafts
  ADD KEY idx_knowledge_drafts_source_status (source_id, status);
