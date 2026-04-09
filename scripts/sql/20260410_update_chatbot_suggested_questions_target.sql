ALTER TABLE chatbot_suggested_questions
  MODIFY COLUMN target enum('all','coop','group','general') NOT NULL DEFAULT 'all';
