'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { OAuthTokenStore } = require('../src/oauthTokenStore');

class FakeRedis {
  constructor() {
    this.values = new Map();
  }

  async set(key, value) {
    this.values.set(key, value);
  }

  async get(key) {
    return this.values.get(key) || null;
  }

  async del(key) {
    this.values.delete(key);
  }
}

test('stores user OAuth tokens encrypted and consumes state once', async () => {
  const redis = new FakeRedis();
  const store = new OAuthTokenStore({ redis, encryptionKey: 'test-key' });

  await store.saveUserToken('U123', 'xoxp-secret-token');
  assert.equal(await store.getUserToken('U123'), 'xoxp-secret-token');
  assert.notEqual(redis.values.get(store.tokenKey('U123')), 'xoxp-secret-token');

  const state = await store.createState('U123');
  assert.equal(await store.consumeState(state), 'U123');
  assert.equal(await store.consumeState(state), null);
});
