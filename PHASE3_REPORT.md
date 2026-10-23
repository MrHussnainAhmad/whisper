# Phase 3: backend completion report

Completed locally on 2026-10-22. No GitHub push, AWS/VPS access, production
configuration, deployment, mobile/native/libsignal change, Tor installation or
onion activation occurred. Phase 0/1 changes remain intact and uncommitted.

## Status and compatibility

Backend mechanisms and local tests are complete. Secure resumption and binary
relay are explicitly negotiated, independently disabled by default, and cannot
operate safely in real use until the documented mobile work is implemented and
verified. Current v7 clients retain immediate disconnect termination, normal
Socket.IO transports, existing invitation formats, Base64 ciphertext, events and
acknowledgments. Neither endpoint requires new credentials from older clients.

The complete event contracts, failure semantics and rollout order are in
[deployment/PHASE3_PROTOCOL.md](deployment/PHASE3_PROTOCOL.md). That document is
part of this implementation, not an assertion that mobile integration exists.

## Inspection and changes

Inspected connection creation, session expiry, handlers, readiness/key locking,
room ownership, acknowledgments/deduplication, write buffers, quotas, and the
Phase 1 circuit boundary. The backend receives opaque Base64 ciphertext up to
192 KiB decoded; it does not identify native media chunks or inspect encrypted
message types. The reported 96 KiB/double-Base64 mobile implementation cannot be
verified from backend code alone. Mobile sources were not changed or used to
claim a verified native optimization.

**Secure resumption.** Each participant receives a separate cryptographically
random 256-bit bearer credential, with only SHA-256 verification data held in RAM.
Records bind to a room, participant slot and credential generation; verification
uses a constant-time digest comparison after bounded lookup. A token authorizes
one attachment only. Refreshing a credential invalidates its predecessor.
At most 512 rooms hold resumption state, bounding detached participants to 1024.

Both clients must negotiate resume support, establish the original secure channel
and obtain credentials before disconnect retention is available. Foreground grace
defaults to 90 seconds, configurable only within 60-90 seconds; subsequent attempts
do not extend the deadline. Original session TTL, explicit leave, block and report
still terminate a conversation. Room destruction clears token indexes, timers and
detached sessions immediately, including termination by the still-connected peer.

Resume uses a newly admitted connection; it never bypasses HTTPS/onion admission,
PROXY checks or connection limits. IP and Tor circuit changes are permitted for
the credential's original transport mode. Standard-to-onion and onion-to-Standard
switches are rejected within the conversation. Phase 1 SID circuit binding remains.

Socket replacement and handler state changes are synchronous and atomic. Old
sockets lose authority before disconnecting, including queued callbacks and
quota consumption. Concurrent attempts have one winner. Duplicate takeover
requests fail closed; the newly authorized socket can recover a lost response
through `resume-status`. Token-response loss on an authorized connection is handled
by issuing another credential. Losing both response and connection is not a token
recovery mechanism and may require ending the conversation.

**Cryptographic continuity gate.** Token acceptance freezes relay delivery. A
fresh random challenge, room/epoch, participant roles and generation vector must
be bound into a continuity message authenticated by the original client libsignal
session. The backend relays bounded opaque proofs and requires both current
participants to acknowledge peer-proof verification. It cannot decrypt or verify
their cryptographic assertions. Only then is delivery unblocked and the resumed
client permitted to obtain its rotated token. Duplicate confirmations are safe;
stale epochs, key exchanges and legacy readiness cannot bypass the gate. No
invitation secret, private key or plaintext is requested by the relay.

**Forwarding and resource handling.** The existing hot path unnecessarily awaited
synchronous in-memory lookups/mutations and quota work. Those handlers now execute
without yielding across authority checks and state changes. This also eliminates
an old-socket/resume race. Socket event guarding remains bounded. Legacy write-buffer
checks now include WebSocket/TCP pending bytes as well as Engine.IO's write buffer.
Existing room fairness, byte/message/event budgets and established reservations
remain active and are shared with the new path.

