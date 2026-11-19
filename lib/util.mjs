import { randomBytes } from 'node:crypto';

// Короткий читаемый id: префикс + 12 base62-символов
export function uid(prefix = '') {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  const bytes = randomBytes(12);
  for (let i = 0; i < 12; i++) out += alphabet[bytes[i] % alphabet.length];
  return prefix + out;
}

export const now = () => Date.now();

export function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

// Экранирование HTML для вставки пользовательских строк
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ESC[ch]);
}
