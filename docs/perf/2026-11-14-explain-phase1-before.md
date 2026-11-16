# Explain report 2026-11-14

Overall: **FAIL** (13 of 49 cases)

- Database: knoqra_s9_perf (101100 contacts, 1010103 timeline events)
- Machine: win32, 16 CPUs, Node 22.21.0, PostgreSQL 17.11
- Role: knoqra_app with RLS, EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) per captured statement
- Partial: import.upsert committed writes, so the replay hit unique-key conflicts on re-insert (R5) and skipped those statements; their DB ms covers the rest only
- Phase 1 baseline: Phase 1 seed and cases, before the Task 10 fixes.

| Case | Milestone | Status | DB ms | Budget ms | Statements | Seq scans |
|---|---|---|---|---|---|---|
| contacts.list.first | M1 | PASS | 0.51 | 50 | 4 | - |
| contacts.list.deep | M1 | PASS | 0.50 | 50 | 4 | - |
| contacts.list.archived | M1 | PASS | 0.65 | 50 | 4 | - |
| contacts.search.name | M1 | PASS | 43.98 | 150 | 4 | contact |
| contacts.search.company | M1 | PASS | 56.43 | 150 | 4 | contact |
| contacts.search.email | M1 | PASS | 51.12 | 150 | 4 | contact |
| contacts.search.digits | M1 | PASS | 44.78 | 150 | 4 | contact |
| contacts.search.rare | M1 | PASS | 67.75 | 150 | 4 | contact |
| contacts.detail | M1 | PASS | 0.40 | 20 | 4 | - |
| timeline.first | M1 | PASS | 1.15 | 50 | 5 | - |
| timeline.deep | M1 | PASS | 1.37 | 50 | 5 | - |
| timeline.calls | M1 | PASS | 2.96 | 50 | 5 | - |
| timeline.notes_consent | M1 | PASS | 1.86 | 50 | 5 | - |
| permissions | M1 | PASS | 0.84 | 20 | 5 | - |
| duplicates | M1 | PASS | 1.38 | 50 | 5 | - |
| import.upsert | M1 | PASS | 5.24 | 150 | 10 | - |
| calls.list.first | M2 | PASS | 1.27 | 50 | 4 | - |
| calls.list.deep | M2 | PASS | 1.69 | 50 | 4 | - |
| calls.list.inbound | M2 | PASS | 1.90 | 50 | 4 | - |
| calls.active | M2 | **FAIL** | 301.18 | 20 | 4 | - |
| voicemails.list | M2 | **FAIL** | 76.19 | 50 | 4 | contact, voicemail |
| wallet.ledger.first | M2 | PASS | 1.38 | 100 | 8 | wallet |
| wallet.ledger.deep | M2 | PASS | 2.18 | 100 | 8 | wallet |
| conversations.list.first | M3 | PASS | 5.54 | 50 | 6 | channel_connection |
| conversations.list.deep | M3 | PASS | 14.29 | 50 | 6 | channel_connection |
| conversations.list.unread | M3 | PASS | 6.62 | 50 | 6 | channel_connection |
| conversations.list.sms | M3 | PASS | 6.33 | 50 | 6 | channel_connection |
| conversations.list.whatsapp | M3 | PASS | 8.67 | 50 | 6 | channel_connection |
| conversations.search.name | M3 | **FAIL** | 136.20 | 150 | 6 | contact, channel_connection |
| conversations.search.digits | M3 | **FAIL** | 73.11 | 150 | 6 | contact, channel_connection |
| conversations.thread.first | M3 | **FAIL** | 132.55 | 50 | 5 | message_template |
| conversations.thread.deep | M3 | **FAIL** | 68.53 | 50 | 5 | message_template |
| messages.detail | M3 | PASS | 0.59 | 20 | 5 | message_template |
| templates.list | M3b | PASS | 0.79 | 50 | 4 | message_template |
| templates.list.sms | M3b | PASS | 0.73 | 50 | 4 | message_template |
| numbers.list | M4 | PASS | 0.59 | 50 | 4 | phone_number |
| usage.summary | M4 | PASS | 1.03 | 100 | 4 | - |
| usage.ledger.first | M4 | **FAIL** | 1736.82 | 100 | 4 | - |
| usage.ledger.deep | M4 | **FAIL** | 1115.28 | 100 | 4 | - |
| usage.ledger.filtered | M4 | **FAIL** | 953.34 | 100 | 4 | - |
| usage.reconciliations.first | M4 | PASS | 1.31 | 50 | 4 | reconciliation_report |
| usage.reconciliations.deep | M4 | PASS | 1.04 | 50 | 4 | reconciliation_report |
| numbers.orders | M4b | PASS | 0.61 | 50 | 4 | number_order |
| tasks.open.first | M5 | **FAIL** | 219.43 | 50 | 4 | task, contact |
| tasks.open.deep | M5 | **FAIL** | 178.28 | 50 | 4 | task, contact |
| tasks.done.first | M5 | PASS | 7.50 | 50 | 4 | - |
| tasks.done.deep | M5 | PASS | 2.58 | 50 | 4 | - |
| tasks.byContact | M5 | **FAIL** | 21.54 | 50 | 4 | task |
| notifications.list | M5 | **FAIL** | 23.57 | 50 | 8 | task, notification |

