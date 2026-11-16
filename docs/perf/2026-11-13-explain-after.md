# Explain report 2026-11-13

Overall: PASS

- Database: knoqra_s9_perf (101100 contacts, 1010103 timeline events)
- Machine: win32, 16 CPUs, Node 22.21.0, PostgreSQL 17.11
- Role: knoqra_app with RLS, EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) per captured statement
- Partial: import.upsert committed writes, so the replay hit unique-key conflicts on re-insert (R5) and skipped those statements; their DB ms covers the rest only

| Case | Milestone | Status | DB ms | Budget ms | Statements | Seq scans |
|---|---|---|---|---|---|---|
| contacts.list.first | M1 | PASS | 0.51 | 50 | 4 | - |
| contacts.list.deep | M1 | PASS | 0.69 | 50 | 4 | - |
| contacts.list.archived | M1 | PASS | 0.52 | 50 | 4 | - |
| contacts.search.name | M1 | PASS | 120.92 | 150 | 4 | contact |
| contacts.search.company | M1 | PASS | 83.40 | 150 | 4 | contact |
| contacts.search.email | M1 | PASS | 85.48 | 150 | 4 | contact |
| contacts.search.digits | M1 | PASS | 85.06 | 150 | 4 | contact |
| contacts.search.rare | M1 | PASS | 91.69 | 150 | 4 | contact |
| contacts.detail | M1 | PASS | 0.34 | 20 | 4 | - |
| timeline.first | M1 | PASS | 1.00 | 50 | 5 | - |
| timeline.deep | M1 | PASS | 1.01 | 50 | 5 | - |
| timeline.calls | M1 | PASS | 2.17 | 50 | 5 | - |
| timeline.notes_consent | M1 | PASS | 1.42 | 50 | 5 | - |
| permissions | M1 | PASS | 0.57 | 20 | 5 | - |
| duplicates | M1 | PASS | 1.63 | 50 | 5 | - |
| import.upsert | M1 | PASS | 2.35 | 150 | 5 | - |

## contacts.list.first

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.12 ms, planning 1.07 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.06 ms, planning 0.44 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.10 ms, planning 0.36 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 0.24 ms, planning 1.12 ms, buffers hit=54 read=0
   - Limit > Index Scan using contact_active_sort_idx

## contacts.list.deep

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.18 ms, planning 1.00 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.05 ms, planning 0.40 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.10 ms, planning 0.39 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 0.36 ms, planning 1.29 ms, buffers hit=55 read=0
   - Limit > Index Scan using contact_active_sort_idx

## contacts.list.archived

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.12 ms, planning 0.95 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.06 ms, planning 0.34 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.08 ms, planning 0.45 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 0.27 ms, planning 1.70 ms, buffers hit=54 read=0
   - Limit > Index Scan using contact_inactive_sort_idx

## contacts.search.name

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.12 ms, planning 0.89 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.05 ms, planning 0.36 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.10 ms, planning 0.39 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 120.65 ms, planning 1.54 ms, buffers hit=4186 read=0
   - Limit > Gather Merge > Sort > Seq Scan on contact

## contacts.search.company

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.10 ms, planning 0.80 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.07 ms, planning 0.42 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.07 ms, planning 0.32 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 83.17 ms, planning 1.52 ms, buffers hit=4186 read=0
   - Limit > Gather Merge > Sort > Seq Scan on contact

## contacts.search.email

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.10 ms, planning 0.93 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.04 ms, planning 0.27 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.08 ms, planning 0.36 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 85.27 ms, planning 1.52 ms, buffers hit=4186 read=0
   - Limit > Gather Merge > Sort > Seq Scan on contact

## contacts.search.digits

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.21 ms, planning 5.90 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.06 ms, planning 0.34 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.11 ms, planning 0.63 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 84.70 ms, planning 2.04 ms, buffers hit=4186 read=0
   - Limit > Gather Merge > Sort > Seq Scan on contact

## contacts.search.rare

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.14 ms, planning 0.98 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.05 ms, planning 0.32 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.09 ms, planning 0.38 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 91.41 ms, planning 1.62 ms, buffers hit=4186 read=0
   - Limit > Gather Merge > Sort > Seq Scan on contact

## contacts.detail

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.08 ms, planning 0.60 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.04 ms, planning 0.34 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.10 ms, planning 0.40 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 0.12 ms, planning 1.40 ms, buffers hit=4 read=0
   - Limit > Index Scan using contact_pkey

