# One-to-one privacy implementation plan and next-session handoff

> Superseded status, October 18, 2026: see SECURITY_HARDENING.md for current
> changes and validation. The source now uses protocol 7, direct HTTPS, and
> invite-only defaults. The historical release gate and testing prohibition
> described below do not describe the current implementation/session.

Prepared: 2026-10-14 (Asia/Karachi).
Updated: 2026-10-15 (Asia/Karachi): external Redis/Valkey storage removed at the user's request.
Status: implementation started; untested. The full privacy architecture is NOT implemented. See the implementation handoff below before continuing.

Latest reliability/attachment changes: see `BUGFIX_HANDOFF.md` (October 16, including streamed attachments).
Protocol 6 supersedes protocols 4/5 for coordinated client/backend upgrades, adds
bounded encrypted chunks and actual relay-acknowledged progress, and corrects
volatile delivery and navigation races. No tests or builds were run. The save
crash still needs device evidence after replacing the Android save path. Local PDF
preview/flattening, Office-to-text conversion, and media container rebuilding are
implemented but unverified; see the handoff for fidelity and privacy limits.
Earlier implementation entries below describe
their original milestones and are superseded by that handoff where applicable.

## 1. Scope and user requirements

Prioritize one-to-one chat in `../mobile` and this backend. Preserve the existing interface where possible. Group chat is outside this implementation scope and must continue to be clearly identified as server-readable; never inherit one-to-one security claims.

The user wants:

- Text, images, video, audio, and files encrypted before leaving the sender's phone, decrypted only on the intended recipient's phone.
- ISPs, Wi-Fi operators, network observers, hosting providers, administrators, and a compromised relay unable to read correctly authenticated conversations merely by obtaining traffic or backend data.
- Real client IP addresses hidden from the chat backend and other participants, with no direct-connection fallback.
- No database storing messages, no stored server attachments, and no offline message queue.
- Screenshot/recording protection throughout one-to-one chat and media viewing. Prohibited overlays must be blocked where supported; a confirmed violation hides content immediately and ends the chat.
- A header control called `Allow saving my media`, off by default, with independent directional permissions. It NEVER disables capture protection or encryption.
- Both sides end when either leaves; no old messages, keys, transfers, or permissions reach the next partner.
- Real implementation and testing, not promises of being unhackable or invented brute-force time estimates.

Current authorization: implement locally, per the user's subsequent request. Do not run tests yet. Deployment, provisioning, purchases, and publishing are not authorized by this document.

## Implementation handoff — 2026-10-14

These are source changes, not verified security guarantees. No tests, builds, runtime checks, or dependency audits were run during this implementation pass. Existing working-tree changes were preserved.

Implemented locally:

- Backend: bounded event concurrency, linear Base64 validation, payload budgets before expensive processing, volatile one-to-one forwarding, tighter room teardown, protocol-version checks, and loopback binding by default. On October 15, removed Redis/Valkey clients, adapters, dependencies, production requirement, and remote storage branches. Sessions, invite locators, queues, rooms, and abuse counters now live only in this server process RAM. Room claims, invite consumption, and teardown do not yield; rate-limit bucket count is bounded.
- Client: protocol v4 room binding, 256-bit invite secrets, bounded serialized sends, session-epoch guards against stale asynchronous work, encrypted typing/security/policy/close/liveness events, and cancellation of pending sends when the chat ends. Old invite codes and older chat clients are incompatible; client/server rollout must be coordinated.
- Media: independent sender-controlled `Allow saving my media`, disabled by default. Permission is authenticated inside each attachment and applies to future attachments. Explicit exports use Android's document picker or an iOS share sheet; app-owned temporary exports and picker copies are cleaned up. Exported copies cannot be recalled. A modified recipient can ignore UI restrictions.
- Capture: Android secure-window, overlay suppression, obscured-touch rejection, and audio-capture restrictions; an iOS native module covers inactive/captured windows, alongside Expo capture protection. Missing iOS native protection prevents chat entry. These changes require native builds and real-device verification; iOS arbitrary-UI screenshot prevention is NOT guaranteed.
- Lifecycle: hide content on inactivity, end on detected privacy violations, authenticated peer liveness with a provisional 35-second expiry, and immediate local teardown on leave. Remote teardown still depends on notification delivery or expiry. Background picker/export flows are exceptions to the normal background timeout.
- Dependency updates: Socket.IO components, proxy-addr and transitive packages; expo-sharing added. Installation used scripts/audits disabled; this is not a vulnerability-audit result.
- Deployment ingredients: `deployment/torrc.example` and `deployment/README.md` describe the intended onion-service boundary. No service was deployed.