## contacts.list.first

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.10 ms, planning 0.46 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.05 ms, planning 0.17 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.06 ms, planning 0.32 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 0.29 ms, planning 1.19 ms, buffers hit=54 read=0
   - Limit > Index Scan using contact_active_sort_idx

## contacts.list.deep

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.08 ms, planning 0.47 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.06 ms, planning 0.32 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.04 ms, planning 0.25 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 0.33 ms, planning 1.04 ms, buffers hit=55 read=0
   - Limit > Index Scan using contact_active_sort_idx

## contacts.list.archived

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.15 ms, planning 0.83 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.07 ms, planning 0.34 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.06 ms, planning 0.57 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 0.37 ms, planning 0.73 ms, buffers hit=68 read=0
   - Limit > Index Scan using contact_inactive_sort_idx

## contacts.search.name

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.08 ms, planning 0.46 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.04 ms, planning 0.18 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.04 ms, planning 0.25 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 43.83 ms, planning 1.00 ms, buffers hit=373 read=3813
   - Limit > Gather Merge > Sort > Seq Scan on contact

## contacts.search.company

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.08 ms, planning 0.48 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.04 ms, planning 0.19 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.08 ms, planning 0.48 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 56.23 ms, planning 1.25 ms, buffers hit=611 read=3575
   - Limit > Gather Merge > Sort > Seq Scan on contact

## contacts.search.email

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.11 ms, planning 0.62 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.05 ms, planning 0.24 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.09 ms, planning 0.93 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 50.88 ms, planning 1.45 ms, buffers hit=845 read=3341
   - Limit > Gather Merge > Sort > Seq Scan on contact

## contacts.search.digits

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.10 ms, planning 0.67 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.05 ms, planning 0.35 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.04 ms, planning 0.23 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 44.60 ms, planning 1.08 ms, buffers hit=1055 read=3131
   - Limit > Gather Merge > Sort > Seq Scan on contact

## contacts.search.rare

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.17 ms, planning 1.00 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.08 ms, planning 0.35 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.06 ms, planning 0.50 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 67.45 ms, planning 1.71 ms, buffers hit=1256 read=2930
   - Limit > Gather Merge > Sort > Seq Scan on contact

## contacts.detail

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.13 ms, planning 0.98 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.07 ms, planning 0.33 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.06 ms, planning 0.54 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 0.14 ms, planning 1.40 ms, buffers hit=4 read=0
   - Limit > Index Scan using contact_pkey

## timeline.first

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.12 ms, planning 0.93 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.07 ms, planning 0.32 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.07 ms, planning 0.42 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 0.17 ms, planning 1.77 ms, buffers hit=4 read=0
   - Limit > Index Scan using contact_pkey
5. `select "id", "organization_id", "contact_id", "kind", "title", "body", "actor_user_id", "source", "ref_type", "ref_id", "occurred_at", "created_at", to_char("oc`
   - 0.73 ms, planning 0.75 ms, buffers hit=55 read=0
   - Limit > Index Scan using timeline_event_contact_occurred_idx

## timeline.deep

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.10 ms, planning 0.76 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.07 ms, planning 0.35 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.05 ms, planning 0.44 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 0.12 ms, planning 2.02 ms, buffers hit=4 read=0
   - Limit > Index Scan using contact_pkey
5. `select "id", "organization_id", "contact_id", "kind", "title", "body", "actor_user_id", "source", "ref_type", "ref_id", "occurred_at", "created_at", to_char("oc`
   - 1.03 ms, planning 0.88 ms, buffers hit=56 read=0
   - Limit > Index Scan using timeline_event_contact_occurred_idx

## timeline.calls

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.15 ms, planning 0.99 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.14 ms, planning 0.35 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.07 ms, planning 0.46 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 0.14 ms, planning 1.94 ms, buffers hit=4 read=0
   - Limit > Index Scan using contact_pkey
5. `select "id", "organization_id", "contact_id", "kind", "title", "body", "actor_user_id", "source", "ref_type", "ref_id", "occurred_at", "created_at", to_char("oc`
   - 2.47 ms, planning 0.65 ms, buffers hit=356 read=0
   - Limit > Index Scan using timeline_event_contact_occurred_idx

## timeline.notes_consent

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.20 ms, planning 1.04 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.08 ms, planning 0.43 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.07 ms, planning 0.41 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 0.15 ms, planning 1.63 ms, buffers hit=4 read=0
   - Limit > Index Scan using contact_pkey
