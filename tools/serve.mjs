// Minimal static server for local preview of site/. Not used in production —
// Netlify serves site/ directly.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

const ROOT = new URL('../site/', import.meta.url).pathname;
const PORT = Number(process.env.PORT || 8788);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.webp': 'image/webp', '.woff2': 'font/woff2', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
};

createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    p = normalize(p).replace(/^(\.\.[/\\])+/, '');
    let file = join(ROOT, p);
    try { if ((await stat(file)).isDirectory()) file = join(file, 'index.html'); }
    catch { }
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('404');
  }
}).listen(PORT, () => console.log(`serving site/ on http://127.0.0.1:${PORT}`));