Release safeguard: `../mobile/src/config.js` currently rejects ALL release chat connections because native anonymous transport is unfinished. Direct HTTPS is available only in development with explicit `EXPO_PUBLIC_ALLOW_DIRECT_DEV=true`; it exposes the device IP to the destination. This affects group networking too because the connection configuration is shared. Do not remove the gate to make a release appear ready.

Still required, in this order:

1. Integrate a maintained, reviewed native hybrid post-quantum authenticated protocol and ratchet, with peer verification and key lifecycle review. The current X25519/XSalsa20 implementation is still a custom legacy protocol, NOT post-quantum and NOT a forward-secret message ratchet. Version 4 framing does not change this fact.
2. Integrate native Tor transport on both mobile platforms and route every chat/media connection through it, without direct DNS/network fallback. Complete onion endpoint identity/TLS handling and redesign source-based abuse limits for Tor. The deployment template alone does not hide client IPs.
3. Resolve the iOS capture acceptance criterion using device evidence. If absolute prevention is still mandatory, do not label consumer iOS compliant or silently substitute a best-effort workaround.
4. After the user permits testing: native compile/autolinking, protocol and session-race tests, updated v4 fixtures, directional media permission checks, capture/overlay device matrix, cache/log/persistence inspection, Tor leak tests, dependency audit, and independent cryptographic/security review. Existing tests may still assume old invite sizes or protocol versions.
5. Enable release connections only after the actual transport/protocol protections and acceptance gates are satisfied. No claims of protection against endpoint compromise, recipient copying, or global traffic correlation.

RAM-only deployment requirement: one Node process and one replica. No cluster mode or autoscaling across independent processes. Restarting ends chats and invalidates invites. Retire any previously provisioned external state service and remove deployment secrets separately; local source edits do not erase remote data or change the running deployment. Host RAM limits, swap, dumps, and snapshots require operational controls. No tests or builds were run for this change.

Useful entry points: backend `handlers.js`, `matchmaking.js`, `sessions.js`, `invites.js`, `abuseLimiter.js`; mobile `src/services/socket.js`, `e2e.js`, `peerLiveness.js`, `captureProtection.js`, `mediaExport.js`, `src/screens/ChatScreen.js`, `plugins/withPrivacyWindow.js`, and `modules/whisper-privacy/ios/WhisperPrivacyModule.swift`.

## 2. Security boundaries and unresolved constraints

Treat the relay as potentially malicious, not merely curious. Public-key exchange through a server is not enough to authenticate a peer. Random matchmaking has no external identity trust anchor; the app must not falsely mark it verified.

The intended recipient necessarily receives plaintext. A modified recipient app can retain it despite disabled save buttons. A compromised endpoint, malicious keyboard, external camera, or malicious app update can expose content. Screenshot restrictions are client protections, not cryptographic controls over the recipient.

Tor reduces IP exposure but cannot guarantee anonymity against an adversary observing and correlating both ends. The ISP still knows the subscriber's connection and may recognize Tor use. The relay still observes temporary pairings and traffic timing/volume. Do not claim IP addresses are simply encrypted out of existence.

Zero-delay remote shutdown is impossible during a partition. Local shutdown must have no intentional delay; remote shutdown happens on notification or expiration of a bounded validity interval. Do not promise instantaneous remote deletion, forensic RAM erasure, or revocation of exported files.

