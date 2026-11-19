// Мини-фреймворк: роутер, JSON-тело, cookies, статика с Range (для аудио/видео).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.ics': 'text/calendar; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

export function json(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(data));
}

export function bytes(res, status, buf, type, headers = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': buf.length, ...headers });
  res.end(buf);
}

export const notFound = (res) => json(res, 404, { error: 'not_found' });
export const badRequest = (res, msg) => json(res, 400, { error: msg || 'bad_request' });
export const unauthorized = (res) => json(res, 401, { error: 'unauthorized' });

export function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

export function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function setCookie(res, name, value, opts = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${opts.path || '/'}; HttpOnly; SameSite=Lax`;
  if (opts.maxAge != null) c += `; Max-Age=${opts.maxAge}`;
  if (opts.expires) c += `; Expires=${opts.expires.toUTCString()}`;
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, c) : [c]);
}

export async function readBody(req, limit = 16 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const ch of req) {
    size += ch.length;
    if (size > limit) throw new Error('payload_too_large');
    chunks.push(ch);
  }
  return Buffer.concat(chunks);
}

export function createApp({ publicDir = null, spa = false, bodyLimit = 16 * 1024 * 1024 } = {}) {
  const routes = [];
  const add = (method, pattern, handler) =>
    routes.push({ method, parts: pattern.split('/').filter(Boolean), handler });

  const app = {
    get: (p, h) => add('GET', p, h),
    post: (p, h) => add('POST', p, h),
    put: (p, h) => add('PUT', p, h),
    patch: (p, h) => add('PATCH', p, h),
    delete: (p, h) => add('DELETE', p, h),
    handle,
    listen,
  };

  function match(method, pathname) {
    const parts = pathname.split('/').filter(Boolean);
    for (const r of routes) {
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
      if (r.parts.length !== parts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < r.parts.length; i++) {
        const rp = r.parts[i];
        if (rp.startsWith(':')) params[rp.slice(1)] = decodeURIComponent(parts[i]);
        else if (rp !== parts[i]) { ok = false; break; }
      }
      if (ok) return { handler: r.handler, params };
    }
    return null;
  }

  async function handle(req, res) {
    try {
      const url = new URL(req.url, 'http://x');
      const m = match(req.method, url.pathname);
      if (m) {
        const ctx = {
          req, res,
          params: m.params,
          query: url.searchParams,
          cookies: parseCookies(req),
          body: null,
          raw: null,
        };
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
          ctx.raw = await readBody(req, bodyLimit);
          const ct = req.headers['content-type'] || '';
          if (ct.includes('application/json')) {
            ctx.body = ctx.raw.length ? JSON.parse(ctx.raw.toString('utf8')) : {};
          }
        }
        await m.handler(ctx);
        return;
      }
      if (publicDir && serveStatic(req, res, url.pathname, publicDir, spa)) return;
      notFound(res);
    } catch (e) {
      console.error(new Date().toISOString(), req.method, req.url, e);
      if (!res.headersSent) json(res, 500, { error: 'internal', message: String(e && e.message || e) });
      else res.end();
    }
  }

  function serveStatic(req, res, pathname, dir, spaFallback) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    if (pathname.includes('\0')) return false;
    let p = decodeURIComponent(pathname);
    if (p === '/') p = '/index.html';
    let file = path.resolve(dir, '.' + p);
    if (file !== path.resolve(dir) && !file.startsWith(path.resolve(dir) + path.sep)) return false;
    let stat = fs.existsSync(file) && fs.statSync(file).isFile() ? fs.statSync(file) : null;
    if (!stat) {
      if (!spaFallback) return false;
      file = path.join(dir, 'index.html');
      if (!fs.existsSync(file)) return false;
      stat = fs.statSync(file);
    }
    const ext = path.extname(file).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const size = stat.size;
    const range = req.headers.range;
    if (range && /^bytes=(\d*)-(\d*)$/.test(range)) {
      const [, sRaw, eRaw] = range.match(/^bytes=(\d*)-(\d*)$/);
      let start = sRaw === '' ? null : parseInt(sRaw, 10);
      let end = eRaw === '' ? null : parseInt(eRaw, 10);
      if (start === null && end !== null) { start = size - end; end = size - 1; }
      if (start === null) start = 0;
      if (end === null || end > size - 1) end = size - 1;
      if (start > end || start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        return res.end(), true;
      }
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(file, { start, end }).pipe(res);
      return true;
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    });
    if (req.method === 'HEAD') return res.end(), true;
    fs.createReadStream(file).pipe(res);
    return true;
  }

  function listen(port, onInit) {
    const server = http.createServer((req, res) => handle(req, res));
    if (onInit) onInit(server);
    server.listen(port, '0.0.0.0', () => console.log(`listening on :${port}`));
    return server;
  }

  return app;
}
