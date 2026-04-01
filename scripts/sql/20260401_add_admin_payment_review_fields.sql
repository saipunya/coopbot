ALTER TABLE users
  ADD COLUMN premium_expires_at timestamp NULL DEFAULT NULL;

ALTER TABLE payment_requests
  ADD COLUMN reviewed_at timestamp NULL DEFAULT NULL,
  ADD COLUMN reviewed_by varchar(255) DEFAULT NULL;
