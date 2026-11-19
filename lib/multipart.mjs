// Разбор multipart/form-data через busboy (используется для загрузки картинок).
// На вход принимает уже прочитанное тело запроса (Buffer) и заголовки запроса.
import Busboy from 'busboy';
import { Readable } from 'node:stream';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export function parseMultipart(req, raw, { maxFileSize = MAX_IMAGE_BYTES, maxFiles = 4 } = {}) {
  return new Promise((resolve, reject) => {
    let busboy;
    try {
      busboy = Busboy({
        headers: req.headers,
        limits: { fileSize: maxFileSize, files: maxFiles, fields: 30, fieldSize: 512 * 1024 },
      });
    } catch {
      return reject(new Error('bad_multipart'));
    }

    const fields = {};
    const files = [];
    let filePending = 0;
    let parseDone = false;
    let failure = null;
    let finished = false;

    const settle = () => {
      if (finished || !parseDone || filePending > 0) return;
      finished = true;
      if (failure) reject(failure);
      else resolve({ fields, files });
    };

    busboy.on('field', (name, value) => { fields[name] = value; });

    busboy.on('file', (field, stream, info) => {
      filePending++;
      const chunks = [];
      let size = 0;
      let truncated = false;
      stream.on('data', (d) => { size += d.length; chunks.push(d); });
      // busboy обрезает файл при превышении лимита и сигнализирует событием limit
      stream.on('limit', () => { truncated = true; });
      stream.on('error', (e) => { failure = failure || e; });
      stream.on('close', () => {
        filePending--;
        files.push({
          field,
          filename: info.filename || '',
          mimeType: info.mimeType || '',
          buffer: Buffer.concat(chunks),
          size,
          truncated,
        });
        settle();
      });
    });

    busboy.on('fieldsLimit', () => { failure = failure || new Error('too_many_fields'); });
    busboy.on('filesLimit', () => { failure = failure || new Error('too_many_files'); });
    busboy.on('error', (e) => {
      failure = failure || e;
      parseDone = true;
      filePending = 0;
      settle();
    });
    const markParsed = () => { parseDone = true; settle(); };
    busboy.on('finish', markParsed);
    busboy.on('close', markParsed);

    Readable.from([raw])
      .on('error', (e) => { failure = failure || e; parseDone = true; settle(); })
      .pipe(busboy);
  });
}
