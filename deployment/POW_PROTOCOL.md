# Optional onion application PoW: future mobile contract

This protocol is implemented locally but disabled by default. It is separate
from C Tor's onion-service PoW. Standard HTTPS clients do not use it, even when
`ONION_APP_POW_ENABLED=1`. Do not enable it for onion clients until coordinated
mobile support is implemented and tested. It adds optional events/fields; it
does not change existing v7 encryption, invitations, or normal acknowledgments.

1. After receiving the usual `joined`, send `pow-challenge` with
   `{ action: "find-random" }` or `{ action: "create-invite" }` and an ack callback.
2. Success is `{ ok: true, challenge: { version: 1, algorithm: "sha256", id,
   nonce, action, difficulty, expiresAt } }`. `id` is 48 lowercase hex characters;
   `nonce` is 64 lowercase hex characters; expiry is Unix milliseconds. Challenges
   live 30 seconds and belong to this anonymous session and operation. Issuing
   another for the same operation replaces the previous challenge.
3. Find a canonical decimal solution string (0, or 1-16 digits without leading
   zeros) whose SHA-256 digest has `difficulty` leading zero bits, MSB first.
   The exact UTF-8 hash input, with no newline or extra spaces, is:

   `whisper-pow-v1|<id>|<nonce>|<action>|<solution>`

   Solve off the mobile UI thread, check expiry, cancel on navigation, and cap
   work/time/battery use. Do not solve a server-supplied unbounded difficulty.
4. Send `pow-solve` with `{ id, solution }` and an acknowledgment. Each verification
   attempt consumes its challenge. Success returns `{ ok: true, ticket, action,
   expiresAt }`. Ticket is 64 lowercase hex characters and lives 15 seconds.
5. Pass `{ admissionTicket: ticket }` as the existing operation's optional data
   field. `create-invite` can also retain its existing `requestId`. A ticket is
   accepted only for its operation and at most once. There is no reusable credit
   balance. Existing idempotent invite responses for the same `requestId` can be
   returned without spending another ticket.

A solved ticket is a short-lived bearer capability. It can be used after a new
anonymous connection/circuit, without repeating work, but restores no identity,
room, messages or encryption session. Keep it only in client RAM and never log
or share it. Disconnect deletes outstanding challenges, not already issued
short-lived tickets. A restart invalidates everything. A consumed ticket is not
refunded if a race/failed operation occurs; request a new challenge if needed.

Failure acknowledgments use `{ ok: false, error }`, with `retryable: true` for
rate pressure/missing admission work. Do not endlessly retry the same ticket.
There is no additional PoW on joining an invite, key exchange, text/media relay,
receipts, typing, or termination. Those retain their existing rate limits.

Bounds: at most 1024 combined outstanding challenges and tickets; at most one
challenge/session/operation; issue limits 6/session, 12/circuit, 300/global per
minute; verification limits 12/session, 24/circuit, 600/global per minute. These
are provisional implementation budgets to validate on actual devices. Normal
Phase 0 event limits also apply. Difficulty defaults to 16 (allowed 8-22);
verification computes one bounded SHA-256 hash. No server-side puzzle solving.
