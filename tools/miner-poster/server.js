const http = require('http');
const fs = require('fs');
const path = require('path');
const root = 'c:/Users/Administrator/Desktop/AXIX/tools/miner-poster';
http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/miner-poster.html';
  fs.readFile(path.join(root, p), (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
}).listen(8765, () => console.log('server up on 8765'));