iOS has no documented general-purpose guarantee for blocking screenshots of arbitrary app UI. The installed Expo implementation does attempt this with secure text rendering. Research and test it; do not confuse successful API invocation with proven enforcement. If the required capture capability cannot be established for a supported configuration, protected chat stays unavailable. If absolute prevention is required rather than a tested best-effort capability, ordinary consumer iOS cannot currently be declared compliant. Do not silently lower this requirement; bring the concrete compatibility findings to the user.

## 3. Proposed architecture

```text
A plaintext / selected media
  -> native client encryption with authenticated peer keys
  -> anonymous transport through Tor
  -> backend onion service: bounded ciphertext forwarding only
  -> anonymous transport through Tor
  -> B authenticates/decrypts locally -> protected rendering
```

The backend uses random room/session identifiers and live connections, not saved user IPs, to route traffic. Use fresh identifiers for each chat. Rotating labels on a persistent connection every few seconds does not hide the connection; do not build fake-IP rotation.

Strict mode connects directly through a real Tor client to an onion service, not a public web-to-onion gateway. No Tor exit is needed for onion service traffic. The backend listener is reachable only through the intended local onion-service path. Keep authenticated transport protection as well as application E2EE; decide and test onion-compatible TLS/certificate handling without disabling certificate validation. Do not require a public clear-web bootstrap that exposes chat use or client IPs to our infrastructure.

Audit all app-originated requests: Socket.IO polling/upgrades, files, DNS, reconnects, link previews, telemetry, crash reporting, update checks, and third-party SDKs. Strict-mode chat traffic must not escape the anonymous transport. Distinguish unrelated OS/App Store traffic from app routing guarantees. Prefer no external previews, analytics, advertising IDs, contact uploads, or content-bearing push notifications. Do not automatically launch links from received messages.

## 4. Encryption and authentication design

### Protocol selection gate

Replace the custom `src/services/e2e.js` protocol with a maintained implementation of an established authenticated messaging protocol. Candidate reference: Signal's PQXDH plus current hybrid/post-quantum ratcheting specifications. Evaluate supported protocol versions, native platform interfaces, maintenance, license obligations, and performance before selecting the exact library/version.

`signalapp/libsignal` is a candidate, NOT a committed dependency. It supplies Java and Swift interfaces over Rust, is AGPL-3.0 licensed, states that external use is unsupported, and warns of API changes. Its Node/TypeScript interface must not be assumed to run in React Native. Verify actual availability of desired PQ ratchet features in the selected release. If unsuitable, document a supported alternative and its security properties; do not implement a bespoke replacement to meet a deadline.

Use native OS randomness. Prefer native crypto state with opaque handles crossing the JS bridge. Keychain/Keystore support must be verified for each algorithm; do not claim all protocol keys can be hardware-backed or non-exportable. For ephemeral chats, avoid persistent private conversation state. Document buffers and temporary plaintext that remain unavoidable for rendering.

### Authenticated invite setup

- Generate a fresh high-entropy invitation secret on the creator's device (target 256 random bits) and a separate routing locator.
- The locator may reach the relay; the secret must not. Avoid URL query parameters, logs, analytics, browser landing pages, or clipboard persistence leaking the secret. A fragment alone is not a complete solution: landing-page JavaScript can read it.
- Integrate invitation authentication only through a reviewed, protocol-compatible construction. Determine whether the invitation authenticates public-key fingerprints, a supported PSK handshake, or another reviewed mechanism. Do NOT arbitrarily concatenate the secret into a KDF or assume PQXDH offers a generic PSK option.
- Bind the session, protocol version, roles, and peer keys as required by that construction. Both ends confirm key possession before accepting user content. Consume the routing locator atomically and expire it.
- Invite possession authenticates possession, not a person's real identity. Secure distribution and/or independent safety-code comparison remain necessary.
- Random chats: keep the unverified status explicit. The strongest verified mode cannot send sensitive content until its authentication requirement is met. Never let a server-provided `verified` flag establish trust.

