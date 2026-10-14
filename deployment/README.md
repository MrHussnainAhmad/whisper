# Private relay deployment prerequisites

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

Production Redis must use `rediss://`, permit CONFIG GET, and report
`appendonly=no` and `save=""`. The application now refuses startup otherwise.
Provider backups/snapshots must separately be disabled. No message history or
attachment storage is added. Redis routing and rate-limit metadata remains
temporary. Connection buffers/pub-sub can transiently carry ciphertext.

The existing source-IP admission logic needs redesign before Tor deployment:
Tor connections converge on local/proxy addresses, and a per-source cap can
incorrectly block the entire service. Do not solve this by adding original-IP
forwarding. Use bounded anonymous admission/session budgets instead.

The mobile release build intentionally refuses direct chat connections until
the real anonymous transport is integrated. Development can explicitly opt
into direct HTTPS using `EXPO_PUBLIC_ALLOW_DIRECT_DEV=true` and
`EXPO_PUBLIC_SERVER_URL`; that mode exposes source IPs and must never be
marketed as anonymous routing. No build/runtime verification has been run in
this implementation session, at the user's request.
