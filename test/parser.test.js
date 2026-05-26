'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  extractMentionedUserIds,
  extractStatusEmoji,
  formatDuration,
  formatDurationWords,
  normalizeInput,
  parseCommand,
  parseDurationToMs,
  stripStatusEmoji
} = require('../src/parser');

test('parses AFK command with compact duration and reason', () => {
  assert.deepEqual(parseCommand('afk 1h30m lunch'), {
    type: 'afk',
    durationMs: 90 * 60 * 1000,
    reason: 'lunch',
    statusEmoji: ':hamburger:'
  });
});

test('parses AFK command with spaced duration words', () => {
  assert.deepEqual(parseCommand('AFK 30 min'), {
    type: 'afk',
    durationMs: 30 * 60 * 1000,
    reason: 'AFK',
    statusEmoji: ':sleeping:'
  });
});

test('parses extend and back commands', () => {
  assert.deepEqual(parseCommand('extend 10m'), { type: 'extend', durationMs: 10 * 60 * 1000 });
  assert.deepEqual(parseCommand('afk extend 30m'), { type: 'extend', durationMs: 30 * 60 * 1000 });
  assert.deepEqual(parseCommand('more 20 mins'), { type: 'extend', durationMs: 20 * 60 * 1000 });
  assert.deepEqual(parseCommand('+20 mins'), { type: 'extend', durationMs: 20 * 60 * 1000 });
  assert.deepEqual(parseCommand('+ 20m'), { type: 'extend', durationMs: 20 * 60 * 1000 });
  assert.deepEqual(parseCommand('back'), { type: 'back' });
});

test('parses reason-before-duration AFK commands from the channel prompt', () => {
  assert.deepEqual(parseCommand('afk lunch 30m'), {
    type: 'afk',
    durationMs: 30 * 60 * 1000,
    reason: 'lunch',
    statusEmoji: ':hamburger:'
  });
  assert.deepEqual(parseCommand('afk meeting 1 hr'), {
    type: 'afk',
    durationMs: 60 * 60 * 1000,
    reason: 'meeting',
    statusEmoji: ':telephone_receiver:'
  });
  assert.deepEqual(parseCommand('AFK break 15 mins'), {
    type: 'afk',
    durationMs: 15 * 60 * 1000,
    reason: 'break',
    statusEmoji: ':coffee:'
  });
});

test('rejects partial or unsafe command shapes', () => {
  assert.equal(parseCommand('please afk 1h'), null);
  assert.equal(parseCommand('afk 1x nope'), null);
  assert.equal(parseCommand('afk extend 0m'), null);
  assert.equal(parseCommand('afk 8d'), null);
});

test('caps input at 200 characters before parsing', () => {
  assert.equal(normalizeInput(`back ${'x'.repeat(400)}`).length, 200);
});

test('parses durations and formats remaining time', () => {
  assert.equal(parseDurationToMs('2d3h4m'), ((2 * 24 + 3) * 60 + 4) * 60 * 1000);
  assert.equal(formatDuration(90 * 60 * 1000), '1h 30m');
  assert.equal(formatDurationWords(30 * 60 * 1000), '30 mins');
  assert.equal(formatDurationWords(60 * 60 * 1000), '1 hr');
});

test('extracts unique Slack user mentions', () => {
  assert.deepEqual(extractMentionedUserIds('hi <@U123ABC> and <@W456DEF> and <@U123ABC>'), [
    'U123ABC',
    'W456DEF'
  ]);
});

test('extracts command status emoji from reason', () => {
  assert.equal(extractStatusEmoji('testing :ramen:'), ':ramen:');
  assert.equal(parseCommand('afk 2m testing :ramen:').statusEmoji, ':ramen:');
  assert.equal(extractStatusEmoji('testing 🍜'), ':ramen:');
  assert.equal(parseCommand('afk 2m testing 🍜').statusEmoji, ':ramen:');
  assert.equal(stripStatusEmoji('testing 🍜'), 'testing');
});

test('infers food status emoji from lunch and dinner typos', () => {
  assert.equal(parseCommand('afk 30m lunch').statusEmoji, ':hamburger:');
  assert.equal(parseCommand('afk 30m luch').statusEmoji, ':hamburger:');
  assert.equal(parseCommand('afk 30m dinner').statusEmoji, ':hamburger:');
  assert.equal(parseCommand('afk 30m dinnr').statusEmoji, ':hamburger:');
});

test('infers generic, meeting, and break status emojis', () => {
  assert.equal(extractStatusEmoji('AFK'), ':sleeping:');
  assert.equal(parseCommand('afk focus 10m').statusEmoji, ':sleeping:');
  assert.equal(parseCommand('afk standup 10m').statusEmoji, ':telephone_receiver:');
  assert.equal(parseCommand('afk coffee 10m').statusEmoji, ':coffee:');
});
