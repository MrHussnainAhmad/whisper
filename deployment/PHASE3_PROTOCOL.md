# Phase 3 negotiated protocol (future mobile integration)

Implementation is local only. `RESUME_ENABLED=0` and `BINARY_RELAY_ENABLED=0` are
the defaults. No app changes or production activation have occurred. All events
below use a data object and a Socket.IO acknowledgment callback, except existing
`secure-channel-ready` / `verify-chat`, which retain their original signatures.

## Capability negotiation

After the usual `joined` and before matchmaking/room assignment, send
`negotiate-capabilities` with `{ resume: 1, binary: 1 }` (omit unsupported options).
The reply is `{ ok: true, resume: boolean, binary: boolean }`, intersected with
server flags. Negotiation is connection-local and cannot be changed in a room
or while queued. After matching, `room-capabilities` with `{}` returns the
intersection of both participants' capabilities. Neither extension is used if
either peer lacks it. Unmodified v7 clients keep immediate disconnect teardown
and the original JSON/Base64 path.

## Resume credentials and lifecycle

1. Establish the original libsignal channel and complete both normal readiness
   acknowledgments. Each participant then calls `resume-token` with `{}`.
   Success returns `{ ok: true, token, roomId, slot, generation, graceMs }`.
   `token` is 32 cryptographically random bytes encoded as 64 lowercase hex
   characters; `slot` is 0 or 1. Each participant receives a different token.
   Both participants must obtain credentials before a disconnect can retain
   the conversation. The relay stores only token hashes and routing metadata.
2. Store credentials in client RAM only. Calling `resume-token` again replaces
   and invalidates that participant's prior token. If its acknowledgment is lost
   while the socket is still authorized, request another token. A token lost
   together with the connection cannot be recovered; fail closed.
3. On network loss, stop all sends. `resume-waiting` carries `{ roomId, deadline }`
   to the connected peer. The first suspension starts a fixed 90-second default
   grace (configurable 60-90 seconds); further attempts never extend it. The
   original 30-minute anonymous-session TTL remains an upper bound. Explicit
   leave, report, block and session expiry still terminate immediately.
4. Create a fresh normally admitted Socket.IO connection. Re-negotiate the same
   resume/binary capabilities. It may use a different IP or Tor circuit, but must
   use the same Standard/onion transport mode as that participant's original
   connection. Never reuse the old Engine.IO SID across circuits.
5. Send `resume-session` with `{ token, requestId }`, where `requestId` is a UUIDv4.
   Success returns `{ ok: true, roomId, epoch, challenge, generations, deadline }`.
   The token is consumed synchronously, the previous socket loses all authority,
   and its replacement is attached but NOT permitted to deliver messages yet.
   Only one concurrent request can consume the token. A repeated request cannot
   reauthorize another socket. The UUID is a validated request label, not a
   reusable credential or an idempotent takeover key.
6. The same context is emitted to both participants as `resume-challenge`.
   `challenge` is fresh 256-bit random hex, `epoch` changes on each attachment,
   and `generations` is the two-slot credential-generation vector. Two simultaneous
   reconnects can supersede the first challenge: use the latest context only.
   If a resume response/event is lost, the newly attached socket can call
   `resume-status` with `{}` to recover the current context and `pending` state.
   An idle/unauthorized socket cannot query another participant's context.

## Required end-to-end continuity proof

This is a required future mobile implementation, not cryptographic verification
performed by the server. A bearer resume token alone is insufficient to resume
delivery. Do NOT enable this feature with clients that merely echo `verified`.

Using the retained original libsignal session, each participant must encrypt and
authenticate a fresh continuity message binding all of:

- domain/version `whisper-resume-v1`;
- original room ID and participant roles (`fromSlot`, `toSlot`);
- current challenge, epoch and two-slot generation vector;
- the fact this is a continuity proof, not an ordinary chat message.

Use a canonical encoding agreed by both mobile implementations. Reject stale,
mismatched, replayed, reflection or wrong-role proofs. Never replace the original
libsignal session, accept a new peer identity key, fall back to room-only invite
authentication, or send private keys/invitation secrets to the relay. The existing
invitation-authenticated session must remain the cryptographic authority.

Send `resume-proof` with `{ epoch, challenge, proof }`, where `proof` is bounded
Base64 ciphertext (at most 16,384 characters). The peer receives
`resume-peer-proof` with `{ roomId, epoch, challenge, proof }`. The server relays
one proof per participant per epoch; duplicate sends acknowledge without another
relay. If an event was missed, terminate safely rather than claim verification.

Only after decrypting and checking the peer proof should each client send
`resume-confirm` with `{ epoch, challenge, verified: true }`. Both proofs must
have been relayed and both current sockets must confirm. The second confirmation
unfreezes delivery and emits `resume-complete` with `{ roomId, epoch }` to both.
Duplicate confirmations for the completed epoch are idempotent. Neither legacy
readiness events nor key-exchange events bypass the freeze. If validation fails,
explicitly end the room; do not acknowledge continuity.

After completion, the resumed participant must call `resume-token` to obtain its
rotated credential. The consumed token cannot be reused. There is no restored
authorization from a lost token. Other still-unused participant tokens remain
separate. The relay coordinates client assertions; it cannot inspect or certify
their libsignal proof validity. Grace expiry destroys the room and credentials.
No persistent identity or session storage exists. At most 512 rooms can hold
resume state concurrently (at most 1024 participant records).

