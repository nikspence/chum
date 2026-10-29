# chumbucket

Node.js 24 backend for the [Chum frontend](../chum/README.md). Uploaded bytes live in a private filesystem folder. SQLite stores folders, file metadata and ownership, frozen state, invitation history, settings, the salted admin password hash, sessions, and login throttling. No npm dependencies or separate database service are required; this uses Node's built-in `node:http` and `node:sqlite`.

## Start on Windows

```powershell
# From chumbucket/; create .env only if it does not exist.
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
notepad .env
# Replace CHUM_ADMIN_PASSWORD with your own passphrase (at least 12 characters).
npm start
```

The default listener is `127.0.0.1:3001`. Check it with:

```powershell
Invoke-RestMethod http://localhost:3001/api/health
```

The admin password initializes the database on the first start. Later starts use its stored scrypt hash; changing the environment variable does not change an existing password. Remove the password variable after initialization if desired. There is no public demo password and no seeded content. Node.js 24 is required. No `npm install` step is necessary.

```powershell
npm test
npm run check
npm run dev
```

`dev` restarts on source changes. Tests start real HTTP listeners against temporary databases and upload folders, then clean them up.

## Storage and behavior

```text
data/
  chumbucket.sqlite       # all persistent structured data
  chumbucket.sqlite-wal   # SQLite-managed journal, when present
  chumbucket.sqlite-shm   # SQLite-managed shared memory, when present
  files/
    <uuid>               # file bytes; original name is in SQLite
    <uuid>.part          # a currently streaming upload
```

Folders form a logical tree in SQLite. Original file/folder names never become physical storage paths. Stable IDs keep invitations valid when folders are renamed. Downloads resolve the logical tree or use the stable ID and always require an authorized session. The upload directory is never served as a static directory.

- Files expire 24 hours after their filesystem modification time. Startup cleanup and a one-minute timer remove expired, unfrozen files. Listing and individual file access also enforce expiry. Cleanup requires the backend to be running; the next startup handles downtime.
- Uploads and file renames start a fresh timer. Freeze preserves the modification timestamp; thaw starts a fresh 24-hour timer. Guests may freeze accessible files and thaw only files frozen by their own invitation identity. All people using one invitation share that identity. Admins may thaw any file. Files frozen before freezer identities were recorded can only be thawed by an admin; after thawing, the next freeze records its identity.
- Guests can upload, create folders and download within the invited folder and descendants. Only the owner or admin can rename an item. Guests can delete their own files and their own empty folders; recursive folder deletion is admin-only.
- A guest identity belongs to an invitation (`guest-<link ID>`), matching Chum's model. People sharing one invitation also share ownership rights. Issue separate invitations when ownership must differ.
- Deleting a folder revokes invitations for that folder and its descendants. Expired/revoked invitations and all issued keys remain in history; new invitations check the complete history for collisions.
- Invitation tokens have 192 random bits. New guest passphrases contain three independently and securely chosen words from a list of 262 familiar words (about 24 bits before excluding previously used phrases). They are easier to speak but substantially easier to guess than the earlier 96-bit hexadecimal passphrases. Login throttling limits attempts; each invitation can still be accessed with its passphrase even when shared as a link. Limit invitation lifetime and scope, and revoke access when finished. Existing hexadecimal passphrases remain valid until expiry or revocation. Guest input accepts spaces or hyphens and ignores capitalization; admin passwords remain exact. Admin invitation history retains these credentials so links can be copied again; protect the database and backups.
- Uploads stream to disk, with configurable limits and no whole-file buffering. One raw request uploads one file; multiple-file uploads send multiple requests. Aborted/failed uploads are removed. Startup removes orphan UUID blobs and partial uploads after a crash. Filesystem and SQLite are not one transaction: metadata is published only after writing the bytes, and metadata deletion precedes blob deletion.

