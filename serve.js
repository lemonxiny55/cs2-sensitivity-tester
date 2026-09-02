// serve.js — dependency-free static file server for local use.
// Usage: node serve.js  then open http://127.0.0.1:4173
// Or just double-click start.cmd to start it and open the browser.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = '127.0.0.1';
const PORT = 4173;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.md': 'text/plain',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  const relative = decodeURIComponent(urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, ''));
  const file = path.join(ROOT, relative);
  fs.readFile(file, (error, data) => {
    if (error) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`404: ${relative}`);
      return;
    }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
    res.end(data);
  });
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is busy - a server is probably already running. Just open http://${HOST}:${PORT} directly.`);
  } else {
    console.error(error);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}  (closing this window stops it)`);
});