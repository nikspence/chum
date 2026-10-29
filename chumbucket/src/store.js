import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, lstatSync, realpathSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { passwordHash, requireValue } from './security.js';

export async function openStore(directory, adminPassword, origin) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const root = realpathSync(directory);
  const files = path.join(root, 'files');
  mkdirSync(files, { recursive: true, mode: 0o700 });
  requireValue(!lstatSync(files).isSymbolicLink(), 500, 'File storage must not be a symlink.');
  const database = path.join(root, 'chumbucket.sqlite');
  try { requireValue(!lstatSync(database).isSymbolicLink(), 500, 'Database must not be a symlink.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const db = new DatabaseSync(database);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY, parent TEXT REFERENCES items(id), name TEXT NOT NULL,
      name_key TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('folder','file')),
      owner TEXT NOT NULL, modified INTEGER NOT NULL, size INTEGER NOT NULL DEFAULT 0,
      type TEXT NOT NULL DEFAULT '', frozen INTEGER NOT NULL DEFAULT 0, frozen_by TEXT,
      UNIQUE(parent,name_key)
    );
    CREATE INDEX IF NOT EXISTS items_parent ON items(parent);
    CREATE TABLE IF NOT EXISTS links (
      id TEXT PRIMARY KEY, folder TEXT NOT NULL, token TEXT UNIQUE NOT NULL,
      passphrase TEXT UNIQUE NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions (
      hash TEXT PRIMARY KEY, role TEXT NOT NULL, link TEXT REFERENCES links(id),
      csrf TEXT NOT NULL, expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS login_attempts (
      key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL
    );
  `);
  const getConfig = key => db.prepare('SELECT value FROM config WHERE key=?').get(key)?.value;
  const setConfig = (key, value) => db.prepare('INSERT INTO config VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
  try {
    // Older databases did not record who froze a file. Leave that identity
    // unknown so only an administrator can thaw those files.
    if (!db.prepare('PRAGMA table_info(items)').all().some(column => column.name === 'frozen_by')) {
      db.exec('ALTER TABLE items ADD COLUMN frozen_by TEXT');
    }
    db.exec('PRAGMA user_version=2');
    if (!getConfig('adminHash')) {
      requireValue(typeof adminPassword === 'string' && adminPassword.length >= 12, 500,
        'Set CHUM_ADMIN_PASSWORD to at least 12 characters for the first start.');
      setConfig('adminHash', await passwordHash(adminPassword));
    }
    if (!getConfig('settings')) setConfig('settings', JSON.stringify({ domain: origin, hours: 24 }));
    db.prepare(`INSERT OR IGNORE INTO items (id,parent,name,name_key,kind,owner,modified) VALUES ('root',NULL,'','', 'folder','admin',?)`).run(Date.now());
    // A crash can leave uploaded bytes without metadata. Only UUID files managed by us are removed.
    for (const name of readdirSync(files)) {
      if (/^[a-f0-9-]{36}(\.part)?$/.test(name) && !db.prepare('SELECT 1 FROM items WHERE id=?').get(name)) {
        unlinkSync(path.join(files, name));
      }
    }
    return { db, root, files, getConfig, setConfig };
  } catch (error) { db.close(); throw error; }
}
