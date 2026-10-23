# Phase 1 future deployment preparation

These are local instructions/templates only. No service, host, firewall, Tor
configuration, or production deployment has been accessed or changed. This file
supersedes the earlier onion-over-loopback-TLS proposal in this directory.
Standard mode keeps the existing independent public HTTPS endpoint and proxy.

## Intended topology

Future Tor-capable mobile client -> standard anonymous Tor v3 onion service ->
C Tor PROXY v1 over protected Unix socket -> the existing Whisper Engine.IO,
Socket.IO namespace, session store, matchmaking, and blind encrypted relay.

The onion endpoint is `http://<56-character-v3-address>.onion:80` through Tor;
its origin authentication/encryption comes from Tor and the correctly distributed
onion address. The local Unix hop is trusted through OS permissions. It does not
use the public domain, DuckDNS, a public certificate, or X-Forwarded-Proto.
Ordinary public requests still require HTTPS in production. Never disable TLS
verification for Standard mode. Never route a claimed onion request from a
public TCP proxy into this Unix socket.

The backend has no SOCKS client, embedded Tor, bridge management, or mobile
networking. The current Android application remains Standard-mode only. Browser
Origin headers are rejected on the onion listener; this phase targets native
clients. No client authorization is configured for the public onion address.

## Future Linux permissions and service setup (not executed)

