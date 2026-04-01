# Coopbot Manual Regression Checklist

Last updated: 2026-04-01

This checklist covers the recent guest access, Google login persistence, monthly usage, payment request, and admin payment review changes.

## Preconditions

- App starts successfully with `.env` configured.
- Database schema has been applied, including:
  - `users`
  - `user_monthly_usage`
  - `payment_requests`
- Google login is configured and working.
- Use one browser profile for guest tests and another incognito profile for clean user tests when possible.

## 1. Guest Mode: 2 Questions Then Block

Goal: verify unauthenticated users can ask 2 real chat questions and are blocked on the 3rd.

Steps:

1. Open `/law-chatbot` in a fresh session with no login.
2. Send a first message through the normal chat form.
3. Confirm the chatbot returns a normal answer.
4. Send a second message through the normal chat form.
5. Confirm the chatbot returns a normal answer.
6. Send a third message through the normal chat form.

Expected:

- First and second `/law-chatbot/chat` requests succeed normally.
- Third `/law-chatbot/chat` request returns a friendly sign-in message.
- The block message asks the user to sign in with Google.
- `chat-summary` and debug endpoints are not involved in the counter.

## 2. Google Login User Defaults to `plan=free`

Goal: verify Google-login persistence creates or updates a user row with default free plan.

Steps:

1. Sign in through Google.
2. Confirm login completes and session is created.
3. Check the `users` table for the signed-in account email.

SQL:

```sql
SELECT id, google_id, email, name, plan, status, plan_started_at, plan_expires_at, premium_expires_at
FROM users
WHERE email = 'user@example.com';
```

Expected:

- A row exists for the Google user.
- `plan = 'free'`
- `status = 'active'`
- `plan_started_at` is populated
- `plan_expires_at` is `NULL` for a new free user
- `premium_expires_at` is `NULL` for a new free user.

## 3. Free Monthly Limit Is Enforced

Goal: verify a free logged-in user is blocked after monthly quota is reached.

Steps:

1. Sign in as a non-admin Google user with `plan = 'free'`.
2. Seed usage close to the limit:

```sql
INSERT INTO user_monthly_usage (user_id, usage_month, question_count, last_used_at)
VALUES (USER_ID_HERE, DATE_FORMAT(CURRENT_DATE(), '%Y-%m'), 49, CURRENT_TIMESTAMP)
ON DUPLICATE KEY UPDATE
  question_count = 49,
  last_used_at = CURRENT_TIMESTAMP;
```

3. Send one real `/law-chatbot/chat` request.
4. Confirm it still succeeds.
5. Send one more real `/law-chatbot/chat` request.

Expected:

- The 50th request succeeds.
- The 51st request is blocked with a friendly monthly limit message.
- The message indicates the free monthly quota has been reached.
- Admin users are not blocked by customer-plan monthly usage limits.

## 4. Payment Request Creation Works

Goal: verify logged-in users can submit a payment request with or without slip upload.

Steps:

1. Sign in as a normal user.
2. Open `/law-chatbot/payment-request`.
3. Submit a valid form with:
   - plan
   - optional note
4. Repeat once with an image slip upload.

Expected:

- The request is accepted.
- A success message is shown.
- A row is inserted into `payment_requests`.
- `amount` is derived by the backend from the selected plan, not user-entered.
- `status = 'pending'`
- `slip_image` is populated only when a file is uploaded.

SQL:

```sql
SELECT id, user_id, plan_name, amount, slip_image, status, reviewed_at, reviewed_by
FROM payment_requests
WHERE user_id = USER_ID_HERE
ORDER BY id DESC;
```

## 5. Telegram Notification Failure Does Not Break Payment Submission

Goal: ensure payment submission still succeeds even if Telegram notification fails.

Current status:

- As of 2026-04-01, the codebase contains Telegram environment variables in `.env`, but no active payment-request Telegram send path was found in application code.
- This means the current payment submission flow is already unaffected by Telegram delivery failure.

If a Telegram notification hook is added later, verify it with these steps:

1. Configure an invalid Telegram token or force the notification call to throw.
2. Submit a valid payment request.

Expected:

- The payment request is still stored successfully.
- User still sees success.
- Notification failure is logged only as a non-blocking side effect.

## 6. Admin Approve Activates the Requested Plan for 30 Days

Goal: verify admin approval updates both payment request review fields and the user plan.

Steps:

1. Create a pending payment request for a free user.
2. Sign in as admin.
3. Open `/admin/payment-requests`.
4. Open the detail page for the pending request.
5. Click approve.

Expected:

- Payment request `status` becomes `approved`.
- `reviewed_at` is set.
- `reviewed_by` is set.
- User `plan` becomes the requested paid plan.
- `plan_started_at` is populated.
- `plan_expires_at` is set to about 30 days ahead.
- `premium_expires_at` mirrors `plan_expires_at` only when the approved plan is `premium`.

SQL:

```sql
SELECT id, plan, plan_started_at, plan_expires_at, premium_expires_at
FROM users
WHERE id = USER_ID_HERE;

SELECT id, status, reviewed_at, reviewed_by
FROM payment_requests
WHERE id = PAYMENT_REQUEST_ID_HERE;
```

## 7. Admin Reject Keeps Current User Plan Unchanged

Goal: verify admin rejection does not change the user's active plan.

Steps:

1. Create another pending payment request for a user with any current plan.
2. Sign in as admin.
3. Open the request detail page.
4. Click reject.

Expected:

- Payment request `status` becomes `rejected`.
- `reviewed_at` is set.
- `reviewed_by` is set.
- User plan remains unchanged from before rejection.
- Existing `plan_expires_at` remains unchanged.

## Quick Smoke SQL

```sql
SELECT COUNT(*) AS user_count FROM users;
SELECT COUNT(*) AS usage_rows FROM user_monthly_usage;
SELECT COUNT(*) AS payment_request_count FROM payment_requests;
SELECT status, COUNT(*) AS total FROM payment_requests GROUP BY status;
```

## Notes

- Use real `/law-chatbot/chat` requests for guest and monthly limit checks. Do not use summary/debug endpoints.
- Payment review routes must stay behind admin auth:
  - `/admin/payment-requests`
  - `/admin/payment-requests/:id`
  - `/admin/payment-requests/approve`
  - `/admin/payment-requests/reject`
