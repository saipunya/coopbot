CREATE TABLE IF NOT EXISTS payment_requests (
  id int(11) NOT NULL AUTO_INCREMENT,
  user_id int(11) NOT NULL,
  plan_name varchar(100) NOT NULL,
  amount decimal(10,2) NOT NULL,
  slip_image varchar(500) DEFAULT NULL,
  note text DEFAULT NULL,
  status varchar(50) NOT NULL DEFAULT 'pending',
  created_at timestamp NULL DEFAULT current_timestamp(),
  updated_at timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (id),
  KEY idx_payment_requests_user_id (user_id),
  KEY idx_payment_requests_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
