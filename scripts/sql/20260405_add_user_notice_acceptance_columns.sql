ALTER TABLE users
  ADD COLUMN law_chatbot_notice_accepted_version varchar(50) DEFAULT NULL AFTER status,
  ADD COLUMN law_chatbot_notice_accepted_at timestamp NULL DEFAULT NULL AFTER law_chatbot_notice_accepted_version;