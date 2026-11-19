// Лента — форум с комьюнити, постами (текст/ссылка/картинка) и древовидными комментариями.
// Каркас: lib/http.mjs (роутер и статика), lib/db.mjs (SQLite), lib/auth.mjs (вход по имени).
import fs from 'node:fs';
import path from 'node:path';
import { createApp, json, bytes, badRequest, notFound, unauthorized } from './lib/http.mjs';
import { migrate, db, uid } from './lib/db.mjs';
import { ensureAuthTables, loginByName, currentUser, logout } from './lib/auth.mjs';
import { parseMultipart, MAX_IMAGE_BYTES } from './lib/multipart.mjs';
import { seedIfEmpty } from './seed.mjs';

const UPLOAD_DIR = path.join(process.cwd(), 'data', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

migrate([
  {
    id: '001-lenta',
    sql: `
      create table if not exists users (
        id text primary key,
        name text not null,
        created integer not null
      );
      create table if not exists communities (
        id text primary key,
        slug text not null unique,
        name text not null,
        description text not null default '',
        created integer not null
      );
      create table if not exists memberships (
        user_id text not null references users(id),
        community_id text not null references communities(id),
        primary key (user_id, community_id)
      );
      create table if not exists posts (
        id text primary key,
        community_id text not null references communities(id),
        user_id text not null references users(id),
        type text not null check (type in ('text','link','image')),
        title text not null,
        text text not null default '',
        url text not null default '',
        image_path text not null default '',
        score integer not null default 0,
        created integer not null
      );
      create index if not exists idx_posts_comm on posts(community_id, created);
      create table if not exists comments (
        id text primary key,
        post_id text not null references posts(id) on delete cascade,
        user_id text not null references users(id),
        parent_id text references comments(id),
        path text not null,
        depth integer not null,
        text text not null,
        score integer not null default 0,
        created integer not null
      );
      create index if not exists idx_comments_post on comments(post_id, path);
      create index if not exists idx_comments_parent on comments(parent_id);
      create table if not exists votes (
        user_id text not null references users(id),
        target_type text not null check (target_type in ('post','comment')),
        target_id text not null,
        value integer not null check (value in (1, -1)),
        created integer not null,
        unique (user_id, target_type, target_id)
      );
      create index if not exists idx_votes_target on votes(target_type, target_id);
    `,
  },
]);
ensureAuthTables(db);
seedIfEmpty();

// power() из математических функций SQLite; на случай сборки без них — своя функция с тем же именем.
try { db.prepare('select power(2, 3)').get(); } catch { db.function('power', (b, e) => Math.pow(b, e)); }

const SLUG_RE = /^[a-z0-9_]{3,24}$/;
// Рейтинг «Горячее»: score / (часы + 2)^1.5, целиком в SQL.
const HOT_RANK = `(p.score + 0) * 1.0 / power(((julianday('now') - julianday(p.created / 1000.0, 'unixepoch')) * 24 + 2), 1.5)`;

const POST_FIELDS = `
  p.id, p.type, p.title, p.text, p.url, p.image_path, p.score, p.created,
  c.slug as community_slug, c.name as community_name, u.name as author_name,
  (select v.value from votes v where v.target_type = 'post' and v.target_id = p.id and v.user_id = @uid) as my_vote
`;

const app = createApp({ publicDir: 'public', spa: true });

// Возвращает пользователя или отвечает 401 и возвращает null.
function auth(ctx) {
  const user = currentUser(db, ctx);
  if (!user) unauthorized(ctx.res);
  return user;
}

const bySlug = (slug) => db.prepare('select * from communities where slug = ?').get(slug);

/* ---------- вход ---------- */

app.post('/api/login', (ctx) => {
  const user = loginByName(db, ctx.res, ctx.body.name);
  if (!user) return json(ctx.res, 400, { error: 'need_name' });
  json(ctx.res, 200, { user: { id: user.id, name: user.name, created: user.created } });
});

app.post('/api/logout', (ctx) => {
  logout(db, ctx);
  json(ctx.res, 200, { ok: true });
});

app.get('/api/me', (ctx) => {
  const user = currentUser(db, ctx);
  json(ctx.res, 200, { user: user ? { id: user.id, name: user.name, created: user.created } : null });
});

/* ---------- лента ---------- */

app.get('/api/feed', (ctx) => {
  const user = currentUser(db, ctx);
  const sort = ['hot', 'new', 'top'].includes(ctx.query.get('sort')) ? ctx.query.get('sort') : 'hot';
  const community = ctx.query.get('community') || 'all';
  const q = (ctx.query.get('q') || '').trim().slice(0, 100);

  const where = [];
  const params = { uid: user ? user.id : '' };
  if (community !== 'all') { where.push('c.slug = @slug'); params.slug = community; }
  if (q) { where.push('p.title like @q'); params.q = '%' + q.replace(/[%_'"\\]/g, '') + '%'; }

  const order = sort === 'new'
    ? 'p.created desc'
    : sort === 'top'
      ? 'p.score desc, p.created desc'
      : `${HOT_RANK} desc, p.created desc`;

  const sql = `
    select ${POST_FIELDS}
    from posts p
    join communities c on c.id = p.community_id
    join users u on u.id = p.user_id
    ${where.length ? 'where ' + where.join(' and ') : ''}
    order by ${order}
    limit 100`;
  json(ctx.res, 200, { posts: db.prepare(sql).all(params), sort });
});

/* ---------- комьюнити ---------- */

app.get('/api/communities', (ctx) => {
  const user = currentUser(db, ctx);
  const rows = db.prepare(`
    select c.*,
      (select count(*) from memberships m where m.community_id = c.id) as members,
      (select count(*) from posts p where p.community_id = c.id) as posts
    from communities c
    order by posts desc, members desc, c.created asc`).all();
  const joined = new Set(
    user ? db.prepare('select community_id from memberships where user_id = ?').all(user.id).map((r) => r.community_id) : []
  );
  json(ctx.res, 200, { communities: rows.map((r) => ({ ...r, joined: joined.has(r.id) })) });
});

app.post('/api/communities', (ctx) => {
  const user = auth(ctx); if (!user) return;
  const slug = String(ctx.body.slug || '').trim();
  const name = String(ctx.body.name || '').trim();
  const description = String(ctx.body.description || '').trim().slice(0, 500);
  if (!SLUG_RE.test(slug)) return badRequest(ctx.res, 'bad_slug');
  if (!name || name.length > 64) return badRequest(ctx.res, 'bad_name');
  if (bySlug(slug)) return badRequest(ctx.res, 'slug_exists');
  const id = uid('c_');
  db.transaction(() => {
    db.prepare('insert into communities(id, slug, name, description, created) values (?, ?, ?, ?, ?)')
      .run(id, slug, name, description, Date.now());
    db.prepare('insert into memberships(user_id, community_id) values (?, ?)').run(user.id, id);
  })();
  json(ctx.res, 200, { community: db.prepare('select * from communities where id = ?').get(id) });
});

app.get('/api/c/:slug', (ctx) => {
  const c = bySlug(ctx.params.slug);
  if (!c) return notFound(ctx.res);
  const user = currentUser(db, ctx);
  const members = db.prepare('select count(*) n from memberships where community_id = ?').get(c.id).n;
  const posts = db.prepare('select count(*) n from posts where community_id = ?').get(c.id).n;
  const joined = user ? !!db.prepare('select 1 from memberships where user_id = ? and community_id = ?').get(user.id, c.id) : false;
  json(ctx.res, 200, { community: { ...c, members, posts, joined } });
});

app.post('/api/communities/:slug/join', (ctx) => {
  const user = auth(ctx); if (!user) return;
  const c = bySlug(ctx.params.slug);
  if (!c) return notFound(ctx.res);
  const exists = db.prepare('select 1 from memberships where user_id = ? and community_id = ?').get(user.id, c.id);
  if (exists) db.prepare('delete from memberships where user_id = ? and community_id = ?').run(user.id, c.id);
  else db.prepare('insert into memberships(user_id, community_id) values (?, ?)').run(user.id, c.id);
  json(ctx.res, 200, { joined: !exists });
});

/* ---------- посты ---------- */

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const MIME_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };

// Проверка магических байтов: файл должен быть настоящей картинкой, а не переименованным текстом.
function sniffImage(buf) {
  if (buf.length < 12) return false;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true; // PNG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true; // JPEG
  if (buf.subarray(0, 4).toString('ascii') === 'GIF8') return true; // GIF
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return true; // WebP
  return false;
}

app.post('/api/c/:slug/posts', async (ctx) => {
  const user = auth(ctx); if (!user) return;
  const community = bySlug(ctx.params.slug);
  if (!community) return notFound(ctx.res);
  const ct = ctx.req.headers['content-type'] || '';
  if (!ct.includes('multipart/form-data')) return badRequest(ctx.res, 'need_multipart');

  let mp;
  try { mp = await parseMultipart(ctx.req, ctx.raw); }
  catch (e) { return badRequest(ctx.res, 'bad_multipart'); }
  const { fields, files } = mp;

  const type = fields.type;
  if (!['text', 'link', 'image'].includes(type)) return badRequest(ctx.res, 'bad_type');
  const title = String(fields.title || '').trim();
  if (!title || title.length > 300) return badRequest(ctx.res, 'bad_title');

  let text = '', url = '', imagePath = '';
  if (type === 'text') {
    text = String(fields.text || '').trim();
    if (!text || text.length > 20000) return badRequest(ctx.res, 'bad_text');
  } else if (type === 'link') {
    url = String(fields.url || '').trim();
    if (!/^https?:\/\/\S{1,2000}$/i.test(url)) return badRequest(ctx.res, 'bad_url');
  } else {
    const file = files.find((f) => f.buffer && f.buffer.length);
    if (!file) return badRequest(ctx.res, 'need_image');
    if (file.truncated || file.size > MAX_IMAGE_BYTES) return badRequest(ctx.res, 'file_too_large');
    let ext = path.extname(file.filename || '').toLowerCase();
    if (!IMAGE_EXT.has(ext)) ext = MIME_EXT[file.mimeType] || '';
    if (!IMAGE_EXT.has(ext) && !MIME_EXT[file.mimeType]) return badRequest(ctx.res, 'bad_image_type');
    if (!sniffImage(file.buffer)) return badRequest(ctx.res, 'bad_image_type');
    if (ext === '.jpeg') ext = '.jpg';
    imagePath = uid('') + ext;
    fs.writeFileSync(path.join(UPLOAD_DIR, imagePath), file.buffer);
  }

  const id = uid('p_');
  db.prepare('insert into posts(id, community_id, user_id, type, title, text, url, image_path, score, created) values (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)')
    .run(id, community.id, user.id, type, title, text, url, imagePath, Date.now());
  json(ctx.res, 200, { post: { id } });
});

app.get('/api/posts/:id', (ctx) => {
  const user = currentUser(db, ctx);
  const post = db.prepare(`
    select ${POST_FIELDS}
    from posts p
    join communities c on c.id = p.community_id
    join users u on u.id = p.user_id
    where p.id = @id`).get({ uid: user ? user.id : '', id: ctx.params.id });
  if (!post) return notFound(ctx.res);

  // Дерево отдаётся одним запросом, упорядоченным по path; клиент строит структуру
  // и сортирует соседей (best — по score, new — по времени).
  const comments = db.prepare(`
    select c.id, c.parent_id, c.path, c.depth, c.text, c.score, c.created, u.name as author_name
    from comments c
    join users u on u.id = c.user_id
    where c.post_id = ?
    order by c.path`).all(post.id);

  const myVotes = {};
  if (user) {
    const rows = db.prepare(`
      select target_type, target_id, value from votes
      where user_id = ? and (
        (target_type = 'post' and target_id = ?) or
        (target_type = 'comment' and target_id in (select id from comments where post_id = ?))
      )`).all(user.id, post.id, post.id);
    for (const r of rows) myVotes[`${r.target_type}:${r.target_id}`] = r.value;
  }
  json(ctx.res, 200, { post, comments, myVotes });
});

app.post('/api/posts/:id/comments', (ctx) => {
  const user = auth(ctx); if (!user) return;
  const post = db.prepare('select id from posts where id = ?').get(ctx.params.id);
  if (!post) return notFound(ctx.res);
  const text = String(ctx.body.text || '').trim();
  if (!text) return badRequest(ctx.res, 'empty_text');
  if (text.length > 5000) return badRequest(ctx.res, 'text_too_long');

  let parent = null;
  if (ctx.body.parent_id) {
    parent = db.prepare('select * from comments where id = ?').get(String(ctx.body.parent_id));
    if (!parent || parent.post_id !== post.id) return badRequest(ctx.res, 'bad_parent');
  }

  const id = uid(''); // фиксированные 12 символов, без префикса
  const pathStr = parent ? parent.path + id + '/' : '/' + id + '/';
  const depth = parent ? parent.depth + 1 : 0;
  db.prepare('insert into comments(id, post_id, user_id, parent_id, path, depth, text, score, created) values (?, ?, ?, ?, ?, ?, ?, 0, ?)')
    .run(id, post.id, user.id, parent ? parent.id : null, pathStr, depth, text, Date.now());
  json(ctx.res, 200, { comment: db.prepare('select id, parent_id, path, depth, created from comments where id = ?').get(id) });
});

/* ---------- голосование ---------- */

app.post('/api/vote', (ctx) => {
  const user = auth(ctx); if (!user) return;
  const { target_type, target_id } = ctx.body;
  const value = Number(ctx.body.value);
  if (!['post', 'comment'].includes(target_type)) return badRequest(ctx.res, 'bad_target_type');
  if (![1, 0, -1].includes(value)) return badRequest(ctx.res, 'bad_value');
  const table = target_type === 'post' ? 'posts' : 'comments';
  if (!db.prepare(`select id from ${table} where id = ?`).get(target_id)) return notFound(ctx.res);

  const score = db.transaction(() => {
    const cur = db.prepare('select value from votes where user_id = ? and target_type = ? and target_id = ?')
      .get(user.id, target_type, target_id);
    if (value === 0 || (cur && cur.value === value)) {
      // повторное нажатие той же стрелки (или явный 0) — снять голос
      db.prepare('delete from votes where user_id = ? and target_type = ? and target_id = ?')
        .run(user.id, target_type, target_id);
    } else {
      db.prepare(`
        insert into votes(user_id, target_type, target_id, value, created) values (?, ?, ?, ?, ?)
        on conflict(user_id, target_type, target_id) do update set value = excluded.value, created = excluded.created`)
        .run(user.id, target_type, target_id, value, Date.now());
    }
    const s = db.prepare('select coalesce(sum(value), 0) s from votes where target_type = ? and target_id = ?')
      .get(target_type, target_id).s;
    db.prepare(`update ${table} set score = ? where id = ?`).run(s, target_id);
    return s;
  })();

  const my = db.prepare('select value from votes where user_id = ? and target_type = ? and target_id = ?')
    .get(user.id, target_type, target_id);
  json(ctx.res, 200, { target_type, target_id, score, my_vote: my ? my.value : 0 });
});

/* ---------- картинки ---------- */

const UPLOAD_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

app.get('/uploads/:name', (ctx) => {
  const name = ctx.params.name;
  if (!/^[a-z0-9]{12}\.(png|jpg|gif|webp)$/.test(name)) return notFound(ctx.res);
  let buf;
  try { buf = fs.readFileSync(path.join(UPLOAD_DIR, name)); } catch { return notFound(ctx.res); }
  bytes(ctx.res, 200, buf, UPLOAD_MIME[path.extname(name)] || 'application/octet-stream', { 'Cache-Control': 'public, max-age=86400' });
});

const PORT = process.env.PORT || 3017;
app.listen(PORT, () => {});
