# Security model and internet deployment — 0.2.0

This is a trusted native-client interoperability service, not a substitute for a host/network security boundary or an independent penetration test. Use staging data first and apply host, Docker, Nginx and dependency updates regularly.

## Passwords and sessions

New/reset passwords require 15 Unicode characters and at most 1,024 UTF-8 bytes. Passwords are not normalized/trimmed by hashing or authentication. Argon2id uses a random 16-byte salt, 64 MiB memory, three passes, two lanes and a 32-byte result, encoded in PHC form. Legacy hashes remain supported and upgrade after valid login. Parameter decoding accepts only supported bounded settings. Comparison is constant-time.

Only SHA-256 hashes of random 256-bit session tokens are stored. New sessions default to 30 days, configurable from 1 to 365; migration never extends existing sessions. Password reset/disable revoke that user's sessions. MFA, public signup, SMTP recovery and SSO are not implemented. Strong passwords and protected client devices remain necessary.

Login throttling combines bounded IP and normalized-account buckets with a global Argon2 concurrency budget. Missing accounts run a dummy verifier. Public HTTP and WebSocket operations have global/user request budgets; connections and pending uploads have global/user bounds. Native-compatible authentication errors still use HTTP 200 plus `error`; resource throttles can use 429. Rate limits reset on restart and are not distributed or a network DDoS defense.

## Tenant isolation and revocation

Public requests resolve their user from the session, never caller-supplied user IDs. Every vault operation requires current membership. Socket login, history, restores, broadcasts, queued downloads, binary pieces and final upload commit are scoped to the authenticated user/vault. Co-owners deliberately have full remote-vault control; sharing is not a read-only role.

Local administrative changes are serialized with outgoing writer boundaries, disconnecting affected sockets on revocation. A chunk already delivered/buffered cannot be recalled, and an in-progress bounded write can delay administration until that write completes or times out. Authorization changes do not remotely erase downloaded plaintext or shared encryption keys.

## Reverse proxy

Install `deploy/nginx.conf` inside Nginx's `http` context and `deploy/vault-sync-proxy.conf` as `/etc/nginx/snippets/vault-sync-proxy.conf`. Replace the domain/certificate paths, run `nginx -t`, and reload. The example uses TLS 1.2/1.3, explicit WebSocket upgrade headers, 300-second upstream timeouts, login throttling, connection limits, HTTP body/header deadlines and security headers. The 64 KiB HTTP body limit does not limit post-upgrade WebSocket attachment transfers; those use 2 MiB binary pieces.

Only the proxy should be internet-facing. Native service defaults to host loopback. Compose publishes host loopback only; a separate override allows a private Docker network with no published backend port. Keep public firewall access limited to HTTPS/necessary HTTP certificate validation and your restricted administrative access. Do not expose port 8080 or the Docker daemon. Configure the default Nginx virtual host to reject unrelated hostnames as well.

Forwarded client IPs are trusted only when the immediate peer belongs to configured CIDRs. The example replaces `X-Forwarded-For` with Nginx's actual peer address. Set `VAULT_SYNC_TRUSTED_PROXIES` to your actual proxy peers, e.g. `127.0.0.1/32` for a native host-loopback proxy. Docker peer addresses depend on networking; inspect/verify your network rather than trusting all private address ranges. If a CDN sits before Nginx, configure Nginx's real-IP module only for that provider's current verified ranges before forwarding client IPs.

CORS/Origin validation preserves exact native origins: `app://obsidian.md`, `capacitor://localhost`, literal `null`, the configured public origin, and requests without Origin. Other origins fail. Origin checks are additional request constraints, not authentication, because non-browser clients can set arbitrary headers. No wildcard Android workaround is present.

## Host/container controls

Run the binary as a dedicated unprivileged user with private data/config permissions. Containers run UID/GID 10001 with a read-only root, dropped capabilities, no-new-privileges, bounded temporary storage, memory/CPU/PID limits and bounded logs. Configure filesystem ownership before binding host directories; do not fix access problems with `chmod 777` or privileged containers.

Use secret files/hidden prompts for account setup, not image layers, build arguments or command-line passwords. Keep restic credentials outside the app. The Unix control socket is mode 0600 in a private directory; never map it into a proxy or another untrusted container. Anyone who controls the host, service UID, Docker socket, database or another privileged app plugin is outside this service's isolation boundary.

Logs omit passwords, bearer tokens, vault keys, request bodies and note data. The Nginx example uses an access-log format that omits query strings; adjust its log destination/retention for your host or proxy container. Administrative events include operation/target IDs and success. Keep logs private and define your own retention. ZIP/database/config backups include sensitive account metadata and hashes even while note content remains encrypted.

## Operational checks

- Verify HTTP redirects to your exact HTTPS domain, certificates renew, and `/healthz` reports readiness without user/vault data.
- Verify the backend is unreachable from the public internet and unauthorized Origins are rejected.
- Test a false forwarded-IP header from an untrusted peer; it must not bypass throttling.
- Test a second user's private-vault isolation, explicit sharing and revocation with a connected device.
- Verify backup failure alerts, free disk space, restic checks and actual restoration into a fresh installation.
- Do not share raw network traces or storage dumps that may contain tokens. The bridge has redacted diagnostic reports.

The release review reports scanner scope and findings separately. A clean reachable-symbol scan does not mean no dependency module has any published advisory, and does not prove absence of unknown vulnerabilities. This server remains a single-process SQLite/local-blob deployment; active-active/HA and multi-node rate limiting are not implemented.

Implementation references: [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html), [Nginx WebSocket proxying](https://nginx.org/en/docs/http/websocket.html), and [Docker Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/).
