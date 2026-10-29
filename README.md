# Chum

Chum is a small, mobile-friendly file-sharing bucket for friends. This repository combines the [Chum frontend](chum/README.md), built with React, Vite and Tailwind CSS, and the [Chumbucket backend](chumbucket/README.md), a dependency-free Node.js 24 HTTP and SQLite server.

The backend owns authentication, authorization, invitations, metadata and private file storage. Files expire after 24 hours unless frozen; invitations grant access to a folder and its descendants. Chum uses the backend's cookie-based sessions and APIs. The backend must stay running for scheduled cleanup. See the component READMEs for features, configuration, API details, storage, limits and tests.

Guests can freeze accessible files and thaw files frozen by their invitation identity. Admins can thaw any file, including files frozen before freezer identities were recorded.

New guest invitations include a three-word passphrase that can be shared by phone; guests can type the words with spaces or hyphens. Existing hexadecimal passphrases still work until expiry or revocation. The random invitation link is harder to guess than the three-word phrase. Limit invitation scope and lifetime and revoke access when finished.

## Local development on Windows

Install Node.js 24. From the combined project root, start the backend in PowerShell:

```powershell
Set-Location .\chumbucket
Copy-Item .env.example .env  # only on first setup; do not overwrite an existing .env
notepad .env                 # set CHUM_ADMIN_PASSWORD to a unique passphrase of at least 12 characters
npm start
```

The password initializes a new database only; changing it later does not reset the stored password. Protect `.env` and the data directory. In a second PowerShell window, from the combined root:

```powershell
Set-Location .\chum
npm install
npm run dev
```

Visit `http://localhost:5173`. Vite proxies `/api/*` and root invitation links to the backend at `127.0.0.1:3001`. For local overrides, see [Chum's README](chum/README.md). The proxy's Origin translation is for development only.

## Ubuntu 26.04 deployment

The following deploys both components on one Ubuntu host. Commands use a shell and assume the current directory is the combined project root unless stated otherwise. Install Node.js 24 and npm, [PM2](https://pm2.keymetrics.io/docs/usage/quick-start/) and [Caddy's official Ubuntu package](https://caddyserver.com/docs/install). Run the backend and PM2 under a dedicated unprivileged account with a persistent home directory. Node and PM2 must remain available to that account after reboot. Point a real public DNS name at the host and allow inbound TCP 80 and 443; keep port 3001 private. Caddy's [automatic HTTPS](https://caddyserver.com/docs/automatic-https) obtains and renews certificates; preserve its writable certificate storage.

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

## Tests

Run backend `npm test` and `npm run check` in `chumbucket/`. Run `npm test`, `npm run test:integration`, and `npm run build` in `chum/`. The frontend integration test starts a separate backend with temporary storage. See the component READMEs for coverage and caveats.

## License

Copyright 2026 Nikolaus Spence. Licensed under the [Apache License, Version 2.0](LICENSE).