5. `select "id", "organization_id", "contact_id", "kind", "title", "body", "actor_user_id", "source", "ref_type", "ref_id", "occurred_at", "created_at", to_char("oc`
   - 1.35 ms, planning 1.08 ms, buffers hit=133 read=0
   - Limit > Index Scan using timeline_event_contact_occurred_idx

## permissions

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.12 ms, planning 0.98 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.08 ms, planning 0.35 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.07 ms, planning 0.35 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 0.48 ms, planning 2.68 ms, buffers hit=4 read=0
   - Limit > Index Scan using contact_pkey
5. `select distinct on ("contact_permission_event"."channel") "id", "organization_id", "contact_id", "channel", "status", "source", "evidence", "actor_user_id", "cr`
   - 0.10 ms, planning 0.76 ms, buffers hit=4 read=0
   - Unique > Index Scan using contact_permission_event_contact_channel_idx

## duplicates

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.14 ms, planning 0.99 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.07 ms, planning 0.36 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.06 ms, planning 0.43 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 0.23 ms, planning 1.37 ms, buffers hit=4 read=0
   - Limit > Index Scan using contact_pkey
5. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 0.88 ms, planning 1.86 ms, buffers hit=58 read=0
   - Limit > Sort > Nested Loop > Bitmap Heap Scan on contact > BitmapOr > Bitmap Index Scan using contact_active_name_key_idx > Bitmap Index Scan using contact_active_email_key_idx > Materialize > Bitmap Heap Scan on contact_duplicate_dismissal > BitmapOr > Bitmap Index Scan using contact_duplicate_dismissal_pair_unique > Bitmap Index Scan using contact_duplicate_dismissal_org_b_idx

## import.upsert

- Note: duplicate key value violates unique constraint "timeline_event_pkey"
- Note: duplicate key value violates unique constraint "audit_event_pkey"
1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.10 ms, planning 0.60 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.07 ms, planning 0.28 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.06 ms, planning 0.43 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 1.47 ms, planning 1.80 ms, buffers hit=228 read=0
   - LockRows > Sort > Result > Index Scan using contact_organization_id_phone_e164_unique
5. `update "contact" set "tags" = $1, "updated_at" = $2 where "contact"."id" = $3`
   - 0.63 ms, planning 0.12 ms, buffers hit=35 read=0
   - ModifyTable on contact > Index Scan using contact_pkey
6. `update "contact" set "tags" = $1, "updated_at" = $2 where "contact"."id" = $3`
   - 0.35 ms, planning 0.13 ms, buffers hit=34 read=0
   - ModifyTable on contact > Index Scan using contact_pkey
7. `update "contact" set "tags" = $1, "updated_at" = $2 where "contact"."id" = $3`
   - 0.60 ms, planning 0.16 ms, buffers hit=33 read=1
   - ModifyTable on contact > Index Scan using contact_pkey
8. `insert into "contact" ("id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "a`
   - 1.97 ms, planning 0.42 ms, buffers hit=412 read=0
   - ModifyTable on contact > Values Scan
9. `insert into "timeline_event" ("id", "organization_id", "contact_id", "kind", "title", "body", "actor_user_id", "source", "ref_type", "ref_id", "occurred_at", "c`
   - 0.00 ms, planning 0.00 ms, buffers -
   - not replayed: duplicate key value violates unique constraint "timeline_event_pkey"
10. `insert into "audit_event" ("id", "organization_id", "actor_user_id", "action", "entity_type", "entity_id", "outcome", "metadata", "created_at") values ($1, $2, `
   - 0.00 ms, planning 0.00 ms, buffers -
   - not replayed: duplicate key value violates unique constraint "audit_event_pkey"

## calls.list.first

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.22 ms, planning 0.53 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.05 ms, planning 0.23 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.04 ms, planning 0.25 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "call"."id", "call"."organization_id", "call"."user_id", "call"."contact_id", "call"."direction", "call"."state", "call"."from_e164", "call"."to_e164", "`
   - 0.96 ms, planning 1.70 ms, buffers hit=246 read=0
   - Limit > Nested Loop > Index Scan using call_org_created_idx > Index Scan using contact_pkey

## calls.list.deep

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.12 ms, planning 1.00 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.05 ms, planning 0.21 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.09 ms, planning 0.52 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "call"."id", "call"."organization_id", "call"."user_id", "call"."contact_id", "call"."direction", "call"."state", "call"."from_e164", "call"."to_e164", "`
   - 1.43 ms, planning 2.68 ms, buffers hit=247 read=0
   - Limit > Nested Loop > Index Scan using call_org_created_idx > Index Scan using contact_pkey

## calls.list.inbound

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.12 ms, planning 0.87 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.07 ms, planning 0.26 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.05 ms, planning 0.33 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "call"."id", "call"."organization_id", "call"."user_id", "call"."contact_id", "call"."direction", "call"."state", "call"."from_e164", "call"."to_e164", "`
   - 1.66 ms, planning 1.76 ms, buffers hit=346 read=0
   - Limit > Nested Loop > Index Scan using call_org_created_idx > Index Scan using contact_pkey

