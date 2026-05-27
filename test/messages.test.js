'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { messages } = require('../src/messages');

test('formats AFK command confirmation messages', () => {
  assert.equal(messages.afkUpdated(30 * 60 * 1000), '✅ AFK status updated for 30 mins');
  assert.equal(messages.afkExtended(10 * 60 * 1000), '✅ AFK extended by 10 mins');
  assert.equal(messages.back('U123'), '✅ Welcome back <@U123>');
  assert.equal(messages.notAfk('U123'), '<@U123>, you are not currently marked AFK.');
});

test('formats already-AFK and rate limit messages', () => {
  assert.equal(
    messages.alreadyAfk('U123'),
    '<@U123>, you are already AFK. Reply with `more 10m`, `+10m`, or `extend 10m` to add time.'
  );
  assert.equal(messages.rateLimited(17), 'Slow down a touch. You can use AFK commands again in 17s.');
  assert.equal(
    messages.rateLimitedPublic('U123', 17),
    '<@U123>, Slow down a touch. You can use AFK commands again in 17s.'
  );
});

test('formats Slack status connection prompts', () => {
  assert.equal(
    messages.statusConnectPrompt('U123', 'https://slack.example/connect'),
    '<@U123>, AFK tracking is on. To also set your Slack status emoji automatically, connect once: https://slack.example/connect'
  );
  assert.equal(
    messages.statusConnectPrompt('U123', null),
    '<@U123>, AFK tracking is on. Automatic Slack status emoji needs OAuth setup by an admin.'
  );
});

test('formats mention status and escapes reason text', () => {
  const now = Date.now();
  assert.equal(
    messages.mentionStatus(
      {
        userId: 'U123',
        reason: 'review <danger> & lunch',
        expiresAt: now + 5 * 60 * 1000
      },
      now
    ),
    '<@U123> is AFK for 5m: review &lt;danger&gt; &amp; lunch'
  );
});

test('formats private reminder and expiry messages', () => {
  assert.equal(messages.reminder(), '⏰ Your AFK ends in 1 minute.');
  assert.equal(messages.expired(), 'AFK expired automatically.');
});
