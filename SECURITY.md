# Security policy

KNOQRA handles phone numbers, message history and spend data for more than one organization, so tenant isolation and authentication bugs are taken seriously.

## Supported versions

| Version | Supported |
| --- | --- |
| `main` | Yes |
| Tagged releases | The latest tag only |
| Older tags and forks | No |

KNOQRA is in early development and has no stable release yet.

## Reporting a vulnerability

Do not open a public issue or pull request for a security problem. Report it privately in one of two ways:

1. Use GitHub private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability** (available once the repository has it enabled).
2. Email **security@knoqra.dev** (placeholder address, to be confirmed before the repository goes public).

## What to include

- A description of the problem and its impact
- Steps to reproduce, or a proof of concept
- The affected commit, tag or deployment
- Anything you know about a fix or mitigation
- Whether you want to be credited, and how

Please do not include real customer data. Use test accounts and fictional phone numbers.

## What to expect

| Step | Target |
| --- | --- |
| Acknowledge your report | Within 72 hours |
| Updates on confirmed issues | Shared as soon as a fix or mitigation plan is known |

We will coordinate disclosure with you, and we ask that you give us a reasonable time to ship a fix before publishing details.

## Scope

In scope:

- **Tenant isolation:** reading or writing another organization's data, bypassing row-level security, or leaking the tenant context between requests
- **Authentication and sessions:** sign-in, session handling, password reset, two-factor, and membership checks
- **Webhook verification:** accepting unsigned or replayed provider webhooks, or processing an event twice
- **Secrets:** any provider secret, `BETTER_AUTH_SECRET` or webhook secret reaching a log, the web bundle or a response

Out of scope:

- Findings that need a compromised device, browser or account on the reporter's side
- Denial of service through sheer traffic volume
- Missing best-practice headers or settings with no demonstrated impact
- Vulnerabilities in third-party services (Cloudflare, Neon, Telnyx), which should be reported to those vendors
- Social engineering of maintainers or contributors
- Issues in unmerged branches or in code marked as an example or fixture

