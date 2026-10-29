# Agent guidance

- This root contains `chum/` (React/Vite frontend) and `chumbucket/` (Node.js backend). Read the relevant component README and backend contract before changing their integration.
- Develop on Windows with PowerShell; keep Linux deployment in mind and use portable, project-relative paths in documentation.
- The backend owns authentication, authorization, persistence, expiry and invitations. Keep its data and `.env` private; never expose uploads as static files or alter live data for tests.
- Preserve same-origin routing: proxy `/api/*` and root invitation requests to the backend before the frontend SPA fallback. Keep production origin, secure cookie and sharing-domain settings aligned.
- Use one backend process per data directory. Tests should use isolated temporary storage; do not overwrite existing `.env` files or databases.
- For backend changes run `npm test` and `npm run check` in `chumbucket/`. For frontend changes run `npm test`, `npm run test:integration` and `npm run build` in `chum/` as appropriate. Report checks that could not be run.
- Update the root and component documentation when behavior or deployment instructions change. Validate Caddy configuration on a host with Caddy before claiming it has been tested.
