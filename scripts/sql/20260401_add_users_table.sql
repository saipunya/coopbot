CREATE TABLE IF NOT EXISTS users (
  id int(11) NOT NULL AUTO_INCREMENT,
  google_id varchar(255) NOT NULL,
  email varchar(255) NOT NULL,
  name varchar(255) DEFAULT NULL,
  avatar_url varchar(500) DEFAULT NULL,
  plan varchar(50) NOT NULL DEFAULT 'free',
  status varchar(50) NOT NULL DEFAULT 'active',
  created_at timestamp NULL DEFAULT current_timestamp(),
  updated_at timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_users_google_id (google_id),
  UNIQUE KEY uniq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
