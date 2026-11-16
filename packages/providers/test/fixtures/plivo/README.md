# Plivo fixtures

Hand-written from Plivo's public docs (`plivo.com/docs/...`) and the official SDK sources (plivo-node,
plivo-python and their test fixtures). None was recorded from a live account: there is no Plivo
account behind KNOQRA yet. Every field name, every value format and every time format here must be
checked against a live account before anyone relies on it. Numbers use the reserved
+1 202 555 01xx range, Auth IDs and UUIDs are made up.

REST (`/v1/Account/<authId>/...`, wrapper `{ api_id, meta: { limit, next, offset, previous,
total_count }, objects }` for lists):

- `numbers-page-1.json`, `numbers-page-2.json`: `GET Number/` (rented numbers), two pages.
- `phone-numbers-search.json`: `GET PhoneNumber/?country_iso=US...` (search), prices as USD strings.
  The third number carries a `restriction`, which KNOQRA leaves out.
- `number-order-fulfilled.json`, `number-order-pending.json`: `POST PhoneNumber/<number>/`.
- `account.json`: `GET Account/<authId>/`, `cash_credits` as a USD string.
- `cdrs.json`: `GET Call/` (call detail records). `end_time` carries an offset in Plivo's examples;
  which time zone the `end_time__gte` filter reads is not confirmed.
- `endpoint-created.json`: `POST Endpoint/`. Plivo appends 12 digits to the username sent.
- `jwt-token.json`: `POST JWT/Token/`.
- `call-created.json`: `POST Call/`.

Callbacks (form fields, posted `application/x-www-form-urlencoded`; the encoding is inferred from
the SDK validators, not stated in the docs):

- `answer-browser.json`: the answer request for a call the browser SDK placed, with the
  `X-PH-ClientState` header passed as a field.
- `answer-inbound.json`: the answer request for a call to a Plivo number.
- `dial-answer.json`, `dial-hangup-busy.json`: `<Dial callbackUrl>` requests.
- `hangup-normal.json`: the application's hangup request.