**Binary relay and priority.** Both peers must negotiate binary support. The new
`send-envelope`/`receive-envelope` path forwards a Node Buffer unchanged, with
validated opaque `control` (up to 4 KiB) or `media` (up to 32 KiB) envelopes.
Media sequence/stream metadata is visible; future clients must authenticate it
inside encryption and preserve consent. The relay cannot assert that an opaque
control envelope actually contains text.

Each recipient direction has separate FIFO control/media queues. Control can
overtake queued media; after four controls, ready media gets a turn. Media remains
ordered within its stream. No unbounded incoming work queue is introduced. Client
concurrency must respect the existing eight-inflight-handler protection. A frame
already handed to WebSocket/TCP cannot be preempted, and legacy v7 traffic is not
reordered. Future libsignal clients must safely support the negotiated out-of-order
envelopes before enabling this feature.

Bounds are 256 KiB queued bytes/128 envelopes per direction, 256 KiB/128 media
chunks awaiting recipient receipts, and 16 MiB combined process reservations.
Dispatch checks transport buffers and recipient window capacity. Cumulative
receipts cannot advance beyond emitted sequences; backward/foreign receipts fail,
and duplicates are harmless. A 768 KiB synthetic transfer with interleaved control
and receipts was tested for byte equality and sequence order.

Sender success means emission to the recipient transport, preserving relay-acceptance
semantics; it is not proof of recipient decryption. Unemitted canceled/expired work
receives explicit negative acknowledgments. Emitted media lacking receipts gets
`envelope-failed`. Queue timeout is ten seconds and receipt timeout thirty seconds.
Disconnect or continuity suspension cancels transfer work; clients must treat lost
transport/receipts as uncertain delivery, retain unacknowledged data locally and
restart affected transfers with fresh IDs. No offline queue, media-file storage,
durable delivery promise or automatic media resumption was added.

## Heartbeats and diagnostics

Local installed Engine.IO code owns its shared ping schedule. The existing
25-second interval and 30-second timeout are retained, close to the intended
approximately 30-second Tor cadence. No redundant application heartbeat,
per-client mutation of shared timers or global WebSocket-only restriction was
introduced. Future Tor clients may explicitly request WebSocket-only. Exact
Tor timing remains a real-device/network validation item; this phase does not
claim an exact 30-second per-onion heartbeat implementation.

Optional `PERF_DIAGNOSTICS=1` maintains bounded aggregate count/sum/max values for
forward duration, queue wait, media receipt delay, buffer bytes and contention.
`performanceMetrics.snapshot()` also returns process memory usage. There is no
external export, HTTP diagnostics route, identifier labeling or content logging.
These are server/receipt observations, not true end-to-end device measurements.

## Actual verification and measurements

| Check | Actual result |
|---|---|
| Baseline `npm test` | 45 passed, 0 failed |
| Baseline `npm run test:integration` | 30 passed, 0 failed |
| Final `npm test` | 61 passed, 0 failed |
| Final `npm run test:integration` | 37 passed, 0 failed |
| `git diff --check` | Passed |

The integration suite overlaps the full suite. All services were local synthetic
servers. Tests cover token separation, rotation/replay, concurrent takeover,
active/old socket authority, two-client reconnect, proof epochs/gating, dedup,
grace expiry and teardown, changed simulated IP/circuit, forbidden mode switching,
disabled/mixed capabilities, control/media priority, starvation prevention,
window/queue pressure, malformed binary/receipts, timeout failure notification,
diagnostic privacy and all existing Phase 0/1 regressions.

Early tests exposed and corrected an avoidable queue wake-up delay. A later
controlled-transfer assertion incorrectly waited for any envelope instead of its
specific control ID; it was corrected and both suites rerun. Failed intermediate
runs are not represented as passes. No production-scale or long heap-soak test
was performed.

