import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createReadStream, lstatSync, realpathSync, unlinkSync, utimesSync } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { openStore } from './store.js';
import { digest, secret, invitationPassphrase, passwordMatches, requireValue, itemName, HttpError } from './security.js';

const DAY = 86400000;
// Never trust the uploaded Content-Type for inline responses.
const inlineTypes = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif', webp:'image/webp', avif:'image/avif', bmp:'image/bmp', mp3:'audio/mpeg', m4a:'audio/mp4', mp4:'video/mp4', webm:'video/webm', ogg:'audio/ogg', oga:'audio/ogg', ogv:'video/ogg', wav:'audio/wav', flac:'audio/flac', mov:'video/quicktime', pdf:'application/pdf' };
const mutations = new Set(['POST', 'PATCH', 'DELETE', 'PUT']);
export async function createApp(options = {}) {
  const publicUrl = new URL(options.origin || 'http://localhost:3001');
  requireValue(['http:', 'https:'].includes(publicUrl.protocol) && !publicUrl.username && !publicUrl.password && publicUrl.pathname === '/' && !publicUrl.search && !publicUrl.hash, 500, 'PUBLIC_ORIGIN must be an HTTP(S) origin.');
  const origin = publicUrl.origin;
  const secure = options.secure ?? new URL(origin).protocol === 'https:';
  requireValue(!(!secure && new URL(origin).protocol === 'https:'), 500, 'HTTPS requires Secure cookies.');
  const maxUpload = options.maxUpload ?? 1024 ** 3;
  const sessionHours = options.sessionHours ?? 168;
  const intervalMs = options.cleanupInterval ?? 60000;
  requireValue(Number.isSafeInteger(maxUpload) && maxUpload > 0 && Number.isFinite(sessionHours) && sessionHours > 0, 500, 'Invalid upload or session limit.');
  requireValue(Number.isFinite(intervalMs) && intervalMs >= 10 && intervalMs <= 2147483647, 500, 'Invalid cleanup interval.');
  const store = await openStore(path.resolve(options.dataDir || 'data'), options.adminPassword, origin);
  const { db, files, getConfig, setConfig } = store;
  const get = id => db.prepare('SELECT * FROM items WHERE id=?').get(id);
  const all = () => db.prepare("SELECT * FROM items WHERE id<>'root'").all();
  const linkById = id => db.prepare('SELECT * FROM links WHERE id=?').get(id);
  const active = link => link && !link.revoked && link.expires > Date.now() && get(link.folder)?.kind === 'folder';
  function within(id, root) {
    const seen = new Set();
    while (id && !seen.has(id)) {
      if (id === root) return true;
      seen.add(id); id = get(id)?.parent;
    }
    return false;
  }
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  // User filenames never become physical paths. Only server-generated UUIDs address blobs.
  function blobPath(id) {
    requireValue(/^[a-f0-9-]{36}$/.test(id), 404, 'File not found.');
    requireValue(realpathSync(files) === files && !lstatSync(files).isSymbolicLink(), 500, 'Unsafe storage folder.');
    const file = path.join(files, id);
    const stat = lstatSync(file);
    requireValue(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 500, 'Unsafe stored file.');
    return { file, stat };
  }
  function removeItems(ids) {
    // Commit metadata removal first. A crash leaves unreachable bytes, removed at next startup.
    const rows = ids.map(get).filter(Boolean);
    transaction(() => {
      for (const row of rows) db.prepare('UPDATE links SET revoked=1 WHERE folder=?').run(row.id);
      for (const row of rows.reverse()) db.prepare('DELETE FROM items WHERE id=?').run(row.id);
    });
    for (const row of rows) if (row.kind === 'file') {
      try { unlinkSync(blobPath(row.id).file); }
      catch (error) { if (error.code !== 'ENOENT') console.error('Unable to remove blob', row.id, error.message); }
    }
  }
  function cleanup() {
    for (const row of db.prepare("SELECT * FROM items WHERE kind='file' AND frozen=0").all()) {
      try { if (Date.now() - blobPath(row.id).stat.mtimeMs >= DAY) removeItems([row.id]); }
      catch (error) { if (error.code === 'ENOENT') removeItems([row.id]); else console.error('Cleanup:', error.message); }
    }
    db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
    db.prepare('DELETE FROM login_attempts WHERE expires<=?').run(Date.now());
  }
  cleanup();
  const timer = setInterval(() => { try { cleanup(); } catch (error) { console.error('Cleanup failed:', error.message); } }, intervalMs);
  timer.unref();
  function authenticate(req) {
    const cookie = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('chum_session='))?.slice(13);
    const session = cookie && db.prepare('SELECT * FROM sessions WHERE hash=? AND expires>?').get(digest(cookie), Date.now());
    requireValue(session, 401, 'Sign in to continue.');
    const link = session.role === 'guest' ? linkById(session.link) : null;
    requireValue(session.role === 'admin' || active(link), 401, 'Your invitation has ended.');
    return { ...session, id: session.role === 'admin' ? 'admin' : `guest-${link.id}`, root: link?.folder || 'root' };
  }
  const userInfo = user => ({ role: user.role, id: user.id, link: user.link, root: user.root });
  const expose = row => ({ ...row, name_key: undefined, frozen: !!row.frozen });
  const exposeLink = row => ({ ...row, revoked: !!row.revoked });
  function authorize(user, id, folder = false) {
    const row = get(id);
    requireValue(row && within(id, user.root), 404, 'Item not found.');
    requireValue(!folder || row.kind === 'folder', 400, 'Expected a folder.');
    if (row.kind === 'file' && !row.frozen && Date.now() - blobPath(id).stat.mtimeMs >= DAY) {
      removeItems([id]); throw new HttpError(404, 'File expired.');
    }
    return row;
  }
  function unique(parent, name, except = '') {
    requireValue(!db.prepare('SELECT 1 FROM items WHERE parent=? AND name_key=? AND id<>?').get(parent, name.toLowerCase(), except), 409, 'That name already exists in this folder.');
  }
  function admin(user) { requireValue(user.role === 'admin', 403, 'Administrator access required.'); }
  async function jsonBody(req) {
    requireValue(req.headers['content-type']?.split(';')[0] === 'application/json', 415, 'Expected application/json.');
    const chunks = []; let size = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) { size += chunk.length; requireValue(size <= 16384, 413, 'JSON body too large.'); chunks.push(chunk); }
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requireValue(value && typeof value === 'object' && !Array.isArray(value), 400, 'Expected a JSON object.');
      if (new URL(req.url, origin).pathname !== '/api/session') authenticate(req);
      return value;
    } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'Invalid JSON object.'); }
  }
  function loginLimit(req) {
    // Do not trust X-Forwarded-For; the proxy must preserve the configured trust boundary.
    const keys = ['global', `ip:${req.socket.remoteAddress}`];
    for (const key of keys) {
      db.prepare('DELETE FROM login_attempts WHERE key=? AND expires<=?').run(key, Date.now());
      const entry = db.prepare('SELECT * FROM login_attempts WHERE key=?').get(key);
      requireValue(!entry || entry.count < (key === 'global' ? 100 : 15), 429, 'Too many sign-in attempts. Try again in 15 minutes.');
    }
    for (const key of keys) db.prepare('INSERT INTO login_attempts VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1').run(key, Date.now() + 900000);
  }
  function issueSession(res, role, link, oldUser) {
    if (oldUser) db.prepare('DELETE FROM sessions WHERE hash=?').run(oldUser.hash);
    const token = secret(), csrf = secret();
    db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?)').run(digest(token), role, link?.id || null, csrf, Math.min(Date.now() + sessionHours * 3600000, link?.expires ?? Infinity));
    res.setHeader('Set-Cookie', `chum_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(sessionHours * 3600)}${secure ? '; Secure' : ''}`);
    return { user: { role, id: role === 'admin' ? 'admin' : `guest-${link.id}`, link: link?.id || null, root: link?.folder || 'root' }, csrfToken: csrf };
  }
  function resolvePath(value) {
    const segments = value.split('/').filter(Boolean); let row = get('root');
    for (const segment of segments) {
      itemName(segment);
      requireValue(row.kind === 'folder', 404, 'Item not found.');
      row = db.prepare('SELECT * FROM items WHERE parent=? AND name_key=?').get(row.id, segment.normalize('NFC').toLowerCase());
      requireValue(row, 404, 'Item not found.');
    }
    return row.id;
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try {
      const rawPath = req.url.split('?')[0];
      let decoded;
      try { decoded = decodeURIComponent(rawPath); } catch { throw new HttpError(400, 'Malformed URL.'); }
      requireValue(!decoded.includes('\\') && !decoded.includes('\0') && !decoded.split('/').some(x => x === '.' || x === '..'), 400, 'Invalid path.');
      const url = new URL(req.url, origin), route = url.pathname, method = req.method;
      if (mutations.has(method)) {
        requireValue(!req.headers.origin || req.headers.origin === origin, 403, 'Origin rejected.');
        requireValue(req.headers['sec-fetch-site'] !== 'cross-site', 403, 'Cross-site request rejected.');
        // This custom header also protects the unauthenticated login endpoint from form CSRF.
        requireValue(req.headers['x-chum-request'] === '1', 403, 'X-Chum-Request: 1 is required.');
      }
      if (route === '/api/health' && method === 'GET') return send(200, { name: 'chumbucket', status: 'ok' });
      if (route === '/api/session' && method === 'POST') {
        loginLimit(req);
        const body = await jsonBody(req);
        requireValue(typeof body.passphrase === 'string' && body.passphrase.length <= 1024, 400, 'Passphrase required.');
        const isAdmin = await passwordMatches(body.passphrase, getConfig('adminHash'));
        const phrase = body.passphrase.trim().toLowerCase().replace(/\s*-\s*|\s+/g, '-');
        const link = db.prepare('SELECT * FROM links WHERE passphrase=?').get(phrase);
        requireValue(isAdmin || active(link), 401, 'Invalid passphrase or expired invitation.');
        let previous; try { previous = authenticate(req); } catch { /* no existing session */ }
        return send(200, issueSession(res, isAdmin ? 'admin' : 'guest', isAdmin ? null : link, previous));
      }
      if (route === '/' && method === 'GET' && url.searchParams.has('access')) {
        loginLimit(req);
        const link = db.prepare('SELECT * FROM links WHERE token=?').get(url.searchParams.get('access'));
        requireValue(active(link), 401, 'Invalid or expired invitation.');
        // Preserve an existing administrator session when following an invitation.
        let previous; try { previous = authenticate(req); } catch { /* no existing session */ }
        if (previous?.role !== 'admin') issueSession(res, 'guest', link, previous);
        res.writeHead(303, { Location: '/' }); return res.end();
      }
      if (route === '/' && method === 'GET') return send(200, { name: 'chumbucket', frontend: 'Serve Chum on the same origin; see README.md.' });
      const user = authenticate(req);
      if (mutations.has(method)) requireValue(req.headers['x-csrf-token'] === user.csrf, 403, 'Invalid CSRF token.');
      if (route === '/api/session' && method === 'GET') return send(200, { user: userInfo(user), csrfToken: user.csrf });
      if (route === '/api/session' && method === 'DELETE') {
        db.prepare('DELETE FROM sessions WHERE hash=?').run(user.hash);
        res.setHeader('Set-Cookie', `chum_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`);
        return send(200, { ok: true });
      }
      if (route === '/api/folders' && method === 'GET') {
        cleanup();
        const id = url.searchParams.get('id') || (url.searchParams.has('path') ? resolvePath(url.searchParams.get('path')) : user.root);
        const folder = authorize(user, id, true);
        const scoped = all().filter(row => within(row.id, user.root));
        return send(200, { folder: expose(folder), root: user.root, items: scoped.filter(row => row.parent === id).map(expose), tree: scoped.map(expose) });
      }
      if (route === '/api/folders' && method === 'POST') {
        const body = await jsonBody(req), parent = body.parent || user.root, name = itemName(body.name);
        authorize(user, parent, true); unique(parent, name);
        const id = randomUUID();
        db.prepare("INSERT INTO items (id,parent,name,name_key,kind,owner,modified) VALUES (?,?,?,?,'folder',?,?)").run(id, parent, name, name.toLowerCase(), user.id, Date.now());
        return send(201, { item: expose(get(id)) });
      }
      if (route === '/api/files' && method === 'POST') {
        const parent = url.searchParams.get('parent') || user.root, name = itemName(url.searchParams.get('name'));
        authorize(user, parent, true); unique(parent, name);
        requireValue(!req.headers['content-type']?.startsWith('multipart/'), 415, 'Send the File itself as the request body, one request per file.');
        if (req.headers['content-length']) requireValue(Number(req.headers['content-length']) <= maxUpload, 413, 'File exceeds upload limit.');
        const id = randomUUID(), temporary = path.join(files, `${id}.part`), destination = path.join(files, id);
        requireValue(realpathSync(files) === files && !lstatSync(files).isSymbolicLink(), 500, 'Unsafe storage folder.');
        let handle, size = 0, published = false;
        try {
          handle = await open(temporary, 'wx', 0o600);
          for await (const chunk of req.iterator({ destroyOnReturn: false })) {
            size += chunk.length; requireValue(size <= maxUpload, 413, 'File exceeds upload limit.');
            let offset = 0;
            while (offset < chunk.length) { const written = await handle.write(chunk, offset); offset += written.bytesWritten; }
          }
          await handle.sync(); await handle.close(); handle = null;
          // The invitation or parent may have changed while the upload was streaming.
          const current = authenticate(req); authorize(current, parent, true); unique(parent, name);
          await rename(temporary, destination); published = true;
          authenticate(req); authorize(current, parent, true); unique(parent, name);
          const modified = Date.now(); utimesSync(destination, modified / 1000, modified / 1000);
          db.prepare("INSERT INTO items (id,parent,name,name_key,kind,owner,modified,size,type) VALUES (?,?,?,?,'file',?,?,?,?)").run(id, parent, name, name.toLowerCase(), current.id, modified, size, String(req.headers['content-type'] || 'application/octet-stream').slice(0, 200));
          return send(201, { item: expose(get(id)) });
        } catch (error) {
          if (handle) await handle.close();
          await unlink(published ? destination : temporary).catch(() => {});
          throw error;
        }
      }
      const itemRoute = route.match(/^\/api\/items\/([a-f0-9-]{36})(\/(?:download|view))?$/);
      if (itemRoute && !itemRoute[2] && method === 'PATCH') {
        const body = await jsonBody(req), row = authorize(user, itemRoute[1]);
        requireValue(Object.keys(body).length > 0 && Object.keys(body).every(key => ['name', 'frozen'].includes(key)), 400, 'Only name and frozen may be updated.');
        if ('name' in body) requireValue(user.role === 'admin' || row.owner === user.id, 403, 'Only the owner or admin may rename an item.');
        if ('frozen' in body) requireValue(row.kind === 'file' && typeof body.frozen === 'boolean', 400, 'Frozen must be a boolean on a file.');
        if (row.frozen && body.frozen === false) requireValue(user.role === 'admin' || row.frozen_by === user.id, 403, 'Only the guest who froze this file or an admin may thaw it.');
        const name = 'name' in body ? itemName(body.name) : row.name;
        unique(row.parent, name, row.id);
        const frozen = 'frozen' in body ? Number(body.frozen) : row.frozen;
        const frozenBy = !row.frozen && frozen ? user.id : row.frozen && !frozen ? null : row.frozen_by;
        const modified = name !== row.name || (row.frozen && !frozen) ? Date.now() : row.modified;
        if (row.kind === 'file') utimesSync(blobPath(row.id).file, modified / 1000, modified / 1000);
        db.prepare('UPDATE items SET name=?,name_key=?,frozen=?,frozen_by=?,modified=? WHERE id=?').run(name, name.toLowerCase(), frozen, frozenBy, modified, row.id);
        return send(200, { item: expose(get(row.id)) });
      }
      if (itemRoute && !itemRoute[2] && method === 'DELETE') {
        const row = authorize(user, itemRoute[1]);
        requireValue(user.role === 'admin' || (row.owner === user.id && (row.kind !== 'folder' || !db.prepare('SELECT 1 FROM items WHERE parent=?').get(row.id))), 403, 'Only the owner of a file or empty folder, or an admin, may delete it.');
        const ids = [row.id, ...all().filter(x => x.id !== row.id && within(x.id, row.id)).sort((a, b) => depth(a.id) - depth(b.id)).map(x => x.id)];
        removeItems(ids); return send(200, { ok: true });
      }
      if (route === '/api/links' && ['GET', 'POST'].includes(method)) {
        admin(user);
        if (method === 'GET') return send(200, { links: db.prepare('SELECT * FROM links ORDER BY created').all().map(exposeLink) });
        const body = await jsonBody(req), folder = body.folder || 'root';
        authorize(user, folder, true);
        const hours = body.hours ?? JSON.parse(getConfig('settings')).hours;
        requireValue(Number.isFinite(hours) && hours > 0 && hours <= 8760, 400, 'Hours must be greater than zero and at most 8760.');
        const id = randomUUID(), created = Date.now();
        // Three random hex groups supply 96 bits; no small dictionary to brute force.
        let token, passphrase;
        do { token = secret(24); passphrase = invitationPassphrase(); }
        while (db.prepare('SELECT 1 FROM links WHERE token=? OR passphrase=?').get(token, passphrase));
        db.prepare('INSERT INTO links VALUES (?,?,?,?,?,?,0)').run(id, folder, token, passphrase, created, created + hours * 3600000);
        return send(201, { link: exposeLink(linkById(id)) });
      }
      const revoke = route.match(/^\/api\/links\/([a-f0-9-]{36})\/revoke$/);
      if (revoke && method === 'POST') {
        admin(user); requireValue(linkById(revoke[1]), 404, 'Invitation not found.');
        transaction(() => {
          db.prepare('UPDATE links SET revoked=1 WHERE id=?').run(revoke[1]);
          db.prepare('DELETE FROM sessions WHERE link=?').run(revoke[1]);
        });
        return send(200, { ok: true });
      }
      if (route === '/api/settings' && ['GET', 'PATCH'].includes(method)) {
        admin(user); let settings = JSON.parse(getConfig('settings'));
        if (method === 'PATCH') {
          const body = await jsonBody(req);
          requireValue(Object.keys(body).every(key => ['domain', 'hours'].includes(key)), 400, 'Unknown setting.');
          settings = { ...settings, ...body };
          let domain; try { domain = new URL(settings.domain); } catch { throw new HttpError(400, 'Invalid domain URL.'); }
          requireValue(['http:', 'https:'].includes(domain.protocol) && !domain.username && !domain.password && !domain.search && !domain.hash && domain.pathname === '/', 400, 'Domain must be an HTTP(S) origin.');
          requireValue(Number.isFinite(settings.hours) && settings.hours > 0 && settings.hours <= 8760, 400, 'Invalid expiration hours.');
          settings.domain = domain.origin; setConfig('settings', JSON.stringify(settings));
        }
        return send(200, { settings });
      }
      if (['GET', 'HEAD'].includes(method) && (itemRoute?.[2] || !route.startsWith('/api/'))) {
        const id = itemRoute?.[1] || resolvePath(decoded);
        const row = authorize(user, id); requireValue(row.kind === 'file', 404, 'File not found.');
        const { file, stat } = blobPath(id);
        if (!row.frozen && Date.now() - stat.mtimeMs >= DAY) { removeItems([id]); throw new HttpError(404, 'File expired.'); }
        if (itemRoute?.[2] === '/view') {
          const ext = row.name.toLowerCase().split('.').pop();
          const type = Object.hasOwn(inlineTypes, ext) && row.name.includes('.') ? inlineTypes[ext] : null;
          requireValue(type, 415, 'This file type cannot be viewed inline.');
          const headers = { 'Content-Type': type, 'Content-Disposition': 'inline', 'Accept-Ranges': 'bytes', 'Content-Security-Policy': "sandbox; default-src 'none'; frame-ancestors 'none'" };
          let start = 0, end = stat.size - 1, status = 200;
          if (req.headers.range && method === 'GET') {
            const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
            if (!match || (!match[1] && !match[2]) || stat.size === 0) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end(); }
            if (!match[1]) { const suffix = Number(match[2]); start = Math.max(0, stat.size - suffix); }
            else { start = Number(match[1]); if (match[2]) end = Math.min(Number(match[2]), end); }
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end(); }
            status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
          }
          headers['Content-Length'] = stat.size === 0 ? 0 : end - start + 1;
          res.writeHead(status, headers);
          if (method === 'HEAD' || !stat.size) return res.end();
          const stream = createReadStream(file, { start, end }); stream.on('error', () => res.destroy());
          res.on('close', () => stream.destroy()); stream.pipe(res); return;
        }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size,
          'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(row.name).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16))}` });
        if (method === 'HEAD') return res.end();
        const stream = createReadStream(file); stream.on('error', () => res.destroy());
        res.on('close', () => stream.destroy()); stream.pipe(res); return;
      }
      throw new HttpError(404, 'Route not found.');
    } catch (error) {
      if (req.aborted || res.destroyed) return;
      if (res.headersSent) return res.destroy();
      const status = error.status || (error.code === 'ENOENT' ? 404 : 500);
      if (status === 500) console.error(error);
      if (status === 429) res.setHeader('Retry-After', '900');
      if (!req.complete) { res.setHeader('Connection', 'close'); req.resume(); }
      send(status, { error: status === 500 ? 'Internal server error.' : error.message });
    }
  });
  function depth(id) { let count = 0; while (get(id)?.parent) { count++; id = get(id).parent; } return count; }
  server.requestTimeout = 15 * 60000;
  server.headersTimeout = 30000;
  return { server, cleanup, store, async close() {
    clearInterval(timer);
    if (server.listening) await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); });
    if (db.isOpen) db.close();
  } };
}