## calls.active

- **FAIL**: over budget (301.18 ms > 20 ms)
1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.08 ms, planning 0.59 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.05 ms, planning 0.28 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.04 ms, planning 0.29 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "call"."id", "call"."organization_id", "call"."user_id", "call"."contact_id", "call"."direction", "call"."state", "call"."from_e164", "call"."to_e164", "`
   - 301.00 ms, planning 1.95 ms, buffers hit=203235 read=0
   - Limit > Nested Loop > Index Scan using call_org_created_idx > Index Scan using contact_pkey

## voicemails.list

- **FAIL**: seq scan on contact
- **FAIL**: over budget (76.19 ms > 50 ms)
1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.07 ms, planning 0.50 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.04 ms, planning 0.17 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.04 ms, planning 0.22 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "voicemail"."id", "voicemail"."organization_id", "voicemail"."call_id", "voicemail"."contact_id", "voicemail"."from_e164", "voicemail"."duration_seconds"`
   - 76.04 ms, planning 1.64 ms, buffers hit=797 read=3469
   - Limit > Sort > Hash Join > Seq Scan on contact > Hash > Seq Scan on voicemail

## wallet.ledger.first

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.08 ms, planning 0.56 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.06 ms, planning 0.26 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.04 ms, planning 0.21 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "provider", "api_key_ciphertext", "api_key_iv", "dek_wrapped", "dek_iv", "key_fingerprint", "api_key_last4", "connection_id", "t`
   - 0.03 ms, planning 0.32 ms, buffers hit=2 read=0
   - Limit > Index Scan using provider_credential_organization_id_provider_unique
5. `insert into "wallet" ("id", "organization_id", "currency", "warn_cap_micros", "stop_cap_micros", "created_at", "updated_at") values ($1, $2, default, default, d`
   - 0.20 ms, planning 0.05 ms, buffers hit=53 read=0
   - ModifyTable on wallet > Result
6. `select "id", "organization_id", "currency", "warn_cap_micros", "stop_cap_micros", "created_at", "updated_at" from "wallet" where "wallet"."organization_id" = $1`
   - 0.03 ms, planning 0.21 ms, buffers hit=1 read=0
   - Limit > Result > Seq Scan on wallet
7. `insert into "ledger_entry" ("id", "organization_id", "wallet_id", "kind", "balance_delta_micros", "held_delta_micros", "reservation_id", "ref_type", "ref_id", "`
   - 0.65 ms, planning 0.08 ms, buffers hit=103 read=0
   - ModifyTable on ledger_entry > Result
8. `select "id", "organization_id", "wallet_id", "kind", "balance_delta_micros", "held_delta_micros", "reservation_id", "ref_type", "ref_id", "idempotency_key", "no`
   - 0.30 ms, planning 0.75 ms, buffers hit=7 read=0
   - Limit > Result > Index Scan using ledger_entry_org_created_idx

## wallet.ledger.deep

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.23 ms, planning 0.91 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.07 ms, planning 0.38 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.07 ms, planning 0.43 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "provider", "api_key_ciphertext", "api_key_iv", "dek_wrapped", "dek_iv", "key_fingerprint", "api_key_last4", "connection_id", "t`
   - 0.04 ms, planning 0.46 ms, buffers hit=2 read=0
   - Limit > Index Scan using provider_credential_organization_id_provider_unique
5. `insert into "wallet" ("id", "organization_id", "currency", "warn_cap_micros", "stop_cap_micros", "created_at", "updated_at") values ($1, $2, default, default, d`
   - 0.43 ms, planning 0.08 ms, buffers hit=53 read=0
   - ModifyTable on wallet > Result
6. `select "id", "organization_id", "currency", "warn_cap_micros", "stop_cap_micros", "created_at", "updated_at" from "wallet" where "wallet"."organization_id" = $1`
   - 0.07 ms, planning 0.43 ms, buffers hit=1 read=0
   - Limit > Result > Seq Scan on wallet
7. `insert into "ledger_entry" ("id", "organization_id", "wallet_id", "kind", "balance_delta_micros", "held_delta_micros", "reservation_id", "ref_type", "ref_id", "`
   - 0.82 ms, planning 0.05 ms, buffers hit=103 read=0
   - ModifyTable on ledger_entry > Result
8. `select "id", "organization_id", "wallet_id", "kind", "balance_delta_micros", "held_delta_micros", "reservation_id", "ref_type", "ref_id", "idempotency_key", "no`
   - 0.47 ms, planning 0.92 ms, buffers hit=5 read=0
   - Limit > Result > Index Scan using ledger_entry_org_created_idx

