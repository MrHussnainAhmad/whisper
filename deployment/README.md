# Private relay deployment prerequisites

Current deployment behavior (October 18, 2026): the mobile app uses direct
HTTPS, not Tor. The topology below is a future architecture, not a description
of the current service. See SECURITY_HARDENING.md in the repository root.

Production requires NODE_ENV=production. For a same-host reverse proxy, set
TRUST_PROXY=1 and TRUST_PROXY_CIDRS=127.0.0.1/32,::1/128. Use the actual proxy
CIDRs for other topologies and restrict inbound Node access to those proxies.
The proxy must overwrite forwarding headers. Random one-to-one chat is enabled;
public groups remain disabled. ALLOW_UNVERIFIED_CHATS is obsolete.
Deploy the Phase 4X backend (commit 544d1db or a descendant) and restart its Node
process together with updating the app. Updating local files does not update the
running server. Earlier protocol-7 backends use incompatible longer invites and
disable random chat; the protocol number alone does not establish compatibility.
New native app builds are required for native changes.

These are preparation files, not a deployed or verified Tor service.

The backend now binds to `127.0.0.1` unless `BIND_HOST` is explicitly set.
For the planned onion service, keep the Node listener and TLS terminator private.
Do not expose a parallel public chat endpoint or a gateway that forwards client IPs.

Required topology:

`native mobile Tor client -> v3 onion service -> loopback TLS terminator -> loopback Node server`

Use a real validated onion certificate with a documented renewal process. Do
not use `rejectUnauthorized=false`, wildcard proxy trust, HTTP public gateways,
or a clearnet bootstrap. TLS and onion provisioning are still outstanding.

The terminator must overwrite `X-Forwarded-Proto` and forwarding headers;
restrict access so only that proxy can reach Node, and set `TRUST_PROXY` to
the actual trusted topology. No access logs or request-body captures for chat.
TLS termination, OS/service logs, provider backups, crash dumps, and swap must
be inspected before release; application code alone cannot enforce those settings.

All sessions, invites, room routing, and rate limits stay in the Node process
RAM. No Redis/Valkey client, adapter, or external-state connection remains.
Run exactly one Node process and one deployment replica; do not enable PM2
cluster mode, autoscaling, or multiple workers. Independent processes cannot
match users or share limits. Restarting loses temporary state and ends chats.
No message history or attachment storage is added. Transport buffers can
transiently carry ciphertext.

Remove obsolete REDIS_URL/VALKEY_URL secrets from the deployment environment.
They are no longer used. Previously deployed services and any existing remote
data must be retired separately; changing source does not delete provider data.
Set host/container RAM limits and disable swap, core dumps, and memory snapshots
for the sensitive process. Application RAM alone does not control host access.

The existing source-IP admission logic needs redesign before Tor deployment:
Tor connections converge on local/proxy addresses, and a per-source cap can
incorrectly block the entire service. Do not solve this by adding original-IP
forwarding. Use bounded anonymous admission/session budgets instead.

The current mobile release build connects directly over HTTPS using
EXPO_PUBLIC_SERVER_URL. There is no anonymous-transport gate or Tor fallback.
Do not advertise IP anonymity. Source tests are separate from inspection of
the actual production proxy, host, logs, certificates and firewall.
