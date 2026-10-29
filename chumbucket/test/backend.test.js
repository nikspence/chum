import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, utimes, writeFile, readdir, link, unlink } from 'node:fs/promises';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { words } from '../src/words.js';

const password = 'a-long-test-admin-password';
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'chumbucket-test-'));
  const app = await createApp({ dataDir: directory, adminPassword: password, maxUpload: 1024, ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  function client() {
    let cookie = '', csrf = '';
    const call = async (route, method = 'GET', body, extra = {}) => {
      const headers = { Cookie: cookie, 'X-Chum-Request': '1', 'X-CSRF-Token': csrf, ...extra };
      if (body !== undefined && typeof body !== 'string') { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
      const response = await fetch(base + route, { method, headers, body, redirect: 'manual' });
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      const text = await response.text(); let data;
      try { data = JSON.parse(text); } catch { data = text; }
      if (data?.csrfToken) csrf = data.csrfToken;
      return { status: response.status, data, headers: response.headers };
    };
    call.headers = () => ({ Cookie: cookie, 'X-Chum-Request': '1', 'X-CSRF-Token': csrf });
    return call;
  }
  const admin = client();
  assert.equal((await admin('/api/session', 'POST', { passphrase: password })).status, 200);
  return { app, directory, client, admin, base };
}

test('files stay on disk; metadata, settings and credentials survive reopening SQLite', async t => {
  const { app, directory, admin } = await fixture(t);
  const folder = (await admin('/api/folders', 'POST', { name: 'Summer' })).data.item;
  const upload = await admin(`/api/files?parent=${folder.id}&name=hello.txt`, 'POST', 'hello chum');
  assert.equal(upload.status, 201);
  const file = upload.data.item;
  assert.equal(file.owner, 'admin'); assert.equal(file.size, 10);
  assert.equal(await readFile(path.join(directory, 'files', file.id), 'utf8'), 'hello chum');
  assert.equal((await admin('/Summer/hello.txt')).data, 'hello chum');
  assert.match((await admin(`/api/items/${file.id}/download`)).headers.get('content-disposition'), /attachment/);
  assert.equal((await admin('/api/settings', 'PATCH', { domain: 'https://chum.example', hours: 72 })).status, 200);
  const second = await createApp({ dataDir: directory });
  try {
    assert.equal(second.store.db.prepare('SELECT name FROM items WHERE id=?').get(file.id).name, 'hello.txt');
    assert.equal(JSON.parse(second.store.getConfig('settings')).hours, 72);
    assert.ok(!second.store.getConfig('adminHash').includes(password));
  } finally { await second.close(); }
  assert.equal((await admin('/api/folders?path=Summer')).data.items.length, 1);
  assert.equal((await admin(`/api/items/${folder.id}`, 'DELETE')).status, 200);
  assert.equal((await admin(`/api/items/${file.id}/download`)).status, 404);
  assert.equal(app.store.db.prepare('SELECT count(*) AS n FROM items').get().n, 1);
});

test('invitation scoping, ownership, recursive deletion, revocation and retained keys', async t => {
  const { admin, client } = await fixture(t);
  const folder = (await admin('/api/folders', 'POST', { name: 'Friends' })).data.item;
  const sibling = (await admin('/api/folders', 'POST', { name: 'Private' })).data.item;
  const captainFile = (await admin(`/api/files?parent=${folder.id}&name=captain.txt`, 'POST', 'private owner')).data.item;
  const link = (await admin('/api/links', 'POST', { folder: folder.id })).data.link;
  const guest = client(), other = client();
  assert.equal((await guest('/api/session', 'POST', { passphrase: link.passphrase })).status, 200);
  assert.equal((await other('/?access=' + link.token)).status, 303);
  assert.equal((await other('/api/session')).data.user.root, folder.id);
  assert.equal((await guest('/api/folders')).data.root, folder.id);
  assert.equal((await guest(`/api/folders?id=${sibling.id}`)).status, 404);
  assert.equal((await guest('/api/folders?id=root')).status, 404);
  assert.equal((await guest('/api/links')).status, 403);
  assert.equal((await guest('/api/settings')).status, 403);
  assert.equal((await guest(`/api/items/${captainFile.id}`, 'DELETE')).status, 403);
  assert.equal((await guest(`/api/items/${captainFile.id}`, 'PATCH', { name: 'stolen.txt' })).status, 403);
  assert.equal((await guest(`/api/items/${captainFile.id}`, 'PATCH', { frozen: true })).status, 200);
  const ownFolder = (await guest('/api/folders', 'POST', { name: 'Mine', owner: 'admin' })).data.item;
  assert.equal(ownFolder.owner, `guest-${link.id}`);
  const own = (await guest(`/api/files?parent=${ownFolder.id}&name=my.txt`, 'POST', 'hello')).data.item;
  assert.equal((await guest(`/api/items/${ownFolder.id}`, 'DELETE')).status, 403);
  const secondLink = (await admin('/api/links', 'POST', { folder: folder.id })).data.link;
  const stranger = client(); await stranger('/api/session', 'POST', { passphrase: secondLink.passphrase });
  assert.equal((await stranger(`/api/items/${own.id}`, 'DELETE')).status, 403);
  assert.equal((await guest(`/api/items/${own.id}`, 'DELETE')).status, 200);
  assert.equal((await guest(`/api/items/${ownFolder.id}`, 'DELETE')).status, 200);
  await admin(`/api/links/${link.id}/revoke`, 'POST');
  assert.equal((await guest('/api/folders')).status, 401);
  assert.equal((await other(`/api/items/${captainFile.id}/download`)).status, 401);
  const history = (await admin('/api/links')).data.links;
  assert.equal(history.find(x => x.id === link.id).token, link.token);
  assert.equal(history.find(x => x.id === link.id).revoked, true);
  await admin(`/api/items/${folder.id}`, 'DELETE');
  assert.equal((await stranger('/api/folders')).status, 401);
});

test('word invitations accept spoken-friendly input and existing hexadecimal phrases still work', async t => {
  const { admin, client, app } = await fixture(t);
  assert.equal(new Set(words).size, words.length);
  assert.ok(words.length >= 250 && words.every(word => /^[a-z]+$/.test(word)));
  const link = (await admin('/api/links', 'POST', {})).data.link;
  const parts = link.passphrase.split('-');
  assert.equal(parts.length, 3);
  assert.ok(parts.every(word => words.includes(word)));
  assert.equal((await client()('/api/session', 'POST', { passphrase: `  ${parts.join('  ').toUpperCase()}  ` })).status, 200);
  assert.equal((await client()('/api/session', 'POST', { passphrase: parts.join(' - ') })).status, 200);
  assert.equal((await client()('/api/session', 'POST', { passphrase: parts.slice(0, 2).join('-') })).status, 401);
  const old = (await admin('/api/links', 'POST', {})).data.link;
  const legacy = '01234567-89abcdef-12345678';
  app.store.db.prepare('UPDATE links SET passphrase=? WHERE id=?').run(legacy, old.id);
  assert.equal((await client()('/api/session', 'POST', { passphrase: legacy })).status, 200);
  assert.equal((await admin('/api/links')).data.links.find(item => item.id === old.id).passphrase, legacy);
});

test('filesystem expiry, frozen files, rename and thaw timestamps', async t => {
  const { admin, app, directory } = await fixture(t);
  const upload = async name => (await admin(`/api/files?name=${name}`, 'POST', 'test')).data.item;
  const expired = await upload('expire.txt'), frozen = await upload('frozen.txt');
  await admin(`/api/items/${frozen.id}`, 'PATCH', { frozen: true });
  const old = new Date(Date.now() - 90000000);
  for (const file of [expired, frozen]) await utimes(path.join(directory, 'files', file.id), old, old);
  app.cleanup();
  assert.equal((await admin(`/api/items/${expired.id}/download`)).status, 404);
  assert.equal((await admin(`/api/items/${frozen.id}/download`)).status, 200);
  const thawed = await admin(`/api/items/${frozen.id}`, 'PATCH', { frozen: false });
  assert.ok(thawed.data.item.modified > Date.now() - 5000);
  const renamed = await admin(`/api/items/${frozen.id}`, 'PATCH', { name: 'renamed.txt' });
  assert.equal(renamed.status, 200);
  assert.equal((await admin('/renamed.txt')).status, 200);
});

test('rejects CSRF, traversal, invalid names, oversized uploads, spoofed permissions and duplicates', async t => {
  const { admin, directory } = await fixture(t);
  assert.equal((await admin('/api/folders', 'POST', { name: 'ok' }, { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await admin('/api/folders', 'POST', { name: 'ok' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await admin('/api/session', 'POST', { passphrase: password }, { 'X-Chum-Request': '' })).status, 403);
  for (const name of ['../escape', 'CON', 'bad:stream', '.', 'trailing.']) {
    assert.equal((await admin('/api/folders', 'POST', { name })).status, 400);
  }
  assert.equal((await admin('/api/files?name=large.txt', 'POST', 'x'.repeat(1025))).status, 413);
  assert.equal((await admin('/api/folders', 'POST', { name: 'Unique' })).status, 201);
  assert.equal((await admin('/api/folders', 'POST', { name: 'UNIQUE' })).status, 409);
  assert.equal((await admin('/api/files?name=outside.txt&parent=..', 'POST', 'x')).status, 404);
  assert.equal((await admin('/api/settings', 'PATCH', { domain: 'file:///etc/passwd' })).status, 400);
  await writeFile(path.join(directory, 'files', 'unmanaged.txt'), 'never exposed');
  assert.equal((await admin('/unmanaged.txt')).status, 404);
});

test('login limits, invitation expiry and session logout are enforced', async t => {
  const { admin, client, app } = await fixture(t);
  const link = (await admin('/api/links', 'POST', {})).data.link;
  const guest = client(); await guest('/api/session', 'POST', { passphrase: link.passphrase });
  app.store.db.prepare('UPDATE links SET expires=? WHERE id=?').run(Date.now() - 1, link.id);
  assert.equal((await guest('/api/session')).status, 401);
  assert.equal((await guest('/?access=' + link.token)).status, 401);
  assert.equal((await admin('/api/session', 'DELETE')).status, 200);
  assert.equal((await admin('/api/session')).status, 401);
  const anonymous = client(); let last;
  for (let i = 0; i < 16; i++) last = await anonymous('/api/session', 'POST', { passphrase: 'wrong' });
  assert.equal(last.status, 429);
});

function rawRequest(base, route, headers, method = 'GET') {
  let request;
  const response = new Promise((resolve, reject) => {
    request = http.request(base + route, { method, headers }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    request.on('error', reject);
  });
  return { request, response };
}

test('encoded traversal, malformed paths and hardlinked blobs are rejected', async t => {
  const { admin, base, directory } = await fixture(t);
  for (const route of ['/a/%2e%2e/private', '/%2e%2e%5cprivate', '/%00', '/%zz']) {
    // http.request preserves the raw path so URL normalization cannot hide the test case.
    const result = rawRequest(base, '/', admin.headers());
    result.request.path = route; result.request.end();
    assert.equal(await result.response, 400);
  }
  const file = (await admin('/api/files?name=safe.txt', 'POST', 'safe')).data.item;
  const blob = path.join(directory, 'files', file.id), outside = path.join(directory, 'outside.txt');
  await writeFile(outside, 'must not download'); await unlink(blob); await link(outside, blob);
  t.mock.method(console, 'error', () => {});
  assert.equal((await admin(`/api/items/${file.id}/download`)).status, 500);
});

test('streamed uploads enforce size limits and revocation during transfer; aborted bytes are removed', async t => {
  const { admin, client, base, directory } = await fixture(t);
  const oversized = rawRequest(base, '/api/files?name=chunked.txt', admin.headers(), 'POST');
  oversized.request.write('x'.repeat(1025)); oversized.request.end();
  assert.equal(await oversized.response, 413);
  const invitation = (await admin('/api/links', 'POST', {})).data.link;
  const guest = client(); await guest('/api/session', 'POST', { passphrase: invitation.passphrase });
  const pending = rawRequest(base, '/api/files?name=revoked.txt', guest.headers(), 'POST');
  pending.request.write('start');
  await admin(`/api/links/${invitation.id}/revoke`, 'POST');
  pending.request.end('end');
  assert.equal(await pending.response, 401);
  const aborted = rawRequest(base, '/api/files?name=aborted.txt', admin.headers(), 'POST');
  const abortedResponse = aborted.response.catch(() => {});
  aborted.request.write('start');
  for (let i = 0; i < 100; i++) {
    if ((await readdir(path.join(directory, 'files'))).some(name => name.endsWith('.part'))) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  aborted.request.destroy(); await abortedResponse;
  for (let i = 0; i < 100; i++) {
    if (!(await readdir(path.join(directory, 'files'))).length) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.deepEqual(await readdir(path.join(directory, 'files')), []);
  assert.equal((await admin('/api/folders')).data.items.length, 0);
});

test('startup removes orphan bytes and expired files while retaining sessions and frozen content', async t => {
  const { app, directory, admin } = await fixture(t);
  const file = (await admin('/api/files?name=expire.txt', 'POST', 'test')).data.item;
  const frozen = (await admin('/api/files?name=keep.txt', 'POST', 'keeper')).data.item;
  await admin(`/api/items/${frozen.id}`, 'PATCH', { frozen: true });
  const headers = admin.headers();
  await app.close();
  const old = new Date(Date.now() - 90000000);
  await utimes(path.join(directory, 'files', file.id), old, old);
  await writeFile(path.join(directory, 'files', '11111111-1111-4111-8111-111111111111.part'), 'unfinished');
  await writeFile(path.join(directory, 'files', '22222222-2222-4222-8222-222222222222'), 'orphan');
  const restarted = await createApp({ dataDir: directory });
  try {
    await new Promise(resolve => restarted.server.listen(0, '127.0.0.1', resolve));
    const response = await fetch(`http://127.0.0.1:${restarted.server.address().port}/api/session`, { headers });
    assert.equal(response.status, 200); await response.json();
    assert.deepEqual(await readdir(path.join(directory, 'files')), [frozen.id]);
    assert.equal(restarted.store.db.prepare('SELECT count(*) AS n FROM items').get().n, 2);
  } finally { await restarted.close(); }
});

test('server entrypoint boots with environment configuration and answers HTTP', async t => {
  const { app, directory } = await fixture(t);
  const port = app.server.address().port;
  await app.close();
  const child = spawn(process.execPath, ['--env-file-if-exists=.env', 'src/server.js'], {
    cwd: process.cwd(), windowsHide: true,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: directory,
      PUBLIC_ORIGIN: `http://localhost:${port}`, COOKIE_SECURE: 'false', CHUM_ADMIN_PASSWORD: '',
      MAX_UPLOAD_BYTES: '1024', SESSION_HOURS: '1', CLEANUP_INTERVAL_MS: '60000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  try {
    for (let i = 0; i < 100 && !output.includes('listening') && child.exitCode === null; i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.match(output, /chumbucket listening/);
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { name: 'chumbucket', status: 'ok' });
  } finally { child.kill('SIGTERM'); await exited; }
});
