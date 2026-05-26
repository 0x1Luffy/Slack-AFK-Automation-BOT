'use strict';

const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { createRedisClient } = require('./redis');
const { createAfkQueue } = require('./queue');
const { createCommandRateLimiter } = require('./rateLimiter');
const { SessionStore } = require('./sessionStore');
const { createSlackAfkApp } = require('./slackApp');
const { SlackStatusManager } = require('./statusManager');
const { OAuthTokenStore } = require('./oauthTokenStore');
const { SlackOAuthManager } = require('./oauth');

async function main() {
  const config = loadConfig();
  const logger = createLogger({ env: config.env, level: config.logLevel });
  const redis = createRedisClient(config.redisUrl, logger, 'afk-primary');
  const queueConnection = createRedisClient(config.redisUrl, logger, 'afk-queue');
  const sessionStore = new SessionStore(redis);
  const rateLimiter = createCommandRateLimiter(redis, {
    points: config.rateLimitPoints,
    durationSeconds: config.rateLimitDurationSeconds
  });
  const tokenStore = new OAuthTokenStore({
    redis,
    encryptionKey: config.tokenEncryptionKey || config.slackClientSecret || config.slackSigningSecret
  });
  const oauthManager = new SlackOAuthManager({
    config,
    tokenStore,
    logger
  });
  const statusManager = new SlackStatusManager({
    token: config.slackUserToken,
    enabled: config.slackStatusEnabled,
    emoji: config.afkStatusEmoji,
    text: config.afkStatusText,
    tokenStore,
    oauthManager,
    logger
  });
  await statusManager.init();

  let afkQueue;

  const { app, startHistoryPolling } = createSlackAfkApp({
    config,
    logger,
    sessionStore,
    rateLimiter,
    statusManager,
    scheduleAutoReturn: (...args) => afkQueue.scheduleAutoReturn(...args),
    removeAutoReturn: (...args) => afkQueue.removeAutoReturn(...args),
    queueDepth: () => afkQueue.queueDepth(),
    redis
  });

  afkQueue = createAfkQueue({
    queueName: config.queueName,
    connection: queueConnection,
    sessionStore,
    slackClient: app.client,
    statusManager,
    channelId: config.afkChannelId,
    logger
  });
  const historyPoller = startHistoryPolling();

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Graceful shutdown started', { signal });

    try {
      await afkQueue.worker.close();
      await afkQueue.queueEvents.close();
      await afkQueue.queue.close();
      historyPoller.stop();
      await Promise.allSettled([redis.quit(), queueConnection.quit()]);
      await app.stop();
      logger.info('Graceful shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error('Graceful shutdown failed', { error });
      process.exit(1);
    }
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', { error });
    shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (error) => {
    logger.error('Unhandled rejection', { error });
    shutdown('unhandledRejection');
  });

  await app.start(config.port);
  logger.info('Slack AFK bot started', { port: config.port, channel: config.afkChannelId, env: config.env });
}

if (require.main === module) {
  main().catch((error) => {
    const logger = createLogger({ env: process.env.NODE_ENV || 'development', level: process.env.LOG_LEVEL || 'info' });
    logger.error('Startup failed', { error });
    process.exit(1);
  });
}

module.exports = { main };
