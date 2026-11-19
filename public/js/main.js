// Лента — клиент. Ванильный JS без сборки: рендер строками, навигация через history API.

const state = {
  user: null,
  sort: 'hot',
  q: '',
  commentSort: 'best',
  collapsed: new Set(),
  replyTo: null,
  tab: 'text',
  imageFile: null,
  imageUrl: null,
  communities: [],
  lastPost: null, // { post, comments, myVotes } для перерисовки страницы поста
};

/* ---------- утилиты ---------- */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ESC[ch]);

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function fmtTime(ts) {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'только что';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} ${plural(m, 'минуту', 'минуты', 'минут')} назад`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ${plural(h, 'час', 'часа', 'часов')} назад`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} ${plural(d, 'день', 'дня', 'дней')} назад`;
  return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

function domain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

const ERR_TEXT = {
  unauthorized: 'Нужен вход',
  need_name: 'Введите имя',
  bad_slug: 'Адрес: 3–24 символа — латиница, цифры, подчёркивание',
  slug_exists: 'Такой адрес уже занят',
  bad_name: 'Укажите название',
  file_too_large: 'Картинка больше 10 МБ',
  bad_image_type: 'Поддерживаются PNG, JPG, GIF и WebP',
  need_image: 'Выберите картинку',
  bad_url: 'Ссылка должна начинаться с http:// или https://',
  bad_title: 'Введите заголовок',
  bad_text: 'Введите текст поста',
  empty_text: 'Комментарий пуст',
  text_too_long: 'Максимум 5000 символов',
  bad_parent: 'Комментарий, на который вы отвечаете, не найден',
  not_found: 'Не найдено',
  need_multipart: 'Посты создаются через форму загрузки',
};
const errText = (e) => ERR_TEXT[e && e.message] || (e && e.message) || 'Ошибка';

async function api(path, opts = {}) {
  const init = { credentials: 'same-origin', ...opts };
  if (typeof init.body === 'string') init.headers = { 'content-type': 'application/json', ...(init.headers || {}) };
  const res = await fetch(path, init);
  let data = {};
  try { data = await res.json(); } catch { /* пустой ответ */ }
  if (!res.ok) throw new Error(data.error || `http_${res.status}`);
  return data;
}

const ico = {
  up: '<svg class="ico" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 3.5 13.5 11H2.5Z" fill="currentColor"/></svg>',
  down: '<svg class="ico" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 12.5 2.5 5h11Z" fill="currentColor"/></svg>',
  link: '<svg class="ico" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M6.7 9.3 9.3 6.7M7.2 4.2l1.6-1.6a2.8 2.8 0 0 1 4 4L11.2 8.2M8.8 11.8l-1.6 1.6a2.8 2.8 0 0 1-4-4L4.8 7.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
};

/* ---------- навигация ---------- */

function navigate(path, { replace = false } = {}) {
  history[replace ? 'replaceState' : 'pushState']({}, '', path);
  renderRoute();
}

function currentRoute() {
  const p = location.pathname;
  let m;
  if (p === '/' || p === '') return { name: 'feed' };
  if ((m = p.match(/^\/c\/([a-z0-9_]{3,24})\/submit$/))) return { name: 'submit', slug: m[1] };
  if ((m = p.match(/^\/c\/([a-z0-9_]{3,24})$/))) return { name: 'community', slug: m[1] };
  if ((m = p.match(/^\/post\/([a-z0-9_]+)$/))) return { name: 'post', id: m[1] };
  return { name: 'notfound' };
}

let renderSeq = 0;
async function renderRoute() {
  const seq = ++renderSeq;
  const r = currentRoute();
  const view = document.getElementById('view');
  const sidebar = document.getElementById('sidebar');
  updateHeader();
  try {
    if (r.name === 'feed') {
      sidebar.hidden = false;
      view.innerHTML = '<div class="card muted">Загрузка…</div>';
      const qs = new URLSearchParams({ sort: state.sort, community: 'all' });
      if (state.q) qs.set('q', state.q);
      const [feed, comms] = await Promise.all([api('/api/feed?' + qs), api('/api/communities')]);
      if (seq !== renderSeq) return;
      state.communities = comms.communities;
      const header = state.q ? `Результаты поиска: «${esc(state.q)}»` : null;
      view.innerHTML = feedViewHTML(feed.posts, header, state.q);
      renderSidebar(sidebar);
    } else if (r.name === 'community') {
      sidebar.hidden = false;
      view.innerHTML = '<div class="card muted">Загрузка…</div>';
      const qs = new URLSearchParams({ sort: state.sort, community: r.slug });
      if (state.q) qs.set('q', state.q);
      const [info, feed, comms] = await Promise.all([
        api('/api/c/' + r.slug), api('/api/feed?' + qs), api('/api/communities'),
      ]);
      if (seq !== renderSeq) return;
      state.communities = comms.communities;
      view.innerHTML = communityViewHTML(info.community) + feedViewHTML(feed.posts, null, state.q);
      renderSidebar(sidebar);
    } else if (r.name === 'submit') {
      sidebar.hidden = true;
      await renderSubmitView(view, r.slug);
    } else if (r.name === 'post') {
      sidebar.hidden = true;
      view.innerHTML = '<div class="card muted">Загрузка…</div>';
      const data = await api(`/api/posts/${r.id}?sort=${state.commentSort}`);
      if (seq !== renderSeq) return;
      state.collapsed = new Set();
      state.replyTo = null;
      state.lastPost = data;
      drawPostPage(view, data);
    } else {
      sidebar.hidden = true;
      view.innerHTML = '<div class="card">Страница не найдена. <a data-link href="/">На главную</a></div>';
    }
  } catch (e) {
    if (seq !== renderSeq) return;
    view.innerHTML = `<div class="card">${esc(errText(e))}. <a data-link href="/">На главную</a></div>`;
  }
}

/* ---------- шапка ---------- */

function updateHeader() {
  const area = document.getElementById('auth-area');
  if (state.user) {
    area.innerHTML = `<span class="user-chip">${esc(state.user.name)}</span><button type="button" class="btn" id="logout-btn">Выйти</button>`;
    document.getElementById('logout-btn').addEventListener('click', async () => {
      await api('/api/logout', { method: 'POST', body: '{}' }).catch(() => {});
      state.user = null;
      state.communities = [];
      updateHeader();
      renderRoute();
    });
  } else {
    area.innerHTML = `
      <form id="login-form" class="login-form">
        <input name="name" placeholder="Имя" maxlength="32" autocomplete="username">
        <button class="btn primary" type="submit">Войти</button>
      </form>`;
  }
  document.querySelectorAll('#sorts button').forEach((b) => b.classList.toggle('active', b.dataset.sort === state.sort));
}

/* ---------- лента ---------- */

function feedViewHTML(posts, header, q) {
  let list;
  if (posts.length) list = posts.map(postCard).join('');
  else if (q) list = '<div class="card muted">Ничего не найдено.</div>';
  else list = '<div class="card muted">Постов пока нет. Создайте первый.</div>';
  return `${header ? `<div class="card search-note"><span>${header}</span><a data-link href="/">сбросить</a></div>` : ''}${list}`;
}

function voteBox(type, id, score, my) {
  return `
  <div class="votebox">
    <button type="button" class="arrow ${my === 1 ? 'on-up' : ''}" data-vote="${type}" data-id="${id}" data-v="1" title="Плюс">${ico.up}</button>
    <span class="score" data-score="${type}:${id}">${score}</span>
    <button type="button" class="arrow ${my === -1 ? 'on-down' : ''}" data-vote="${type}" data-id="${id}" data-v="-1" title="Минус">${ico.down}</button>
  </div>`;
}

function postPreview(p) {
  if (p.type === 'text') {
    return p.text ? `<div class="p-preview">${esc(p.text.slice(0, 200))}${p.text.length > 200 ? '…' : ''}</div>` : '';
  }
  if (p.type === 'link') {
    return `<a class="p-domain" href="${esc(p.url)}" target="_blank" rel="noopener nofollow">${ico.link}${esc(domain(p.url))}</a>`;
  }
  return p.image_path
    ? `<a data-link class="p-thumb" href="/post/${p.id}"><img src="/uploads/${esc(p.image_path)}" alt="Картинка поста" loading="lazy"></a>`
    : '';
}

function postCard(p) {
  return `
  <article class="card post">
    ${voteBox('post', p.id, p.score, p.my_vote || 0)}
    <div class="p-main">
      <div class="meta">
        <a data-link href="/c/${p.community_slug}">${esc(p.community_name)}</a>
        <span class="sep">·</span><span>${esc(p.author_name)}</span>
        <span class="sep">·</span><span>${fmtTime(p.created)}</span>
      </div>
      <a data-link class="p-title" href="/post/${p.id}">${esc(p.title)}</a>
      ${postPreview(p)}
    </div>
  </article>`;
}

/* ---------- сайдбар ---------- */

function renderSidebar(sidebar) {
  const list = state.communities;
  const mine = state.user ? list.filter((c) => c.joined) : [];
  sidebar.innerHTML = `
    <section class="card side">
      <h3>Мои комьюнити</h3>
      ${state.user
        ? (mine.length
            ? `<div class="c-list">${mine.map((c) => `<a data-link class="c-link" href="/c/${c.slug}">${esc(c.name)}</a>`).join('')}</div>`
            : '<p class="muted">Вы пока нигде не состоите.</p>')
        : '<p class="muted">Войдите, чтобы видеть свои комьюнити.</p>'}
      ${state.user ? '<button type="button" class="btn" data-action="new-community">Создать комьюнити</button>' : ''}
    </section>
    <section class="card side">
      <h3>Популярные</h3>
      <div class="c-list">
        ${list.map((c) => `
          <div class="c-row">
            <a data-link href="/c/${c.slug}">${esc(c.name)}</a>
            <span class="muted small">${c.members}</span>
            ${state.user ? `<button type="button" class="btn small" data-join="${c.slug}">${c.joined ? 'Выйти' : 'Вступить'}</button>` : ''}
          </div>`).join('')}
      </div>
    </section>`;
}

/* ---------- страница комьюнити ---------- */

function communityViewHTML(c) {
  return `
  <section class="card community-head">
    <div>
      <h2>${esc(c.name)}</h2>
      <p class="ch-desc">${esc(c.description)}</p>
      <p class="muted small">${c.members} ${plural(c.members, 'участник', 'участника', 'участников')} · ${c.posts} ${plural(c.posts, 'пост', 'поста', 'постов')}</p>
    </div>
    <div class="ch-actions">
      ${state.user
        ? `<button type="button" class="btn" data-join="${c.slug}">${c.joined ? 'Выйти' : 'Вступить'}</button>
           <a data-link class="btn primary" href="/c/${c.slug}/submit">Создать пост</a>`
        : ''}
    </div>
  </section>`;
}

/* ---------- создание поста ---------- */

async function renderSubmitView(view, slug) {
  if (!state.user) {
    view.innerHTML = `<section class="card"><h2>Создать пост</h2><p class="muted">Войдите, чтобы публиковать посты.</p></section>`;
    return;
  }
  const { communities } = await api('/api/communities');
  if (!communities.length) {
    view.innerHTML = '<section class="card">Сначала создайте комьюнити в сайдбаре на главной.</section>';
    return;
  }
  const selected = communities.some((c) => c.slug === slug) ? slug : communities[0].slug;
  view.innerHTML = `
  <section class="card">
    <h2>Создать пост</h2>
    <form id="submit-post">
      <label for="sp-community">Комьюнити</label>
      <select id="sp-community">
        ${communities.map((c) => `<option value="${c.slug}" ${c.slug === selected ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
      </select>
      <label for="sp-title">Заголовок</label>
      <input id="sp-title" maxlength="300" placeholder="О чём пост">
      <div class="tabs" id="sp-tabs">
        <button type="button" data-tab="text" class="${state.tab === 'text' ? 'active' : ''}">Текст</button>
        <button type="button" data-tab="link" class="${state.tab === 'link' ? 'active' : ''}">Ссылка</button>
        <button type="button" data-tab="image" class="${state.tab === 'image' ? 'active' : ''}">Картинка</button>
      </div>
      <div id="sp-body"></div>
      <div class="err" id="sp-err"></div>
      <div class="row-end"><button class="btn primary" type="submit">Опубликовать</button></div>
    </form>
  </section>`;
  renderTabBody();
}

function renderTabBody() {
  const body = document.getElementById('sp-body');
  if (!body) return;
  const t = state.tab;
  document.querySelectorAll('#sp-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  if (t === 'text') body.innerHTML = '<textarea id="sp-text" rows="8" placeholder="Текст поста"></textarea>';
  else if (t === 'link') body.innerHTML = '<input id="sp-url" placeholder="https://…">';
  else {
    body.innerHTML = `
      <input id="sp-image" type="file" accept="image/png,image/jpeg,image/gif,image/webp">
      <p class="muted small">PNG, JPG, GIF или WebP, до 10 МБ</p>
      <div id="sp-image-preview"></div>`;
  }
}

/* ---------- страница поста и комментарии ---------- */

function buildTree(comments, sort) {
  const byId = new Map(comments.map((c) => [c.id, { ...c, children: [] }]));
  const roots = [];
  for (const c of comments) {
    const node = byId.get(c.id);
    if (c.parent_id && byId.has(c.parent_id)) byId.get(c.parent_id).children.push(node);
    else roots.push(node);
  }
  const cmp = sort === 'new'
    ? (a, b) => b.created - a.created
    : (a, b) => (b.score - a.score) || (b.created - a.created);
  const sortRec = (nodes) => { nodes.sort(cmp); nodes.forEach((n) => sortRec(n.children)); };
  sortRec(roots);
  return roots;
}

function commentHTML(c, postId, myVotes) {
  const my = myVotes['comment:' + c.id] || 0;
  const collapsed = state.collapsed.has(c.id);
  const deep = c.depth > 8;
  return `
  <div class="comment">
    <div class="c-head">
      <button type="button" class="collapse" data-collapse="${c.id}" title="${collapsed ? 'Развернуть ветку' : 'Свернуть ветку'}">${collapsed ? '[+]' : '[−]'}</button>
      <span class="c-author">${esc(c.author_name)}</span>
      <span class="c-votes">
        <button type="button" class="mini ${my === 1 ? 'on-up' : ''}" data-vote="comment" data-id="${c.id}" data-v="1" title="Плюс">${ico.up}</button>
        <span class="score" data-score="comment:${c.id}">${c.score}</span>
        <button type="button" class="mini ${my === -1 ? 'on-down' : ''}" data-vote="comment" data-id="${c.id}" data-v="-1" title="Минус">${ico.down}</button>
      </span>
      <span class="muted small">${fmtTime(c.created)}</span>
      ${deep ? '<span class="deep-note">продолжение ветки</span>' : ''}
    </div>
    ${collapsed
      ? '<div class="collapsed-hint muted small">ветка свёрнута</div>'
      : `
      <div class="c-body">${esc(c.text).replace(/\n/g, '<br>')}</div>
      <div class="c-actions"><button type="button" class="linklike" data-reply="${c.id}">Ответить</button></div>
      ${state.replyTo === c.id ? replyFormHTML(postId, c.id) : ''}
      ${c.children.length ? `<div class="children${c.depth >= 8 ? ' flat' : ''}">${c.children.map((ch) => commentHTML(ch, postId, myVotes)).join('')}</div>` : ''}
    `}
  </div>`;
}

function replyFormHTML(postId, parentId) {
  return `
  <form class="reply-form" data-post="${postId}" data-parent="${parentId}">
    <textarea name="text" rows="3" maxlength="5000" placeholder="Ваш ответ"></textarea>
    <div class="row-end">
      <button class="btn primary" type="submit">Ответить</button>
      <button class="btn" type="button" data-cancel-reply>Отмена</button>
    </div>
  </form>`;
}

function drawPostPage(view, data) {
  const { post, comments, myVotes } = data;
  const tree = buildTree(comments, state.commentSort);
  view.innerHTML = `
    <article class="card post-full">
      ${voteBox('post', post.id, post.score, myVotes['post:' + post.id] || 0)}
      <div class="pf-main">
        <div class="meta">
          <a data-link href="/c/${post.community_slug}">${esc(post.community_name)}</a>
          <span class="sep">·</span><span>${esc(post.author_name)}</span>
          <span class="sep">·</span><span>${fmtTime(post.created)}</span>
        </div>
        <h2 class="pf-title">${esc(post.title)}</h2>
        ${post.type === 'text' ? `<div class="pf-text">${esc(post.text).replace(/\n/g, '<br>')}</div>` : ''}
        ${post.type === 'link' ? `<a class="p-domain" href="${esc(post.url)}" target="_blank" rel="noopener nofollow">${ico.link}${esc(domain(post.url))}</a>` : ''}
        ${post.type === 'image' && post.image_path ? `<img class="pf-image" src="/uploads/${esc(post.image_path)}" alt="Картинка поста">` : ''}
      </div>
    </article>
    <section class="card comments-card">
      <div class="c-top">
        <h3>Комментарии <span class="muted">(${comments.length})</span></h3>
        <div class="csort">
          <button type="button" data-csort="best" class="${state.commentSort === 'best' ? 'active' : ''}">Лучшие</button>
          <button type="button" data-csort="new" class="${state.commentSort === 'new' ? 'active' : ''}">Новые</button>
        </div>
      </div>
      ${state.user
        ? `<form id="composer" data-post="${post.id}">
             <textarea name="text" rows="4" maxlength="5000" placeholder="Ваш комментарий"></textarea>
             <div class="row-end"><button class="btn primary" type="submit">Отправить</button></div>
           </form>`
        : '<p class="muted">Войдите, чтобы комментировать и голосовать.</p>'}
      <div id="comments">
        ${tree.length ? tree.map((c) => commentHTML(c, post.id, myVotes)).join('') : '<p class="muted">Пока нет комментариев.</p>'}
      </div>
    </section>`;
}

function redrawComments() {
  const el = document.getElementById('comments');
  const d = state.lastPost;
  if (!el || !d) return;
  const tree = buildTree(d.comments, state.commentSort);
  el.innerHTML = tree.length
    ? tree.map((c) => commentHTML(c, d.post.id, d.myVotes)).join('')
    : '<p class="muted">Пока нет комментариев.</p>';
}

async function refreshPost(postId) {
  const data = await api(`/api/posts/${postId}?sort=${state.commentSort}`);
  state.lastPost = data;
  drawPostPage(document.getElementById('view'), data);
}

/* ---------- модальное окно комьюнити ---------- */

function openCommunityModal() {
  document.getElementById('modal-root').innerHTML = `
  <div class="overlay" data-action="close-overlay">
    <div class="modal">
      <h3>Создать комьюнити</h3>
      <form id="community-modal-form">
        <label for="mc-slug">Адрес</label>
        <input id="mc-slug" placeholder="moy_klub" maxlength="24" autocomplete="off">
        <p class="muted small">3–24 символа: латиница в нижнем регистре, цифры, подчёркивание. Потом не меняется.</p>
        <label for="mc-name">Название</label>
        <input id="mc-name" maxlength="64" placeholder="Мой клуб">
        <label for="mc-desc">Описание</label>
        <textarea id="mc-desc" rows="3" maxlength="500" placeholder="О чём это комьюнити"></textarea>
        <div class="err" id="mc-err"></div>
        <div class="row-end">
          <button class="btn primary" type="submit">Создать</button>
          <button class="btn" type="button" data-action="close-modal">Отмена</button>
        </div>
      </form>
    </div>
  </div>`;
  document.getElementById('mc-slug').focus();
}

function closeModal() {
  document.getElementById('modal-root').innerHTML = '';
}

/* ---------- обработчики ---------- */

async function onVote(btn) {
  if (!state.user) return toast('Войдите, чтобы голосовать');
  const type = btn.dataset.vote, id = btn.dataset.id, v = Number(btn.dataset.v);
  try {
    const r = await api('/api/vote', { method: 'POST', body: JSON.stringify({ target_type: type, target_id: id, value: v }) });
    const scoreEl = document.querySelector(`[data-score="${type}:${id}"]`);
    if (scoreEl) scoreEl.textContent = r.score;
    const box = btn.closest('.votebox') || btn.closest('.c-votes');
    if (box) {
      box.querySelectorAll('[data-vote]').forEach((b) => {
        const val = Number(b.dataset.v);
        b.classList.toggle('on-up', r.my_vote === 1 && val === 1);
        b.classList.toggle('on-down', r.my_vote === -1 && val === -1);
      });
    }
    if (state.lastPost) {
      state.lastPost.myVotes[`${type}:${id}`] = r.my_vote;
      if (type === 'post' && state.lastPost.post.id === id) state.lastPost.post.score = r.score;
      else {
        const c = state.lastPost.comments.find((x) => x.id === id);
        if (c) c.score = r.score;
      }
    }
  } catch (e) { toast(errText(e)); }
}

async function onJoin(slug) {
  if (!state.user) return toast('Войдите, чтобы вступать в комьюнити');
  try {
    await api(`/api/communities/${slug}/join`, { method: 'POST', body: '{}' });
    renderRoute();
  } catch (e) { toast(errText(e)); }
}

document.addEventListener('click', (e) => {
  const link = e.target.closest('a[data-link]');
  if (link && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    return navigate(link.getAttribute('href'));
  }
  const t = e.target.closest('[data-vote],[data-collapse],[data-reply],[data-cancel-reply],[data-join],[data-tab],[data-csort],[data-action]');
  if (!t) return;
  if (t.dataset.vote !== undefined) return void onVote(t);
  if (t.dataset.collapse !== undefined) {
    const id = t.dataset.collapse;
    if (state.collapsed.has(id)) state.collapsed.delete(id); else state.collapsed.add(id);
    return redrawComments();
  }
  if (t.dataset.reply !== undefined) {
    state.replyTo = t.dataset.reply;
    redrawComments();
    const ta = document.querySelector(`.reply-form[data-parent="${state.replyTo}"] textarea`);
    if (ta) ta.focus();
    return;
  }
  if (t.dataset.cancelReply !== undefined) { state.replyTo = null; return redrawComments(); }
  if (t.dataset.join) return void onJoin(t.dataset.join);
  if (t.dataset.tab) { state.tab = t.dataset.tab; return renderTabBody(); }
  if (t.dataset.csort) {
    state.commentSort = t.dataset.csort;
    if (state.lastPost) refreshPost(state.lastPost.post.id).catch((er) => toast(errText(er)));
    return;
  }
  const action = t.dataset.action;
  if (action === 'new-community') return openCommunityModal();
  if (action === 'close-modal') return closeModal();
  if (action === 'close-overlay' && t === e.target) return closeModal();
});

document.addEventListener('submit', async (e) => {
  const f = e.target;
  if (!f.matches('#login-form, #search-form, #composer, .reply-form, #submit-post, #community-modal-form')) return;
  e.preventDefault();
  try {
    if (f.id === 'login-form') {
      const name = f.querySelector('input').value.trim();
      if (!name) return toast('Введите имя');
      const { user } = await api('/api/login', { method: 'POST', body: JSON.stringify({ name }) });
      state.user = user;
      updateHeader();
      renderRoute();
    } else if (f.id === 'search-form') {
      state.q = f.querySelector('input').value.trim();
      navigate('/');
    } else if (f.id === 'composer') {
      const ta = f.querySelector('textarea');
      const text = ta.value.trim();
      if (!text) return toast('Комментарий пуст');
      await api(`/api/posts/${f.dataset.post}/comments`, { method: 'POST', body: JSON.stringify({ text }) });
      await refreshPost(f.dataset.post);
    } else if (f.classList.contains('reply-form')) {
      const ta = f.querySelector('textarea');
      const text = ta.value.trim();
      if (!text) return toast('Комментарий пуст');
      const postId = f.dataset.post, parentId = f.dataset.parent;
      state.replyTo = null;
      await api(`/api/posts/${postId}/comments`, { method: 'POST', body: JSON.stringify({ parent_id: parentId, text }) });
      await refreshPost(postId);
    } else if (f.id === 'submit-post') {
      const errEl = document.getElementById('sp-err');
      errEl.textContent = '';
      const title = document.getElementById('sp-title').value.trim();
      if (!title) { errEl.textContent = 'Введите заголовок'; return; }
      const communitySlug = document.getElementById('sp-community').value;
      const fd = new FormData();
      fd.append('type', state.tab);
      fd.append('title', title);
      if (state.tab === 'text') {
        const text = document.getElementById('sp-text').value.trim();
        if (!text) { errEl.textContent = 'Введите текст поста'; return; }
        fd.append('text', text);
      } else if (state.tab === 'link') {
        const url = document.getElementById('sp-url').value.trim();
        if (!/^https?:\/\/\S+$/i.test(url)) { errEl.textContent = ERR_TEXT.bad_url; return; }
        fd.append('url', url);
      } else {
        if (!state.imageFile) { errEl.textContent = 'Выберите картинку'; return; }
        fd.append('image', state.imageFile);
      }
      const btn = f.querySelector('button[type=submit]');
      btn.disabled = true;
      const { post } = await api(`/api/c/${communitySlug}/posts`, { method: 'POST', body: fd });
      state.imageFile = null;
      state.tab = 'text';
      navigate('/post/' + post.id);
    } else if (f.id === 'community-modal-form') {
      const errEl = document.getElementById('mc-err');
      errEl.textContent = '';
      const slug = document.getElementById('mc-slug').value.trim();
      const name = document.getElementById('mc-name').value.trim();
      const description = document.getElementById('mc-desc').value.trim();
      if (!/^[a-z0-9_]{3,24}$/.test(slug)) { errEl.textContent = ERR_TEXT.bad_slug; return; }
      if (!name) { errEl.textContent = ERR_TEXT.bad_name; return; }
      const { community } = await api('/api/communities', { method: 'POST', body: JSON.stringify({ slug, name, description }) });
      closeModal();
      toast(`Комьюнити «${name}» создано`);
      navigate('/c/' + community.slug);
    }
  } catch (err) { toast(errText(err)); }
});

document.addEventListener('change', (e) => {
  if (e.target.id !== 'sp-image') return;
  const file = e.target.files[0];
  const prev = document.getElementById('sp-image-preview');
  state.imageFile = null;
  if (state.imageUrl) { URL.revokeObjectURL(state.imageUrl); state.imageUrl = null; }
  if (!file) { if (prev) prev.innerHTML = ''; return; }
  if (file.size > 10 * 1024 * 1024) { if (prev) prev.innerHTML = ''; return toast(ERR_TEXT.file_too_large); }
  if (!file.type.startsWith('image/')) { if (prev) prev.innerHTML = ''; return toast(ERR_TEXT.bad_image_type); }
  state.imageFile = file;
  state.imageUrl = URL.createObjectURL(file);
  if (prev) prev.innerHTML = `<img class="upload-preview" alt="Предпросмотр" src="${state.imageUrl}">`;
});

document.getElementById('sorts').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-sort]');
  if (!b || b.dataset.sort === state.sort) return;
  state.sort = b.dataset.sort;
  navigate('/');
});

window.addEventListener('popstate', renderRoute);

/* ---------- старт ---------- */

(async function boot() {
  try { state.user = (await api('/api/me')).user; } catch { state.user = null; }
  updateHeader();
  renderRoute();
})();
