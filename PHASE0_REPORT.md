# Phase 0: local backend security and matchmaking hardening

Completed locally on 2026-10-22. No mobile files, production systems, AWS resources,
Tor configuration, or deployment settings were changed. Nothing was pushed.

## Findings and implementation

1. **Blocks identified networks rather than people in an anonymous session.**
   Random matchmaking and block/report handlers used HMAC-derived IP source keys.
   Disconnect cleanup used session IDs, which did not match those records.
   Blocks now use the server's existing cryptographically random per-connection
   UUIDs. Random matching and invite room creation both enforce these pairs.
   Removal and TTL expiry of either session remove both block indexes. The
   existing 30-minute block TTL, periodic sweep, and configurable 50,000-pair
   default cap remain. No additional identity is sent to clients.

2. **Rejected attempts consumed shared quotas before sender quotas were checked.**
   Socket action limits now check the socket first, source second when applicable,
   and global quota last. Established encrypted messages no longer share an IP
   message-count or byte bucket. Public HTTP, transport admission, connection
   admission, and discovery/control source limits remain in place.

3. **Conversations shared unpartitioned event/message/bandwidth allowances.**
   Added room-owned counters and independent global counters. Each established
   room receives an equal share, bounded by room ceilings; unused shares are not
   borrowed. Only confirmed rooms count toward that division. A room cannot
   receive more than half of a global allowance, even when alone.
   At the existing default connection cap of 5,000:
   - The existing 10,000 events/second allowance is partitioned into 8,000 for
     established conversations and 2,000 for admission/unconfirmed traffic.
   - Established rooms are capped at 200 events/second; sockets retain 100.
   - The existing 4,000 messages/second global budget remains; rooms are capped
     at 80 and senders at 40, with smaller equal shares as room counts rise.
   - The existing 64 MiB/second global byte budget and 8 MiB/second sender budget
     remain. Room byte shares use a ten-second window, capped at 16 MiB per room
     per window, allowing a 192 KiB media chunk at the default maximum occupancy.
     The global byte check still uses a one-second window.
   - Established clients receive retryable negative acknowledgments under event
     resource pressure rather than having their conversations disconnected.
     Existing pending-handler overflow protection still disconnects abusive clients.

4. **Key exchange remained relayable after readiness.**
   The first successful `secure-channel-ready` (or existing `verify-chat` alias)
   locks both participants' room against further key exchange and key proofs.
   Both initial proofs must have been sent before readiness succeeds. Duplicate
   readiness remains successful and does not reset state. Membership and socket
   ownership are checked before key mutation; key mutation/relay and readiness
   transitions do not yield after their final state checks. Key submissions
   outside a room no longer populate session key state.

5. **Waiting timers survived successful matching until their deadlines.**
   Matching now cancels both participants' waiting timers. Teardown removes the
   room, session room/key metadata, and established-room count exactly once.
   Room resource counters use weak references and add no timers. Existing
   periodic cleanup timers remain unreferenced, and disconnect clears search timers.

## Inspection scope

Inspected matchmaking, sessions, handlers, invitations, validators, admission,
source normalization, HTTP/socket limiting, server setup, and disabled group chat.
`proofOfWork.js` does not exist. The only proof of work is in the disabled group
captcha path in `groupChat.js`; normal encrypted messages perform no proof of work.
Groups remain disabled, as they were before this change.

IP-derived source keys still serve HTTP, Engine.IO and Socket.IO admission,
unconfirmed event throttling, and action-specific discovery/control limits.
IPv4-mapped IPv6 normalization, IPv6 /64 aggregation, trusted-proxy handling,
HTTPS/origin checks, global connection caps, and per-source connection caps remain.

The backend stores only invite lookup locators and routing metadata, relays public
bundles and opaque encrypted proofs, and forwards ciphertext unchanged. There is
no server-side libsignal private-key handling or message decryption. No invitation
secret field, plaintext message store, external API, or new persistence was added.
The relay cannot prove that a client actually encrypted a syntactically valid
payload or authenticated a peer; those are client responsibilities.

## Compatibility and security boundaries