Use a dedicated backend account `whisper`, Tor account `debian-tor` (substitute
that distribution's actual Tor account), and group `whisper-onion` containing
only those two service accounts. Root remains trusted. Do not add other users.
The backend owns the directory and socket. Tor may traverse/connect, but must
not be allowed to replace the socket or directory. Restrict other processes
running under these accounts too; PROXY v1 has no cryptographic authentication.

Expected filesystem layout:

| Path | Owner | Group | Mode |
|---|---|---|---|
| `/run/whisper-onion` | `whisper` | `whisper-onion` | `0750` |
| `/run/whisper-onion/relay.sock` | `whisper` | `whisper-onion` | `0660` |
| `/var/lib/tor/whisper` | Tor service user | Tor service group | `0700` |

A future systemd backend unit should include the equivalent of:

```ini
[Service]
User=whisper
Group=whisper-onion
RuntimeDirectory=whisper-onion
RuntimeDirectoryMode=0750
UMask=0077
Environment=NODE_ENV=production
Environment=ONION_ENABLED=1
Environment=ONION_SOCKET_PATH=/run/whisper-onion/relay.sock
Environment=ONION_APP_POW_ENABLED=0
# Keep existing ExecStart, public proxy settings, limits and hardening.
```

Give the separate Tor unit supplemental group `whisper-onion` (or add its service
account to that group). Preserve its existing primary user/group. Service user
names, unit names, sandbox mount visibility, AppArmor/SELinux policy and socket
access must be verified on the eventual host. This is not a complete unit file.

The backend validates every parent path: no symlink directories, no group/world
writable ancestor, and a backend-owned final directory inaccessible to others.
It does not create directories, add groups, or remove pre-existing socket paths.
At bind it applies the directory's group and mode 0660, then enables acceptance.
Before that, incoming sockets are rejected. Ordinary shutdown closes streams and
lets Node remove its Unix socket. A stale path after a crash requires an operator
to verify no live process owns it before removing that exact socket. Never use a
blind startup `rm` or expose a TCP fallback. Windows activation fails explicitly.

## Tor configuration

Use [torrc.example](torrc.example) for a future dedicated C Tor service. The file
sets v3 service storage, virtual port 80 to the Unix socket, circuit export,
Tor's onion PoW, finite streams, and circuit closure on excessive streams. It
opens no SOCKS or relay port. Keep normal anonymous service defaults: never
set `HiddenServiceSingleHopMode` or `HiddenServiceNonAnonymousMode`.

`HiddenServicePoWQueueRate 250` and `HiddenServicePoWQueueBurst 2500` are documented
Tor defaults, not Whisper throughput claims. Tune to measured rendezvous demand,
CPU/RAM and application budgets. The example `HiddenServiceMaxStreams 8` aligns
with this backend's initial raw-stream ceiling; it is a deployment choice, not a
universal security threshold. Account for multiple polling streams and upgrades.
Check that the selected C Tor build supports onion PoW and all listed options;
a future operator must validate the config with that installed version before
activation. None of those validation/deployment commands were run here.

Protect the onion service private keys in `HiddenServiceDir`; do not place them
in this repository, app bundle, general logs, shared backups, or the backend
account's readable directories. Make an encrypted offline backup under restricted
operator custody and test recovery separately. Losing keys changes the address;
key theft permits impersonation. Distribute/pin the intended onion address in a
later coordinated mobile release. Circuit handles are not user identities.

## Backend settings and resource boundaries

| Variable | Default | Meaning |
|---|---|---|
| `ONION_ENABLED` | `0` | Only `1` enables the production Unix listener |
| `ONION_SOCKET_PATH` | `/run/whisper-onion/relay.sock` | Absolute protected Unix socket path, at most 100 bytes |
| `ONION_MAX_STREAMS` | `1000` | Total raw streams, including incomplete PROXY headers |
| `ONION_MAX_PENDING` | `64` | Concurrent incomplete PROXY headers |
| `ONION_STREAMS_PER_CIRCUIT` | `8` | Concurrent raw streams per circuit |
| `ONION_PROXY_TIMEOUT_MS` | `2000` | PROXY deadline; maximum 10000 ms |
| `ONION_MAX_CONNECTIONS` | `1000` | Onion Engine.IO cap, also bounded by half the existing global connection cap |
| `ONION_CONNECTIONS_PER_CIRCUIT` | `4` | Engine.IO/Socket.IO circuit cap |
| `ONION_APP_POW_ENABLED` | `0` | Optional application PoW, onion discovery only |
| `ONION_APP_POW_BITS` | `16` | SHA-256 leading-zero difficulty, allowed 8 through 22 |

Global and per-socket limits from Phase 0 are still enforced. Raw streams are
bounded separately from established Engine.IO connections. The existing global
connection ceiling covers both endpoint classes. Onion connections cannot occupy
more than half that ceiling (minimum one); new public traffic retains its old
limits. This does not reserve capacity against a distributed attacker using both
endpoints. Established traffic retains Phase 0's reserved event budget and room
allocation. Onion health/initial HTTP requests have separate fixed limits of
120/circuit/minute and 6000/minute; valid session polling bypasses those initial
request limits but still uses event/room limits. Circuit counters expire in RAM.

A circuit switch cannot attach to an existing Engine.IO SID, even with valid
HTTP headers. It must create a new anonymous session. The same circuit must be
used across polling and WebSocket upgrade streams. Future mobile Tor integration
must test that behavior; automatic circuit changes are not session resumption.
Colliding/reused 32-bit handles can share temporary limits, and new circuits do
not prove different users. Per-session blocking never uses these handles.

## Future release checks

Run local tests first, then separately validate Linux socket ownership/access,
unauthorized local-user rejection, real C Tor header export, onion descriptor and
PoW support, Socket.IO polling/upgrades over Tor, and mobile challenge handling.
Use a controlled environment and obtain deployment authorization separately.
Synthetic loopback tests do not establish that a real onion service works.
Keep a single backend process/replica: all routing, rooms, quotas and tickets are
RAM-only. Process restart ends chats. Inspect swap, crash dumps, infrastructure
logs and backups independently; no application change can guarantee their policy.

References checked for this implementation:
- [Tor circuit export specification](https://spec.torproject.org/haproxy-proxy.html)
- [Tor onion service setup](https://community.torproject.org/onion-services/setup/)
- [Tor onion PoW documentation](https://onionservices.torproject.org/technology/pow/)
- [Tor onion DoS guidance](https://community.torproject.org/onion-services/advanced/dos/)
