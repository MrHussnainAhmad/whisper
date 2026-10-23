# Phase 1 completion report

Completed locally on 2026-10-22. The onion listener and application PoW are
disabled by default. No push, deployment, VPS/AWS access, Tor installation,
mobile modification, or Phase 2/3 work was performed.

## Listener and PROXY boundary

`ONION_ENABLED=1` enables a separate Unix-domain socket. The public endpoint
retains its HTTPS enforcement, origin policy, proxy trust and source-IP limits.
There is no production onion TCP fallback; activation on Windows fails explicitly.

The listener validates a backend-owned private directory and non-symlink,
non-group/world-writable ancestors. It refuses pre-existing socket paths, assigns
the directory's group to its socket, and applies mode 0660 before acceptance.
The separate Tor account receives access through a restricted shared group.
Filesystem permissions and trusted service accounts authenticate the local hop;
PROXY v1 itself cannot authenticate a local process.

Each stream must supply a PROXY v1 TCP6 header before HTTP parsing. Validation
covers IPv6 syntax, 16-bit numeric ports, separators and CRLF. The parser buffers
at most 108 header bytes, with a default two-second deadline. It rejects missing,
incomplete, oversized, binary/v2, UNKNOWN, TCP4 and malformed headers. Fragmented
headers and coalesced HTTP bytes are preserved correctly.

