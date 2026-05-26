'use strict';

const { App, ExpressReceiver } = require('@slack/bolt');
const { COMMANDS, extractMentionedUserIds, formatDuration, parseCommand } = require('./parser');
const { consumeCommand } = require('./rateLimiter');

function createSlackAfkApp({
  config,
  logger,
  sessionStore,
  rateLimiter,
  statusManager,
  scheduleAutoReturn,
  removeAutoReturn,
  queueDepth,
  redis
}) {
  const receiver = new ExpressReceiver({
    signingSecret: config.slackSigningSecret,
    processBeforeResponse: true
  });

  const app = new App({
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
    if (!event.ts) return true;

    const result = await redis.set(`afk:processed-message:${event.channel}:${event.ts}`, source, 'EX', 86400, 'NX');
    return result === 'OK';
  }

  async function processMessage({ event, client, botUserId, source }) {
    if (!event || event.channel !== config.afkChannelId || event.subtype || event.bot_id) {
      return;
    }

    const text = event.text || '';
    const userId = event.user;
    if (!userId || userId === botUserId) return;

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

  async function handleCommand({ command, client, event, userId }) {
    const limit = await consumeCommand(rateLimiter, userId);
    if (!limit.allowed) {
      if (event.source === 'history-poller') {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: event.ts,
          text: `<@${userId}>, slow down a touch. You can use AFK commands again in ${limit.retryAfterSeconds}s.`
        });
      } else {
        await client.chat.postEphemeral({
          channel: event.channel,
          user: userId,
          text: `Slow down a touch. You can use AFK commands again in ${limit.retryAfterSeconds}s.`
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
        thread_ts: event.ts,
        text: `Welcome back, <@${userId}>.`
      });
      logger.info('AFK session cleared manually', { userId });
      return;
    }

    if (command.type === COMMANDS.EXTEND) {
      const existing = await sessionStore.get(userId);
      if (!existing) {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: event.ts,
          text: `<@${userId}>, you are not currently marked AFK.`
        });
        return;
      }

      const expiresAt = existing.expiresAt + command.durationMs;
      const updated = { ...existing, expiresAt, updatedAt: Date.now() };
      await sessionStore.set(updated);
      await scheduleAutoReturn(userId, expiresAt);
      const statusResult = await statusManager.setAfk(userId, expiresAt, existing.reason, existing.statusEmoji);
      await maybeSendStatusConnectPrompt({ statusResult, client, event, userId });
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: `<@${userId}> AFK extended by ${formatDuration(command.durationMs)}. Back in ${formatDuration(
          expiresAt - Date.now()
        )}.`
      });
      logger.info('AFK session extended', { userId, expiresAt });
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
    await maybeSendStatusConnectPrompt({ statusResult, client, event, userId });
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      text: `<@${userId}> is AFK for ${formatDuration(command.durationMs)}: ${command.reason}`
    });
    logger.info('AFK session started', { userId, expiresAt });
  }

  async function maybeSendStatusConnectPrompt({ statusResult, client, event, userId }) {
    if (!statusResult || statusResult.ok || statusResult.reason !== 'missing_user_oauth') return;

    const text = statusResult.connectUrl
      ? `<@${userId}>, AFK tracking is on. To also set your Slack status emoji automatically, connect once: ${statusResult.connectUrl}`
      : `<@${userId}>, AFK tracking is on. Automatic Slack status emoji needs OAuth setup by an admin.`;

    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      text
    });
  }

  async function handleMentions({ mentionedUserIds, client, event }) {
    const sessions = await Promise.all(
      mentionedUserIds.map(async (mentionedUserId) => sessionStore.get(mentionedUserId))
    );

    const replies = sessions
      .filter(Boolean)
      .map((session) => {
        const remaining = formatDuration(session.expiresAt - Date.now());
        return `<@${session.userId}> is AFK for ${remaining}: ${session.reason}`;
      });

    if (replies.length === 0) return;

    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
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

module.exports = { createSlackAfkApp };