## Binary encrypted envelopes and prioritization

Both participants must negotiate binary support. Existing `send-encrypted` is
unchanged and remains available. The server does not convert Base64 or alter
ciphertext. For a negotiated binary envelope, send `send-envelope` with:

```text
{ roomId, messageId: UUIDv4, kind: "control" | "media", ciphertext: binary,
  streamId?: UUIDv4, sequence?: integer }
```

Node Socket.IO receives `ciphertext` as a Buffer. Mobile must use its supported
binary interface (not a Base64 string, JSON Buffer object or numeric array).
Control ciphertext is 1-4096 bytes. Media ciphertext is 1-32768 bytes, targeting
24-32 KiB chunks after accounting for encryption overhead. Media requires a
fresh stream UUID and monotonically consecutive sequence starting at zero.
Each direction supports one outstanding media stream. Receiver consent must be
obtained through the authenticated client protocol before sending any media.

`kind`, sizes, stream ID and sequence are visible routing metadata. The relay
validates their shape/limits but cannot authenticate plaintext meaning. Mobile
must bind this metadata inside authenticated encryption and compare it after
decryption, rejecting inconsistencies. No plaintext MIME types, filenames,
captions or invitation secrets belong in the relay envelope. Small envelope
classification is advisory and cannot bypass socket/room quotas.

The receiver gets `receive-envelope` with the allow-listed fields above. Media
order is preserved within its stream; control envelopes may overtake queued media.
Control order is FIFO. After four controls a ready media envelope gets a turn.
Client libsignal handling must therefore support authenticated out-of-order
messages/skipped keys or separate safe streams; do not enable this format until
that behavior and metadata authentication are implemented and tested. The relay
does not change libsignal or impose this ordering on legacy v7 messages.

Each direction has at most 256 KiB of queued ciphertext, 128 queued envelopes,
and 256 KiB / 128 chunks awaiting recipient acknowledgment. A process-wide
16 MiB reservation bounds queued plus outstanding bytes. A slow transport's
pending output is checked before further emission; queued control cannot preempt
a WebSocket frame already in TCP. Ordinary Engine.IO payload/inflight limits and
Phase 0 quotas still apply. Limit client concurrency (for example four sends);
the existing eight-inflight-handler protection is not disabled.

The sender's acknowledgment is delayed until emission to the recipient transport:
`{ ok: true, messageId, duplicate: false }`. A bounded 200-ID cache returns
`duplicate: true` on a retry after emission; pending retries get retryable errors.
This is server relay acceptance, NOT recipient decryption/delivery confirmation.

After receiving/decrypting/validating contiguous media chunks, the recipient
sends `media-ack` with `{ roomId, streamId, through }`, the highest contiguous
sequence accepted. It cannot acknowledge unsent sequences. Duplicate cumulative
receipts are harmless; backward/foreign/out-of-range receipts are rejected.
The sender receives `media-credit` with
`{ roomId, streamId, through, availableBytes }`. The backend gates dispatch on
its own window accounting; clients must also keep outstanding bytes <=256 KiB.
Control messages need any true delivery receipts inside the encrypted protocol.

Queued work waiting ten seconds or media lacking receipts for thirty seconds
aborts the direction's work. Unemitted sends receive negative acknowledgments;
already emitted/unacknowledged media produces `envelope-failed` with
`{ messageId, reason }`. Disconnect/continuity suspension or room termination
also cancels queued work. Clients must retain unacknowledged data locally,
treat transport loss as uncertain delivery, abort affected transfers, and use
fresh stream/message IDs after recovery. There is no offline ciphertext queue,
durable delivery guarantee, or automatic media resumption. Never report success
to a user solely from the relay acknowledgment.

## Heartbeat, diagnostics and rollout

Engine.IO continues to own heartbeats: current 25-second ping interval and
30-second timeout are retained for compatibility, near the intended ~30-second
Tor interval. No redundant application heartbeat or global WebSocket-only policy
is added. Future Tor clients can select WebSocket-only themselves. Exact Tor
timing needs real-network testing; shared engine timer options must not be mutated
for a single client. New HTTP streams still face Phase 1 header deadlines.

`PERF_DIAGNOSTICS=1` enables bounded aggregate count/sum/max observations for
forward duration, queue wait, media acknowledgment delay, pending bytes and
contention. `performanceMetrics.snapshot()` returns those plus process memory
in the running process; there is no HTTP diagnostics endpoint or external export.
Queue-inclusive server emission duration and client receipt latency differ from
true sender-to-recipient delivery. Benchmark artifacts are synthetic local results.

Eventual order (not executed): review backend -> keep flags off -> implement and
test both mobile cryptographic/queue contracts -> real-device/Linux/Tor staging
and load tests -> authorized coordinated activation -> observe aggregate behavior.
Future VPS flags are `RESUME_ENABLED`, `RESUME_GRACE_MS` (60000-90000),
`BINARY_RELAY_ENABLED`, and optional `PERF_DIAGNOSTICS`. Disabling flags is a
process configuration change and restart ends RAM-only conversations. No new
infrastructure, persistent state, Tor configuration, or deployment is required
by this local code change.