## conversations.list.first

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.15 ms, planning 0.93 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.13 ms, planning 0.36 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.06 ms, planning 0.47 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "conversation"."id", "conversation"."organization_id", "conversation"."contact_id", "conversation"."channel", "conversation"."last_activity_at", "convers`
   - 4.16 ms, planning 2.60 ms, buffers hit=258 read=0
   - Limit > Nested Loop > Index Scan using conversation_inbox_idx > Memoize > Index Scan using contact_pkey
5. `select distinct on ("contact_permission_event"."contact_id", "contact_permission_event"."channel") "id", "organization_id", "contact_id", "channel", "status", "`
   - 0.98 ms, planning 0.85 ms, buffers hit=183 read=0
   - Unique > Sort > Bitmap Heap Scan on contact_permission_event > Bitmap Index Scan using contact_permission_event_contact_channel_idx
6. `select "id", "organization_id", "channel", "provider", "address", "registration_status", "created_at", "updated_at" from "channel_connection" where "channel_con`
   - 0.06 ms, planning 0.54 ms, buffers hit=1 read=0
   - Seq Scan on channel_connection

## conversations.list.deep

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.23 ms, planning 0.95 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.09 ms, planning 0.41 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.07 ms, planning 0.43 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "conversation"."id", "conversation"."organization_id", "conversation"."contact_id", "conversation"."channel", "conversation"."last_activity_at", "convers`
   - 12.48 ms, planning 2.44 ms, buffers hit=259 read=0
   - Limit > Nested Loop > Index Scan using conversation_inbox_idx > Memoize > Index Scan using contact_pkey
5. `select distinct on ("contact_permission_event"."contact_id", "contact_permission_event"."channel") "id", "organization_id", "contact_id", "channel", "status", "`
   - 1.35 ms, planning 0.77 ms, buffers hit=177 read=0
   - Unique > Sort > Bitmap Heap Scan on contact_permission_event > Bitmap Index Scan using contact_permission_event_contact_channel_idx
6. `select "id", "organization_id", "channel", "provider", "address", "registration_status", "created_at", "updated_at" from "channel_connection" where "channel_con`
   - 0.06 ms, planning 0.60 ms, buffers hit=1 read=0
   - Seq Scan on channel_connection

## conversations.list.unread

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.16 ms, planning 0.98 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.08 ms, planning 0.37 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.13 ms, planning 0.49 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "conversation"."id", "conversation"."organization_id", "conversation"."contact_id", "conversation"."channel", "conversation"."last_activity_at", "convers`
   - 5.02 ms, planning 2.42 ms, buffers hit=657 read=0
   - Limit > Nested Loop > Index Scan using conversation_inbox_idx > Index Scan using contact_pkey
5. `select distinct on ("contact_permission_event"."contact_id", "contact_permission_event"."channel") "id", "organization_id", "contact_id", "channel", "status", "`
   - 1.17 ms, planning 1.06 ms, buffers hit=183 read=0
   - Unique > Sort > Bitmap Heap Scan on contact_permission_event > Bitmap Index Scan using contact_permission_event_contact_channel_idx
6. `select "id", "organization_id", "channel", "provider", "address", "registration_status", "created_at", "updated_at" from "channel_connection" where "channel_con`
   - 0.06 ms, planning 0.64 ms, buffers hit=1 read=0
   - Seq Scan on channel_connection

## conversations.list.sms

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.12 ms, planning 0.89 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.07 ms, planning 0.40 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.09 ms, planning 0.60 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "conversation"."id", "conversation"."organization_id", "conversation"."contact_id", "conversation"."channel", "conversation"."last_activity_at", "convers`
   - 4.00 ms, planning 2.41 ms, buffers hit=271 read=0
   - Limit > Nested Loop > Index Scan using conversation_inbox_idx > Memoize > Index Scan using contact_pkey
5. `select distinct on ("contact_permission_event"."contact_id", "contact_permission_event"."channel") "id", "organization_id", "contact_id", "channel", "status", "`
   - 2.00 ms, planning 0.80 ms, buffers hit=183 read=0
   - Unique > Sort > Bitmap Heap Scan on contact_permission_event > Bitmap Index Scan using contact_permission_event_contact_channel_idx
6. `select "id", "organization_id", "channel", "provider", "address", "registration_status", "created_at", "updated_at" from "channel_connection" where "channel_con`
   - 0.05 ms, planning 0.46 ms, buffers hit=1 read=0
   - Seq Scan on channel_connection

## conversations.list.whatsapp

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.14 ms, planning 1.00 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.08 ms, planning 0.29 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.06 ms, planning 0.43 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "conversation"."id", "conversation"."organization_id", "conversation"."contact_id", "conversation"."channel", "conversation"."last_activity_at", "convers`
   - 7.32 ms, planning 2.57 ms, buffers hit=455 read=0
   - Limit > Nested Loop > Index Scan using conversation_inbox_idx > Index Scan using contact_pkey
