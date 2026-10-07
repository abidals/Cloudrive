# Cloudrive

Self-hosted file sharing with **accounts & roles, expiring links and resumable transfers**.

Cloudrive is a fork of [PsiTransfer](https://github.com/psi-4ward/psitransfer) (BSD-2-Clause)
extended with an account/role layer for deployments that must not offer a fully open upload page.

## Highlights

- Upload buckets with expiry: one-time download, 1 hour up to 8 weeks (configurable list)
- Resumable implements (tus.io) uploads and downloads
- Public download links: recipients never need an account; bucket passwords stay supported
- **Accounts & roles** (Cloudrive addition): `admin` and `uploader` roles, login page,
  signed-cookie sessions, per-user bootstrap
- Upload limits: per-file and per-bucket size caps
- `/admin` overview (requires `admin` login)
- Quick, lightweight Vue frontend (<100k gzipped)

## Login & roles

```
Role       Access
------     -------------------------------------------------------------
admin      Upload page, all buckets in /admin, everything an uploader can do
uploader   Upload page + own bucket metadata
guest      Nothing; only download links are public
```

When `accounts` is enabled, the upload page redirects to a login page and the tus
upload endpoints only accept authenticated users. Bucket pages (`/<sid>`) remain
public as designed — each bucket may additionally carry its own password.

### Manage a user

```
users.json
{
  "users": [ { "name": "nateq", "role": "uploader", "hash": "$argon2id$...", "createdAt": 1717410000000, "disabled": false } ]
}
```

You can edit this file while the app is stopped, or use the CLI helpers:

```bash
node cli.js user-add <name> <password> [admin|uploader]
node cli.js user-list
node cli.js user-remove <name>
```

### Config permissions

| Env var                       | Default | Notes                                        |
|-------------------------------|---------|----------------------------------------------|
| `CLOUDRIVE_ACCOUNTS`          | `false` | `true` enables the account layer             |
| `CLOUDRIVE_ADMIN_USER`        | —       | Bootstrap admin name (first start only)      |
| `CLOUDRIVE_ADMIN_PASSWORD`    | —       | Bootstrap admin password (first start only)  |
| `CLOUDRIVE_UPLOAD_PASS`       | `false` | Legacy mode only: single shared upload password |
| `CLOUDRIVE_ADMIN_PASS`        | `false` | Legacy mode only: `/admin` password          |
| `CLOUDRIVE_SESSION_TTL`       | `86400` | Signed cookie lifetime in seconds            |
| `CLOUDRIVE_SESSION_SECRET`    | auto    | Fixed HMAC secret; auto-generated and persisted otherwise |
| `CLOUDRIVE_MAX_FILE_SIZE`     | none    | Max file size in bytes                       |
| `CLOUDRIVE_MAX_BUCKET_SIZE`   | none    | Max bucket size in bytes                     |
| `CLOUDRIVE_RETENTIONS`        | see above | JSON `{"3600":"1 Hour",...}`                |
| `CLOUDRIVE_REQUIRE_BUCKET_PASSWORD` | `false` | Force per-bucket download passwords     |

## Quickstart

### Docker

```bash
$ docker run -p 0.0.0.0:3000:3000 \
  -e CLOUDRIVE_ACCOUNTS=true \
  -e CLOUDRIVE_ADMIN_USER=admin \
  -e CLOUDRIVE_ADMIN_PASSWORD=secret \
  -v $PWD/data:/data \
  ghcr.io/abidals/cloudrive
```

The `/data` volume must be writable by UID 1000 (`chown -R 1000 data`).

### Manual

```bash
$ NODE_ENV=production npm install
$ cd app && npm install && npm run build && cd ..
$ npm start
```

### Install the Olares app (any Olares 1.12.6+)

Download the chart from the [Releases](https://github.com/abidals/Cloudrive/releases)
page, then:

```bash
olares-cli market upload cloudrive-0.1.2.tgz
olares-cli market install cloudrive -s upload \
  --env CLOUDRIVE_ADMIN_USER=admin --env CLOUDRIVE_ADMIN_PASSWORD=temp-REci2kCSK0
```

`CLOUDRIVE_RESET_ADMIN=true` (env, default false) wipes ONLY accounts
(`users.json` + session secret) at next startup so the bootstrap admin is
re-seeded with the current env values — uploaded files are kept. The shipped
temp password `temp-REci2kCSK0` is public — change it right after install
(inside the pod: `node cli.js user-pass admin <new>`, or set the env + reset).

Read `PLAN-Cloudrive.md` for packaging internals, upgrade runbook and roadmap.

## License

BSD-2-Clause — © Christoph Wiechert (PsiTransfer)
Fork additions © Cloudrive contributors.