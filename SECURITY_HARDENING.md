# Security hardening — October 18, 2026

Implemented locally; no deployment or production configuration changes made.

## Behavior changes

- Protocol 7 is required by both the mobile client and backend. Earlier versions
  are rejected. The relay accepts bounded encrypted libsignal key bundles and
  confirmation ciphertexts without seeing their plaintext or the invite secret.
- Secret invites are the default. Random/public groups require the explicit
  `ALLOW_UNVERIFIED_CHATS=true` opt-in. Keep this false for confidential use.
- Engine.IO polling and upgrade requests enforce production HTTPS before
  transport allocation. Initial requests have rate limits; transport reservations
  also count peers that never complete the Socket.IO namespace handshake.
- Proxy trust requires both `TRUST_PROXY` (hop limit) and `TRUST_PROXY_CIDRS`
  (allowed addresses). For a same-host proxy: `TRUST_PROXY=1`,
  `TRUST_PROXY_CIDRS=127.0.0.1/32,::1/128`. The proxy must overwrite forwarding
  headers and Node must not be publicly reachable around it.
- Per-packet transport limit is 288 KiB; decoded ciphertext limit is 192 KiB.
  Protocol 7 encrypts large attachments in 96 KiB plaintext chunks on the client.
- Per-session, source, and global event/bandwidth budgets limit relay abuse.
  The relay sends retryable responses for temporary message limits and bounds
  a peer's pending transport buffer to 2 MiB.
- Source labels use a process-local HMAC secret rather than enumerable IP hashes.
- Tests use bounded event waits and reject obsolete plaintext control events.

## Verification

`npm test`: 17 tests passed, including production transport checks, explicit
proxy trust, admission exhaustion, default mode restrictions, invite redemption,
room routing and legacy endpoint rejection.

With both repositories checked out beside each other, run
`npm run test:integration` in `../whisperui`. It runs the actual mobile socket
and crypto implementations against this server with two independent clients.
Device APIs are mocked; it does not certify native behavior.

## Remaining security work

The client now integrates native libsignal 0.105.1 with an invite-authenticated
bundle exchange. Its native bridges still need compilation/device verification,
independent integration review and resolution of licensing before distribution.
See the mobile repository's SECURITY_PROTOCOL.md. Coordinate both releases;
old installed clients and Expo Go cannot use protocol 7.
Invite possession authenticates possession of the secret, not a real identity.

The service currently uses direct HTTPS; it does not hide source IPs. Native
anonymous transport and onion deployment remain unimplemented. The old Tor
notes are a proposal. Rate limits must be redesigned for shared Tor ingress.

Public groups, if explicitly re-enabled, are server-readable. They are not a
confidential group feature. Keep them disabled until a reviewed group protocol
with authenticated membership changes is implemented.

Run one backend process/replica. Review real proxy/firewall/TLS configuration,
host permissions, logging, swap, dumps, backups, and provider access separately.
The Vercel `api/index.js` route does not start the persistent Socket.IO server;
deploy `server.js` on a service that supports persistent connections.
