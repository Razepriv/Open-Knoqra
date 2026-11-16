# Telnyx messaging fixtures

These fixtures were **built from Telnyx's published documentation, not recorded**.
No Telnyx account or API key was used, so no fixture has been checked against a
live response. Each file follows the documented example for its endpoint or event
as closely as possible, with these changes:

- Phone numbers are replaced with reserved test numbers in `+1 202 555 01xx`
  (`+12025550100` is our number, `+12025550123` is the contact).
- Ids, organization ids and messaging profile ids are obviously fake
  (`00000000-...` UUIDs, or the docs' own sample UUIDs). Keys are `KEY_FAKE_...`.
- Fields that only one doc page shows are kept as that page shows them. No field
  is invented. Where a doc page gives no full example, the fixture uses only fields
  that the page names, and the gap is noted below.

Docs read on 2026-11-13.

## Sending (Task 1)

| Fixture | Source |
| --- | --- |
| `send-sms-response.json` | 200 example of `POST /v2/messages`: https://developers.telnyx.com/api/messaging/send-message (SMS instead of the example's MMS, so `media` is empty and `subject` is dropped) |
| `send-whatsapp-text-request.json` | Free-text example of `POST /v2/messages/whatsapp`: https://developers.telnyx.com/docs/messaging/whatsapp/send-messages (the optional `preview_url: false` is left out; it is the default per the API reference) |
| `send-whatsapp-template-request.json` | Template example with two body parameters, same page: https://developers.telnyx.com/docs/messaging/whatsapp/send-messages |
| `send-whatsapp-response.json` | `WhatsappResponse` schema and example values of `POST /v2/messages/whatsapp`: https://developers.telnyx.com/api-reference/whatsapp-messaging/send-a-whatsapp-message (the page shows no single complete 200 example, so this is assembled from the schema's example values) |
| `error-40300-stop.json` | Error body shape `{"errors":[{code,title,detail,source}]}` from https://developers.telnyx.com/api/messaging/send-message; code, title and detail from https://developers.telnyx.com/docs/overview/errors/40300 and https://developers.telnyx.com/docs/messaging/messages/error-codes |
| `error-400-invalid-to.json` | Same error body shape; code 40310 "Invalid 'to' address" from https://developers.telnyx.com/docs/messaging/messages/error-codes. The `detail` deliberately echoes a phone number and a fake key, so the leak test can prove neither reaches an error message |
| `error-401-auth.json` | Same error body shape; code 10009 "Authentication failed" from https://developers.telnyx.com/docs/overview/errors/10009 |

## Webhooks (Task 2)

Event envelope: `{ "data": { "record_type": "event", "id", "event_type", "occurred_at", "payload" }, "meta": { "attempt", "delivered_to" } }`.

| Fixture | Source |
| --- | --- |
| `webhook-sms-received.json` | `message.received` example: https://developers.telnyx.com/docs/messaging/messages/receiving-webhooks and the payload field table at https://developers.telnyx.com/docs/messaging/messages/receive-message |
| `webhook-mms-only-received.json` | Inbound MMS example (`type: MMS`, `media[]` with `url`, `content_type`, `sha256`, `size`) at https://developers.telnyx.com/docs/messaging/messages/receive-message, with `text` set to `null` as that page documents for media-only MMS |
| `webhook-whatsapp-received.json` | `message.received` with `payload.type: "WHATSAPP"`, text at `payload.body.text.body`, sender at `payload.from.phone_number`: the handler code and webhook list in https://developers.telnyx.com/docs/messaging/whatsapp/quickstart. That page has no complete inbound sample, so the remaining fields follow the SMS `message.received` example |
| `webhook-sms-sent.json` | `message.sent` example: https://developers.telnyx.com/docs/messaging/messages/receiving-webhooks |
| `webhook-sms-finalized-delivered.json` | `message.finalized` example with `to[0].status: "delivered"`, same page |
| `webhook-sms-finalized-failed.json` | Same `message.finalized` example with `to[0].status: "delivery_failed"` and an `errors[]` item (`code`, `title`, `detail`, `source.pointer`) as documented on the same page; code 40001 "Not routable" from https://developers.telnyx.com/docs/messaging/messages/error-codes |
| `webhook-sms-finalized-unconfirmed.json` | Same example with `to[0].status: "delivery_unconfirmed"`, a status in the delivery-status table on https://developers.telnyx.com/docs/messaging/messages/receiving-webhooks |
| `webhook-sms-finalized-unknown-status.json` | Same example with `to[0].status: "queued"`, a documented status that is not terminal |
| `webhook-whatsapp-finalized-read.json` | `message.finalized` with `payload.type: "WHATSAPP"` and `to[0].status: "read"`. The WhatsApp webhook guide lists `read` as a status: https://support.telnyx.com/en/articles/13986487-how-to-configure-whatsapp-webhooks. The outbound WhatsApp payload fields (`body.type`, `template_name`) follow the `message.sent` sample in https://developers.telnyx.com/docs/messaging/whatsapp/quickstart |
| `webhook-whatsapp-finalized-undeliverable.json` | `message.finalized` with `payload.type: "WHATSAPP"` and `to[0].status: "undeliverable"`. The troubleshooting section of https://developers.telnyx.com/docs/messaging/whatsapp/quickstart says an invalid recipient's status webhook returns `undeliverable` with Meta API error details. The `errors[]` item uses the documented shape (`code`, `title`, `detail`) from https://developers.telnyx.com/docs/messaging/messages/receiving-webhooks; code 40008 "Undeliverable" is from https://developers.telnyx.com/docs/messaging/messages/error-codes and https://developers.telnyx.com/docs/messaging/whatsapp/send-messages |
| `webhook-whatsapp-read.json` | The separate `message.read` event listed for WhatsApp in https://developers.telnyx.com/docs/messaging/whatsapp/quickstart. Telnyx publishes no WhatsApp `message.read` sample, so the shape follows the documented `message.read` example (`to[].status: "read"`, `direction: "outbound"`) in https://developers.telnyx.com/docs/messaging/messages/receiving-rcs-webhooks, with `type: "WHATSAPP"` |
| `webhook-unrelated-event.json` | An event outside the messaging list (`call.initiated`), used to prove such events are ignored |

## Number ownership (Task 4 fix round 1)

`TelnyxMessagingProvider.ownsNumber` calls `GET /v2/phone_numbers?filter[phone_number]=<digits>`.
The API reference says this filter needs at least three digits and that "non-numerical characters
will result in no values being returned", so the request sends the E.164 digits without the `+`
and the code compares each returned `phone_number` (documented as +E.164) to the number exactly.

| Fixture | Source |
| --- | --- |
| `list-phone-numbers-owned.json` | The 200 example of `GET /v2/phone_numbers` (List phone numbers): https://developers.telnyx.com/api/numbers/list-phone-numbers. `phone_number` is our test number instead of the example's; `meta` is set to one page of one result. The page's generated example also carries an `errors[]` array inside the 200 body, which the response schema does not list for success, so it is left out |
| `list-phone-numbers-empty.json` | Same endpoint and envelope (`data`, `meta` with `total_pages`, `total_results`, `page_number`, `page_size`) with no matching number. The page shows no empty example, so `data` is `[]` and `meta` follows the documented fields |
| `error-401-auth.json` (reused) | The same error body shape applies to this endpoint's 401 response on the page above |

Docs read on 2026-11-13.

## WhatsApp inbound media, reactions and replies (messaging upgrade, docs read on 2026-11-16)

These follow the **live** inbound WhatsApp shape seen on 2026-11-16 (`payload.to` is a plain E.164
string, text at `payload.body.text.body`, `payload.body.type` names the content) plus the fields
Telnyx's guides document for it. The guides do not show every type, so the per-type fields are
Meta's own (Telnyx passes `payload.body` through). Built, not recorded.

| Fixture | Source |
| --- | --- |
| `webhook-whatsapp-image-received.json` | `body.image` with a Telnyx-hosted `url`, `mime_type`, `sha256`: "Downloading Inbound Media" in https://developers.telnyx.com/docs/messaging/whatsapp/send-messages; `body.foreign_id` is the wamid per the `MessagingInboundMessagePayload` schema; `caption` per Meta's image webhook reference |
| `webhook-whatsapp-voice-received.json` | The guide's fallback case: a Meta media `id` and no `url` (downloaded with `GET /v2/whatsapp/media/{phone_number}/{id}`); `voice: true` and `audio/ogg; codecs=opus` per Meta's audio webhook reference |
| `webhook-whatsapp-document-received.json` | `body.document` with `filename` and `caption` per Meta's document webhook reference |
| `webhook-whatsapp-video-received.json` | `body.video`, same pattern as the image |
| `webhook-whatsapp-sticker-received.json` | `body.sticker` with `animated` per Meta's sticker webhook reference |
| `webhook-whatsapp-reaction-received.json` | `type: "reaction"`, `reaction: { message_id, emoji }` per Meta's reaction webhook reference (Telnyx does not document inbound reactions) |
| `webhook-whatsapp-reply-received.json` | `context: { from, id }` per Meta's contextual-replies reference (Telnyx does not document inbound context) |
