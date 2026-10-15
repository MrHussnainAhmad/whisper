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
