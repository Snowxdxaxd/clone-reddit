// Демо-данные при первом запуске: комьюнити, посты трёх типов, ветки комментариев
// глубиной до 4 уровней и голоса пяти фоновых пользователей. Работает только на пустой базе.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { db, uid } from './lib/db.mjs';

const UPLOAD_DIR = path.join(process.cwd(), 'data', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// --- минимальный генератор PNG (диагональный градиент из двух цветов), без внешних зависимостей ---
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function makePng(w, h, [r1, g1, b1], [r2, g2, b2]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8 бит, truecolor RGB
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) {
      const m = (x / (w - 1) + y / (h - 1)) / 2;
      row[1 + x * 3] = Math.round(r1 + (r2 - r1) * m);
      row[2 + x * 3] = Math.round(g1 + (g2 - g1) * m);
      row[3 + x * 3] = Math.round(b1 + (b2 - b1) * m);
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export function seedIfEmpty() {
  if (db.prepare('select count(*) n from users').get().n > 0) return;

  const nowMs = Date.now();
  const HOUR = 3600 * 1000;
  const MIN = 60 * 1000;

  const run = db.transaction(() => {
    // Фоновые пользователи — от их имени созданы посты, комментарии и голоса.
    const users = {};
    for (const name of ['Алексей', 'Мария', 'Дмитрий', 'Ольга', 'Сергей']) {
      const id = uid('u_');
      db.prepare('insert into users(id, name, created) values (?, ?, ?)').run(id, name, nowMs - 45 * 24 * HOUR);
      users[name] = id;
    }

    const communities = {};
    const comDefs = [
      ['oren_dev', 'Разработка', 'Всё о разработке ПО: стек, опыт, вакансии и пет-проекты.'],
      ['kotiki', 'Котики', 'Фото, истории и вопросы про котов.'],
      ['kuhnya', 'Кулинария', 'Рецепты, споры о еде и советы с кухни.'],
      ['auto', 'Автомобили', 'Выбор, ремонт и всё про машины.'],
    ];
    for (const [slug, name, description] of comDefs) {
      const id = uid('c_');
      db.prepare('insert into communities(id, slug, name, description, created) values (?, ?, ?, ?, ?)')
        .run(id, slug, name, description, nowMs - 60 * 24 * HOUR);
      communities[slug] = id;
    }

    const joins = [
      ['Алексей', ['oren_dev', 'kotiki']],
      ['Мария', ['kotiki', 'kuhnya']],
      ['Дмитрий', ['oren_dev', 'auto']],
      ['Ольга', ['kotiki', 'kuhnya', 'oren_dev']],
      ['Сергей', ['oren_dev', 'auto', 'kotiki']],
    ];
    for (const [name, slugs] of joins) {
      for (const s of slugs) {
        db.prepare('insert into memberships(user_id, community_id) values (?, ?)').run(users[name], communities[s]);
      }
    }

    const vote = (name, type, id, v) =>
      db.prepare('insert into votes(user_id, target_type, target_id, value, created) values (?, ?, ?, ?, ?)')
        .run(users[name], type, id, v, nowMs - 5 * MIN);

    const addPost = ({ community, author, type, title, text = '', url = '', img = null, hoursAgo, votes = [] }) => {
      const id = uid('p_');
      let imagePath = '';
      if (img) {
        imagePath = uid('') + '.png';
        fs.writeFileSync(path.join(UPLOAD_DIR, imagePath), makePng(96, 72, img[0], img[1]));
      }
      db.prepare('insert into posts(id, community_id, user_id, type, title, text, url, image_path, score, created) values (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)')
        .run(id, communities[community], users[author], type, title, text, url, imagePath, nowMs - hoursAgo * HOUR);
      for (const [name, v] of votes) vote(name, 'post', id, v);
      return { id, created: nowMs - hoursAgo * HOUR };
    };

    const addComment = ({ post, parent = null, author, text, minutesAfter = 30, votes = [] }) => {
      const id = uid(''); // 12 символов, без префикса — как требует materialized path
      const created = Math.min(nowMs - 2 * MIN, post.created + minutesAfter * MIN);
      const p = parent ? parent.path + id + '/' : '/' + id + '/';
      const depth = parent ? parent.depth + 1 : 0;
      db.prepare('insert into comments(id, post_id, user_id, parent_id, path, depth, text, score, created) values (?, ?, ?, ?, ?, ?, ?, 0, ?)')
        .run(id, post.id, users[author], parent ? parent.id : null, p, depth, text, created);
      for (const [name, v] of votes) vote(name, 'comment', id, v);
      return { id, path: p, depth, created };
    };

    // --- посты ---
    const p1 = addPost({
      community: 'oren_dev', author: 'Алексей', type: 'text', hoursAgo: 3,
      title: 'Как вы организуете код-ревью в небольшой команде?',
      text: 'Нас пятеро, начали задыхаться на ревью: пул-реквесты висят по два дня. Кто как выкручивается — парное программирование, ротация ревьюеров, ограничения на размер диффа?',
      votes: [['Мария', 1], ['Дмитрий', 1], ['Ольга', 1], ['Сергей', 1]],
    });
    const p2 = addPost({
      community: 'oren_dev', author: 'Дмитрий', type: 'link', hoursAgo: 26,
      title: 'Материализованные пути для деревьев в SQLite: разбор подхода',
      url: 'https://www.sqlite.org/whentouse.html',
      votes: [['Алексей', 1], ['Ольга', 1], ['Сергей', 1]],
    });
    addPost({
      community: 'oren_dev', author: 'Сергей', type: 'image', hoursAgo: 8,
      title: 'Скриншот пет-проекта: планировщик смен для небольшого склада',
      img: [[75, 107, 216], [36, 52, 132]],
      votes: [['Алексей', 1], ['Ольга', 1]],
    });
    const p4 = addPost({
      community: 'kotiki', author: 'Ольга', type: 'image', hoursAgo: 5,
      title: 'Мой рыжий окончательно освоил подоконник',
      text: 'Три дня выбирал между столом и окном. Выбор сделан в пользу солнца.',
      img: [[232, 148, 62], [176, 96, 30]],
      votes: [['Алексей', 1], ['Мария', 1], ['Дмитрий', 1], ['Сергей', 1], ['Ольга', 1]],
    });
    const p5 = addPost({
      community: 'kotiki', author: 'Мария', type: 'text', hoursAgo: 2,
      title: 'Кот внезапно начал будить в пять утра. Что делать?',
      text: 'Раньше вставал вместе с нами, теперь орет под дверью в 5:00. Кормление по расписанию не помогло. У кого так было?',
      votes: [['Дмитрий', 1], ['Ольга', 1], ['Сергей', 1], ['Алексей', 1]],
    });
    addPost({
      community: 'kotiki', author: 'Алексей', type: 'link', hoursAgo: 30,
      title: 'Гайд: как приучить кота к переноске без стресса',
      url: 'https://www.reddit.com/r/CatAdvice/',
      votes: [['Мария', 1], ['Сергей', 1]],
    });
    const p7 = addPost({
      community: 'kuhnya', author: 'Дмитрий', type: 'text', hoursAgo: 10,
      title: 'Идеальный борщ: спорим о порядке закладки?',
      text: 'Знакомый повар утверждает, что зажарку надо делать отдельно от бульона. Мама так никогда не делала. Где правда?',
      votes: [['Ольга', 1], ['Алексей', 1], ['Сергей', 1]],
    });
    addPost({
      community: 'kuhnya', author: 'Мария', type: 'image', hoursAgo: 20,
      title: 'Испёк первый хлеб на домашней закваске',
      text: 'Закваску выводил две недели. Корка хрустит, мякиш крупчатый. Дальше — ржаной.',
      img: [[196, 148, 92], [120, 80, 44]],
      votes: [['Алексей', 1], ['Дмитрий', 1], ['Ольга', 1], ['Сергей', 1]],
    });
    addPost({
      community: 'kuhnya', author: 'Сергей', type: 'link', hoursAgo: 50,
      title: 'Пять соусов, которые спасут любой ужин',
      url: 'https://ru.wikipedia.org/wiki/Соус',
      votes: [['Мария', 1]],
    });
    const p10 = addPost({
      community: 'auto', author: 'Алексей', type: 'text', hoursAgo: 6,
      title: 'Стоит ли брать машину с пробегом за 200 тысяч км?',
      text: 'Цена заметно ниже аналогов, история вроде чистая. Насколько это лотерея? На что смотреть в первую очередь?',
      votes: [['Мария', -1], ['Дмитрий', -1], ['Ольга', -1]],
    });
    addPost({
      community: 'auto', author: 'Ольга', type: 'image', hoursAgo: 15,
      title: 'Летняя поездка: трасса под Оренбургом на закате',
      img: [[240, 170, 90], [120, 70, 60]],
      votes: [['Дмитрий', 1], ['Сергей', 1]],
    });
    addPost({
      community: 'auto', author: 'Мария', type: 'link', hoursAgo: 70,
      title: 'Что поменялось в правилах техосмотра: краткий разбор',
      url: 'https://www.gosuslugi.ru/',
      votes: [['Дмитрий', -1], ['Сергей', -1]],
    });

    // --- комментарии: ветки глубиной до 4 ---
    // p1 — код-ревью
    const c1 = addComment({
      post: p1, author: 'Мария', minutesAfter: 25,
      text: 'У нас пул-реквесты до 400 строк и правило «ревью в течение рабочего дня». Помогает больше, чем любые процессы.',
      votes: [['Дмитрий', 1], ['Ольга', 1], ['Сергей', 1]],
    });
    const c11 = addComment({
      post: p1, parent: c1, author: 'Дмитрий', minutesAfter: 40,
      text: 'А сколько человек в среднем смотрят один пул-реквест?',
      votes: [['Ольга', 1], ['Сергей', 1]],
    });
    const c111 = addComment({
      post: p1, parent: c11, author: 'Мария', minutesAfter: 55,
      text: 'Обычно двое, для мелких правок — один.',
      votes: [['Сергей', 1]],
    });
    addComment({
      post: p1, parent: c111, author: 'Сергей', minutesAfter: 70,
      text: 'Мы ввели правило: за сутки без ревью можно мержить самому. Жалоб нет.',
      votes: [['Дмитрий', 1], ['Ольга', 1]],
    });
    addComment({
      post: p1, parent: c11, author: 'Ольга', minutesAfter: 60,
      text: 'У нас двое обязательны только для изменений в ядре.',
      votes: [['Дмитрий', 1]],
    });
    addComment({
      post: p1, parent: c1, author: 'Сергей', minutesAfter: 50,
      text: 'Пробовали парное программирование вместо ревью — спорно, но часть задач реально закрывает.',
    });
    addComment({
      post: p1, author: 'Ольга', minutesAfter: 35,
      text: 'Главное — маленькие диффы. Большой пул-реквест не спасёт никакая ротация.',
      votes: [['Мария', 1], ['Дмитрий', 1]],
    });

    // p4 — котик
    const c4a = addComment({
      post: p4, author: 'Алексей', minutesAfter: 20,
      text: 'Официально заявляю: это лучший подоконник в городе.',
      votes: [['Мария', 1], ['Дмитрий', 1], ['Сергей', 1]],
    });
    const c4a1 = addComment({
      post: p4, parent: c4a, author: 'Ольга', minutesAfter: 35,
      text: 'Спасибо! Теперь он там живёт на постоянной прописке.',
      votes: [['Алексей', 1], ['Мария', 1]],
    });
    const c4a11 = addComment({
      post: p4, parent: c4a1, author: 'Дмитрий', minutesAfter: 50,
      text: 'Кот одобряет. Голос от кота засчитан.',
      votes: [['Сергей', 1]],
    });
    addComment({
      post: p4, parent: c4a11, author: 'Мария', minutesAfter: 65,
      text: 'Рыжие вообще умеют выбирать лучшие места в квартире.',
      votes: [['Ольга', 1]],
    });
    addComment({
      post: p4, author: 'Мария', minutesAfter: 30,
      text: 'Какой насыщенный оттенок рыжего!',
      votes: [['Ольга', 1]],
    });

    // p5 — кот будит
    const c5a = addComment({
      post: p5, author: 'Дмитрий', minutesAfter: 25,
      text: 'Кормление прямо перед сном нам помогло — за неделю сдвинул цикл.',
      votes: [['Мария', 1], ['Сергей', 1]],
    });
    const c5a1 = addComment({
      post: p5, parent: c5a, author: 'Мария', minutesAfter: 40,
      text: 'Пробовали, будит всё равно. Раньше пяти не сдаётся.',
    });
    const c5a11 = addComment({
      post: p5, parent: c5a1, author: 'Дмитрий', minutesAfter: 55,
      text: 'Тогда автокормушка с таймером на 5:00. Кот переключился на неё и спал дальше.',
      votes: [['Мария', 1], ['Ольга', 1]],
    });
    addComment({
      post: p5, parent: c5a11, author: 'Ольга', minutesAfter: 70,
      text: 'Подтверждаю: автокормушка — единственное, что сработало у нас.',
      votes: [['Дмитрий', 1]],
    });
    addComment({
      post: p5, author: 'Сергей', minutesAfter: 30,
      text: 'Строго не реагировать. Неделя утренней тишины — и отучится.',
      votes: [['Алексей', 1]],
    });

    // p7 — борщ
    const c7a = addComment({
      post: p7, author: 'Ольга', minutesAfter: 30,
      text: 'Зажарку делать отдельно и добавлять в конце, а не варить в бульоне.',
      votes: [['Алексей', 1], ['Сергей', 1]],
    });
    const c7a1 = addComment({
      post: p7, parent: c7a, author: 'Сергей', minutesAfter: 45,
      text: 'Ересь. Настоящий борщ начинается с бульона и лука.',
      votes: [['Ольга', -1]],
    });
    addComment({
      post: p7, parent: c7a1, author: 'Ольга', minutesAfter: 60,
      text: 'Судьба борща решается в зажарке, проверено поколениями.',
      votes: [['Алексей', 1], ['Мария', 1]],
    });
    addComment({
      post: p7, author: 'Алексей', minutesAfter: 40,
      text: 'Сало с чесноком в конце — бесспорно, тут спорить не о чем.',
      votes: [['Дмитрий', 1]],
    });

    // p10 — пробег
    const c10a = addComment({
      post: p10, author: 'Дмитрий', minutesAfter: 30,
      text: 'Смотрите не на пробег, а на историю обслуживания и состояние подвески.',
      votes: [['Алексей', 1], ['Сергей', 1]],
    });
    const c10a1 = addComment({
      post: p10, parent: c10a, author: 'Алексей', minutesAfter: 45,
      text: 'И тест-драйв по ямам, а не по ровному паркингу.',
      votes: [['Дмитрий', 1]],
    });
    const c10a11 = addComment({
      post: p10, parent: c10a1, author: 'Дмитрий', minutesAfter: 60,
      text: 'Да, и проверить VIN по базам до звонка продавцу.',
      votes: [['Сергей', 1]],
    });
    addComment({
      post: p10, parent: c10a11, author: 'Сергей', minutesAfter: 75,
      text: 'И не ведитесь на «продажа срочная, чуть дешевле рынка».',
    });
    addComment({
      post: p10, author: 'Ольга', minutesAfter: 35,
      text: 'На таком пробеге всё зависит от марки. Что за модель?',
      votes: [['Дмитрий', 1]],
    });

    // p2 — sqlite
    const c2a = addComment({
      post: p2, author: 'Сергей', minutesAfter: 40,
      text: 'Материализованные пути — самое простое рабочее решение для деревьев средней глубины.',
      votes: [['Алексей', 1]],
    });
    addComment({
      post: p2, parent: c2a, author: 'Алексей', minutesAfter: 55,
      text: 'До пары тысяч узлов хватает с головой, дальше уже нужны другие структуры.',
      votes: [['Сергей', 1]],
    });

    // Пересчёт денормализованных score из голосов.
    db.prepare(`update posts set score = (select coalesce(sum(value), 0) from votes v where v.target_type = 'post' and v.target_id = posts.id)`).run();
    db.prepare(`update comments set score = (select coalesce(sum(value), 0) from votes v where v.target_type = 'comment' and v.target_id = comments.id)`).run();
  })();

  const stats = {
    users: db.prepare('select count(*) n from users').get().n,
    communities: db.prepare('select count(*) n from communities').get().n,
    posts: db.prepare('select count(*) n from posts').get().n,
    comments: db.prepare('select count(*) n from comments').get().n,
    votes: db.prepare('select count(*) n from votes').get().n,
  };
  console.log('seed: база была пуста, засеяны демо-данные', stats);
  return stats;
}