5. `select distinct on ("contact_permission_event"."contact_id", "contact_permission_event"."channel") "id", "organization_id", "contact_id", "channel", "status", "`
   - 1.01 ms, planning 1.00 ms, buffers hit=182 read=0
   - Unique > Sort > Bitmap Heap Scan on contact_permission_event > Bitmap Index Scan using contact_permission_event_contact_channel_idx
6. `select "id", "organization_id", "channel", "provider", "address", "registration_status", "created_at", "updated_at" from "channel_connection" where "channel_con`
   - 0.06 ms, planning 0.53 ms, buffers hit=1 read=0
   - Seq Scan on channel_connection

## conversations.search.name

- **FAIL**: seq scan on contact
1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.11 ms, planning 0.75 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.05 ms, planning 0.29 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.08 ms, planning 0.62 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "conversation"."id", "conversation"."organization_id", "conversation"."contact_id", "conversation"."channel", "conversation"."last_activity_at", "convers`
   - 134.97 ms, planning 2.52 ms, buffers hit=7042 read=3176
   - Limit > Gather Merge > Sort > Nested Loop > Seq Scan on contact > Index Scan using conversation_organization_id_contact_id_channel_unique
5. `select distinct on ("contact_permission_event"."contact_id", "contact_permission_event"."channel") "id", "organization_id", "contact_id", "channel", "status", "`
   - 0.94 ms, planning 0.76 ms, buffers hit=174 read=0
   - Unique > Sort > Bitmap Heap Scan on contact_permission_event > Bitmap Index Scan using contact_permission_event_contact_channel_idx
6. `select "id", "organization_id", "channel", "provider", "address", "registration_status", "created_at", "updated_at" from "channel_connection" where "channel_con`
   - 0.05 ms, planning 0.54 ms, buffers hit=1 read=0
   - Seq Scan on channel_connection

## conversations.search.digits

- **FAIL**: seq scan on contact
1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.17 ms, planning 1.41 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.08 ms, planning 0.39 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.09 ms, planning 0.42 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "conversation"."id", "conversation"."organization_id", "conversation"."contact_id", "conversation"."channel", "conversation"."last_activity_at", "convers`
   - 72.50 ms, planning 2.56 ms, buffers hit=1209 read=2984
   - Limit > Gather Merge > Sort > Nested Loop > Seq Scan on contact > Index Scan using conversation_organization_id_contact_id_channel_unique
5. `select distinct on ("contact_permission_event"."contact_id", "contact_permission_event"."channel") "id", "organization_id", "contact_id", "channel", "status", "`
   - 0.22 ms, planning 0.69 ms, buffers hit=22 read=0
   - Unique > Index Scan using contact_permission_event_contact_channel_idx
6. `select "id", "organization_id", "channel", "provider", "address", "registration_status", "created_at", "updated_at" from "channel_connection" where "channel_con`
   - 0.05 ms, planning 0.54 ms, buffers hit=1 read=0
   - Seq Scan on channel_connection

## conversations.thread.first

- **FAIL**: over budget (132.55 ms > 50 ms)
1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.11 ms, planning 0.73 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.07 ms, planning 0.33 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.08 ms, planning 0.74 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "conversation"."id", "conversation"."organization_id", "conversation"."contact_id", "conversation"."channel", "conversation"."last_activity_at", "convers`
   - 0.43 ms, planning 1.91 ms, buffers hit=3 read=5
   - Limit > Nested Loop > Index Scan using conversation_pkey > Index Scan using contact_pkey
5. `select * from ( select 'message'::text as kind, m.id, m.occurred_at, to_char(m.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as occurred_key,`
   - 131.85 ms, planning 1.96 ms, buffers hit=6402 read=3234
   - Limit > Sort > Append > Hash Join > Bitmap Heap Scan on message > Bitmap Index Scan using message_conversation_idx > Hash > Seq Scan on message_template > Nested Loop > Index Scan using timeline_event_conversation_ref_idx > Memoize > Index Scan using user_pkey

## conversations.thread.deep

- **FAIL**: over budget (68.53 ms > 50 ms)
1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.09 ms, planning 0.71 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.04 ms, planning 0.18 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.04 ms, planning 0.22 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "conversation"."id", "conversation"."organization_id", "conversation"."contact_id", "conversation"."channel", "conversation"."last_activity_at", "convers`
   - 0.37 ms, planning 3.07 ms, buffers hit=8 read=0
   - Limit > Nested Loop > Index Scan using conversation_pkey > Index Scan using contact_pkey
5. `select * from ( select 'message'::text as kind, m.id, m.occurred_at, to_char(m.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as occurred_key,`
   - 68.00 ms, planning 1.97 ms, buffers hit=8828 read=0
   - Limit > Sort > Append > Hash Join > Bitmap Heap Scan on message > Bitmap Index Scan using message_conversation_idx > Hash > Seq Scan on message_template > Nested Loop > Index Scan using timeline_event_conversation_ref_idx > Memoize > Index Scan using user_pkey

