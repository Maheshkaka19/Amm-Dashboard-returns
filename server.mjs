import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const port = parseInt(process.env.PORT || '3000', 10);
const publicDir = path.join(__dirname, 'public');

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

http.createServer((req, res) => {
  const cleanPath  = (req.url || '/').split('?')[0];
  const requested  = cleanPath === '/' ? '/index.html' : cleanPath;
  const normalized = path.normalize(requested).replace(/^([.][.][/\\])+/, '');
  const filePath   = path.join(publicDir, normalized);
  if (!filePath.startsWith(publicDir)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.stat(filePath, (err, stats) => {
    if (!err && stats.isFile()) { sendFile(res, filePath); return; }
    sendFile(res, path.join(publicDir, 'index.html'));
  });
}).listen(port, () => console.log(`Institutional Pair Rebalancer running at http://localhost:${port}`));
