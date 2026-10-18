# Chat reliability and attachment changes — October 15, 2026

Status: implemented in source, not runtime-verified. The user's earlier instruction
not to run tests remains in effect. No tests, builds, or deployments were run.
The mobile working tree contains other pre-existing changes; preserve them.

## Deployment compatibility

Both mobile clients and the backend must be updated together. One-to-one
protocol 5 introduces encrypted attachment chunks and a bounded replay window.
Protocol 4 key exchanges are rejected with an update message. Existing invite
format is unchanged. Rebuild the APK: photo normalization adds the Expo 54
image-manipulator native dependency, and video capture enables microphone
permission. Installing dependencies used scripts/audits disabled.
The local WhisperAttachments Expo module now includes Android save/PDF/media
operations and iOS PDF/media operations. A fresh native build is required;
an OTA JavaScript update alone cannot supply these APIs. Dependencies fflate
0.8.2 and pdf-lib 1.17.1 were added with scripts/audits disabled.

## Changes

- Connected requests use regular Socket.IO events with bounded acknowledgement
  deadlines and disconnect cancellation. Volatile delivery no longer drops
  matchmaking, invite requests, messages, or attachment chunks when busy.
- Relay forwarding checks the live peer and bounds its pending transport data.
  Retries are deduplicated again immediately before forwarding. Relay ACKs still
  mean relay acceptance, not recipient decryption; encrypted receipts indicate
  recipient processing. No database/history/offline message queue was added.
- Up to eight encrypted packets may be in flight; attachment windows use four
  chunks so control/text traffic need not wait for a whole attachment. Each
  chunk has an authenticated descriptor, index/count, transfer ID, and its own
  nonce/sequence. A 256-sequence replay window tolerates bounded reordering while
  rejecting already accepted or stale sequence numbers. Receiver buffers at
  most two transfers of 3 MB each, expires them after 60 seconds, validates the
  assembled size/body, and clears buffers on session reset.
- The progress bar measures bytes accepted by the relay and is labeled that
  way. Final encrypted recipient receipt remains separate. No simulated progress.
- Home listeners detach synchronously when navigating; a central pending-match
  slot bridges the Home-to-Waiting handoff. Reconnecting retains subscriptions.
- Invite creation uses a per-connection request ID and client-held secret for
  retry consistency; the server keeps the request ID with the expiring locator.
- Local leave clears state immediately. A separate leave event has a bounded
  1.2-second acknowledgement deadline before disconnect; it is not put behind
  attachment acknowledgements. Remote network delay is still unavoidable.
- Attachments open in the same protected native window. Images, audio/video,
  text and PDFs have previews. DOCX/XLSX/PPTX can be extracted locally as text.
  No private file is automatically opened in an external app.
- The export control is now a download icon with busy state. Save-picker
  transitions get background grace instead of immediately ending chat; an
  outstanding background timer cannot end chat while the picker is active.
  Android shows save completion only after the file write finishes.
- QR invites can be decoded locally from Photos without camera permission.
  Multiple valid invite QRs are rejected as ambiguous; owned picker copies are
  removed. The live camera path remains available.
- Camera offers Take photo and Record video, requesting camera/microphone access
  for recording. The existing 3 MB attachment limit remains.
- Photos selected through the photo/camera paths are decoded, resized and
  re-encoded as JPEG, with application metadata/comments removed. This converts
  transparency/animation to a still JPEG. Saved JPEGs receive Whisperchat
  description, software, artist, and copyright tags. All exported filenames
  use Whisperchat plus a random identifier. System file timestamps and technical
  format fields are not replaced with branding.
- Android export now uses ACTION_CREATE_DOCUMENT and a bounded native stream
  write instead of the previous directory-based JavaScript SAF path. Cancelled
  or interrupted exports attempt to delete the chosen file. Provider deletion
  failures cannot guarantee removal; successful recipient exports are permanent.
- PDF sends explicitly ask to flatten visible pages into a new PDF, removing
  original document objects, metadata, scripts, forms and embedded attachments.
  Text selection and digital signatures are lost. Maximum 20 pages and 3 MB.
  Exported PDFs receive Whisperchat descriptive metadata. Native previews render
  one page at a time, with a 1200-pixel maximum dimension.