The current v7 Socket.IO protocol is preserved: event names, required fields,
acknowledgment structures, ciphertext formats, invite locator formats, and the
readiness alias are unchanged. Normal random and invite chats, ciphertext/media,
duplicate-message acknowledgments, reporting, blocking, and termination are tested.
Post-confirmation rekey/proof attempts are intentionally rejected. Retries during
initial negotiation remain allowed within existing quotas. No invitation-to-random
authentication fallback was introduced.

This is backend protocol compatibility validation, not execution of the actual
mobile application or verification of its libsignal implementation. Mobile work
later must enforce invite-secret authentication, room/session binding, peer-key
pinning, rejection of unsolicited key/proof changes, and no authentication
downgrades on the client itself. A malicious relay cannot be constrained by its
own implementation. Padding, fingerprints, and reconnection/resumption are untouched.

Remaining limitations:
- A new anonymous connection cannot be recognized as the same blocked person.
  Blocks end on session removal, expiry, process restart, or bounded-store eviction.
- Fair allocation is bounded best-effort protection, not a Sybil or network-DDoS
  defense. Many attackers that establish rooms can still compete for capacity.
- Fixed quota windows permit boundary bursts. Room churn can cause temporary
  contention until windows reset. Global byte limits can defer competing bursts
  despite unused longer-window room allowance. Retry is required under load.
- Public IP admission/control limits can still affect unrelated NAT users.
  HTTP's existing global-first limiter can reject new requests under a flood;
  active Engine.IO session requests bypass it. No network/listener redesign was made.
- Reduced connection caps reduce budgets; exceptionally small caps can make large
  media chunks exceed the global per-second allowance. Production sizing needs
  environment-specific load testing, which was not performed here.
- Existing bounded queues/counters, the 200-message-ID deduplication cache, eight
  pending handlers per socket, transport payload cap, and peer write-buffer cap
  remain. Cleanup behavior was tested and reviewed; no heap soak/profile was run.
- RAM-only application state is not a guarantee about operating-system swap,
  crash dumps, infrastructure logging, traffic analysis, or a compromised endpoint.

## Changed files

- `matchmaking.js`: session-based pairs, invite enforcement, established-room count.
- `sessions.js`: block cleanup on removal and TTL expiration.
- `abuseLimiter.js`: local-first quota charging; optional source-free action quotas.
- `handlers.js`: session-based block/report, room limits, reserved events, channel
  lock/membership checks, matched timer cancellation.
- `roomLimiter.js`: new bounded room/global resource allocator.
- `package.json`: added `test:integration` command. No dependency changes.
- `.gitignore`: made backend test sources/helpers reviewable; previously all tests
  were ignored. Generated test output remains ignored.
- `test/phase0.test.js`, `test/phase0.integration.test.js`: new regression coverage.
- `test/randomChat.test.js`, `test/joinCodes.test.js`: corrected expectations for
  anonymous-session blocking and local-first quota charging.
- Existing `test/security.test.js`, `test/transport.test.js`, and
  `test/serverFixture.cjs` are now visible to Git without content changes.
- `PHASE0_REPORT.md`: this report.

No new dependencies or environment variables. Existing capacity configuration is
reused. All tests launch only local loopback servers.

## Executed verification and readiness

- Baseline `npm test`: 24 passed, 0 failed.
- Final `npm test`: 33 passed, 0 failed.
- Final `npm run test:integration`: 25 passed, 0 failed (overlaps the full suite).
- `git diff --check`: passed.

Coverage includes shared-IP independent sessions, block expiry/removal, reporting,
blocked invite redemption, confirmed-channel key/proof rejection, duplicate ready,
invalid membership, malformed relay payloads, maximum-size ciphertext chunks,
message acknowledgments, termination, room/global exhaustion, noisy senders,
unmatched-client floods, concurrent random/invite rooms, and admission protections.
Earlier failed test iterations were corrected and rerun; the final results above
are actual executions, not inferred passes.

Phase 0 backend implementation is complete locally and ready for review and
eventual coordinated deployment validation. Deployment itself is not authorized
or performed. A real-device smoke test and production-capacity load test remain
release validation steps. No later phase was started.
