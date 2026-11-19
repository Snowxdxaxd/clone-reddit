import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

// Все данные приложения живут в ./data (gitignored). DATA_DIR можно переопределить.
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

const appliedRows = (() => {
  try {
    return db.prepare('select id from _migrations').all().map((r) => r.id);
  } catch {
    return [];
  }
})();
const applied = new Set(appliedRows);

// Миграции: список {id, sql}. Применяются один раз, каждая в транзакции.
export function migrate(list) {
  db.exec(`create table if not exists _migrations (id text primary key, applied integer not null)`);
  for (const m of list) {
    if (applied.has(m.id)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('insert into _migrations(id, applied) values (?, ?)').run(m.id, Date.now());
    })();
    applied.add(m.id);
  }
}

export { uid } from './util.mjs';