### Message processing

- Use the selected protocol's authenticated encryption, KDF, nonce rules, and evolving message keys unchanged.
- Scope messages and control events to the authenticated session; reject replay, forgery, tampering, key substitution, and downgrade attempts. Bound skipped-key and out-of-order buffers to resist memory exhaustion.
- Retrying transmission reuses the already-produced encrypted packet according to library semantics; it must not accidentally reuse a nonce for different plaintext or reset sequence state.
- Distinguish relay acceptance from an authenticated recipient receipt. Do not call server acceptance `delivered`.
- Protect receipts, media permissions, typing events if retained, and security notices with E2EE. Minimize unnecessary metadata events.
- Validate classical and post-quantum confidentiality/authentication properties separately. PQ confidentiality does not automatically imply fully PQ-resistant authentication.
- No master key, server decrypt endpoint, escrow key, plaintext moderation pipeline, or insecure compatibility fallback for one-to-one content.

## 5. Media and independent saving permissions

| A allows saving A's media | B allows saving B's media | Allowed in the official client |
| --- | --- | --- |
| Off | Off | Neither saves the other's media |
| On | Off | B saves A's media only |
| Off | On | A saves B's media only |
| On | On | Both save the other's media |

Save permission changes do not affect E2EE, capture prevention, overlay handling, or session cleanup. Default off in every new session. A recipient cannot grant themselves saving permission. Show the sender's setting and changes clearly to both parties.

Planning default: snapshot the sender's saving policy into each authenticated attachment descriptor at send time. Switching on applies to future attachments; it does not unlock old attachments. Switching off stops permission for future attachments; already granted permissions/copies cannot be recalled. Explain this in the control's concise help text. A separate per-attachment grant can be considered later, not required for the first release.

- Fresh attachment encryption key per file; carry keys and metadata only inside E2EE messages.
- Use a reviewed authenticated streaming/file format with unique nonces and binding to session, attachment ID, chunk index, length, and completion as appropriate to the selected construction. Do not invent a chunk protocol without review.
- Authenticate chunks and final completion; reject reordering, truncation, substitution, duplicates outside protocol allowances, and unbounded allocation.
- Encrypt filenames, MIME metadata, thumbnails, captions, and sensitive descriptors. Routing sizes remain partially observable.
- No remote cleartext URLs or automatic preview fetches. Bound memory, decoded sizes, dimensions, duration, transfer concurrency, and bandwidth.
- Render only verified content. Do not execute attachments or auto-open them in external apps.
- Do not write received plaintext media to disk by default. If native playback requires temporary files, evaluate encrypted cache plus short-lived decryption and OS data protection, and disclose the limitation before approving the design.
- Audit picker/camera copies, thumbnail caches, playback caches, crash recovery, backups, sharing, and export paths. Clean up only app-owned temporary files, never the user's original library files.
- Strip supported metadata with tested transformations; renaming a file or setting `exif: false` is not evidence all embedded metadata is removed. Warn for arbitrary document types that cannot be safely sanitized.
- Only explicit, permitted Save creates an intentional persistent recipient copy. Once exported, the OS or other apps can back it up; that is outside session deletion.
- Confirm whether audio capture/playback needs new UI: the reviewed client explicitly exposes text/image/video/file paths; do not claim a dedicated voice-note feature already exists.

## 6. Capture protection, overlays, and notices

Protection must be active before first sensitive frame and cover chat, keyboards where feasible, modals, image zoom, video players, attachments, navigation transitions, app-switcher previews, and inactive/background states. Native lifecycle handling is required; a delayed JS effect alone is insufficient.

Android:

- Use secure windows to exclude content from supported screenshots, recordings, casting, and recents previews.
- Use supported overlay suppression on Android 12+ and appropriate obscured-touch protection. This does not detect every active application or every system/accessibility overlay.
- Confirm actual violation signals before ending a session; do not treat an installed recorder, keyboard, permission dialog, or ordinary system UI as proof of an attack.
- Stop/pause playback when capture is detected and evaluate audio playback-capture exclusion. Black video alone does not protect audio.
- Do not request broad photo-library access merely to monitor screenshots. Use supported screenshot callbacks where available, recognizing blocked attempts may not emit callbacks.

iOS:

- Production baseline: native scene capture state handling, immediate opaque content replacement, stopped playback, protected app-switcher snapshots, and initial capture-state checks before rendering.
- Inspect and test the existing Expo secure-text rendering workaround as a supplementary capability, including all windows/viewers and lifecycle transitions. Apple does not document arbitrary-view screenshot blocking through secure text fields.
- The current app invokes capture protection from both `App.js` and `ChatScreen.js`; review ownership/idempotency and native layer restoration to avoid nested wrappers, crashes, or permanently black UI.
- FairPlay is not a general chat protection solution; MDM restrictions are a separate managed-device deployment option, not ordinary app permissions. Do not use private APIs or assessment entitlements as a loophole for a chat app.
- Produce a tested OS/device support matrix. Fail closed when initialization fails. Do not treat `isAvailableAsync()` or a resolved promise as proof a screenshot was excluded.

Security event policy:

- Confirmed prohibited-overlay violation: hide content and stop playback immediately, transition to ended, notify peer if possible, clear local state. Recording detection: hide/pause immediately; end if the required protected state cannot be maintained. Do not promise third-party recorder identification.
- Screenshot event: small in-chat notice where supported, with session-local display name or `Peer` if there is no username. Say `Screenshot detected on Alex's device` when that is the evidence. Say `blocked`/`failed` only if independently established by the platform, not merely requested.
- Security notices are authenticated device reports, not proof from a trusted remote OS. Rate-limit them and avoid false accusations. Use the ended screen if chat already closed.
- Keep capture protection active during permitted in-app media use; external exported copies cannot retain app-enforced capture restrictions.

## 7. Session lifecycle and shutdown

Proposed states: idle -> anonymous transport connecting -> peer authentication -> protected active -> ending -> ended. Ended is terminal; callbacks from prior generations cannot revive a session.

- No user content before transport/privacy initialization and peer-authentication requirements complete.
- Explicit Leave: synchronously hide local content and stop input/playback/transfers; attempt an authenticated close notice before destroying state without waiting to hide content. Server atomically closes room, rejects subsequent traffic, and notifies peer. Cleanup is idempotent and race-safe.
- Recipient closes on valid termination notice/server room closure; denial of service by a malicious relay remains possible. Independently enforce peer liveness with authenticated challenges/heartbeats so a malicious relay cannot indefinitely forge a live peer.
- Lost connectivity: immediately hide content when detected, then expire the session using a measured deadline. Use monotonic timers and recheck on foregrounding. No automatic resurrection of ended chats; a new connection starts a fresh session.
- Determine heartbeat/expiry settings from measured Tor latency and mobile suspension behaviour. Short expiry increases false endings. Record a chosen measurable bound; do not invent a zero-delay guarantee or keep the current 2-second reconnect window blindly.
- Hide content on background/inactive transitions. Define short system interruptions separately from leaving so the picker, permission dialogs, or file export do not break the session unexpectedly; recheck protection before revealing content.
- On ending: discard keys, message buffers, pending receipts, in-flight decoded chunks, saved-policy state, timers/listeners, peer identity state, and app-owned temporary files. Restart cleanup removes abandoned app-owned cache, with no secret persisted to resume a chat.
- Test stale events across rematching, simultaneous leave/send, partial downloads, app crash/kill, and server restart. A next partner must never see earlier content or inherit permissions.

## 8. Backend and operations

