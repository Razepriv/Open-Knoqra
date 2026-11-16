/**
 * The public half of KNOQRA's license signing key: base64 of the raw 32-byte Ed25519 key.
 * Self-hosted instances check license keys against it, offline.
 *
 * Empty until KNOQRA's key issuer generates its signing key pair and pastes the public half here
 * (see docs/licensing.md). While it is empty no license key verifies, so a self-hosted instance
 * stays at the setup screen and says the build has no license key built in.
 *
 * Changing it invalidates every key signed with the old private key.
 */
export const LICENSE_PUBLIC_KEY = '';