- Office files explicitly ask to convert to plain text. Only selected document
  body XML is inflated with bounded counts/size; macros, external relationships,
  comments and original metadata are not transferred. Formatting/images are
  lost. Hidden text/rows within the body may still be extracted: review content.
  Other unsupported document formats are rejected with a conversion instruction.
- Audio/video are rebuilt into MP4 containers from supported media tracks,
  omitting source location/descriptive container metadata. Unsupported codecs
  fail without sending the original. This does not scrub codec-internal data,
  visible identifying content or voices. MP4 descriptive branding is not added;
  the saved filename is branded. Do not claim every metadata field is replaced.
- Native processing uses private temporary files, removed normally and cleaned
  at initialization after interruption. No server history/database was added;
  this is not a guarantee of forensic erasure on the device.

## Remaining evidence and limitations

- The reported native save crash still needs an Android crash trace/device
  reproduction. The lifecycle fix addresses a confirmed chat-ending path; do
  not report the native crash as proven fixed.
- OS screenshot prevention does not reliably provide a blocked-attempt event.
  Notices remain conditional on actual OS callbacks; no fabricated failure
  notifications and no weakening of capture prevention.
- Tor and the reviewed post-quantum protocol remain separate unfinished work.

Once testing is authorized: verify two fresh builds against protocol 5; both
random/code flows; busy polling and WebSocket transports; lost/delayed ACKs;
match navigation races; duplicate/out-of-order/tampered chunks; interrupted
transfers; viewer capture restrictions; save success/cancellation/peer departure;
native Android crash logs; JPEG orientation/tags; QR import; camera video/audio;
PDF rendering/flattening/export; Office conversion/oversized malformed archives;
media remux compatibility and container metadata; document-provider cancellation;
and repeated chat teardown/reconnection. Update protocol fixtures before relying
on the existing test suite.

## Expo Go / invite follow-up

Source review found that iOS Expo Go lacks WhisperPrivacy, so protection setup
rejects after matching and the other peer receives a normal leave event. Random
matching and invite create/join now check protection before contacting the relay,
with an explicit installed-build requirement. Protection is not bypassed for Expo Go.
QR modules are now black in both themes; dark mode previously rendered white
modules on the white quiet-zone background. Displayed invites clear on disconnect
and expire conservatively after 290 seconds. Removed hidden double-tap invite
cancellation; the explicit close button remains. Invite joining now awaits the
preflight and avoids adding a timeout after a match/error already completed.
The reported server 'not found or expired' error has not been reproduced against
the deployed service. Verify current native clients and backend protocol 5, the
same server origin, and a single backend process holding the in-memory locator.

## QR image sharing

Home's Share QR action and the QR modal now export an actual image/png file with
expo-sharing, replacing the text-only React Native Share action. The PNG is
encoded from the same QR matrix used on screen (8-pixel modules, four-module
white border), without screen capture or relaxing capture protection. Temporary
files use random filenames under the existing export-cache cleanup directory and
are deleted after the share sheet returns. The image contains the complete invite
secret by design; copies in recipient apps remain until those apps remove them.
PNG checksums, dimensions, decoded pixel data and quiet-zone rendering were
checked locally. OS share-sheet delivery still needs physical-device verification.

## Camera and attachment picker — October 16, 2026

- Replaced the external system-camera/photo-or-video alert with ChatCamera in the
  protected chat window. Photo/Video modes, front/back camera, record/stop, and
  review with Retake/Use are available. Video stays within the existing 30-second
  and 3 MB attachment constraints (recording stops at 2.8 MB to leave container
  overhead). Microphone permission is requested when selecting Video.
- Selection and processing are separate states. No processing modal is displayed
  over permissions, the photo/video library, or the camera. A small Preparing
  indicator appears only after selection. iOS waits for attachment-sheet dismissal
  before presenting the library picker.
