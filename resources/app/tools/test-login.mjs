// Test admin login
import http from 'node:http';
import https from 'node:https';

const body = JSON.stringify({ username: 'admin', password: 'WG-Admin-2026' });
const options = {
  hostname: '127.0.0.1',
  port: 8082,
  path: '/api/admin/login',
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
};

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', (c) => data += c);
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    console.log('Headers:', JSON.stringify(res.headers, null, 2));
    console.log('Body:', data);
  });
});
req.on('error', (e) => console.error('Error:', e.message));
req.write(body);
req.end();
