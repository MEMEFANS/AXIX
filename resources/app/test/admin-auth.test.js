import assert from 'node:assert/strict';
import { createAdminAuth } from '../src/admin-auth.js';

const auth = createAdminAuth({ username:'admin', password:'correct-password' });

assert.throws(() => auth.login('admin', 'wrong-password'), error => error.statusCode === 401);
assert.throws(() => auth.login('wrong-user', 'correct-password'), error => error.statusCode === 401);

const login = auth.login('admin', 'correct-password');
assert.equal(login.username, 'admin');
assert.ok(login.token.length >= 64);
assert.equal(auth.session(login.token)?.username, 'admin');
assert.equal(auth.session('invalid-token'), null);

auth.logout(login.token);
assert.equal(auth.session(login.token), null);

const unconfigured = createAdminAuth();
assert.throws(() => unconfigured.login('admin', 'password'), error => error.statusCode === 503);

console.log('admin auth tests passed');
