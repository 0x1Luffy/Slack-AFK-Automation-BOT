'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createSlackAfkApp, parseLogLine, readLastLogEntries, readLastLogLines } = require('../src/slackApp');

function createLogger() {
  return {
    error() {},
    info() {},
    warn() {}
  };
}

function createTestApp({ session, statusSetResult = { ok: true } }) {
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
        return statusSetResult;
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
  assert.equal(testApp.posts.at(-1).thread_ts, '1710000000.000100');
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
  assert.equal(testApp.posts.at(-1).thread_ts, '1710000000.000100');
});

test('top-level afk confirmation replies in the message thread', async () => {
  const testApp = createTestApp({});

  await testApp.processMessage({
    event: {
      channel: 'C_AFk',
      user: 'U123',
      text: 'afk 30min',
      ts: '1710000002.000400'
    },
    client: testApp.slackClient,
    botUserId: 'UBOT',
    source: 'events-api'
  });

  assert.equal(testApp.posts.at(-1).text, '✅ AFK status updated for 30 mins');
  assert.equal(testApp.posts.at(-1).thread_ts, '1710000002.000400');
});

test('ignores bot messages seen by history polling', async () => {
  const now = Date.now();
  const testApp = createTestApp({
    session: {
      userId: 'U123',
      reason: 'AFK',
      startedAt: now,
      updatedAt: now,
      expiresAt: now + 5 * 60 * 1000,
      statusEmoji: ':sleeping:'
    }
  });

  await testApp.processMessage({
    event: {
      channel: 'C_AFk',
      user: 'UBOT',
      app_id: 'A123',
      text: '<@U123>, AFK tracking is on.',
      ts: '1710000003.000500'
    },
    client: testApp.slackClient,
    botUserId: 'UBOT',
    source: 'history-poller'
  });

  assert.deepEqual(testApp.posts, []);
});

test('afk confirmation is sent before status connection prompt', async () => {
  const testApp = createTestApp({
    statusSetResult: {
      ok: false,
      reason: 'missing_user_oauth',
      connectUrl: 'https://slack.example/connect'
    }
  });

  await testApp.processMessage({
    event: {
      channel: 'C_AFk',
      user: 'U123',
      text: 'afk 5mins',
      ts: '1710000004.000600'
    },
    client: testApp.slackClient,
    botUserId: 'UBOT',
    source: 'events-api'
  });

  assert.equal(testApp.posts[0].text, '✅ AFK status updated for 5 mins');
  assert.equal(testApp.posts[0].method, 'postMessage');
  assert.match(testApp.posts[1].text, /connect once/);
  assert.equal(testApp.posts[1].method, 'postEphemeral');
});

test('readLastLogLines returns the last requested lines', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'afk-logs-'));
  const file = path.join(dir, 'local-app.log');
  const lines = Array.from({ length: 105 }, (_, index) => `line-${index + 1}`);
  await fs.writeFile(file, `${lines.join('\n')}\n`);

  const result = await readLastLogLines(file, 100);

  assert.equal(result.split('\n').length, 100);
  assert.equal(result.split('\n')[0], 'line-6');
  assert.equal(result.split('\n').at(-1), 'line-105');
});

test('readLastLogLines returns empty text when log file is missing', async () => {
  const result = await readLastLogLines('/tmp/does-not-exist-local-app.log', 100);

  assert.equal(result, '');
});

test('parseLogLine parses production JSON log lines', () => {
  const entry = parseLogLine(
    '{"level":"info","message":"Slack AFK bot started","port":3000,"timestamp":"2026-05-27T04:37:15.841Z"}'
  );

  assert.equal(entry.level, 'info');
  assert.equal(entry.message, 'Slack AFK bot started');
  assert.equal(entry.port, 3000);
  assert.equal(entry.timestamp, '2026-05-27T04:37:15.841Z');
});

test('parseLogLine parses colored development log lines', () => {
  const entry = parseLogLine(
    '2026-05-27T04:37:15.841Z \u001b[32minfo\u001b[39m: Slack AFK bot started {"port":3000,"env":"development"}'
  );

  assert.equal(entry.level, 'info');
  assert.equal(entry.message, 'Slack AFK bot started');
  assert.equal(entry.port, 3000);
  assert.equal(entry.env, 'development');
});

test('readLastLogEntries returns parsed objects', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'afk-log-entries-'));
  const file = path.join(dir, 'local-app.log');
  await fs.writeFile(
    file,
    [
      '{"level":"info","message":"one","timestamp":"2026-05-27T00:00:00.000Z"}',
      '2026-05-27T00:00:01.000Z info: two {"port":3000}'
    ].join('\n')
  );

  const entries = await readLastLogEntries(file, 100);

  assert.equal(entries.length, 2);
  assert.equal(entries[0].message, 'one');
  assert.equal(entries[1].message, 'two');
  assert.equal(entries[1].port, 3000);
});
