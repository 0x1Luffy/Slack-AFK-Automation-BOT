'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { AUTO_RETURN_JOB, REMINDER_JOB, queueJobId, sendDm } = require('../src/queue');

test('queueJobId creates BullMQ-safe custom ids', () => {
  assert.equal(queueJobId('U123', REMINDER_JOB), 'afk-reminder-U123');
  assert.equal(queueJobId('U123', AUTO_RETURN_JOB), 'afk-auto-return-U123');
  assert.equal(queueJobId('U:123', REMINDER_JOB), 'afk-reminder-U_123');
  assert.equal(queueJobId('U123', REMINDER_JOB).includes(':'), false);
});

test('sendDm opens a user DM and posts only to the DM channel', async () => {
  const calls = [];
  const slackClient = {
    conversations: {
      async open(args) {
        calls.push(['open', args]);
        return { channel: { id: 'D123' } };
      }
    },
    chat: {
      async postMessage(args) {
        calls.push(['postMessage', args]);
      }
    }
  };

  await sendDm(slackClient, 'U123', 'AFK expired automatically.');

  assert.deepEqual(calls, [
    ['open', { users: 'U123' }],
    ['postMessage', { channel: 'D123', text: 'AFK expired automatically.' }]
  ]);
});
