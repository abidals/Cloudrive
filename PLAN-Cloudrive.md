# PLAN — Cloudrive

> Working plan and context for Cloudrive. Read this before any future update,
> upgrade or debugging session.

## 1. What Cloudrive is

Self-hosted, account-gated file sharing with **public, expiring download links**.

- **Base:** PsiTransfer v2 line (`psi-4ward/psitransfer`, BSD-2-Clause, master
  tree at fork time: base `e1040f2` "fix: Zip download broken")
- **Fork owner:** abidals — repo `github.com/abidals/Cloudrive`
- **License:** BSD-2-Clause (attribution preserved; fork note in README)

## 2. What we changed vs upstream

| Area | Upstream | Cloudrive |
|---|---|---|
| Accounts | None by design | `accounts` mode: users.json under the upload dir; roles `admin` / `uploader` |
| Sessions | Single shared passwords | Signed-cookie sessions (HMAC-SHA256, `CLOUDRIVE_SESSION_SECRET`, TTL configurable) |
| Login page | Password prompt only | `GET /login` page, `POST /login`, `/logout` |
| Role gates | `uploadPass` / `adminPass` header checks | Cookie guards on upload page, `config.json`, `/files` (tus), `/admin*`; legacy header flows kept when accounts off |
| Ownership | None | Bucket metadata gets `owner` from the uploader; non-admin roles filtered in `/admin/data.json` (view-only today) |
| Port envars | `PSITRANSFER_*` | `CLOUDRIVE_*` (config.js loop, also guards the k8s ServiceLinks `*_PORT` trap) |
| CLI | `bin = cloudrive` boots app | + `user-add / user-list / user-pass / user-remove` (these force `CLOUDRIVE_ACCOUNTS=true` before config loads — see bugfix note) |
| Frontend | tacit x-passwd flows | `Admin.vue` auto-fetches on mount (session path), falls back to password form (legacy path) |

Key files touched: `lib/accounts.js` (new), `lib/endpoints.js`, `config.js`,
`cli.js`, `public/pug/login.pug` (new), `app/src/Admin.vue`, Dockerfile, CI,
README.

## 3. Runtime data layout (container)

```
/data                    ← single volume (appData userspace mount in Olares)
/data/users.json         ← account store (rotate/disable via CLI or edit + restart)
/data/.session-secret    ← session HMAC secret (chart-managed)
/data/<sid>/             ← bucket dirs; file names are `<uuid>` (hashed names via tusboy)
```

`db` is in-memory, rebuilt from disk at boot; retention sweep runs every 60 s.

## 4. Requirements checklist (owner's ask, all delivered)

- [x] Upload with expiry (built-in retentions, one-time → 8 wk)
- [x] Public view/download without login (default bucket behavior; per-bucket
  passwords stay optional)
- [x] Login page (accounts mode)
- [x] Upload limits (`CLOUDRIVE_MAX_FILE_SIZE`, `CLOUDRIVE_MAX_BUCKET_SIZE`)
- [x] File permissions → roles (admin/uploader), plus `requireBucketPassword`
  option
- [x] Olares packaging (chart/cloudrive, lint-passing, deployed on my@cgtale.com)

## 5. Olares app packaging

- **Chart dir:** `chart/cloudrive/` (`Chart.yaml`, `OlaresManifest.yaml`,
  `values.yaml`, `templates/{service,secret,deployment}`)
- **Image:** `ghcr.io/abidals/cloudrive:<tag>` and `:latest`, multi-arch
  (`linux/amd64`, `linux/arm64`), Node 24 alpine, `USER node` (uid 1000)
- **Entrance:** `cloudrive` → `cloudrive-svc:3000`, `authLevel: public`
  (deliberate — recipients follow links without Olares SSO; the app's own
  login gates writes)
- **Storage:** `permission.appData: true` + `init-permissions` initContainer
  (`beclab/aboveos-busybox:1.37.0`, non-recursive chown of `/data`); pod runs
  uid/gid 1000 (`spec.runAsUser: true`)
- **Secrets:** `cloudrive-auth` Secret, `helm.sh/resource-policy: keep`;
  session secret generated once via `lookup`/`randAlphaNum` and kept across
  upgrades. Admin bootstrap user/password flow through the Secret too.
- **Timeouts:** `options.apiTimeout: 0` (uploads/downloads must not be cut by
  the 15 s entrance proxy default)

### Install profile on my@cgtale.com

- Bootstrap admin: `admin` / temp password `temp-REci2kCSK0`
  **→ change after first login** (`cli.js user-pass admin <new>` inside the
  pod, or Settings → edit the two envs and let the pod restart)
- Limits shipped by default: 2 GiB per file, 8 GiB per bucket, 24 h sessions
- `CLOUDRIVE_RESET_ADMIN=true` (env, default false): deletes only
  `users.json` + session secret at next startup so the bootstrap admin is
  re-seeded; uploaded files are kept. Turn it back to false afterwards
  (v0.1.5 flip flow: uninstall → install with the env false; appData keeps
  `users.json` so logins survive reinstalls).

## ⚠ WAN access via the Olares public relay (operational constraint)

The public entrance (`*.my.cgtale.com`) tunnels through the Olares relay
(`*.frp.olares.com`). Measured on 2026-10-08:

- Every single HTTP response is cut after **~80 s** at the relay, regardless
  of `options.apiTimeout: 0` (which is the chart-side knob, and is set).