## messages.detail

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.14 ms, planning 0.98 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.07 ms, planning 0.32 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.07 ms, planning 0.49 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "message"."id", "message"."organization_id", "message"."conversation_id", "message"."contact_id", "message"."channel", "message"."direction", "message"."`
   - 0.21 ms, planning 2.36 ms, buffers hit=6 read=0
   - Limit > Hash Join > Seq Scan on message_template > Hash > Index Scan using message_pkey
5. `select "id", "organization_id", "message_id", "status", "applied", "occurred_at", "raw_event_id", "error_code", "created_at" from "message_status_event" where "`
   - 0.10 ms, planning 0.41 ms, buffers hit=14 read=0
   - Incremental Sort > Index Scan using message_status_event_message_idx

## templates.list

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.12 ms, planning 0.99 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.18 ms, planning 0.29 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.06 ms, planning 0.38 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "name", "channel", "body", "approval_status", "archived_at", "created_by", "created_at", "whatsapp_template_name", "whatsapp_lan`
   - 0.44 ms, planning 1.18 ms, buffers hit=5 read=0
   - Sort > Seq Scan on message_template

## templates.list.sms

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.08 ms, planning 0.55 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.06 ms, planning 0.33 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.07 ms, planning 0.32 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "name", "channel", "body", "approval_status", "archived_at", "created_by", "created_at", "whatsapp_template_name", "whatsapp_lan`
   - 0.52 ms, planning 0.65 ms, buffers hit=5 read=0
   - Sort > Seq Scan on message_template

## numbers.list

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.08 ms, planning 0.52 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.08 ms, planning 0.39 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.07 ms, planning 0.64 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "provider", "provider_number_id", "e164", "status", "voice", "sms", "mms", "whatsapp", "ten_dlc_status", "whatsapp_status", "ass`
   - 0.36 ms, planning 1.11 ms, buffers hit=10 read=0
   - Sort > Seq Scan on phone_number

## usage.summary

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.14 ms, planning 1.05 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.08 ms, planning 0.29 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.07 ms, planning 0.47 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select to_char("created_at" at time zone 'UTC', 'YYYY-MM-DD'), "kind", case "ref_type" when 'call' then 'voice' when 'sms' then 'sms' when 'whatsapp' then 'what`
   - 0.75 ms, planning 1.17 ms, buffers hit=5 read=0
   - Aggregate > Result > Index Scan using ledger_entry_org_created_idx

## usage.ledger.first

