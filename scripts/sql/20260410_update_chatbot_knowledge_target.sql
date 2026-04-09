ALTER TABLE chatbot_knowledge
  MODIFY COLUMN target enum('coop', 'group', 'all', 'general') NOT NULL DEFAULT 'general';
