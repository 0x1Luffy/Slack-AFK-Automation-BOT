'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { App, ExpressReceiver } = require('@slack/bolt');
const helmet = require('helmet');
const { messages } = require('./messages');
const { COMMANDS, extractMentionedUserIds, parseCommand } = require('./parser');
const { consumeCommand } = require('./rateLimiter');

async function sendDm(slackClient, userId, text) {
  const opened = await slackClient.conversations.open({ users: userId });
  const channel = opened.channel && opened.channel.id;
  if (!channel) {
    throw new Error('Slack did not return a DM channel');
  }

  await slackClient.chat.postMessage({ channel, text });
}

async function readLastLogLines(logFile, lineCount = 100) {
  try {
    const content = await fs.readFile(logFile, 'utf8');
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    const trailingEmpty = lines.at(-1) === '' ? 1 : 0;
    return lines.slice(Math.max(0, lines.length - trailingEmpty - lineCount), lines.length - trailingEmpty).join('\n');
  } catch (error) {
    if (error && error.code === 'ENOENT') return '';
    throw error;
  }
}

function stripAnsi(value) {
  return String(value).replace(/\u001b\[[0-9;]*m/g, '');
}

function parseLogLine(line) {
  const clean = stripAnsi(line).trim();
  if (!clean) return null;

  try {
    const parsed = JSON.parse(clean);
    return { raw: line, ...parsed };
  } catch {
    // Fall through to the development printf format.
  }

  const match = /^(\S+)\s+(\w+):\s+(.+?)(?:\s+(\{.*\}))?$/.exec(clean);
  if (!match) {
    return { level: 'raw', message: clean, raw: line };
  }

  const [, timestamp, level, message, metaText] = match;
  let meta = {};
  if (metaText) {
    try {
      meta = JSON.parse(metaText);
    } catch {
      meta = { meta: metaText };
    }
  }

  return {
    timestamp,
    level,
    message,
    ...meta,
    raw: line
  };
}

async function readLastLogEntries(logFile, lineCount = 100) {
  const text = await readLastLogLines(logFile, lineCount);
  return text
    .split('\n')
    .map(parseLogLine)
    .filter(Boolean);
}

function createSlackAfkApp({
  config,
  logger,
  sessionStore,
  rateLimiter,
  statusManager,
  scheduleAutoReturn,
  removeAutoReturn,
  queueDepth,
  redis,
  boltApp,
  receiver: providedReceiver
}) {
  const receiver =
    providedReceiver ||
    new ExpressReceiver({
      signingSecret: config.slackSigningSecret,
      processBeforeResponse: true
    });

  if (!providedReceiver) {
    receiver.app.disable('x-powered-by');
    receiver.app.set('trust proxy', 1);
    receiver.app.use(
      helmet({
        contentSecurityPolicy: false,
        hsts: config.env === 'production' ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false
      })
    );
  }

  const app =
    boltApp ||
    new App({
      token: config.slackBotToken,
      receiver,
      logLevel: 'ERROR'
    });

  receiver.app.get('/health', async (_req, res) => {
    try {
      const [activeSessions, depth] = await Promise.all([sessionStore.activeCount(), queueDepth()]);
      res.json({
        status: redis.status === 'ready' ? 'ok' : 'degraded',
        uptime: process.uptime(),
        activeSessions,
        redisConnected: redis.status === 'ready',
        queueDepth: depth
      });
    } catch (error) {
      logger.error('Health check failed', { error });
      res.status(503).json({
        status: 'degraded',
        uptime: process.uptime(),
        activeSessions: 0,
        redisConnected: redis.status === 'ready',
        queueDepth: 0
      });
    }
  });

  receiver.app.get('/logs', async (req, res) => {
    if (!config.logAccessKey) {
      res.status(404).type('text/plain').send('Logs endpoint is disabled.');
      return;
    }

    if (req.query.key !== config.logAccessKey) {
      res.status(403).type('text/plain').send('Forbidden');
      return;
    }

    try {
      const logFile = path.resolve(process.cwd(), 'logs/local-app.log');
      if (req.query.format === 'text') {
        const text = await readLastLogLines(logFile, 100);
        res.type('text/plain').send(text);
        return;
      }

      const entries = await readLastLogEntries(logFile, 100);
      res.json({
        count: entries.length,
        lines: entries
      });
    } catch (error) {
      logger.error('Logs endpoint failed', { error });
      res.status(500).type('text/plain').send('Could not read logs.');
    }
  });

  if (statusManager.oauthManager) {
    statusManager.oauthManager.registerRoutes(receiver.app);
  }

  app.event('message', async ({ event, client, context }) => {
    logger.info('Slack message event received', {
      channel: event && event.channel,
      user: event && event.user,
      subtype: event && event.subtype,
      hasBotId: Boolean(event && event.bot_id)
    });
    await processMessage({ event, client, botUserId: context.botUserId, source: 'events-api' });
  });

  async function markProcessed(event, source) {
    const clientMsgId = event.client_msg_id;
    if (clientMsgId) {
      const result = await redis.set(`afk:processed-message:${event.channel}:client:${clientMsgId}`, source, 'EX', 86400, 'NX');
      return result === 'OK';
    }

    const messageTs = event.ts || event.message_ts;
    if (!messageTs) return true;

    const result = await redis.set(`afk:processed-message:${event.channel}:${messageTs}`, source, 'EX', 86400, 'NX');
    return result === 'OK';
  }

  function isBotMessage(event, botUserId) {
    return Boolean(
      event.subtype ||
        event.bot_id ||
        event.app_id ||
        event.bot_profile ||
        (botUserId && event.user === botUserId)
    );
  }

  async function processMessage({ event, client, botUserId, source }) {
    if (!event || event.channel !== config.afkChannelId || isBotMessage(event, botUserId)) {
      return;
    }

    const text = event.text || '';
    const userId = event.user;
    if (!userId) return;

    const shouldProcess = await markProcessed(event, source);
    if (!shouldProcess) return;

    const command = parseCommand(text);
    if (command) {
      logger.info('AFK command detected', {
        source,
        userId,
        command: command.type,
        channel: event.channel,
        ts: event.ts
      });
      await handleCommand({ command, client, event, userId });
      return;
    }

    const mentionedUserIds = extractMentionedUserIds(text).filter(
      (mentionedId) => mentionedId !== userId && mentionedId !== botUserId
    );
    if (mentionedUserIds.length > 0) {
      logger.info('AFK mention check detected', {
        source,
        userId,
        mentionedCount: mentionedUserIds.length,
        channel: event.channel,
        ts: event.ts
      });
      await handleMentions({ mentionedUserIds, client, event });
    }
  }

  function replyThreadTs(event) {
    return event.thread_ts || event.ts || event.message_ts;
  }

  async function handleCommand({ command, client, event, userId }) {
    const limit = await consumeCommand(rateLimiter, userId);
    if (!limit.allowed) {
      if (event.source === 'history-poller') {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: replyThreadTs(event),
          text: messages.rateLimitedPublic(userId, limit.retryAfterSeconds)
        });
      } else {
        await client.chat.postEphemeral({
          channel: event.channel,
          user: userId,
          text: messages.rateLimited(limit.retryAfterSeconds)
        });
      }
      return;
    }

    if (command.type === COMMANDS.BACK) {
      await sessionStore.delete(userId);
      await removeAutoReturn(userId);
      await statusManager.clearAfk(userId);
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: replyThreadTs(event),
        text: messages.back(userId)
      });
      logger.info('AFK session cleared manually', { userId });
      return;
    }

    if (command.type === COMMANDS.EXTEND) {
      const existing = await sessionStore.get(userId);
      if (!existing) {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: replyThreadTs(event),
          text: messages.notAfk(userId)
        });
        return;
      }

      const expiresAt = existing.expiresAt + command.durationMs;
      const updated = { ...existing, expiresAt, updatedAt: Date.now() };
      await sessionStore.set(updated);
      await scheduleAutoReturn(userId, expiresAt);
      const statusResult = await statusManager.setAfk(userId, expiresAt, existing.reason, existing.statusEmoji);
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: replyThreadTs(event),
        text: messages.afkExtended(command.durationMs)
      });
      await maybeSendStatusConnectPrompt({ statusResult, client, event, userId });
      logger.info('AFK session extended', { userId, expiresAt });
      return;
    }

    const existing = await sessionStore.get(userId);
    if (existing) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: replyThreadTs(event),
        text: messages.alreadyAfk(userId)
      });
      return;
    }

    const now = Date.now();
    const expiresAt = now + command.durationMs;
    const session = {
      userId,
      reason: command.reason,
      startedAt: now,
      updatedAt: now,
      expiresAt,
      statusEmoji: command.statusEmoji
    };

    await sessionStore.set(session);
    await scheduleAutoReturn(userId, expiresAt);
    const statusResult = await statusManager.setAfk(userId, expiresAt, command.reason, command.statusEmoji);
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: replyThreadTs(event),
      text: messages.afkUpdated(command.durationMs)
    });
    await maybeSendStatusConnectPrompt({ statusResult, client, event, userId });
    logger.info('AFK session started', { userId, expiresAt });
  }

  async function maybeSendStatusConnectPrompt({ statusResult, client, event, userId }) {
    if (!statusResult || statusResult.ok || statusResult.reason !== 'missing_user_oauth') return;

    const text = messages.statusConnectPrompt(userId, statusResult.connectUrl);

    try {
      await client.chat.postEphemeral({
        channel: event.channel,
        thread_ts: replyThreadTs(event),
        user: userId,
        text
      });
    } catch (error) {
      logger.warn('Could not send status connection prompt ephemerally; sending DM instead', {
        userId,
        channel: event.channel,
        error
      });
      await sendDm(client, userId, text);
    }
  }

  async function handleMentions({ mentionedUserIds, client, event }) {
    const sessions = await Promise.all(
      mentionedUserIds.map(async (mentionedUserId) => sessionStore.get(mentionedUserId))
    );

    const replies = sessions
      .filter(Boolean)
      .map((session) => messages.mentionStatus(session));

    if (replies.length === 0) return;

    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: replyThreadTs(event),
      text: replies.join('\n')
    });
  }

  function startHistoryPolling() {
    if (!config.historyPollingEnabled) {
      logger.info('Slack history polling disabled');
      return { stop: () => undefined };
    }

    let timer = null;
    let running = false;
    let latestTs = `${Date.now() / 1000}`;
    let botUserId = null;

    async function tick() {
      if (running) return;
      running = true;

      try {
        if (!botUserId) {
          const auth = await app.client.auth.test();
          botUserId = auth.user_id;
          logger.info('Slack history polling authenticated', { botUserId });
        }

        const history = await app.client.conversations.history({
          channel: config.afkChannelId,
          oldest: latestTs,
          inclusive: false,
          limit: 100
        });

        const messages = [...(history.messages || [])].reverse();
        if (messages.length > 0) {
          logger.info('Slack history polling found messages', {
            count: messages.length,
            newestTs: messages[messages.length - 1].ts
          });
        }
        for (const message of messages) {
          if (message.ts && Number(message.ts) > Number(latestTs)) {
            latestTs = message.ts;
          }

          await processMessage({
            event: { ...message, channel: config.afkChannelId, source: 'history-poller' },
            client: app.client,
            botUserId,
            source: 'history-poller'
          });
        }
      } catch (error) {
        logger.error('Slack history polling failed', { error });
      } finally {
        running = false;
      }
    }

    timer = setInterval(tick, config.historyPollingIntervalMs);
    timer.unref();
    tick();
    logger.info('Slack history polling started', { intervalMs: config.historyPollingIntervalMs });

    return {
      stop: () => {
        if (timer) clearInterval(timer);
        timer = null;
      }
    };
  }

  return { app, receiver, processMessage, startHistoryPolling };
}

module.exports = { createSlackAfkApp, parseLogLine, readLastLogEntries, readLastLogLines, stripAnsi };