`test/localRelayBenchmark.cjs` ran before and after changes: Node v24.21.0,
Windows loopback, WebSocket, 125 synthetic 256-byte ciphertext messages in five
paced batches. Raw aggregate artifacts are in `benchmarks/phase3-baseline.json`
and `benchmarks/phase3-after.json`.

| Local observation | Baseline | Final |
|---|---:|---:|
| Sender acknowledgment median | 1.7695 ms | 2.0465 ms |
| Sender acknowledgment p95 | 3.2775 ms | 3.6945 ms |
| Synthetic receiver delivery median | 1.4931 ms | 1.6796 ms |
| Synthetic receiver delivery p95 | 2.6463 ms | 3.1368 ms |

The final run was slower. These small uncontrolled loopback samples establish
neither a speedup nor a production regression attribution. We make no latency
improvement claim. Removing unnecessary microtask yields is technically justified
for atomicity; bounded priority/window behavior is demonstrated by tests. Real
profiling is still needed to quantify user-visible performance and overhead.

Targets remain unverified: warm Tor median <=1 s / p95 <=2.5 s, text during media
p95 <=3 s, Standard HTTPS median <=250 ms, and Tor media throughput >=150 KB/s.
Neither local plaintext-loopback timing nor synthetic ciphertext tests establish
these HTTPS/Tor/mobile end-to-end targets.

## Files and configuration

New modules: `phase3Config.js`, `sessionResume.js`, `binaryRelay.js`,
`performanceMetrics.js`.

Changed runtime files: `handlers.js` (negotiation, resume/binary events, authority
checks, synchronous handling, buffer metrics), `abuseLimiter.js` (synchronous
in-memory action checks), `matchmaking.js` (room cleanup callbacks and detached
session removal), `sessions.js` (clear retained dedup state at room termination).

Configuration/tests/artifacts: `.env.example`, `package.json`,
`test/phase3.test.js`, `test/phase3.integration.test.js`, `test/phase3Fixture.cjs`,
`test/localRelayBenchmark.cjs`, `benchmarks/phase3-baseline.json`,
`benchmarks/phase3-after.json`, `deployment/PHASE3_PROTOCOL.md`,
`PHASE3_REQUIREMENTS.md`, `PHASE3_PROGRESS.md`, `PHASE3_REPORT.md`.

No dependencies or infrastructure added. Future configuration, all unchanged in
production: `RESUME_ENABLED=0`, `RESUME_GRACE_MS=90000` (allowed 60000-90000),
`BINARY_RELAY_ENABLED=0`, `PERF_DIAGNOSTICS=0`. Earlier Phase 0/1 changes also
remain visible in the working tree; they were not reset or pushed.

## Mobile requirements, rollout and remaining boundaries

Mobile must implement retained RAM-only libsignal state and credentials, canonical
fresh continuity proofs with replay/reflection/role checks, safe loss recovery,
capability negotiation, binary interfaces and authenticated envelope metadata,
out-of-order safety, media consent, byte-window accounting, cumulative receipts,
local unacknowledged-data handling, error reporting and delivery measurement.
The server cannot verify a client that falsely claims proof validation. It must
remain disabled for clients without those complete cryptographic checks.

Synthetic proofs in tests test backend gates, not real libsignal continuity.
Real Android/iOS behavior, Tor circuit behavior, Linux onion permissions, mobile
suspension, E2E security review, actual HTTPS/Tor latency and throughput, and
production memory/CPU capacity remain unverified. Bearer-token theft can cause
denial of service even though delivery still requires peer continuity confirmation.
Anonymous session TTL, finite caches, rate limits, process restarts and network
loss impose finite recovery guarantees; nothing here creates persistent identity.

Safe eventual order: review backend with flags off; implement both mobile sides;
validate cryptographic transcripts, ordering, loss and replay on devices; validate
Linux/Tor/HTTPS staging and load; obtain separate deployment approval; activate
negotiated features in a coordinated release and observe aggregate diagnostics.
No step of that rollout occurred. Phase 3 backend coding and local testing are
complete, with mobile integration and real-device/network verification outstanding.
