ALTER TABLE chatbot_knowledge_suggestions
  ADD COLUMN source_reference TEXT NULL AFTER content;