## timeline.first

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.10 ms, planning 0.73 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.05 ms, planning 0.35 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.10 ms, planning 0.43 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 0.11 ms, planning 1.30 ms, buffers hit=4 read=0
   - Limit > Index Scan using contact_pkey
5. `select "id", "organization_id", "contact_id", "kind", "title", "body", "actor_user_id", "source", "ref_type", "ref_id", "occurred_at", "created_at", to_char("oc`
   - 0.64 ms, planning 0.57 ms, buffers hit=55 read=0
   - Limit > Index Scan using timeline_event_contact_occurred_idx

## timeline.deep

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.10 ms, planning 0.74 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.03 ms, planning 0.25 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.11 ms, planning 0.52 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 0.19 ms, planning 1.45 ms, buffers hit=4 read=0
   - Limit > Index Scan using contact_pkey
5. `select "id", "organization_id", "contact_id", "kind", "title", "body", "actor_user_id", "source", "ref_type", "ref_id", "occurred_at", "created_at", to_char("oc`
   - 0.58 ms, planning 0.77 ms, buffers hit=56 read=0
   - Limit > Index Scan using timeline_event_contact_occurred_idx

## timeline.calls

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.12 ms, planning 0.76 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.06 ms, planning 0.38 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.08 ms, planning 0.35 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 0.14 ms, planning 1.50 ms, buffers hit=4 read=0
   - Limit > Index Scan using contact_pkey
5. `select "id", "organization_id", "contact_id", "kind", "title", "body", "actor_user_id", "source", "ref_type", "ref_id", "occurred_at", "created_at", to_char("oc`
   - 1.78 ms, planning 0.65 ms, buffers hit=356 read=0
   - Limit > Index Scan using timeline_event_contact_occurred_idx

## timeline.notes_consent

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.12 ms, planning 0.86 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.05 ms, planning 0.42 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.08 ms, planning 0.34 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 0.15 ms, planning 1.58 ms, buffers hit=4 read=0
   - Limit > Index Scan using contact_pkey
5. `select "id", "organization_id", "contact_id", "kind", "title", "body", "actor_user_id", "source", "ref_type", "ref_id", "occurred_at", "created_at", to_char("oc`
   - 1.01 ms, planning 6.85 ms, buffers hit=133 read=0
   - Limit > Index Scan using timeline_event_contact_occurred_idx

## permissions

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.10 ms, planning 0.79 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.06 ms, planning 0.38 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.08 ms, planning 0.37 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 0.17 ms, planning 1.46 ms, buffers hit=4 read=0
   - Limit > Index Scan using contact_pkey
5. `select distinct on ("contact_permission_event"."channel") "id", "organization_id", "contact_id", "channel", "status", "source", "evidence", "actor_user_id", "cr`
   - 0.17 ms, planning 0.71 ms, buffers hit=4 read=0
   - Unique > Index Scan using contact_permission_event_contact_channel_idx

## duplicates

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.11 ms, planning 1.00 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.07 ms, planning 0.37 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.10 ms, planning 0.44 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 0.14 ms, planning 1.43 ms, buffers hit=4 read=0
   - Limit > Index Scan using contact_pkey
5. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 1.21 ms, planning 1.69 ms, buffers hit=58 read=0
   - Limit > Sort > Nested Loop > Bitmap Heap Scan on contact > BitmapOr > Bitmap Index Scan using contact_active_name_key_idx > Bitmap Index Scan using contact_active_email_key_idx > Materialize > Bitmap Heap Scan on contact_duplicate_dismissal > BitmapOr > Bitmap Index Scan using contact_duplicate_dismissal_pair_unique > Bitmap Index Scan using contact_duplicate_dismissal_org_b_idx

## import.upsert

- Note: duplicate key value violates unique constraint "audit_event_pkey"
1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.13 ms, planning 0.89 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.07 ms, planning 0.38 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.09 ms, planning 0.44 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 2.06 ms, planning 2.04 ms, buffers hit=329 read=0
   - LockRows > Sort > Result > Index Scan using contact_organization_id_phone_e164_unique
5. `insert into "audit_event" ("id", "organization_id", "actor_user_id", "action", "entity_type", "entity_id", "outcome", "metadata", "created_at") values ($1, $2, `
   - 0.00 ms, planning 0.00 ms, buffers -
   - not replayed: duplicate key value violates unique constraint "audit_event_pkey"
