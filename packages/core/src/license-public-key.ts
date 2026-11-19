/**
 * The public half of KNOQRA's license signing key: base64 of the raw 32-byte Ed25519 key.
 * Self-hosted instances check license keys against it, offline.
 *
 * Set on 2026-11-19 from KNOQRA's signing key pair (see docs/licensing.md). The private half
 * stays with KNOQRA's key issuer and is never committed. If this were empty, no license key would
 * verify and a self-hosted instance would stay at the setup screen.
 *
 * Changing it invalidates every key signed with the old private key.
 */
export const LICENSE_PUBLIC_KEY = 'IGzvASLUQuvPi3Ui3aE3bjFbTnGWue51ZaXnm+KLD/I=';
