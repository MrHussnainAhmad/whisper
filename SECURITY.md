## Phase 4X join-code update
Six-character codes are short-lived lookup IDs, not secrets or authentication keys.
The old 256-bit invite-secret design below is superseded for new chats. Clients use
libsignal and must compare safety codes through a trusted channel to authenticate
peers. Relay misdirection is possible without that comparison. Limits: 5/connection,
10/IP (IPv6 /64), 1000 global attempts per minute; all attempts count, including
malformed requests. INVITE_TTL_MS defaults to 600000. Codes are single-use and never logged.

# Security policy

## Reporting

Use GitHub private vulnerability reporting for this repository. Do not include
real chat content, credentials, access tokens, IP addresses, or production
database URLs in a report.

## Deployment requirements

- Terminate TLS at the application or exactly `TRUST_PROXY` trusted hops away.
- Set `CORS_ORIGIN` to explicit HTTPS origins; wildcard production origins are rejected.
- Keep temporary state in the backend process RAM. No external Redis/Valkey
  service or adapter is used. Run one process/replica; restarts end active chats.
- Configure host/container RAM limits and prevent swap, crash dumps, and memory
  snapshots from persisting sensitive process memory.
- The server binds to `127.0.0.1` by default. See `deployment/README.md` for the
  unfinished onion-service topology; do not expose a clearweb fallback.
- Keep `.env`, signing material, service-account files, and build artifacts out of Git.
- Enable the repository security workflow, Dependabot, branch protection, and
  GitHub private vulnerability reporting.

## Threat model

One-to-one message bodies and media are end-to-end encrypted. Invite chats mix
the full client-only invite secret into the session key; random-chat peers have
no external identity and must compare the safety code to detect relay
impersonation.

Group chat is public and server-readable. Group messages are relayed live and
are not retained by the backend. Do not describe group chat as end-to-end
encrypted until an independently reviewed MLS-style group protocol is deployed.

The cryptographic protocol has not received an independent professional audit.

Current changes are untested at the user's request. Protocol v4 clients and
server must be rolled out together; old clients/invites are incompatible. The
mobile release connection gate remains closed pending native Tor routing and a
reviewed post-quantum protocol/ratchet. See `SECURITY_IMPLEMENTATION_PLAN.md` for
the implementation handoff. Templates and source changes are not evidence that
IP anonymity, capture prevention, or production deployment is complete.