Use **one backend process per data directory**, on a local filesystem. Keep the data directory private to its service account. Do not modify managed blobs externally. Back up the entire data directory while the service is stopped so SQLite and file contents remain consistent. Restoring the full directory preserves metadata, invitation history, and unexpired sessions. SQLite writes use WAL and explicit transactions for recursive deletion/revocation.

## Configuration

Environment variables can be placed in `.env` (gitignored). Relative `DATA_DIR` paths resolve from the process working directory.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `3001` | Listener port |
| `DATA_DIR` | `./data` | Database and private uploads |
| `PUBLIC_ORIGIN` | `http://localhost:3001` | Exact browser-facing origin, including port; CSRF origin check |
| `CHUM_ADMIN_PASSWORD` | none | Required on first start; at least 12 characters |
| `COOKIE_SECURE` | inferred from public origin | `true` for HTTPS; `false` for local HTTP |
| `MAX_UPLOAD_BYTES` | `1073741824` | 1 GiB maximum per uploaded file |
| `SESSION_HOURS` | `168` | Maximum session lifetime; guests also expire with their invitation |
| `CLEANUP_INTERVAL_MS` | `60000` | Periodic cleanup interval |

Use an HTTPS reverse proxy in deployment, set `PUBLIC_ORIGIN` to the browser-facing HTTPS origin and `COOKIE_SECURE=true`, and serve Chum and the API on that same origin. The backend listener itself speaks HTTP. No cross-origin CORS access is enabled. Changing the sharing `domain` setting changes generated links only; it does not change the allowed origin, provision DNS, or configure TLS.

Sessions use random opaque cookies with `HttpOnly`, `SameSite=Lax`, and `Secure` over HTTPS. Only session-token hashes are stored in SQLite. Mutations require `X-Chum-Request: 1`, an accepted Origin when present, and an authenticated `X-CSRF-Token` (except login). `GET /api/session` retrieves the session and CSRF token after a reload. Sign-out deletes the session. Each guest request rechecks invitation expiry, revocation and folder existence, including downloads and inline views. Downloads are attachments; inline views use a fixed media-type allowlist, sandbox policy and byte ranges for seeking. Both use `nosniff` and `no-store` headers. Path traversal, unsafe Windows filenames, symlink blobs, and hard-linked blobs are rejected.

Login and token exchanges are limited to 15 attempts per direct remote IP and 100 globally per 15 minutes, including successful attempts. Limits persist across restarts. Forwarded IP headers are deliberately ignored; behind a reverse proxy, clients generally share the proxy's IP limit. Adjust the deployment's authentication rate limiting strategy if the small-group defaults become restrictive. Uploads have a 15-minute request timeout; JSON bodies are limited to 16 KiB. There is no aggregate disk quota or resumable upload support.

## API

Responses are JSON except downloads and invitation redirects. Errors are `{ "error": "message" }`. IDs are server-generated UUIDs, and `root` is the bucket's root folder. Item fields include `id`, `parent`, `name`, `kind`, `owner`, `modified` (Unix milliseconds), `size`, `type`, `frozen`, and `frozen_by` (the freezer identity or null).

| Method | Route | Body / response |
| --- | --- | --- |
| GET | `/api/health` | Public liveness response |
| POST | `/api/session` | `{passphrase}` → `{user, csrfToken}`; admin or guest login |
| GET | `/api/session` | `{user, csrfToken}` for the remembered session |
| DELETE | `/api/session` | Sign out |
| GET | `/?access=<token>` | Exchange invitation for guest cookie; 303 redirect to `/`; an existing admin stays admin |
| GET | `/api/folders?id=<folder ID>` | `{folder, root, items, tree}`; defaults to session root |
| GET | `/api/folders?path=<logical/path>` | Same listing using a bucket-relative path |
| POST | `/api/folders` | `{name, parent?}` → `{item}` |
| POST | `/api/files?parent=<ID>&name=<filename>` | Raw file bytes → `{item}`; `parent` defaults to session root |
| PATCH | `/api/items/:id` | `{name?, frozen?}` → `{item}` |
| DELETE | `/api/items/:id` | Delete item (recursive for admin) |
| GET, HEAD | `/api/items/:id/download` | Cookie-authenticated attachment |
| GET, HEAD | `/api/items/:id/view` | Cookie-authenticated inline image, audio, video or PDF; single byte ranges supported on GET |
| GET, HEAD | `/<folders>/<filename>` | Cookie-authenticated attachment using logical path |
| GET | `/api/links` | Admin only → `{links}` with retained history |
| POST | `/api/links` | Admin only: `{folder?, hours?}` → `{link}` |
| POST | `/api/links/:id/revoke` | Admin only; invalidate all sessions for invitation |
| GET | `/api/settings` | Admin only → `{settings: {domain, hours}}` |
| PATCH | `/api/settings` | Admin only: `{domain?, hours?}` → `{settings}` |

