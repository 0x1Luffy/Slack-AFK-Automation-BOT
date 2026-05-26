'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { SessionStore } = require('../src/sessionStore');

class FakePipeline {
  constructor(redis) {
    this.redis = redis;
    this.ops = [];
  }

  set(...args) {
    this.ops.push(['set', args]);
    return this;
  }

  sadd(...args) {
    this.ops.push(['sadd', args]);
    return this;
  }

  del(...args) {
    this.ops.push(['del', args]);
    return this;
  }

  srem(...args) {
    this.ops.push(['srem', args]);
    return this;
  }

  async exec() {
    for (const [name, args] of this.ops) {
      await this.redis[name](...args);
    }
  }
}

class FakeRedis {
  constructor() {
    this.values = new Map();
    this.sets = new Map();
  }

  pipeline() {
    return new FakePipeline(this);
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

  async sadd(key, value) {
    if (!this.sets.has(key)) this.sets.set(key, new Set());
    this.sets.get(key).add(value);
  }

  async srem(key, ...values) {
    const set = this.sets.get(key);
    if (set) values.forEach((value) => set.delete(value));
  }

  async smembers(key) {
    return [...(this.sets.get(key) || new Set())];
  }

  async mget(keys) {
    return keys.map((key) => this.values.get(key) || null);
  }
}

test('stores, reads, deletes, and counts active sessions', async () => {
  const redis = new FakeRedis();
  const store = new SessionStore(redis);
  const session = { userId: 'U123', reason: 'focus', startedAt: Date.now(), expiresAt: Date.now() + 60000 };

  await store.set(session);
  assert.deepEqual(await store.get('U123'), session);
  assert.equal(await store.activeCount(), 1);

  await store.delete('U123');
  assert.equal(await store.get('U123'), null);
  assert.equal(await store.activeCount(), 0);
});
