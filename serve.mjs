// Minimal static server. ESM + import maps need http://, not file://
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const TYPES = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript',
  '.json':'application/json', '.css':'text/css', '.psd':'application/octet-stream',
  '.psb':'application/octet-stream', '.map':'application/json' };

const PORT = process.env.PORT || 5173;
const ROOT = process.cwd();

http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  let file = path.join(ROOT, url === '/' ? 'demo/index.html' : url);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
  fs.stat(file, (err, st) => {
    if (err || st.isDirectory()) { res.writeHead(404).end('not found: ' + url); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  });
}).listen(PORT, () => console.log(`\n  PSD reader demo -> http://localhost:${PORT}\n`));
