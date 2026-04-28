ALTER TABLE users
  ADD COLUMN response_tone varchar(32) NOT NULL DEFAULT 'semi_formal'
  AFTER law_chatbot_notice_accepted_at;
