UPDATE users
SET plan = 'pro'
WHERE plan = 'standard';

UPDATE payment_requests
SET plan_name = 'pro'
WHERE plan_name = 'standard';

UPDATE user_search_history
SET plan_code = 'pro'
WHERE plan_code = 'standard';