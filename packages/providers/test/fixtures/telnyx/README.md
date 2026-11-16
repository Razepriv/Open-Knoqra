# Telnyx webhook fixtures

These files are hand-written from Telnyx's public v2 webhook documentation. They were not recorded
from a live account. Phone numbers use the reserved +1 202 555 01xx range and every id is made up.
`client_state` values are base64 of `idem_key_1`, `idem_key_2` and `idem_key_3`.

The REST fixtures (`balance.json`, `phone-numbers-page-1.json`, `phone-numbers-page-2.json`,
`phone-number-campaigns.json`, `detail-records.json`) are likewise hand-written from Telnyx's
documented v2 response shapes, not recorded. They must be checked against a live account before
anyone relies on the field names. Numbers use +1 202 555 01xx and every id is made up.

`available-phone-numbers.json` (search and quote) and `number-order-created.json` (a pending order)
are also hand-written from the documented Telnyx v2 shapes, not recorded. Both endpoints must be
checked against a live account before a real purchase. Numbers use +1 202 555 01xx and every id is
made up.

## WhatsApp account reads (messaging upgrade, 2026-11-16)

Built from Telnyx's OpenAPI document (`team-telnyx/openapi` spec3.json, `WhatsappPhoneResponse` and
`ListWabas`) and the Embedded Signup guide's status table, not recorded:

- `whatsapp-phone-numbers.json`: `GET /v2/whatsapp/phone_numbers`. One CONNECTED number and one
  still PENDING, with the documented fields (`status`, `waba_id`, `display_name`,
  `quality_rating`, `coexistence_state`).
- `whatsapp-business-accounts.json`: `GET /v2/whatsapp/business_accounts`. One ACTIVE account with
  `account_review_status` APPROVED and one PENDING.
