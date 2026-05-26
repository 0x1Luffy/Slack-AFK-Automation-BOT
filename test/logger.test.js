'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { redactValue } = require('../src/logger');

test('redacts sensitive fields and preserves error details', () => {
  const error = new Error('boom');
  const redacted = redactValue({
    token: 'secret-token',
    nested: { signingSecret: 'secret-value', ok: true },
    error
  });

  assert.equal(redacted.token, '[REDACTED]');
  assert.equal(redacted.nested.signingSecret, '[REDACTED]');
  assert.equal(redacted.nested.ok, true);
  assert.equal(redacted.error.message, 'boom');
  assert.equal(redacted.error.name, 'Error');
});
