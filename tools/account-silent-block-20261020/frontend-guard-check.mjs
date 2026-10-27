import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = process.argv.includes('--local') ? path.resolve(root, '../../resources/app') : path.join(root, 'candidate');
const source = fs.readFileSync(path.join(sourceRoot, 'public/js/account-action-guard.js'), 'utf8');
const response = (marker = null, status = 200) => ({
  status,
  headers: { get: name => name.toLowerCase() === 'x-axix-action' ? marker : null }
});
function setup(fetchImpl = () => Promise.resolve(response())) {
  const calls = [];
  const listeners = new Map();
  const dialogs = [];
  const window = {
    location: new URL('https://example.test/?page=earn'),
    fetch(...args) { calls.push(args); return fetchImpl(...args); },
    addEventListener(type, listener, options) { listeners.set(type, { listener, options }); },
    alert(value) { dialogs.push(['alert', value]); },
    confirm(value) { dialogs.push(['confirm', value]); return true; },
    prompt(value) { dialogs.push(['prompt', value]); return 'normal'; }
  };
  vm.runInNewContext(source, { window, URL, Promise });
  function interaction(type) {
    let prevented = false;
    let stopped = false;
    const entry = listeners.get(type);
    assert(entry?.options.capture && entry?.options.passive === false);
    entry.listener({
      cancelable: true,
      preventDefault() { prevented = true; },
      stopImmediatePropagation() { stopped = true; }
    });
    return { prevented, stopped };
  }
  return { window, calls, dialogs, interaction, listeners };
}
async function remainsPending(promise) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(settled, false, 'idle request must not resolve or reject into application fallbacks');
}

{
  const ok = response(null, 200);
  const s = setup(() => Promise.resolve(ok));
  const options = { method: 'POST', body: 'original' };
  assert.equal(await s.window.fetch('/api/a-token/claim', options), ok);
  assert.equal(s.calls[0][1], options);
  assert.deepEqual(s.interaction('click'), { prevented: false, stopped: false });
  assert.equal(s.window.confirm('confirm'), true);
  assert.equal(s.window.prompt('prompt'), 'normal');
  s.window.alert('alert');
  assert.equal(s.dialogs.length, 3);
}
console.log('PASS normal API, options, interactions and dialogs remain unchanged');

{
  const failure = new Error('ordinary network failure');
  const s = setup(() => Promise.reject(failure));
  await assert.rejects(s.window.fetch('/api/profile'), error => error === failure);
  assert.equal(s.window.confirm('still normal'), true);
  const bad = response(null, 500);
  const e = setup(() => Promise.resolve(bad));
  assert.equal(await e.window.fetch('/api/profile'), bad);
}
console.log('PASS ordinary network errors and error HTTP responses are preserved');

{
  const s = setup(() => Promise.resolve(response('idle', 204)));
  await remainsPending(s.window.fetch('/api/profile'));
  const first = s.window.fetch('/api/a-token/claim');
  const second = s.window.fetch('https://example.test/api/withdraw', { method: 'POST' });
  assert.equal(first, second, 'all later API attempts share one pending promise');
  await remainsPending(first);
  assert.equal(s.calls.length, 1, 'later blocked requests must not reach the network');
  for (const type of s.listeners.keys()) {
    assert.deepEqual(s.interaction(type), { prevented: true, stopped: true }, type);
  }
  assert.equal(s.window.alert('silent'), undefined);
  assert.equal(s.window.confirm('silent'), false);
  assert.equal(s.window.prompt('silent'), null);
  assert.equal(s.dialogs.length, 0);
}
console.log('PASS marked response stays pending, prevents repeated requests and captures interactions without dialogs');

{
  let resolveOld;
  let rejectOld;
  const s = setup(url => {
    if (url === '/api/old') return new Promise(resolve => { resolveOld = resolve; });
    if (url === '/api/old-error') return new Promise((_, reject) => { rejectOld = reject; });
    return Promise.resolve(response('idle', 204));
  });
  const old = s.window.fetch('/api/old');
  const oldError = s.window.fetch('/api/old-error');
  await remainsPending(s.window.fetch('/api/auth/challenge'));
  resolveOld(response());
  rejectOld(new Error('late failure'));
  await remainsPending(old);
  await remainsPending(oldError);
}
console.log('PASS other in-flight API responses and failures cannot resume the marked application');

{
  const s = setup(() => Promise.resolve(response('idle', 204)));
  for (const url of ['https://other.test/api/profile', '/js/core.js', '/api-extra', '/assets/logo.svg']) {
    assert.equal((await s.window.fetch(url)).status, 204);
  }
  assert.deepEqual(s.interaction('click'), { prevented: false, stopped: false });
  await remainsPending(s.window.fetch('/api/profile'));
  for (const url of ['https://other.test/api/profile', '/js/core.js', '/api-extra']) {
    assert.equal((await s.window.fetch(url)).status, 204);
  }
  assert.equal(s.calls.length, 8);
}
console.log('PASS external URLs and static resources neither trigger nor inherit API freezing');

{
  const s = setup(() => Promise.resolve(response('idle', 204)));
  await remainsPending(s.window.fetch({ url: 'https://example.test/api/auth/verify' }));
  assert.equal(s.calls.length, 1);
  await remainsPending(s.window.fetch(new URL('https://example.test/api/profile')));
  assert.equal(s.calls.length, 1);
}
console.log('PASS Request-style inputs and URL inputs use the same API boundary');

{
  const beforeRoot = process.argv.includes('--local') ? 'local-before' : 'production-before';
  const before = fs.readFileSync(path.join(root, beforeRoot, 'public/index.html'), 'utf8');
  const after = fs.readFileSync(path.join(sourceRoot, 'public/index.html'), 'utf8');
  const line = '<script src="/js/account-action-guard.js?v=20261020-1"></script>';
  assert.equal(after.split(line).length, 2);
  assert.equal(after.replace(line + (before.includes('\r\n') ? '\r\n' : '\n'), ''), before);
  assert(after.indexOf(line) < after.indexOf('<script defer'));
}
console.log('PASS index differs only by the synchronous versioned guard before all business scripts');
