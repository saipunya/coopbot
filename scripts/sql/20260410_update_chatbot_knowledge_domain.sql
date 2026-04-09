ALTER TABLE chatbot_knowledge
  MODIFY COLUMN domain enum('legal','general','mixed') NOT NULL DEFAULT 'general';