- Relay throughput ≈ **260 KB/s**, so one response carries ≈ **20 MiB**.
- The connection closes **cleanly** (200 + FIN), so browsers treat the
  truncated body as a completed download — silent truncation for direct
  browser clicks, no resume offered. THIS was the owner's original complaint.
- HTTP **Range works** through the relay (206 verified): a resumable client
  (curl `-C -`, aria2, wget) can pull any size by walking ranges
  (verified: 60 MiB in 3 × 20 MiB steps = complete & intact).
- LAN/direct access does not traverse the relay.

Consequences:

- Files ≳ 20 MiB over **WAN+relay** need resumable tooling or LAN access;
  share-zip is also capped per response.
- App-level mitigation SHIPPED in v0.1.6: the download page walks each
  file > 12 MiB in self-adapting HTTP Range chunks (targets < 50 s per
  response, auto-retries, assembles client-side, streams to disk via the
  File System Access API with a Blob fallback). Browsers now get complete
  files despite the relay cut. Zip/tar archives remain single-stream (not
  resumable) — keep archives small over WAN or fetch them in LAN.

### Rebuild + redeploy loop

```bash
# image (both arches; the node is amd64)
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/abidals/cloudrive:<ver> -t ghcr.io/abidals/cloudrive:latest --push .

# chart
sed -i '' 's/^\(  version: \).*/\1<new>/' chart/cloudrive/Chart.yaml
sed -i '' 's/^\(  version: \).*/\1<new>/' chart/cloudrive/OlaresManifest.yaml  # keep equal
sed -i '' 's/image: ghcr.io\/abidals\/cloudrive:.*$/image: ghcr.io\/abidals\/cloudrive:<new>/' chart/cloudrive/templates/deployment-cloudrive.yaml

olares-cli chart lint ./chart/cloudrive
olares-cli chart package ./chart/cloudrive
olares-cli market upload chart/cloudrive-<new>.tgz
olares-cli market install cloudrive -s upload --watch --watch-timeout 2m -o json
olares-cli market status cloudrive
# pods / logs if anything misbehaves: olares-cli cluster ... via olares-doctor
```

Version bumps: bump Chart.yaml + manifest `metadata.version` + `image tag`
at the same **only when app code changed**. Chart-only changes bump chart +
manifest `metadata.version` but reuse the existing image tag. App asset
versions (like 0.1.2 app image) and chart versions (0.1.5) advance on
independent counters — do not assume they match. Never re-push an unchanged
version number.

Distribution rule: the repo root keeps ONLY the latest `cloudrive-<ver>.tgz`;
superseded charts live in the Releases section (tags v0.1.0 / v0.1.1 / v0.1.2
/ v0.1.5 carry their own assets).

## 6. Known traps (do not regress)

1. **ServiceLinks env collision** — Service name is `cloudrive-svc`; legacy
   Kubernetes injects `CLOUDRIVE_PORT`-style vars for services whose upper
   name collides with app config. The deployment sets
   `enableServiceLinks: false` — keep it.
2. **users.json CLI bug class** — user commands must run with
   `CLOUDRIVE_ACCOUNTS=true` (cli.js does this) or the store loads empty and a
   `user-add` overwrite drops existing users. Likewise set
   `CLOUDRIVE_UPLOAD_DIR` or the CLI touches a repo-local `data/` dir.
3. **Init container chown** — keep it **non-recursive** (red line: no
   `chown -R` at runtime).
4. **`runAsUser: true` reaches only the workload named `cloudrive`** — fine
   today (single Deployment; Group forced at template level too).
5. **Frontend rebuild** — `app/` is a Vue 2/webpack app; any SPA change needs
   `cd app && npm install && npm run build` (Docker build does this itself).
6. **node ~24 only** — `.nvmrc`/engines; the build toolchain (proto) enforces.

## 7. Roadmap (candidates, not commitments)

- Cloudrive admin UI to manage users (today: CLI / files edit)
- Per-user "my uploads" page (metadata.owner already stored)
- Public, configurable retention presets (env `CLOUDRIVE_RETENTIONS` JSON)
- Email share notification (upstream mailTemplate plumbing)
- Optional end-to-end client-side encryption
- Upstream sync: periodic `git remote add upstream psi-4ward/psitransfer`
  checks; keep our e1040f2 base current (upstream is slow-moving; rebase
  carefully over `lib/endpoints.js` conflicts).

## 8. Distribution

- Chart `.tgz` committed under `chart/` in the repo + a GitHub **Release**
  carries the same artifact.
- Anyone can install without Olares Market access:
  ```bash
  curl -LO https://github.com/abidals/Cloudrive/releases/download/v<ver>/cloudrive-<ver>.tgz
  olares-cli market upload cloudrive-<ver>.tgz
  olares-cli market install cloudrive -s upload
  ```
- Not submitted to beclab/apps (per owner's decision).

## 9. Security posture

- Process uid 1000, non-root, `allowPrivilegeEscalation: false`,
  all Linux capabilities dropped; uploads confined to the appData mount.
- Public entrance is intentional; every write path (upload page, tus
  endpoints, config, admin) requires a valid session cookie.
- Bucket downloads: public by design, optionally argon2-password protected
  (hashes at rest since upstream v2; legacy plaintext metadata tolerated).
- User passwords: argon2id (m=8MiB, t=3, p=1 — upstream params kept).
- Session cookies: HttpOnly, SameSite=Lax, signed, TTL-bound.
- Rotate session secret (invalidates all sessions): delete the
  `cloudrive-auth` Secret and upgrade; rotate admin password via CLI.
- Brute-force damping: 200–500 ms delays on auth failures (server-side).