- No stored message history in process data structures. Small bounded transport buffering is unavoidable; it must not become an offline queue.
- Temporary routing, invite-locator, and abuse-control metadata stays in this server process RAM. No external state service, pub/sub, or persistence. Run one process/replica and use bounded admission and counters. Restarts erase temporary application state.
- Inspect proxy, load-balancer, hosting, OS, diagnostic, and crash logging. Avoid client IP/content/key records; prohibit core dumps, swap, and unintended persistent memory snapshots for sensitive processes where configurable. Do not claim infrastructure absence of logs from source inspection alone.
- With onion transport, existing per-IP limits may see only a local/Tor proxy address. Redesign admission using bounded anonymous connection/session budgets and cheap checks before expensive work, without trusting spoofable headers or introducing stable tracking IDs. Do not defeat IP privacy by forwarding original client addresses.
- Patch reachable dependency issues, bound all frame/packet/attachment processing, replace problematic Base64 validation, constrain concurrency, and validate control payloads before allocation or expensive crypto.
- Check trusted-proxy/TLS topology, private service exposure, connection limits, atomic RAM operations, and single-process deployment. `Origin` checks are not authentication.
- Anonymous routing does not prevent floods. Measure resource limits and overload rejection; no unlimited padding, unlimited message queues, or unconstrained proof-of-work.
- Harden releases: pinned/reviewed dependencies, signed builds and updates, minimal update/signing access, reproducible-build feasibility, and no secret-bearing build logs. Attestation is not a magic proof of honest clients and may introduce identifiers/external requests; evaluate separately before adoption.

## 9. Ingredients and readiness inventory

| Ingredient | What is available / next action |
| --- | --- |
| Mobile app | Expo 54 (`~54.0.35`), React Native 0.81.5, React 19.1.0; confirm lockfile/installed versions on resumption |
| Existing crypto | TweetNaCl custom protocol; use as migration baseline only, not the target ratchet |
| Native crypto candidate | libsignal Java/Swift interfaces; validate AGPL compatibility, external maintenance, protocol support, build sizes and memory lifecycle |
| Attachment crypto | Prefer selected protocol's supported attachment format; otherwise evaluate maintained authenticated streaming library (e.g. libsodium secretstream) with native bindings and independent integration review |
| Capture integration | Existing `expo-screen-capture ~8.0.9`, native Android project, existing iOS secure-text workaround; inspect exact installed code and Expo patches |
| Tor networking | No verified integration selected. Evaluate maintained Android/iOS Tor libraries/client embedding, lifecycle, onion-service support, and real Socket.IO WebSocket/polling routing. Do not assume Node SOCKS-agent options work in React Native |
| Tor alternatives | Any runtime must actually support the required onion-service client/server features on mobile. Do not assume a named Tor implementation has feature parity without testing |
| Transport bridge | Likely native networking adapter/custom Expo development build; demonstrate remote/onion name resolution and no direct/DNS fallback |
| Build tools | Android SDK/NDK as required; macOS + Xcode and signing access for iOS; Rust/native tools if selected dependency needs them. Availability not yet verified |
| Test hardware | At least two physical phones, Android/iOS cross-platform pairs, multiple supported OS versions/vendors, stock and third-party recorders, mirroring, and controlled Wi-Fi packet capture |
| Infrastructure | Isolated onion-service staging host, verified transport configuration, single-process RAM-only backend, host memory/swap/dump controls. No production provisioning performed |
| Test harness | Hostile relay simulator, packet capture, network delay/loss injection, OS/device capture tests, storage inspection after restart/crash |
| Independent review | Cryptographic integration, mobile privacy, networking/IP leak review; external reviewer/budget not arranged |

Do not download/install speculative packages or request production credentials during planning. Readiness research is not proof of mobile feasibility. Continue locally available work before asking for missing device/build access.

## 10. Source map and baseline findings

Paths are relative to this backend directory.