Invitation expiration must be greater than zero and no more than 8760 hours. Existing invitations retain their original expiration when defaults change. There is no item move endpoint. File and folder names share one case-insensitive sibling namespace. The `tree` listing contains only authorized metadata; guests cannot obtain the rest of the bucket tree or invitation secrets through it.

## Run Chum with Chumbucket

Chum in `../chum/` is connected to this backend. It uses server sessions, folder listings, uploads, downloads, invitations and settings. Its list/grid preference stays in localStorage; old demo data is not imported. The frontend's own `src/chumbucket.js` is its API client.

Start Chumbucket as described above, then in another PowerShell window, from `chumbucket/`:

```powershell
Set-Location ../chum
npm install  # when dependencies are missing or changed
npm run dev
```

Open `http://localhost:5173` and sign in with the configured admin password or a guest passphrase. Chum's Vite proxy forwards API and invitation requests to `127.0.0.1:3001`; its local Origin translation supports the backend's default `PUBLIC_ORIGIN=http://localhost:3001`. See Chum's README and `.env.example` for local overrides. The development proxy is not the production configuration.

## Ubuntu 26.04 deployment with Caddy and PM2


The following deploys Chum and Chumbucket on one Ubuntu host. Commands use a shell and assume the current directory is the combined project root unless stated otherwise. Install Node.js 24 and npm, [PM2](https://pm2.keymetrics.io/docs/usage/quick-start/) and [Caddy's official Ubuntu package](https://caddyserver.com/docs/install). Run the backend and PM2 under a dedicated unprivileged account with a persistent home directory. Node and PM2 must remain available to that account after reboot. Point a real public DNS name at the host and allow inbound TCP 80 and 443; keep port 3001 private. Caddy's [automatic HTTPS](https://caddyserver.com/docs/automatic-https) obtains and renews certificates; preserve its writable certificate storage.

### Build the frontend

```sh
cd chum
npm ci
npm run build
cd ..
```

Publish the contents of `chum/dist/` to a directory readable and traversable by the Caddy service account. For example, the following uses `/srv/chum` as the web root; this is a deployment location, not a project-relative source path:

```sh
sudo mkdir -p /srv/chum
sudo cp -a chum/dist/. /srv/chum/
```

On later deployments replace old assets as appropriate and rebuild first. Keep the backend `.env` and data outside the web root. Caddy's packaged service commonly cannot traverse private home directories; `/srv` avoids that issue.

### Configure and start the backend

From the project root, as the backend service account:

```sh
cd chumbucket
cp -n .env.example .env
chmod 600 .env
```

Edit `.env`, keeping any existing settings and data location. For a new installation use values like:

```dotenv
HOST=127.0.0.1
PORT=3001
DATA_DIR=./data
PUBLIC_ORIGIN=https://chum.example.com
COOKIE_SECURE=true
CHUM_ADMIN_PASSWORD=replace-with-a-long-unique-passphrase
```

Replace the hostname and password. `PUBLIC_ORIGIN` must exactly match the browser's HTTPS origin. `DATA_DIR` is resolved from the backend working directory; preserve an existing data directory when upgrading. Use one backend process per data directory on a local filesystem, and give its account private read/write access. The password is used only to initialize a new database and may be removed from `.env` after initialization. Back up the complete data directory with the backend stopped so SQLite and uploaded files remain consistent.

Install PM2 for the service account, using your Node installation's appropriate global npm prefix, then start the server from `chumbucket/`:

```sh
npm install -g pm2
pm2 start src/server.js --name chumbucket --node-args="--env-file-if-exists=.env"
pm2 status
pm2 logs chumbucket
```

PM2 retains the working directory used at start, so Node reads `chumbucket/.env` and `./data` resolves there. Node's environment-file option reads the file on each process start; existing environment variables take precedence over its values. Avoid exporting conflicting variables into the PM2 environment. After editing `.env`, use `pm2 restart chumbucket`; if changing variables supplied by the shell or PM2, use `pm2 restart chumbucket --update-env` from the service account with the desired environment. See [Node's environment-file documentation](https://nodejs.org/docs/latest-v24.x/api/cli.html#--env-file-if-existsfile).

To restore the process after reboot, as the same service account:

```sh
pm2 save
pm2 startup
```

Run the privileged command printed by `pm2 startup`; it installs the systemd startup service for that account. Run `pm2 save` again after changing the process list. Verify the service with `systemctl status pm2-<user>` and test a reboot. If Node's installation path changes, regenerate the startup service as described in [PM2's startup guide](https://pm2.keymetrics.io/docs/usage/startup/). PM2 restarts the process on failure; it does not replace backups.

### Configure Caddy

With the official package, edit `/etc/caddy/Caddyfile`. Replace the hostname and, if different, the deployed static directory:

```caddyfile
chum.example.com {
    root * /srv/chum

    @invitation {
        path /
        query access=*
    }
    route {
        reverse_proxy @invitation 127.0.0.1:3001
        reverse_proxy /api/* 127.0.0.1:3001
        try_files {path} /index.html
        file_server
    }
}
```

The ordered route forwards invitation exchanges before the SPA fallback, and keeps the `/api` prefix for backend requests. Caddy serves built assets and terminates HTTPS; the private backend connection is HTTP. The example supports ID-based downloads used by Chum, but not the backend's optional logical-path downloads. Add explicit proxy rules before the fallback if needed, avoiding frontend paths. Never serve the private upload directory directly.

Validate and reload the packaged service:

```sh
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl enable --now caddy
sudo systemctl reload caddy
sudo systemctl status caddy
```

See [Caddy's service documentation](https://caddyserver.com/docs/running). Sign in at the public HTTPS origin and set **Settings → Sharing domain** to the same origin; this controls generated links separately from `PUBLIC_ORIGIN`. Verify `curl https://chum.example.com/api/health`, login and reload, an upload/download, and a guest invitation and revocation in a separate browser session. Check `pm2 logs chumbucket` and `journalctl -u caddy` when troubleshooting. Behind Caddy, the backend's direct-peer login rate limit is shared by proxied clients.


The Caddy configuration is an example; validate it and perform the end-to-end checks on the deployment host.

## Verification

Integration tests cover real file bytes and attachments, persistence on reopening SQLite, settings, hashed credentials, word and legacy passphrases, folder boundaries, owner assignment, guest permissions, recursive deletion, retained invitation keys, revocation during uploads, expiry, thaw and rename behavior, CSRF and Origin rejection, encoded traversal, hardlink rejection, duplicate/unsafe names, streamed upload limits, aborted uploads, crash recovery, login throttling, logout, and the server entrypoint in a separate process. Chum has its own unit and backend/proxy integration tests; see its README for commands and prior browser checks. Verify a production Caddy deployment end to end as described above.

Reference: [Node.js SQLite documentation](https://nodejs.org/docs/latest-v24.x/api/sqlite.html), [filesystem documentation](https://nodejs.org/docs/latest-v24.x/api/fs.html).
