// Простая сессионная авторизация «по имени» (демо-режим для публичных ссылок).
// Ожидается таблица users(id text primary key, name text, created integer).
import { uid } from './util.mjs';
import { setCookie } from './http.mjs';

export function ensureAuthTables(db) {
  db.exec(`
    create table if not exists sessions (
      token text primary key,
      user_id text not null references users(id),
      created integer not null
    );
  `);
}

// Вход/регистрация: если имя новое — создаём пользователя, иначе логинимся под ним.
export function loginByName(db, res, name) {
  name = String(name || '').trim().slice(0, 32);
  if (!name) return null;
  let user = db.prepare('select * from users where lower(name) = lower(?)').get(name);
  if (!user) {
    const id = uid('u_');
    db.prepare('insert into users(id, name, created) values (?, ?, ?)').run(id, name, Date.now());
    user = db.prepare('select * from users where id = ?').get(id);
  }
  const token = uid('s_');
  db.prepare('insert into sessions(token, user_id, created) values (?, ?, ?)').run(token, user.id, Date.now());
  setCookie(res, 'sid', token, { maxAge: 60 * 60 * 24 * 30 });
  return user;
}

export function logout(db, ctx) {
  const token = ctx.cookies.sid;
  if (token) db.prepare('delete from sessions where token = ?').run(token);
  setCookie(ctx.res, 'sid', '', { maxAge: 0 });
}

export function currentUser(db, ctx) {
  const token = ctx.cookies.sid;
  if (!token) return null;
  const s = db.prepare('select user_id from sessions where token = ?').get(token);
  if (!s) return null;
  return db.prepare('select * from users where id = ?').get(s.user_id) || null;
}

// Мидлварь-хелпер: вернуть user или ответить 401 и вернуть null
export function requireUser(db, ctx) {
  const user = currentUser(db, ctx);
  if (!user) {
    import('./http.mjs').then(({ unauthorized }) => unauthorized(ctx.res));
    return null;
  }
  return user;
}
