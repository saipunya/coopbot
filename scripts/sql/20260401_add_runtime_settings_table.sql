CREATE TABLE IF NOT EXISTS runtime_settings (
  setting_key varchar(100) NOT NULL,
  setting_value text NOT NULL,
  updated_by varchar(255) DEFAULT NULL,
  created_at timestamp NULL DEFAULT current_timestamp(),
  updated_at timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
