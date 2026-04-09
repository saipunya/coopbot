# Coopbot Manual Regression Checklist

Last updated: 2026-04-10

This checklist covers the recent guest access, Google login persistence, monthly usage, three-plan package model, payment request, admin payment review changes, and responsive small-screen UI behavior.

## Preconditions

- App starts successfully with `.env` configured.
- Database schema has been applied, including:
  - `users`
  - `user_monthly_usage`
  - `payment_requests`
  - `chatbot_knowledge` with `domain` defaulting to `general` and `target` in `coop`, `group`, `all`, `general`
  - `knowledge_sources` with `idx_knowledge_sources_target_status`
  - `knowledge_drafts` with `approved_record_type`, `approved_record_id`, and `idx_knowledge_drafts_source_status`
  - `chatbot_suggested_questions` with `domain`, `target` in `all`, `coop`, `group`, `general`, `source_id`, and `draft_id`
- If the environment previously used `standard`, run the migration in `scripts/sql/20260404_merge_standard_into_pro.sql` before testing package management flows.
- Google login is configured and working.
- Use one browser profile for guest tests and another incognito profile for clean user tests when possible.

## Package Model Reference

- Active packages are `free`, `pro`, and `premium`.
- `pro` is presented to users as `Professional`.
- Legacy `standard` input should resolve to `pro` and must not appear as a purchasable package in UI.
- Existing `pro` customers must not lose prior entitlement level during the 3-package rollout.
- Free users can try limited AI preview, described in UI as AI responses at the `Professional` level.

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

## 4. Package Selection UI Shows Only 3 Packages

Goal: verify user-facing package selection and plan comparison are aligned with the current product structure.

Steps:

1. Sign in as a normal user with `plan = 'free'`.
2. Open `/law-chatbot/payment-request`.
3. Review the package comparison cards and the package dropdown.

Expected:

- Only `Free`, `Professional`, and `Premium` are represented in UI behavior.
- `Standard` is not shown anywhere as a selectable package.
- The current package label uses Thai wording such as `แพ็กเกจปัจจุบัน`.
- Free AI preview messaging refers to `Professional`-level AI preview.

## 5. Payment Request Creation Works

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

## 6. Telegram Notification Failure Does Not Break Payment Submission

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

## 7. Admin Approve Activates the Requested Plan for 30 Days

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

## 8. Admin Reject Keeps Current User Plan Unchanged

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

## 9. Responsive UI: Small Screen Regression Pass

Goal: verify all main user and admin pages remain usable on small screens and narrow mobile viewports.

Viewport matrix:

1. `320 x 568` for older/smaller phones.
2. `390 x 844` for common modern phones.
3. `768 x 1024` for portrait tablet.

Preparation:

1. Start the app and sign in with one normal Google user and one admin account.
2. Open browser DevTools device toolbar or use a real phone/tablet.
3. Repeat the checks below on at least `320 x 568` and `390 x 844`.

Pages to verify:

1. `/law-chatbot`
2. `/law-chatbot/payment-request`
3. `/law-chatbot/upload`
4. `/law-chatbot/feedback`
5. `/admin/login`
6. `/admin`
7. `/admin/users`
8. `/admin/payment-requests`
9. `/admin/payment-requests/:id`
10. `/user`
11. `/user/search-history`

Expected on all small screens:

- No horizontal scrolling is required for core content.
- Header, action buttons, and form controls stay fully visible.
- Buttons are stacked or wrapped cleanly when width is limited.
- Package cards, chips, and status badges do not overflow their containers.
- Primary forms keep readable spacing and inputs remain full-width.
- Lists and cards keep text readable without clipped labels.

Expected page-specific checks:

1. `/law-chatbot`
  - The page header, plan ribbon, chat composer, and floating controls stay usable on a phone-sized screen.
  - The send button, voice button, and clear/reset actions remain reachable without layout overlap.
2. `/law-chatbot/payment-request`
  - Plan comparison cards stack vertically on narrow screens.
  - The current-plan panel, request form, and recent-request list remain readable.
3. `/law-chatbot/upload`
  - The hero area collapses to one column.
  - Upload stats and accepted-type chips wrap cleanly.
4. `/law-chatbot/feedback`
  - The feedback form and summary metrics collapse to one column.
  - Recent feedback items remain readable without text collision.
5. `/admin/login`
  - The login card fits within the viewport with comfortable padding.
  - Google sign-in button and back link remain visible without clipping.
6. `/admin`
  - Metric cards become single-column where needed.
  - Quick links, system actions, and suggestion-management forms remain usable on touch screens.
7. `/admin/users`
  - Search controls, plan controls, and per-user actions stack into a single column on narrow screens.
  - User cards keep plan chips and account status visible without overflow.
8. `/admin/payment-requests`
  - Status, requested plan, and current plan remain visible together even when wrapped.
  - Pending-request plan update controls become full-width on mobile.
9. `/admin/payment-requests/:id`
  - Detail summary panels collapse cleanly into one column.
  - Approve/reject actions remain full-width and easy to tap on mobile.
10. `/user`
  - Profile card, plan spotlight, stat cards, and action buttons collapse to a single-column layout.
11. `/user/search-history`
  - History items stack correctly and action buttons become full-width on small screens.

## Quick Smoke SQL

```sql
SELECT COUNT(*) AS user_count FROM users;
SELECT COUNT(*) AS usage_rows FROM user_monthly_usage;
SELECT COUNT(*) AS payment_request_count FROM payment_requests;
SELECT status, COUNT(*) AS total FROM payment_requests GROUP BY status;
SELECT plan, COUNT(*) AS total FROM users GROUP BY plan ORDER BY plan;
```

## Notes

- Use real `/law-chatbot/chat` requests for guest and monthly limit checks. Do not use summary/debug endpoints.
- For quick UI smoke checks while the app is running, use `npm run verify:ui`.
- For manual responsive review prep, use `npm run review:responsive` to print the viewport matrix and page list.
- To open the responsive review page set in your default browser, use `npm run review:responsive:open`.
- To test that command without opening browser tabs, use `npm run review:responsive:open -- --print-only`.
- `npm run verify:ui` now fails if no active admin/user test accounts exist.
- When `NODE_ENV=production`, the command only runs if both app/DB targets are local, or if `COOPBOT_VERIFY_ALLOW_SESSION_WRITE=true` is set explicitly.
- `npm run verify:ui` validates route availability and key phrases, but it does not replace manual responsive checks with real viewport resizing.
- Payment review routes must stay behind admin auth:
  - `/admin/payment-requests`
  - `/admin/payment-requests/:id`
  - `/admin/payment-requests/approve`
  - `/admin/payment-requests/reject`
