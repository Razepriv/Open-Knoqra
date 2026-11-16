# Explain report 2026-11-12

Overall: **FAIL** (7 of 16 cases)

- Database: knoqra_s9_perf (101100 contacts, 1010103 timeline events)
- Machine: win32, 16 CPUs, Node 22.21.0, PostgreSQL 17.11
- Role: knoqra_app with RLS, EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) per captured statement
- Partial: import.upsert committed writes, so the replay hit unique-key conflicts on re-insert (R5) and skipped those statements; their DB ms covers the rest only
- The seed database still holds writes from earlier import-case runs (no re-seed since).

| Case | Milestone | Status | DB ms | Budget ms | Statements | Seq scans |
|---|---|---|---|---|---|---|
| contacts.list.first | M1 | PASS | 1.18 | 50 | 4 | - |
| contacts.list.deep | M1 | **FAIL** | 176.04 | 50 | 4 | - |
| contacts.list.archived | M1 | PASS | 16.12 | 50 | 4 | - |
| contacts.search.name | M1 | **FAIL** | 203.11 | 150 | 4 | contact |
| contacts.search.company | M1 | **FAIL** | 295.98 | 150 | 4 | contact |
| contacts.search.email | M1 | **FAIL** | 282.16 | 150 | 4 | contact |
| contacts.search.digits | M1 | **FAIL** | 1089.75 | 150 | 4 | - |
| contacts.search.rare | M1 | **FAIL** | 281.97 | 150 | 4 | contact |
| contacts.detail | M1 | PASS | 0.51 | 20 | 4 | - |
| timeline.first | M1 | PASS | 1.03 | 50 | 5 | - |
| timeline.deep | M1 | PASS | 1.01 | 50 | 5 | - |
| timeline.calls | M1 | PASS | 2.01 | 50 | 5 | - |
| timeline.notes_consent | M1 | PASS | 1.33 | 50 | 5 | - |
| permissions | M1 | PASS | 0.49 | 20 | 5 | - |
| duplicates | M1 | **FAIL** | 476.20 | 50 | 5 | contact |
| import.upsert | M1 | PASS | 5.54 | 150 | 5 | - |

## contacts.list.first

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.12 ms, planning 0.94 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.06 ms, planning 0.33 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.06 ms, planning 0.34 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 0.94 ms, planning 0.98 ms, buffers hit=55 read=0
   - Limit > Index Scan using contact_organization_id_lower_display_name_idx

## contacts.list.deep

- **FAIL**: over budget (176.04 ms > 50 ms)
1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.12 ms, planning 0.78 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.07 ms, planning 0.50 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.09 ms, planning 0.33 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 175.76 ms, planning 1.34 ms, buffers hit=52469 read=0
   - Limit > Index Scan using contact_organization_id_lower_display_name_idx

## contacts.list.archived

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.12 ms, planning 1.20 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.06 ms, planning 0.37 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.09 ms, planning 0.39 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 15.84 ms, planning 1.46 ms, buffers hit=1276 read=0
   - Limit > Index Scan using contact_organization_id_lower_display_name_idx

## contacts.search.name

- **FAIL**: over budget (203.11 ms > 150 ms)
1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.11 ms, planning 0.82 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.06 ms, planning 0.33 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.06 ms, planning 0.42 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 202.89 ms, planning 2.17 ms, buffers hit=2915 read=0
   - Limit > Gather Merge > Sort > Seq Scan on contact

## contacts.search.company

- **FAIL**: over budget (295.98 ms > 150 ms)
1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.12 ms, planning 0.83 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.08 ms, planning 0.38 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.08 ms, planning 0.45 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 295.69 ms, planning 1.22 ms, buffers hit=2915 read=0
   - Limit > Gather Merge > Sort > Seq Scan on contact

## contacts.search.email

- **FAIL**: over budget (282.16 ms > 150 ms)
1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.09 ms, planning 1.10 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.09 ms, planning 0.36 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.09 ms, planning 0.42 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 281.90 ms, planning 1.13 ms, buffers hit=2915 read=0
   - Limit > Gather Merge > Sort > Seq Scan on contact

## contacts.search.digits

- **FAIL**: over budget (1089.75 ms > 150 ms)
1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.13 ms, planning 1.15 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.06 ms, planning 0.38 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.09 ms, planning 0.54 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 1089.47 ms, planning 1.42 ms, buffers hit=101844 read=0
   - Limit > Index Scan using contact_organization_id_lower_display_name_idx

## contacts.search.rare

- **FAIL**: over budget (281.97 ms > 150 ms)
1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.09 ms, planning 0.77 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.07 ms, planning 0.35 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.09 ms, planning 0.45 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 281.71 ms, planning 1.41 ms, buffers hit=2915 read=0
   - Limit > Gather Merge > Sort > Seq Scan on contact

## contacts.detail

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.23 ms, planning 0.97 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.06 ms, planning 0.37 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.08 ms, planning 0.38 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 0.14 ms, planning 1.62 ms, buffers hit=4 read=0
   - Limit > Index Scan using contact_pkey

