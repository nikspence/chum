# chum

A small, mobile-friendly bucket for sharing files with friends. React, Vite, and Tailwind CSS frontend for the Node.js 24 [Chumbucket backend](../chumbucket/README.md).

## Run with your existing backend

Chumbucket is expected at **http://127.0.0.1:3001**. In this directory:

```powershell
npm install  # only when dependencies are missing or changed
npm run dev
```

Open **http://localhost:5173** and enter the admin password configured in Chumbucket, or a valid guest passphrase. There is no demo password or seeded content.

Vite proxies `/api/*` and `/?access=<token>` to Chumbucket. The browser only contacts the frontend origin, so the server's HttpOnly cookie works for login, reload, downloads, and guest invitation exchanges without enabling CORS.

The current backend uses `PUBLIC_ORIGIN=http://localhost:3001`. The local proxy translates the Origin of explicitly allowed frontend addresses to that backend origin. It rejects other Origin headers before forwarding, and preserves the backend's CSRF token and custom-header protections. No backend restart or `.env` edit is needed for this default setup. This proxy is a local development convenience, not a production security configuration.

### Optional local configuration

Copy `.env.example` to `.env.local` only if you need overrides:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CHUM_BACKEND_TARGET` | `http://127.0.0.1:3001` | Proxy destination |
| `VITE_CHUM_BACKEND_ORIGIN` | `http://localhost:3001` | Must match the backend's `PUBLIC_ORIGIN` |
| `CHUM_FRONTEND_PORT` | `5173` | Dev server port; fails rather than silently switching ports |
| `CHUM_PREVIEW_PORT` | `4173` | Local production-build preview port |
| `CHUM_FRONTEND_ORIGIN` | unset | One additional exact browser origin for LAN development |

Restart Vite after changing environment variables. Use `localhost` consistently to preserve the same cookie scope. `127.0.0.1` is also allowed locally but has a separate browser cookie scope.

## Connected features

- Server password/guest-passphrase login; session restoration from the HttpOnly cookie; server sign-out.
- File tree, ownership, expiry and frozen state loaded from the authorized backend listing.
- Raw file uploads, one request per selected/dropped file, without buffering file contents into localStorage or IndexedDB.
- Real downloads via `/api/items/:id/download`, with a HEAD check for unavailable files or lost access.
- Nested folders, creation, owner/admin renaming, and permission-checked deletion.
- Freeze and thaw through the backend. The server manages all file expiry, including while the UI is closed.
- Server-generated invitations, QR codes, copyable links/passphrases, retained history and revocation.
- Admin domain and invitation lifetime settings saved to the server; custom lifetimes supported up to 8760 hours.
- Authorized metadata refresh every 15 seconds while the tab is visible, on focus, and after changes. Expired/revoked sessions return to login. Network failures display a retry notice instead of pretending a local operation succeeded.
- List/grid, search, sorting, breadcrumbs, mobile navigation and accessible dialogs.

Only the cosmetic list/grid preference is saved to localStorage. Previous demo data is ignored; it is not uploaded, imported, or removed. The frontend no longer generates passwords, invitation credentials, user identities or file-expiry decisions.

### Invitations and shared URLs

Use Settings to set the sharing domain to the browser-facing **frontend** origin. Chumbucket does not serve Chum's assets itself.

For local development only, if the stored domain exactly matches `VITE_CHUM_BACKEND_ORIGIN`, links and QR codes use the current frontend origin instead. Thus the backend's initial `http://localhost:3001` setting produces working `http://localhost:5173/?access=...` invitations without modifying your stored settings. Explicit custom sharing domains are preserved. Production builds use the server's stored domain as-is.

New guest passphrases contain **three random words**, displayed with hyphens for easy sharing by phone. Guests can enter spaces or hyphens and use any capitalization. Existing hexadecimal passphrases continue to work until expiry or revocation. Three-word phrases offer less guessing resistance than invitation links, and remain valid even when the link is shared instead. Limit the invitation's scope and lifetime, and revoke it when finished. People using the same invitation share its guest identity and upload ownership; issue separate invitations when that distinction matters.

The backend exchanges invitation tokens for a cookie and redirects to `/` before Chum loads. On return, Chum obtains the authorized root folder from `/api/session`; guests never need the admin-only invitation table or settings. Admins following their own links remain admins.

Localhost links work only on the same computer. For another device, configure a reachable frontend origin, the dev origin allowance if using Vite, and the sharing domain. For deployment, use the same-origin production layout below.

## Build and local preview

```powershell
npm run build
npm run preview
```

The build is in `dist/`. Local `preview` runs at http://localhost:4173 and uses the same API proxy. Preview is for checking the build; set the sharing domain to its frontend address if testing invitations there. Production uses Caddy to serve the built files directly; neither the Vite development server nor `vite preview` needs to run.

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

## Validation

```powershell
npm test
npm run test:integration
npm run build
```

Unit tests cover folder/ownership presentation, invitation status, sharing-domain handling, raw file transport, cookie/CSRF request configuration, meaningful failures and a stale-session response race.

The integration test imports `../chumbucket/src/app.js` (override with `CHUM_BACKEND_SOURCE`) and starts **isolated temporary storage and a separate backend**, plus the actual Vite proxy on port 5179. It does not use the running bucket's data or password. It verifies login/restore/logout, folders, real file bytes/downloads, freeze/thaw/rename, settings, guest boundaries/ownership, token exchange/cookies, revocation/history, hostile Origin rejection and missing-CSRF rejection. Temporary storage is removed on completion. The test is skipped if the backend source is unavailable.

Initial integration validation: unit and API/proxy integration tests passed and the production build succeeded. Browser checks on an isolated server verified admin login, folder creation, freeze persistence and session restoration after reload, invitation/QR display, sign-out and guest token login limited to its shared folder. The mobile guest layout was also checked. No live bucket contents were changed.
