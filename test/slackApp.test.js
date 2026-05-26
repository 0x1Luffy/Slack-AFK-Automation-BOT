'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createSlackAfkApp } = require('../src/slackApp');

function createLogger() {
  return {
    error() {},
    info() {},
    warn() {}
  };
}

function createTestApp({ session }) {
  const posts = [];
  const scheduled = [];
  const sessions = new Map(session ? [[session.userId, session]] : []);

  const { processMessage } = createSlackAfkApp({
    config: {
      afkChannelId: 'C_AFk',
      env: 'test',
      slackBotToken: 'xoxb-test',
      slackSigningSecret: 'test-secret'
    },
    logger: createLogger(),
    sessionStore: {
      async activeCount() {
        return sessions.size;
      },
      async delete(userId) {
        sessions.delete(userId);
      },
      async get(userId) {
        return sessions.get(userId) || null;
      },
      async set(updated) {
        sessions.set(updated.userId, updated);
      }
    },
    rateLimiter: {
      async consume() {}
    },
    statusManager: {
      async clearAfk() {
        return { ok: true };
      },
      async setAfk() {
        return { ok: true };
      }
    },
    async scheduleAutoReturn(userId, expiresAt) {
      scheduled.push({ userId, expiresAt });
    },
    async removeAutoReturn() {},
    async queueDepth() {
      return 0;
    },
    redis: {
      status: 'ready',
      async set() {
        return 'OK';
      }
    },
    boltApp: {
      client: {},
      event() {}
    },
    receiver: {
      app: {
        get() {}
      }
    }
  });

  return {
    posts,
    processMessage,
    scheduled,
    sessions,
    slackClient: {
      chat: {
        async postEphemeral(args) {
          posts.push({ method: 'postEphemeral', ...args });
        },
        async postMessage(args) {
          posts.push({ method: 'postMessage', ...args });
        }
      }
    }
  };
}

test('thread reply "+20 mins" extends the replying user active AFK session', async () => {
  const now = Date.now();
  const original = {
    userId: 'U123',
    reason: 'lunch',
    startedAt: now,
    updatedAt: now,
    expiresAt: now + 30 * 60 * 1000,
    statusEmoji: ':hamburger:'
  };
  const testApp = createTestApp({ session: original });

  await testApp.processMessage({
    event: {
      channel: 'C_AFk',
      user: 'U123',
      text: '+20 mins',
      ts: '1710000001.000200',
      thread_ts: '1710000000.000100'
    },
    client: testApp.slackClient,
    botUserId: 'UBOT',
    source: 'events-api'
  });

  const updated = testApp.sessions.get('U123');
  assert.equal(updated.expiresAt, original.expiresAt + 20 * 60 * 1000);
  assert.deepEqual(testApp.scheduled, [{ userId: 'U123', expiresAt: updated.expiresAt }]);
  assert.equal(testApp.posts.at(-1).text, '✅ AFK extended by 20 mins');
});

test('thread reply "more 20 mins" extends the replying user active AFK session', async () => {
  const now = Date.now();
  const original = {
    userId: 'U123',
    reason: 'meeting',
    startedAt: now,
    updatedAt: now,
    expiresAt: now + 30 * 60 * 1000,
    statusEmoji: ':telephone_receiver:'
  };
  const testApp = createTestApp({ session: original });

  await testApp.processMessage({
    event: {
      channel: 'C_AFk',
      user: 'U123',
      text: 'more 20 mins',
      ts: '1710000001.000300',
      thread_ts: '1710000000.000100'
    },
    client: testApp.slackClient,
    botUserId: 'UBOT',
    source: 'events-api'
  });

  const updated = testApp.sessions.get('U123');
  assert.equal(updated.expiresAt, original.expiresAt + 20 * 60 * 1000);
  assert.deepEqual(testApp.scheduled, [{ userId: 'U123', expiresAt: updated.expiresAt }]);
  assert.equal(testApp.posts.at(-1).text, '✅ AFK extended by 20 mins');
});