- Captures use expo-camera's private Camera cache; no gallery-save API or external
  camera activity is invoked. Cancel/Retake, late capture completion after closure,
  normal preparation and app restart clean app-owned temporary captures. No secure
  flash erasure or memory-only recording guarantee is made. Previously saved
  gallery items are not deleted. Native remux and resized-photo caches retain their
  existing cleanup paths.
- The camera stays under the privacy cover during transient permission prompts,
  closes on backgrounding, and does not open a separate unprotected modal window.
- iOS and Android JS exports passed. Physical-device camera permissions, record/stop/size limit,
  review cancellation, Photos/Gallery absence and interrupted-session cleanup still
  require device validation; no native build or deployment was performed.

## Capture quality and storage clarification

The user clarified that private temporary storage is acceptable; the requirement
is no automatic saving to Photos/Gallery/shared storage, including received media.
Explicit sender-authorized Save remains a separate export action.
Photo capture now requests maximum JPEG quality and the largest enumerated Android
photo size (iOS Photo preset). Photo preparation no longer resizes to 1600 pixels
and re-encodes at JPEG quality 1 for normalization/metadata removal. This is not RAW
or mathematically lossless capture. Video requests 2160p with camera-library
fallback to supported quality; the previous 480p/600 kbps override is removed.
The 3 MB transfer cap remains. Large photos are rejected without silent quality
reduction, and video recording can reach its size cap quickly at high quality.
Native camera capabilities, actual resolution and gallery behavior require device
verification. No automatic gallery-save or media-library write was introduced.

## Large media streaming — October 16, 2026 (supersedes 3 MB transport limit)

Protocol 6 is required on BOTH native clients and the backend. Upgrade together;
no deployment or native build was performed in this pass. Protocol 5 clients are
rejected during key exchange. Session/key-confirmation domain labels and encrypted
envelope version changed together.

There is no fixed total attachment byte cap on the new file-backed transport.
96 KiB chunks are encrypted independently, four per transfer in flight, and
paced by encrypted recipient acknowledgements. At most two outgoing/incoming
transfers are admitted concurrently. Chunk count/size/descriptor validation,
bounded reordering, safe integer checks and actual disk-space checks remain.
Incoming timeout is 60 seconds of inactivity, not a total transfer duration.
Receiver files are created under generated UUID names, never peer-supplied paths.
Peer fileUri properties are rejected; local URIs are created only by the receiver.

Attachments reside in PRIVATE TEMPORARY PLAINTEXT FILES on devices. They are
removed at chat reset and initialization, with cleanup on incomplete/error paths.
No automatic Photos/Gallery/shared-storage export is added. RAM-only claims from
earlier milestones no longer describe attachment storage. No forensic-erasure
guarantee is made. Explicit authorized Save copies a file using a bounded native
stream on Android or the iOS share sheet. JPEG branding/metadata removal streams
the compressed image; large documents do not receive universal metadata branding.

Video remux returns a private file URI instead of a complete Base64 payload;
recording's 30-second/2.8 MB cutoff is removed. Native sample buffers are bounded;
unsupported codecs or unusually large individual frames may still fail. JPEG
preparation preserves full resolution and does not load compressed file data into
one Base64 string. Pixel decoding still requires image-sized native memory.

Existing bounded PDF/Office conversion and preview limits are separate from
transfer size. Large/unsupported files require explicit consent to send the
original (including original metadata). Preview of large documents can be
unavailable even when transfer/export succeeds. Storage, network loss, session
expiry, OS capture restrictions and device resources still bound operation.

Relay rate limits now use one-second windows (120 packets / 8 MiB per connection,
240 packets / 16 MiB per source), rather than exhausting the previous minute
budget halfway through large transfers. Rate responses provide bounded retries;
transport queue backpressure remains. Progress is recipient-acknowledged bytes.

Validation: 17 MiB-plus-seven-byte receiver transfer with reordered four-chunk
windows compared byte-for-byte; malformed size/order/descriptor cleanup and chat
teardown cleanup pass. Mobile crypto/reconnect tests pass (9 tests combined).
Backend tests updated from obsolete plaintext security events to protocol 6 and
all 13 pass. Android/iOS JS exports pass. Native video/export methods and actual
phone disk-space/camera/lifecycle behavior still require device/build validation.
