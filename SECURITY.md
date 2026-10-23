# Security policy

## Reporting

Use GitHub private vulnerability reporting for this repository. Do not include
real chat content, credentials, access tokens, IP addresses, or production
database URLs in a report.

## Current relay behavior

### Network metadata and IP addresses
The Standard-mode endpoint observes source IPs (or explicitly trusted proxy
addresses), timing and traffic volume. Current mobile clients still use direct
HTTPS. Phase 1 adds a disabled-by-default local onion listener; this is not a
claim that a real onion service is deployed or that mobile traffic uses Tor.
See `PHASE1_REPORT.md` and `deployment/README.md` for the boundary and test limits.

Public connection/admission limits use process-keyed HMAC source labels (IPv4
addresses and IPv6 /64s). Onion limits use separate process-keyed labels derived
from the circuit handle exported over the protected Unix/PROXY boundary, never
from HTTP forwarding headers. Labels are temporary resource handles, not users.
Counters expire in memory and connection entries are released on disconnect.
Block/report relationships instead use random anonymous session UUIDs; they do
not use IP or circuit labels. Blocks end on session removal, TTL expiry, bounded
store eviction or restart. Fresh sessions cannot reliably identify a blocked peer.

The raw public IP remains in OS/Node socket state while connected. The onion
backend does not receive a client IP from Tor; it still observes pairings and
traffic timing/volume. No circuit handles are emitted, logged or persisted by
the application. Production does not log per-connection events;
`securityMonitor.js` logs only aggregate event counts.

### Sessions and rooms
Sessions, queue entries, invite locators, and rooms live only in this process
RAM (`sessions.js`, `matchmaking.js`, `invites.js`). A session is created per
socket connection and removed on disconnect or after 30 minutes. `leave-room`
destroys the room (clearing both participants' room and relayed-key state),
withdraws any queue entry or outstanding invite for the session, resets the
socket's per-chat key, confirmation, and duplicate-message state, and notifies
the peer. It keeps the session entry, because that entry belongs to the
still-open connection and is needed to start another chat. The disconnect
handler removes it.

### Random one-to-one chat
Random matching is enabled with libsignal encryption and an unverified-peer
safety fingerprint. Public groups are hard-disabled even if the obsolete
environment flag is set. A malicious relay can misdirect pairing without trusted
fingerprint comparison. Queue: 2-minute timeout, 10 entries/connection and
20/network source per minute. Block/Skip/Report stores a pair of HMAC source
labels, bounded by `MAX_BLOCKED_PAIRS` (default 50000), expiring after 30
minutes with a 1-minute sweep. Shared-network collateral is possible, and
changing network can evade this anonymous block. Only explicit report
categories are counted; no messages or files are submitted or retained.

### Join codes
Codes are eight characters from `0-9A-Z` (36^8, about 2.8 x 10^12 values,
generated with `crypto.randomInt`). They are short-lived, single-use lookup IDs,
not secrets or authentication keys. Clients use libsignal and must compare
safety codes through a trusted channel to authenticate peers; relay misdirection
is possible without that comparison. Redemption limits are unchanged: 5 per
connection and 10 per network source (IPv6 /64) per minute, plus a global cap
of 1000 per minute scaled by `MAX_CONNECTIONS_GLOBAL / 5000`. Every attempt
counts, including malformed ones. Creation is limited to 5 per connection and
10 per source per 5 minutes. `INVITE_TTL_MS` defaults to 600000. Codes are never
logged. Mobile apps that only accept the previous six-character format must be
updated together with the relay.

### Media and saved files
The relay forwards end-to-end encrypted payloads and cannot read attachments or
the sender's Allow downloads setting. That setting travels inside the encrypted
transfer and is enforced by the receiving app before it writes to its optional
Saved Files vault. It is not DRM and cannot stop a recipient from retaining
media already delivered to their device. See the mobile `SECURITY.md` and
`PRIVACY_POLICY.md`.

## Deployment requirements

- Terminate TLS at the application or exactly `TRUST_PROXY` trusted hops away.
- Set `CORS_ORIGIN` to explicit HTTPS origins; wildcard production origins are rejected.
- Keep temporary state in the backend process RAM. No external Redis/Valkey
  service or adapter is used. Run one process/replica; restarts end active chats.
- Configure host/container RAM limits and prevent swap, crash dumps, and memory
  snapshots from persisting sensitive process memory.
- The server binds to `127.0.0.1` by default. Hosting and proxy access logs are
  outside this code base; configure their retention separately.
- Keep `.env`, signing material, service-account files, and build artifacts out of Git.
- Enable the repository security workflow, Dependabot, branch protection, and
  GitHub private vulnerability reporting.

## Threat model

One-to-one message bodies and media are end-to-end encrypted with libsignal.
Join codes contribute no key material. Every peer, whether from a code or a
random match, must compare the safety code to detect relay impersonation.

Group chat is disabled. Do not describe any group feature as end-to-end
encrypted until an independently reviewed MLS-style group protocol is deployed.

The cryptographic protocol has not received an independent professional audit.
Protocol 7 clients and relay must be rolled out together. Native Tor routing is
not implemented. Templates and source changes are not evidence that IP
anonymity, capture prevention, or production deployment is complete. See
`SECURITY_IMPLEMENTATION_PLAN.md` for remaining work.