- **FAIL**: over budget (1736.82 ms > 100 ms)
1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.12 ms, planning 0.84 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.08 ms, planning 0.42 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.08 ms, planning 0.42 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "created_at", to_char("created_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), "kind", case "ref_type" when 'call' then 'voice' when 'sms`
   - 1736.54 ms, planning 1.93 ms, buffers hit=3479 read=10331
   - Limit > Sort > Subquery Scan > WindowAgg > Result > Index Scan using ledger_entry_org_created_idx

## usage.ledger.deep

- **FAIL**: over budget (1115.28 ms > 100 ms)
1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.11 ms, planning 1.07 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.08 ms, planning 0.41 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.07 ms, planning 0.48 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "created_at", to_char("created_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), "kind", case "ref_type" when 'call' then 'voice' when 'sms`
   - 1115.02 ms, planning 1.41 ms, buffers hit=13810 read=0
   - Limit > Sort > Subquery Scan > WindowAgg > Result > Index Scan using ledger_entry_org_created_idx

## usage.ledger.filtered

- **FAIL**: over budget (953.34 ms > 100 ms)
1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.13 ms, planning 0.84 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.06 ms, planning 0.32 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.07 ms, planning 0.42 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "created_at", to_char("created_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), "kind", case "ref_type" when 'call' then 'voice' when 'sms`
   - 953.08 ms, planning 1.53 ms, buffers hit=13810 read=0
   - Limit > Sort > Subquery Scan > WindowAgg > Result > Index Scan using ledger_entry_org_created_idx

## usage.reconciliations.first

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.15 ms, planning 0.90 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.07 ms, planning 0.35 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.07 ms, planning 0.50 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "period_date", "service", "trigger", "status", "captured_micros", "provider_micros", "ledger_micros", "drift_micros", "adjust_en`
   - 1.02 ms, planning 1.17 ms, buffers hit=13 read=0
   - Limit > Sort > Result > Seq Scan on reconciliation_report

## usage.reconciliations.deep

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.16 ms, planning 0.85 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.05 ms, planning 0.39 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.06 ms, planning 0.40 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "period_date", "service", "trigger", "status", "captured_micros", "provider_micros", "ledger_micros", "drift_micros", "adjust_en`
   - 0.76 ms, planning 1.27 ms, buffers hit=13 read=0
   - Limit > Sort > Result > Seq Scan on reconciliation_report

## numbers.orders

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.12 ms, planning 0.82 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.08 ms, planning 0.27 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.05 ms, planning 0.36 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "quote_id", "provider", "e164", "idempotency_key", "status", "provider_order_id", "upfront_micros", "monthly_micros", "reservati`
   - 0.35 ms, planning 1.21 ms, buffers hit=11 read=0
   - Limit > Sort > Seq Scan on number_order

## tasks.open.first

- **FAIL**: seq scan on task
- **FAIL**: seq scan on contact
- **FAIL**: over budget (219.43 ms > 50 ms)
1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.09 ms, planning 0.56 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.07 ms, planning 0.30 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.06 ms, planning 0.32 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "task"."id", "task"."organization_id", "task"."owner_user_id", "task"."contact_id", "task"."title", "task"."notes", "task"."due_at", "task"."remind_at", `
   - 219.21 ms, planning 2.18 ms, buffers hit=612 read=4084
   - Limit > Sort > Hash Join > Seq Scan on task > Hash > Seq Scan on contact

## tasks.open.deep

- **FAIL**: seq scan on task
- **FAIL**: seq scan on contact
- **FAIL**: over budget (178.28 ms > 50 ms)
1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.16 ms, planning 0.96 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.07 ms, planning 0.54 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.07 ms, planning 0.36 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "task"."id", "task"."organization_id", "task"."owner_user_id", "task"."contact_id", "task"."title", "task"."notes", "task"."due_at", "task"."remind_at", `
   - 177.98 ms, planning 2.05 ms, buffers hit=676 read=4020
   - Limit > Sort > Hash Join > Seq Scan on task > Hash > Seq Scan on contact

## tasks.done.first

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.13 ms, planning 1.00 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.08 ms, planning 0.38 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.07 ms, planning 0.56 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "task"."id", "task"."organization_id", "task"."owner_user_id", "task"."contact_id", "task"."title", "task"."notes", "task"."due_at", "task"."remind_at", `
   - 7.23 ms, planning 2.36 ms, buffers hit=867 read=0
   - Limit > Incremental Sort > Nested Loop > Index Scan using task_owner_completed_idx > Memoize > Index Scan using contact_pkey

## tasks.done.deep

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.10 ms, planning 1.25 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.07 ms, planning 0.28 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.06 ms, planning 0.40 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "task"."id", "task"."organization_id", "task"."owner_user_id", "task"."contact_id", "task"."title", "task"."notes", "task"."due_at", "task"."remind_at", `
   - 2.34 ms, planning 2.49 ms, buffers hit=199 read=0
   - Limit > Incremental Sort > Nested Loop > Index Scan using task_owner_completed_idx > Memoize > Index Scan using contact_pkey

## tasks.byContact

- **FAIL**: seq scan on task
1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.14 ms, planning 0.90 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.07 ms, planning 0.32 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.06 ms, planning 0.37 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "task"."id", "task"."organization_id", "task"."owner_user_id", "task"."contact_id", "task"."title", "task"."notes", "task"."due_at", "task"."remind_at", `
   - 21.28 ms, planning 2.21 ms, buffers hit=584 read=0
   - Limit > Sort > Nested Loop > Seq Scan on task > Materialize > Index Scan using contact_pkey

## notifications.list

- **FAIL**: seq scan on task
1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.11 ms, planning 0.97 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.08 ms, planning 0.35 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.09 ms, planning 0.57 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "title", "remind_at" from "task" where (("task"."organization_id" = $1 and "task"."owner_user_id" = $2 and "task"."status" = $3) and "task"."remind`
   - 10.44 ms, planning 1.08 ms, buffers hit=574 read=0
   - Result > Seq Scan on task
5. `select "id", "title", "due_at" from "task" where (("task"."organization_id" = $1 and "task"."owner_user_id" = $2 and "task"."status" = $3) and "task"."due_at" i`
   - 1.14 ms, planning 0.20 ms, buffers hit=375 read=0
   - Result > Bitmap Heap Scan on task > Bitmap Index Scan using task_owner_status_due_idx
6. `insert into "notification" ("id", "organization_id", "user_id", "kind", "title", "body", "ref_type", "ref_id", "dedupe_key", "read_at", "created_at") values ($1`
   - 10.13 ms, planning 2.50 ms, buffers hit=2319 read=0
   - ModifyTable on notification > Values Scan
7. `select "id", "organization_id", "user_id", "kind", "title", "body", "ref_type", "ref_id", "dedupe_key", "read_at", "created_at" from "notification" where ("noti`
   - 0.10 ms, planning 0.51 ms, buffers hit=23 read=0
   - Limit > Result > Index Scan using notification_user_created_idx
8. `select count(*)::int from "notification" where (("notification"."organization_id" = $1 and "notification"."user_id" = $2) and "notification"."read_at" is null)`
   - 1.49 ms, planning 0.17 ms, buffers hit=128 read=0
   - Aggregate > Result > Seq Scan on notification