- `../mobile/src/services/e2e.js`: current X25519 + XSalsa20-Poly1305, custom key derivation, static shared session secret, no evolving ratchet; invite authentication described as 80 bits.
- `../mobile/src/services/socket.js`: invitation parsing, key lifecycle, envelope validation, receipts, send text/image/video/file, reconnect and permission integration point.
- `../mobile/src/screens/ChatScreen.js`: handshake, messages, media lifecycle, capture events, header UI, local termination.
- `../mobile/App.js`: global capture-protection ownership and app-switcher protection.
- `../mobile/src/components/MediaPickerButton.js`, `ChatBubble.js`: file picker cache, metadata, rendering/export paths.
- `../mobile/src/components/SafetyVerifyOverlay.js`: accurate verification status and safety-code workflow.
- `../mobile/src/screens/HomeScreen.js`, `WaitingScreen.js`, `ChatEndedScreen.js`: invite UI, secure readiness, disconnect reason.
- `../mobile/src/config.js`, `app.config.js`, `app.json`, `android/app/src/main/AndroidManifest.xml`, `android/app/src/main/java/com/hussnainahmadsahi/chat/MainActivity.kt`: native build/privacy/network configuration.
- `handlers.js`, `matchmaking.js`, `sessions.js`, `invites.js`: ciphertext relay, routing, atomic close and invite use, protocol migration.
- `server.js`, `security.js`, `networkConfig.js`, `abuseLimiter.js`, `httpLimiter.js`, `validation.js`: transport, RAM-only limits, deployment assumptions. `redisClient.js` and its parsing helper were removed.
- `test/security.test.js`, `../mobile/test/e2e.test.cjs`: existing tests to extend/replace meaningfully for new protocol.

Earlier local review in this conversation: 13 backend and 5 mobile tests passed. These are not proof of the target architecture. Audit found engine.io 6.6.9 and socket.io-parser 4.2.6 high-severity availability advisories, proxy-addr 2.0.7 critical advisory with deployment-dependent applicability, and qs 6.15.3 moderate advisories. Re-run audits and assess reachable paths; do not blindly force upgrades. A 5,592,408-character allowed-size Base64 input caused a RangeError in validation on the local Node runtime; validation occurs before message bandwidth checks. Handler catches the exception, but expensive work remains a concern.

Historical local review found production mode and remote-store persistence safeguards unset. That storage integration has since been removed. This is not verification of the deployed infrastructure. Do not copy secrets into reports. Direct development networking is not the planned strict anonymity route.

Both repositories have substantial pre-existing user changes. Backend dirty files included `.env.example`, `package-lock.json`, `package.json`, `server.js`; mobile has many modified/untracked files. Re-read git status before edits, preserve all user work, and do not reset, clean, or overwrite unrelated changes.

## 11. Implementation order and acceptance gates

1. **Baseline and threat model:** re-read this document, repository instructions, source changes, and supported platforms. Record claims/nonclaims and current tests/audits. Preserve existing work.
2. **Feasibility prototypes:** build native crypto handshake/ratchet on both platforms; prove Tor/onion WebSocket and fallback isolation; test existing capture implementation on real phones. Produce dependency/license decision, device support matrix, measured costs, and blockers before a broad migration.
3. **Server hardening and protocol boundary:** fix independently confirmed vulnerabilities; implement bounded ciphertext-only relay and strict protocol versioning. Define rollout without silent downgrade or mixing incompatible old/new clients.
4. **Authenticated encrypted sessions:** replace custom crypto, integrate invite authentication and safety codes, implement replay-safe control events and receipts. Verify hostile relay tests before UI security claims.
5. **Anonymous transport integration:** route all required requests through Tor, remove direct escape routes in strict mode, test DNS/reconnect/background leakage and redesign abuse limits.
6. **Media and saving controls:** encrypt streaming attachments, implement directional policies, verified rendering, exports and cache cleanup. Keep capture restrictions independent.
7. **Native privacy lifecycle:** unify capture ownership, cover all viewers/previews and audio, implement confirmed-overlay response, accurate notices and fail-closed capability handling.
8. **Session closure:** implement atomic room closure, authenticated liveness/expiry, no resurrection, and cleanup across crashes/races/new matches. Measure connected and partition cases separately.
9. **Independent verification and staged release:** complete test matrix, audit deployment/logging and supply chain, resolve review findings. Publication/deployment requires concrete review and appropriate user authorization; no absolute privacy marketing claims.

