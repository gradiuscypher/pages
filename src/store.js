import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export function openStore(filename) {
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS pages (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      markdown TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      pageId TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      content BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS assets_page ON assets(pageId);
  `);
  const sql = {
    page: db.prepare('SELECT * FROM pages WHERE id = ?'),
    pages: db.prepare('SELECT id, title, description, createdAt, updatedAt FROM pages ORDER BY updatedAt DESC, id'),
    create: db.prepare('INSERT INTO pages VALUES (?, ?, ?, ?, ?, ?)'),
    update: db.prepare('UPDATE pages SET title = ?, description = ?, markdown = ?, updatedAt = ? WHERE id = ?'),
    touch: db.prepare('UPDATE pages SET updatedAt = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM pages WHERE id = ?'),
    assets: db.prepare('SELECT id, pageId, name, mime, size FROM assets WHERE pageId = ? ORDER BY rowid'),
    asset: db.prepare('SELECT * FROM assets WHERE id = ?'),
    upload: db.prepare('INSERT INTO assets VALUES (?, ?, ?, ?, ?, ?)'),
    removeAsset: db.prepare('DELETE FROM assets WHERE pageId = ? AND id = ?'),
  };
  function transaction(fn) {
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
  return {
    close: () => db.close(),
    list: () => sql.pages.all(),
    get(id) {
      const page = sql.page.get(id);
      return page ? { ...page, assets: sql.assets.all(id) } : null;
    },
    create({ title, description, markdown }) {
      const id = randomUUID();
      const now = new Date().toISOString();
      sql.create.run(id, title, description, markdown, now, now);
      return this.get(id);
    },
    update(id, { title, description, markdown }) {
      sql.update.run(title, description, markdown, new Date().toISOString(), id);
      return this.get(id);
    },
    remove: (id) => sql.remove.run(id).changes > 0,
    getAsset: (id) => sql.asset.get(id),
    addAsset(pageId, name, mime, content) {
      const asset = { id: randomUUID(), pageId, name, mime, size: content.length };
      transaction(() => {
        sql.upload.run(asset.id, pageId, name, mime, asset.size, content);
        sql.touch.run(new Date().toISOString(), pageId);
      });
      return asset;
    },
    removeAsset(pageId, id) {
      return transaction(() => {
        const removed = sql.removeAsset.run(pageId, id).changes > 0;
        if (removed) sql.touch.run(new Date().toISOString(), pageId);
        return removed;
      });
    },
  };
}
