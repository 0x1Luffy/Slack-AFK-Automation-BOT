'use strict';

const IORedis = require('ioredis');

function createRedisClient(redisUrl, logger, name = 'redis') {
  const client = new IORedis(redisUrl, {
    enableReadyCheck: true,
    maxRetriesPerRequest: null,
    connectionName: name
  });

  client.on('error', (error) => logger.error('Redis client error', { name, error }));
  client.on('connect', () => logger.info('Redis client connected', { name }));
  client.on('ready', () => logger.info('Redis client ready', { name }));
  client.on('close', () => logger.warn('Redis client closed', { name }));

  return client;
}

module.exports = { createRedisClient };
