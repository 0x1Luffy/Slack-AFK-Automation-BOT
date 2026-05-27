'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

const REQUIRED = ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'AFK_CHANNEL_ID', 'REDIS_URL'];

function loadEnvFile() {
  const envFile = process.env.ENV_FILE
    ? path.resolve(process.env.ENV_FILE)
    : path.resolve(process.cwd(), '.env');

  if (fs.existsSync(envFile)) {
    dotenv.config({ path: envFile, quiet: true });
  }
}

function readInteger(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name] ?? String(fallback);
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function readBoolean(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (/^(true|1|yes)$/i.test(raw)) return true;
  if (/^(false|0|no)$/i.test(raw)) return false;
  throw new Error(`${name} must be true or false`);
}

function loadConfig() {
  loadEnvFile();

  const missing = REQUIRED.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  const oauthConfigured = Boolean(
    process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET && process.env.SLACK_OAUTH_REDIRECT_URI
  );
  if ((process.env.NODE_ENV || 'development') === 'production' && oauthConfigured) {
    if (!process.env.TOKEN_ENCRYPTION_KEY || process.env.TOKEN_ENCRYPTION_KEY.length < 32) {
      throw new Error('TOKEN_ENCRYPTION_KEY must be set to at least 32 characters when OAuth is enabled in production');
    }
  }

  return {
    env: process.env.NODE_ENV || 'development',
    port: readInteger('PORT', 3000, { min: 1, max: 65535 }),
    logLevel: process.env.LOG_LEVEL || 'info',
    logAccessKey: process.env.LOG_ACCESS_KEY || '',
    logFilePath: process.env.LOG_FILE_PATH
      ? path.resolve(process.env.LOG_FILE_PATH)
      : path.resolve(process.cwd(), 'logs/local-app.log'),
    slackBotToken: process.env.SLACK_BOT_TOKEN,
    slackUserToken: process.env.SLACK_USER_TOKEN || '',
    slackClientId: process.env.SLACK_CLIENT_ID || '',
    slackClientSecret: process.env.SLACK_CLIENT_SECRET || '',
    slackOAuthRedirectUri: process.env.SLACK_OAUTH_REDIRECT_URI || '',
    tokenEncryptionKey: process.env.TOKEN_ENCRYPTION_KEY || '',
    slackSigningSecret: process.env.SLACK_SIGNING_SECRET,
    afkChannelId: process.env.AFK_CHANNEL_ID,
    redisUrl: process.env.REDIS_URL,
    rateLimitPoints: readInteger('RATE_LIMIT_POINTS', 5, { min: 1, max: 1000 }),
    rateLimitDurationSeconds: readInteger('RATE_LIMIT_DURATION_SECONDS', 60, { min: 1, max: 86400 }),
    queueName: process.env.AFK_QUEUE_NAME || 'afk-auto-return',
    historyPollingEnabled: readBoolean('SLACK_HISTORY_POLLING_ENABLED', true),
    historyPollingIntervalMs: readInteger('SLACK_HISTORY_POLLING_INTERVAL_MS', 5000, { min: 1000, max: 60000 }),
    slackStatusEnabled: readBoolean('SLACK_STATUS_ENABLED', true),
    afkStatusEmoji: process.env.AFK_STATUS_EMOJI || ':sleeping:',
    afkStatusText: process.env.AFK_STATUS_TEXT || 'AFK'
  };
}

module.exports = { loadConfig, loadEnvFile };