Required acceptance evidence:

- Packet captures and server instrumentation with synthetic canary content show no plaintext messages/files/private keys; a compromised relay cannot substitute keys in authenticated mode.
- Replayed/modified/downgraded messages and attachment swaps/truncations are rejected; legitimate retry/reordering cases behave safely within bounds.
- No app traffic escapes the intended anonymous route during DNS, polling/upgrades, reconnect, Tor failure, background/foreground, file viewing or sending. Backend never receives the test device's real public IP through chat paths.
- Test device traffic still exposes Tor connectivity/timing to its access network; documentation states this limitation instead of claiming invisibility.
- Four saving-policy combinations pass for each media type; setting changes cannot be forged/replayed, and capture protection remains active.
- Screenshots/recordings/mirroring/audio/background previews are evaluated with actual outputs on the support matrix, not just mocks/API success. Unsupported requirements block strict-mode release on affected platforms.
- Explicit leave immediately clears local UI and ends remote UI on receipt; bounded expiry handles network loss. Old events/files/keys cannot reach a newly matched person.
- Backend storage/logs/backups contain no message history; app-owned caches are inspected after normal exit/crash/restart. Authorized exports and original sender files are explicitly excluded from deletion promises.
- No unresolved reachable high-impact vulnerabilities, no unexplained diagnostic failures, and independent review findings resolved before strong privacy claims.

## 12. Primary references collected

Recheck compatibility/security advisories at implementation time.

- Signal PQXDH: https://signal.org/docs/specifications/pqxdh/
- Signal ratchets including post-quantum extensions: https://signal.org/docs/specifications/doubleratchet/
- Signal ML-KEM Braid: https://signal.org/docs/specifications/mlkembraid/
- Libsignal implementation and limitations: https://github.com/signalapp/libsignal
- Authenticated file streaming candidate: https://doc.libsodium.org/secret-key_cryptography/secretstream
- Tor onion-service design: https://community.torproject.org/onion-services/overview/
- Tor traffic-analysis limits: https://support.torproject.org/about-tor/security/attacks-on-onion-routing/
- Tor guards (do not invent rapid circuit/entry rotation): https://support.torproject.org/about-tor/how-tor-works/entry-guards/
- Android secure windows/overlay suppression: https://developer.android.com/security/fraud-prevention/activities
- Android screenshot detection limitations: https://developer.android.com/about/versions/14/features/screenshot-detection
- Expo SDK 54 capture API: https://docs.expo.dev/versions/v54.0.0/sdk/screen-capture/
- Apple capture-state handling: https://developer.apple.com/documentation/swiftui/protecting-sensitive-content-when-screen-sharing
- Apple screenshot notification: https://developer.apple.com/documentation/uikit/uiapplication/userdidtakescreenshotnotification
- Apple engineering on secure-text workaround: https://developer.apple.com/forums/thread/824922
- Apple managed-device restrictions: https://support.apple.com/en-ca/guide/deployment/dep0f7dd3d8/web
- Apple FairPlay/capture/audio distinctions: https://developer.apple.com/library/archive/qa/qa1970/_index.html
- Engine.IO advisory: https://github.com/advisories/GHSA-2gc4-cqfq-p2gv
- Socket.IO parser advisory: https://github.com/advisories/GHSA-2m8v-j782-fhvr
- Proxy-addr advisory: https://github.com/advisories/GHSA-jqcg-44mw-7w3h

## 13. Next-session starting instruction

Read `backend/SECURITY_IMPLEMENTATION_PLAN.md` completely, inspect both repositories' instructions and dirty state, and continue from the first incomplete milestone after implementation is requested. Start with feasibility prototypes and current security baseline. Do not claim the current app already provides Tor routing, post-quantum ratcheting, guaranteed screenshot blocking, or audited security. Record decisions and actual verification evidence in this document as work progresses.
