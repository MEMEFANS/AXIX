// 零依赖静态预览。仅绑定回环地址，不加载 .env、数据库或生产服务。
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const root = path.resolve(fileURLToPath(new URL('../../resources/app/public/', import.meta.url)));
export const preview = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
    if (url.pathname.startsWith('/api/')) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"error":"Local preview has no wallet session"}'); }
    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const full = path.resolve(root, '.' + relative);
    if (!full.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
    const data = await fs.readFile(full);
    const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
    res.writeHead(200, { 'Content-Type': mime[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'" });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch { res.writeHead(404); res.end('Not found'); }
});
preview.listen(4173, '127.0.0.1', () => console.log('Run AIX local preview: http://127.0.0.1:4173/run-aix.html'));
