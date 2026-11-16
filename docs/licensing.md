# Self-host license keys

KNOQRA is AGPL-3.0 software. Anyone may self-host it free, with their own database and telephony provider, and without usage limits. A self-hosted instance asks for a **license key** before it unlocks. KNOQRA issues the key free, to anyone who signs in with GitHub and has starred [Razepriv/Open-Knoqra](https://github.com/Razepriv/Open-Knoqra).

The key is not a software license. Everyone's rights to the code come from the [AGPL-3.0](../LICENSE), with or without a key. The key is the project's way of asking self-hosters for a star, and of knowing roughly how many there are.

## Editions

`KNOQRA_EDITION` is a var on the API Worker:

| Value | Who runs it | License check |
| --- | --- | --- |
| `cloud` | KNOQRA's hosted service and local development | Never |
| `selfhost`, unset or anything else | Everyone else | On |

The local `wrangler dev` block of `apps/api/wrangler.jsonc` sets `cloud`, so contributors are never blocked by the license screen. A self-hosted deployment runs as `selfhost`: `pnpm knoqra deploy` always writes it into `wrangler.selfhost.jsonc` ([self-host guide](self-host.md)). To try the license screen locally, put `KNOQRA_EDITION=selfhost` in `apps/api/.dev.vars`.

## The key

```text
KNOQRA-LICENSE-1.<base64url payload>.<base64url signature>
```

- The payload is JSON: `{ "v": 1, "sub": "<GitHub user id>", "login": "<GitHub login>", "iat": "YYYY-MM-DD", "edition": "selfhost" }`.
- The signature is Ed25519 over the ASCII text `KNOQRA-LICENSE-1.<base64url payload>`.
- KNOQRA's hosted service signs with the private key, which never leaves it.
- A self-hosted instance verifies with the public key built into the code, `LICENSE_PUBLIC_KEY` in `packages/core/src/license-public-key.ts`. The check is offline: no network and no call home.
- Keys do not expire.

The verifier refuses:

- a key signed by another key;
- a changed payload or signature;
- another prefix;
- an edition other than `selfhost`;
- a date more than a day and a half in the future;
- anything malformed.

If the build has no public key embedded, it refuses every key and says so. Code: `packages/core/src/license.ts`, tests: `packages/core/src/license.test.ts`.

## Getting a key (self-hoster)

1. Star [Razepriv/Open-Knoqra](https://github.com/Razepriv/Open-Knoqra) on GitHub.
2. Open <https://app.knoqra.app/api/license/github/start>, also linked from the instance's license screen as **Get a license key**.
3. Sign in with GitHub. KNOQRA asks for no scopes: only your public profile.
4. The page shows your key once. Copy it.
5. In your instance, sign in and paste the key on the license screen. Or set it as the API Worker's `KNOQRA_LICENSE_KEY` secret.

## How a self-hosted instance enforces it

- `GET /api/v1/license` reports the status: `{ edition, required, licensed, source, license, reason, message }`.
- `PUT /api/v1/license` stores a key. It must verify first, and only an owner or admin may enter it.
  - The key goes in `instance_license`, a one-row system table with no row-level security, because it belongs to the whole instance.
  - Every sign-up creates a personal workspace with its creator as owner, so any user of the instance can enter a valid key.
- `KNOQRA_LICENSE_KEY`, when set and valid, wins over the stored key.
- Until a valid key is found:
  - Every other `/api/v1/*` route answers `403 license_required`. `/api/v1/me` and `/api/v1/license` stay open.
  - The Desk shows the license screen instead of the shell.
- A valid result is remembered for a minute per Worker isolate. An invalid one is checked again on every request, so a newly entered key unlocks every isolate at once.

## Issuing keys

KNOQRA's hosted service issues the keys: a GitHub sign-in with no scopes, a check that the account starred the repository, then a key signed with KNOQRA's private key and dated that day (UTC). It stores nothing: not the token, not the login, not the key. The issuing service is part of KNOQRA's hosted edition, not of this repository ([EDITIONS.md](../EDITIONS.md)). A self-hosted instance only verifies keys, offline.

## Risks the owner accepted

The owner chose to issue keys only to users who star the repository, after hearing these risks (decision relayed 2026-11-15):

1. **GitHub's rules on stars.** GitHub's Acceptable Use Policies forbid inflating a repository's standing through inauthentic activity. Giving something in exchange for a star can be read as an incentivized star. GitHub could:
   - remove stars;
   - keep the repository out of trending or search;
   - act on the account.
2. **The check can be removed.** The code is AGPL-3.0, so anyone may fork it and delete the gate. `KNOQRA_EDITION=cloud` switches it off with no code change. The key is a request, not a lock.
3. **No revocation.** A key works forever:
   - unstarring later changes nothing;
   - a key shared publicly unlocks any instance;
   - nothing records who holds a key, so a key cannot be revoked short of rotating the signing key for everyone.
4. **GitHub dependency.** A self-hoster needs a GitHub account to get a key, and issuing depends on GitHub's OAuth and API being up. An instance that already has a key never needs GitHub again.
5. **Personal data in the key.** The key carries the holder's GitHub login and user id. Anyone the key is shared with sees them. KNOQRA's cloud sees them while issuing, but does not store them.
6. **Not a legal license.** The AGPL-3.0 grants the rights. Wording in the Desk, the docs and the website must not suggest that the key grants or limits any right to the code. Brand and license wording are covered separately.