Circuit labels use a process-local HMAC of the source address's low 32 bits.
The upper 96 bits are ignored, following the
[Tor specification](https://spec.torproject.org/haproxy-proxy.html).
Destination/port fields are syntax-checked but not treated as identity. Circuit
handles/labels are never emitted to clients, logged or persisted by the application.

Only this parser can mark trusted onion sockets. Forwarded, X-Real-IP and
X-Forwarded-* headers are discarded on the onion path. No HTTP header can claim
onion status on the public listener. Trusted local onion HTTP requires no public
domain, DuckDNS or TLS certificate; public production connections still require
HTTPS. Browser Origin headers are rejected on the native-only onion endpoint.

The onion HTTP parser feeds the existing Engine.IO instance and Socket.IO
namespace, sharing all existing sessions, matching, invitations and blind relay
handlers. Public and onion peers can occupy the same room. Existing Engine.IO
SIDs are bound to their transport class and circuit. Polling may span streams on
the same circuit; changing circuits requires a new anonymous session. Weak request
metadata preserves binding after the initial polling socket closes.

The final review fixed lifecycle forwarding needed to start Node's absolute
HTTP header/body timeout checker on the otherwise unbound parser server. A
regression test rejects trickling HTTP headers after a valid PROXY header.

## Abuse protection and optional PoW

Defaults cap onion raw streams at 1000, incomplete PROXY headers at 64, and raw
streams/circuit at 8. The existing combined Engine.IO connection ceiling remains.
An additional onion cap defaults to 1000 and is clamped to half the global cap
(minimum one); Engine.IO/Socket.IO connections are capped at 4/circuit. Public
source-IP limits remain independent. Phase 0 room allocation, established-event
reservation, session-based blocking/reporting and secure-channel locking remain.

Onion initial HTTP requests have separate 120/circuit/minute and 6000/minute
limits. Valid session polling bypasses those admission HTTP quotas while retaining
event/relay limits. Circuit stream counts release on close; temporary HTTP counters
expire; parser timers clear on completion/close. Shutdown closes accepted streams,
the parser server and messaging engine. No persistent message state was added.

`ONION_APP_POW_ENABLED=1` gates only onion `find-random` and `create-invite`.
It defaults to 0 and never gates Standard HTTPS clients. Additive events
`pow-challenge` and `pow-solve` issue a ticket supplied as optional
`admissionTicket` data in the original operation. Required v7 fields, invite
formats, ciphertext and libsignal encryption are unchanged.

Random challenges bind to session and operation, expire after 30 seconds, and
are consumed on verification. Verification computes one SHA-256 hash; default
difficulty is 16 leading zero bits, configurable from 8 through 22. Combined
outstanding challenges/tickets are capped at 1024. Issuance and verification have
per-session, circuit and global quotas. No server-side puzzle solving occurs.

Tickets are single-use, operation-bound bearer capabilities lasting 15 seconds.
They may be used after a fresh connection without repeating the work, but restore
no identity, chat, messages or encryption session. Disconnect removes unsolved
challenges; expiry cleanup removes old tickets. Normal text/media relay, typing,
receipts, acknowledgments and termination require no PoW. The exact future
mobile contract is in [deployment/POW_PROTOCOL.md](deployment/POW_PROTOCOL.md).

## Configuration and eventual VPS preparation

No dependencies were added/upgraded. New settings, defaults and limits are listed
in `.env.example` and [deployment/README.md](deployment/README.md):
`ONION_ENABLED`, `ONION_SOCKET_PATH`, `ONION_MAX_STREAMS`, `ONION_MAX_PENDING`,
`ONION_STREAMS_PER_CIRCUIT`, `ONION_PROXY_TIMEOUT_MS`, `ONION_MAX_CONNECTIONS`,
`ONION_CONNECTIONS_PER_CIRCUIT`, `ONION_APP_POW_ENABLED`, `ONION_APP_POW_BITS`.

The deployment guide gives the future systemd runtime-directory/user/group
settings, permission matrix, stale-socket handling and validation steps.
`deployment/torrc.example` supplies standard anonymous v3 storage/port mapping,
Unix target, circuit export, Tor PoW queue settings, finite streams and circuit
closure on overflow. Queue values are documented Tor starting defaults, not
measured Whisper capacity. No single-hop/non-anonymous service, client
authorization or relay listener is configured. Private-key protection, restricted
encrypted offline backups and onion-address distribution are documented.
None of these deployment steps was executed.

## Phase 1 files

- New modules: `torProxy.js`, `onionListener.js`, `onionHttp.js`, `proofOfWork.js`.
- Runtime changes: `server.js` (startup, routing, binding, expiry, shutdown and
  local test exports), `security.js` (trusted-onion exception),
  `transportAdmission.js` and `abuseLimiter.js` (circuit admission), `handlers.js`
  (optional PoW events/gates and cleanup).
- Configuration: `.env.example`, `package.json` integration command.
- Tests: `test/phase1Proxy.test.js`, `test/phase1Pow.test.js`,
  `test/phase1.integration.test.js`, `test/phase1Server.cjs`.
- Deployment documentation: `deployment/README.md`, `deployment/torrc.example`,
  `deployment/POW_PROTOCOL.md`.
- Status corrections: `SECURITY.md`, `SECURITY_HARDENING.md`,
  `SECURITY_IMPLEMENTATION_PLAN.md`.
- Tracking/report: `PHASE1_REQUIREMENTS.md`, `PHASE1_PROGRESS.md`, `PHASE1_REPORT.md`.

Earlier uncommitted Phase 0 work remains intact; the overall dirty state includes
those earlier changes too. Nothing was reset or pushed.

## Executed verification

| Check | Actual result |
|---|---|
| Baseline `npm test` | 33 passed, 0 failed |
| Baseline `npm run test:integration` | 25 passed, 0 failed |
| Final `npm test` | 45 passed, 0 failed |
| Final `npm run test:integration` | 30 passed, 0 failed |
| `git diff --check` | Passed |

Integration tests overlap the full suite. New tests cover header syntax,
fragmentation/coalescing, bypass/spoof attempts, size/deadline rejection, raw and
Engine.IO admission pressure, concurrent circuits, polling/WebSocket, SID circuit
changes, mixed public/onion matching, invites, maximum-size encrypted media,
termination, PoW replay/expiry/bounds, fresh-session tickets, issuance pressure
and shutdown cleanup. All Phase 0 tests remain passing.

One final iteration exposed a cleanup assertion race: client close can precede
server-side counter release. The test now waits for both endpoints to close;
the full suite was rerun successfully. That failed iteration is not counted as
a pass. Test-only loopback surrogates are confined to test harnesses and do not
introduce a production TCP mode.

## Compatibility, remaining concerns and completion

Current Android Standard-mode clients retain the existing HTTPS v7 API. Both new
features are off by default. Backend protocol tests pass; the real Android app
was not built or exercised during this phase.

Unverified: Linux Unix-socket permissions and separate service-user access,
host sandbox policy, real C Tor header export/onion connectivity/PoW, mobile Tor
routing and puzzle solving, circuit behavior during mobile polling/upgrades,
production-capacity load and heap-soak testing. Synthetic tests are not proof of
a working real onion service.

A compromised trusted local account can forge PROXY metadata. Circuit handles
can collide/recur, and new circuits do not prove distinct people. Distributed
attackers can still compete for global capacity; PoW is not a Sybil defense.
Phase 0 fixed-window contention and public NAT admission limitations remain.
The relay sees timing, volume and temporary pairings; host swap/dumps/logging and
traffic analysis are separate concerns. Public/onion peers share matchmaking;
future mobile work must decide and communicate peer-transport expectations.

Phase 1 backend implementation and local tests are complete. The saved checkpoint
records completion so work need not restart after credit interruption. Activation
and deployment remain separate, unauthorized steps requiring the validation above.
No later phase was started.