## timeline.first

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.09 ms, planning 0.70 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.05 ms, planning 0.37 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.08 ms, planning 0.32 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 0.14 ms, planning 1.20 ms, buffers hit=4 read=0
   - Limit > Index Scan using contact_pkey
5. `select "id", "organization_id", "contact_id", "kind", "title", "body", "actor_user_id", "source", "ref_type", "ref_id", "occurred_at", "created_at", to_char("oc`
   - 0.67 ms, planning 0.76 ms, buffers hit=55 read=0
   - Limit > Index Scan using timeline_event_contact_occurred_idx

## timeline.deep

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.12 ms, planning 0.89 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.06 ms, planning 0.32 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.08 ms, planning 0.55 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 0.14 ms, planning 1.19 ms, buffers hit=4 read=0
   - Limit > Index Scan using contact_pkey
5. `select "id", "organization_id", "contact_id", "kind", "title", "body", "actor_user_id", "source", "ref_type", "ref_id", "occurred_at", "created_at", to_char("oc`
   - 0.62 ms, planning 0.66 ms, buffers hit=56 read=0
   - Limit > Index Scan using timeline_event_contact_occurred_idx

## timeline.calls

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.16 ms, planning 0.87 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.07 ms, planning 0.37 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.08 ms, planning 0.47 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 0.15 ms, planning 1.24 ms, buffers hit=4 read=0
   - Limit > Index Scan using contact_pkey
5. `select "id", "organization_id", "contact_id", "kind", "title", "body", "actor_user_id", "source", "ref_type", "ref_id", "occurred_at", "created_at", to_char("oc`
   - 1.55 ms, planning 0.67 ms, buffers hit=356 read=0
   - Limit > Index Scan using timeline_event_contact_occurred_idx

## timeline.notes_consent

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.09 ms, planning 0.75 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.07 ms, planning 0.46 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.08 ms, planning 0.38 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 0.15 ms, planning 1.19 ms, buffers hit=4 read=0
   - Limit > Index Scan using contact_pkey
5. `select "id", "organization_id", "contact_id", "kind", "title", "body", "actor_user_id", "source", "ref_type", "ref_id", "occurred_at", "created_at", to_char("oc`
   - 0.94 ms, planning 0.68 ms, buffers hit=133 read=0
   - Limit > Index Scan using timeline_event_contact_occurred_idx

## permissions

1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.12 ms, planning 1.07 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.06 ms, planning 0.37 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.09 ms, planning 0.37 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 0.14 ms, planning 1.12 ms, buffers hit=4 read=0
   - Limit > Index Scan using contact_pkey
5. `select distinct on ("contact_permission_event"."channel") "id", "organization_id", "contact_id", "channel", "status", "source", "evidence", "actor_user_id", "cr`
   - 0.09 ms, planning 0.68 ms, buffers hit=4 read=0
   - Unique > Index Scan using contact_permission_event_contact_channel_idx

## duplicates

- **FAIL**: seq scan on contact
- **FAIL**: over budget (476.20 ms > 50 ms)
1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.10 ms, planning 1.12 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.05 ms, planning 0.31 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.06 ms, planning 0.32 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 0.16 ms, planning 1.14 ms, buffers hit=4 read=0
   - Limit > Index Scan using contact_pkey
5. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 475.82 ms, planning 4.78 ms, buffers hit=2926 read=0
   - Limit > Nested Loop > Gather Merge > Sort > Seq Scan on contact > Materialize > Bitmap Heap Scan on contact_duplicate_dismissal > BitmapOr > Bitmap Index Scan using contact_duplicate_dismissal_pair_unique > Bitmap Index Scan using contact_duplicate_dismissal_org_b_idx

## import.upsert

- Note: duplicate key value violates unique constraint "audit_event_pkey"
1. `select "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id" from "session" where "session"."`
   - 0.23 ms, planning 0.91 ms, buffers hit=2 read=0
   - Index Scan using session_token_unique
2. `select "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "two_factor_enabled" from "user" where "user"."id" = $1`
   - 0.07 ms, planning 1.06 ms, buffers hit=2 read=0
   - Index Scan using user_pkey
3. `select "role" from "member" where ("member"."user_id" = $1 and "member"."organization_id" = $2) limit $3`
   - 0.16 ms, planning 0.38 ms, buffers hit=2 read=0
   - Limit > Bitmap Heap Scan on member > Bitmap Index Scan using member_userId_idx
4. `select "id", "organization_id", "display_name", "company", "phone_e164", "timezone", "source", "email", "job_title", "tags", "source_detail", "archived_at", "me`
   - 5.07 ms, planning 1.45 ms, buffers hit=333 read=0
   - LockRows > Sort > Result > Index Scan using contact_organization_id_phone_e164_unique
5. `insert into "audit_event" ("id", "organization_id", "actor_user_id", "action", "entity_type", "entity_id", "outcome", "metadata", "created_at") values ($1, $2, `
   - 0.00 ms, planning 0.00 ms, buffers -
   - not replayed: duplicate key value violates unique constraint "audit_event_pkey"
