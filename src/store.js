import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';

const keyDigest = (key) => createHash('sha256').update(key).digest();
const passwordHash = (password, salt) =>
  scryptSync(password, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function migrate(db) {
  // SQLite's table-rebuild procedure: leave child assets in place while replacing
  // their parent, check the resulting references, then enable enforcement.
  db.exec('PRAGMA foreign_keys = OFF');
  transaction(db, () => {
    const { user_version: version } = db.prepare('PRAGMA user_version').get();
    if (version === 1) return;
    if (version !== 0) throw new Error(`Unsupported pages database version: ${version}`);
    const legacy = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'pages'").get();
    db.exec(`
      CREATE TABLE users (
        username TEXT PRIMARY KEY NOT NULL,
        salt BLOB,
        passwordHash BLOB,
        CHECK ((salt IS NULL) = (passwordHash IS NULL))
      );
      CREATE TABLE apiKeys (
        id TEXT PRIMARY KEY NOT NULL,
        owner TEXT NOT NULL REFERENCES users(username),
        digest BLOB NOT NULL UNIQUE
      );
      CREATE INDEX keys_owner ON apiKeys(owner);
      CREATE TABLE groups (
        owner TEXT NOT NULL REFERENCES users(username),
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        PRIMARY KEY (owner, id),
        UNIQUE (owner, name)
      );
      CREATE TABLE pages_new (
        id TEXT PRIMARY KEY NOT NULL,
        owner TEXT NOT NULL REFERENCES users(username),
        groupId TEXT,
        title TEXT NOT NULL,
        description TEXT NOT NULL CHECK (length(CAST(trim(description) AS BLOB)) > 0 AND length(description) <= 500),
        markdown TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY (owner, groupId) REFERENCES groups(owner, id)
      );
    `);
    if (legacy) {
      db.function('migrated_summary', (description, markdown, title) => {
        const text = description.trim() || markdown.replace(/\s+/gu, ' ').trim() || title.trim() || 'Untitled page';
        return text.slice(0, 500).replace(/[\uD800-\uDBFF]$/u, '').trimEnd();
      });
      // A historical owner has no credentials until explicitly provisioned.
      db.exec(`
        INSERT INTO users (username) SELECT 'gradius' WHERE EXISTS (SELECT 1 FROM pages);
        INSERT INTO pages_new (id, owner, title, description, markdown, createdAt, updatedAt)
          SELECT id, 'gradius', title, migrated_summary(description, markdown, title), markdown, createdAt, updatedAt FROM pages;
        DROP TABLE pages;
      `);
    }
    db.exec(`
      ALTER TABLE pages_new RENAME TO pages;
      CREATE INDEX pages_owner_updated ON pages(owner, updatedAt DESC, id);
      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY,
        pageId TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        content BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS assets_page ON assets(pageId);
      PRAGMA user_version = 1;
    `);
    if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Pages migration found invalid references.');
  });
  db.exec('PRAGMA foreign_keys = ON');
}

export function openStore(filename) {
  const db = new DatabaseSync(filename);
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL');
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }
  const pageIndex = 'SELECT id, owner, groupId, title, description, createdAt, updatedAt FROM pages';
  const pageOrder = 'ORDER BY updatedAt DESC, id';
  const sql = {
    page: db.prepare('SELECT * FROM pages WHERE id = ?'),
    pages: db.prepare(`${pageIndex} ${pageOrder}`),
    ownPages: db.prepare(`${pageIndex} WHERE owner = ? ${pageOrder}`),
    create: db.prepare('INSERT INTO pages (id, owner, groupId, title, description, markdown, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    update: db.prepare(`UPDATE pages SET title = ?, description = ?, markdown = ?, updatedAt = ?,
      groupId = CASE WHEN ? THEN ? ELSE groupId END WHERE id = ?`),
    setGroup: db.prepare('UPDATE pages SET groupId = ?, updatedAt = ? WHERE id = ?'),
    touch: db.prepare('UPDATE pages SET updatedAt = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM pages WHERE id = ?'),
    assets: db.prepare('SELECT id, pageId, name, mime, size FROM assets WHERE pageId = ? ORDER BY rowid'),
    asset: db.prepare('SELECT * FROM assets WHERE id = ?'),
    upload: db.prepare('INSERT INTO assets VALUES (?, ?, ?, ?, ?, ?)'),
    removeAsset: db.prepare('DELETE FROM assets WHERE pageId = ? AND id = ?'),
    user: db.prepare('SELECT salt, passwordHash FROM users WHERE username = ?'),
    createUser: db.prepare(`INSERT INTO users (username, salt, passwordHash) VALUES (?, ?, ?)
      ON CONFLICT (username) DO UPDATE SET salt = excluded.salt, passwordHash = excluded.passwordHash WHERE users.passwordHash IS NULL`),
    createKey: db.prepare('INSERT INTO apiKeys (id, owner, digest) VALUES (?, ?, ?)'),
    keys: db.prepare('SELECT id FROM apiKeys WHERE owner = ? ORDER BY rowid'),
    revokeKey: db.prepare('DELETE FROM apiKeys WHERE owner = ? AND id = ?'),
    keyOwner: db.prepare('SELECT owner FROM apiKeys WHERE digest = ?'),
    groups: db.prepare('SELECT id, name FROM groups WHERE owner = ? ORDER BY name COLLATE NOCASE, id'),
    createGroup: db.prepare('INSERT INTO groups (owner, id, name) VALUES (?, ?, ?) ON CONFLICT (owner, name) DO NOTHING'),
    hasGroup: db.prepare('SELECT 1 FROM groups WHERE owner = ? AND id = ?'),
  };
  return {
    close: () => db.close(),
    verifyUser(username, password) {
      const row = sql.user.get(username);
      return !!row?.passwordHash && timingSafeEqual(passwordHash(password, row.salt), row.passwordHash);
    },
    createUser(username, password) {
      const salt = randomBytes(16);
      return sql.createUser.run(username, salt, passwordHash(password, salt)).changes > 0;
    },
    createKey(username) {
      const id = randomUUID();
      const key = randomBytes(32).toString('base64url');
      sql.createKey.run(id, username, keyDigest(key));
      return { id, key };
    },
    listKeys: (username) => sql.keys.all(username),
    revokeKey: (username, id) => sql.revokeKey.run(username, id).changes > 0,
    keyOwner: (key) => sql.keyOwner.get(keyDigest(key))?.owner ?? null,
    listGroups: (username) => sql.groups.all(username),
    createGroup(username, name) {
      const id = randomUUID();
      return sql.createGroup.run(username, id, name).changes ? { id, name } : null;
    },
    hasGroup: (username, id) => !!sql.hasGroup.get(username, id),
    setGroup(pageId, groupId) {
      sql.setGroup.run(groupId, new Date().toISOString(), pageId);
      return this.get(pageId);
    },
    list: (owner) => owner === undefined ? sql.pages.all() : sql.ownPages.all(owner),
    get(id) {
      const page = sql.page.get(id);
      return page ? { ...page, assets: sql.assets.all(id) } : null;
    },
    create({ owner, groupId = null, title, description, markdown }) {
      const id = randomUUID();
      const now = new Date().toISOString();
      sql.create.run(id, owner, groupId, title, description, markdown, now, now);
      return this.get(id);
    },
    update(id, { title, description, markdown, groupId }) {
      sql.update.run(title, description, markdown, new Date().toISOString(), Number(groupId !== undefined), groupId ?? null, id);
      return this.get(id);
    },
    remove: (id) => sql.remove.run(id).changes > 0,
    getAsset: (id) => sql.asset.get(id),
    addAsset(pageId, name, mime, content) {
      const asset = { id: randomUUID(), pageId, name, mime, size: content.length };
      transaction(db, () => {
        sql.upload.run(asset.id, pageId, name, mime, asset.size, content);
        sql.touch.run(new Date().toISOString(), pageId);
      });
      return asset;
    },
    removeAsset(pageId, id) {
      return transaction(db, () => {
        const removed = sql.removeAsset.run(pageId, id).changes > 0;
        if (removed) sql.touch.run(new Date().toISOString(), pageId);
        return removed;
      });
    },
  };
}
