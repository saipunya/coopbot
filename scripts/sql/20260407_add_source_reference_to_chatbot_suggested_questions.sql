ALTER TABLE chatbot_suggested_questions
  ADD COLUMN source_reference TEXT DEFAULT NULL AFTER answer_text;