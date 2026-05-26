'use strict';

const { RateLimiterRedis } = require('rate-limiter-flexible');

function createCommandRateLimiter(redis, { points, durationSeconds }) {
  return new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: 'afk-command-rate-limit',
    points,
    duration: durationSeconds
  });
}

async function consumeCommand(limiter, userId) {
  try {
    await limiter.consume(userId);
    return { allowed: true };
  } catch (error) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((error.msBeforeNext || 1000) / 1000))
    };
  }
}

module.exports = { consumeCommand, createCommandRateLimiter };
