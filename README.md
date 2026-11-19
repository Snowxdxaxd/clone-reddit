# Лента — форум с комьюнити и древовидными комментариями

**▶ Live demo:** https://demo-reddit-u33o.onrender.com (free-инстанс Render: первый запрос будит сервис ~30–60 сек)


Клон Reddit / Hacker News для портфолио: комьюнити, посты трёх типов (текст, ссылка, картинка), комментарии бесконечной вложенности со сворачиванием веток, голосование и сортировки «Горячее / Лучшее / Новое».

## Запуск

Требуется Node 24.

```
npm install
npm start
```

Сервер слушает `0.0.0.0:3017` (порт переопределяется переменной `PORT`). При первом запуске пустая база наполняется демо-данными: 4 комьюнити, 12 постов, ветки комментариев и голоса пяти фоновых пользователей.

Вход — по имени без пароля (демо-режим каркаса): новое имя создаёт пользователя, существующее — входит под ним.

## Стек и структура

- Node 24, ESM, без сборки.
- `better-sqlite3` — база `data/app.db` (WAL, foreign keys, миграции с таблицей `_migrations`).
- `busboy` — разбор `multipart/form-data`, картинки до 10 МБ складываются в `data/uploads/`.
- Клиент — ванильный JS (`public/js/main.js`): рендер строками, навигация через history API, светлая тема, иконки — инлайновые SVG.

| Файл | Назначение |
| --- | --- |
| `server.js` | миграции, API, раздача статики и загрузок |
| `lib/http.mjs` | мини-роутер, JSON, куки, статика с Range |
| `lib/db.mjs` | подключение SQLite и `migrate()` |
| `lib/auth.mjs` | сессии, вход по имени |
| `lib/util.mjs` | `uid()` (12 base62-символов), общие хелперы |
| `lib/multipart.mjs` | multipart через busboy, лимит 10 МБ на файл |
| `seed.mjs` | демо-данные при первом запуске (только на пустой базе) |
| `public/` | `index.html`, стили, клиент |

## Схема данных

- `users(id, name, created)`, `sessions`.
- `communities(id, slug ^[a-z0-9_]{3,24}$, name, description, created)`, `memberships(user_id, community_id)`.
- `posts(id, community_id, user_id, type 'text'|'link'|'image', title, text, url, image_path, score, created)`.
- `comments(id — 12 символов без префикса, post_id, user_id, parent_id, path, depth, text, score, created)`. Материализованный путь: корень `/<id>/`, вложение — `parent.path + id + '/'`; `depth = сегменты − 1`. Дерево достаётся одним запросом `ORDER BY path`.
- `votes(user_id, target_type 'post'|'comment', target_id, value 1|-1, UNIQUE(user_id, target_type, target_id))`.

## API

- `POST /api/login {name}`, `POST /api/logout`, `GET /api/me`.
- `GET /api/feed?sort=hot|new|top&community=<slug|all>&q=<поиск по заголовку>` — посты + комьюнити + автор + `my_vote`.
- `GET /api/communities` — список со счётчиками и флагом `joined`; `POST /api/communities {slug, name, description}`; `POST /api/communities/:slug/join` — переключатель вступил/вышел.
- `GET /api/c/:slug` — карточка комьюнити.
- `POST /api/c/:slug/posts` — multipart: `type`, `title`, `text|url|image` (PNG/JPG/GIF/WebP до 10 МБ, проверка магических байтов).
- `GET /api/posts/:id?sort=best|new` — `{post, comments (плоско, ORDER BY path), myVotes}`; дерево строит клиент, сортируя соседей (best — по score, new — по времени).
- `POST /api/posts/:id/comments {parent_id?, text ≤ 5000}`.
- `POST /api/vote {target_type, target_id, value: 1|0|-1}` — повторное нажатие той же стрелки или `value: 0` снимает голос, иначе upsert; `score` пересчитывается в той же транзакции как `SUM(value)`. Накрутка исключена unique-ключом: один пользователь — один голос на цель.

Сортировки: `new` — по времени; `top` — по score; `hot` — `score / (часы + 2)^1.5`, считается SQL-выражением через `julianday` и `power` (если сборка SQLite без математических функций, `power` регистрируется на стороне приложения).

## Ограничения

- Вход по имени без пароля — умышленный демо-режим каркаса, не producción-авторизация.
- Картинки не ресайзятся и не проверяются на содержимое глубже магических байтов.
- Ветка комментариев отображается до глубины 8, глубже рендер идёт линейно с пометкой «продолжение ветки».
- Лимиты: заголовок 300, текст поста 20000, комментарий 5000 символов, картинка 10 МБ.