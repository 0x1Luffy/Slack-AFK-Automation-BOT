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

function parseBasicAuth(header) {
  if (!header || !header.startsWith('Basic ')) return null;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const index = decoded.indexOf(':');
  if (index < 0) return null;
  return {
    username: decoded.slice(0, index),
    password: decoded.slice(index + 1)
  };
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

  receiver.app.get('/', async (_req, res) => {
    try {
      const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Slack AFK Bot — API</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
    <style>
      :root{--bg:#f6f8fa;--card:#fff;--muted:#6b7280;--accent:#2563eb}
      html,body{height:100%}
      body{font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;margin:0;background:var(--bg);color:#0f172a}
      .wrap{max-width:980px;margin:48px auto;padding:24px}
      header{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}
      h1{font-size:20px;margin:0}
      p.lead{margin:6px 0 0;color:var(--muted)}
      .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;margin-top:20px}
      .card{background:var(--card);border-radius:12px;padding:18px;box-shadow:0 1px 2px rgba(16,24,40,0.04);border:1px solid rgba(15,23,42,0.04)}
      .card h3{margin:0 0 8px 0;font-size:15px}
      .muted{color:var(--muted);font-size:13px}
      a.link{display:inline-block;margin-top:8px;color:var(--accent);text-decoration:none;font-weight:600}
      pre{background:#0b1220;color:#e6eef8;padding:12px;border-radius:8px;margin:12px 0;overflow:auto;font-size:13px}
      footer{margin-top:28px;color:var(--muted);font-size:13px}
      .logo{display:flex;align-items:center;gap:12px}
      .logo svg{width:38px;height:38px}
    </style>
  </head>
  <body>
    <div class="wrap">
      <header>
        <div>
          <div class="logo"><svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="24" height="24" rx="6" fill="#2563eb"/><path d="M7 12h10M7 8h10M7 16h6" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <div>
              <h1>Slack AFK Bot — API</h1>
              <p class="lead">Simple endpoints for health, logs and status management.</p>
            </div>
          </div>
        </div>
        <div class="muted">v1 • lightweight</div>
      </header>

      <div class="grid">
        <div class="card">
          <h3>Health</h3>
          <div class="muted">Check service health and runtime metrics.</div>
          <a class="link" href="/health">GET /health</a>
          <pre>curl -sS --fail {{HOST}}/health | jq .</pre>
        </div>

        <div class="card">
          <h3>Logs (JSON / text)</h3>
          <div class="muted">Retrieve recent logs. When enabled, a query key is required.</div>
          <a class="link" href="/logs">GET /logs</a>
          <pre>curl -sS "{{HOST}}/logs?key=YOUR_KEY" | jq .</pre>
        </div>

        <div class="card">
          <h3>Logs (browser view)</h3>
          <div class="muted">Simple plaintext log view protected by basic auth when enabled.</div>
          <a class="link" href="/logs/view">GET /logs/view</a>
          <pre>open {{HOST}}/logs/view</pre>
        </div>

        <div class="card">
          <h3>Slack OAuth</h3>
          <div class="muted">OAuth connection routes are registered when Slack OAuth is configured.</div>
          <div style="margin-top:8px;font-size:13px">If enabled, use the configured redirect URI to connect user tokens.</div>
        </div>
      </div>

      <footer>
        <div>Usage tips: replace <strong>{{HOST}}</strong> with your host (e.g. <code>https://example.com</code> or <code>http://localhost:3000</code>).</div>
      </footer>
    </div>
  </body>
</html>`;
      res.type('text/html').send(html);
    } catch (error) {
      logger.error('Landing page render failed', { error });
      res.status(500).type('text/plain').send('Server error');
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
      const logFile = config.logFilePath || path.resolve(process.cwd(), 'logs/local-app.log');
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

  receiver.app.get('/logs/view', async (req, res) => {
    if (!config.logsUsername || !config.logsPassword) {
      res.status(404).type('text/plain').send('Logs view is disabled.');
      return;
    }

    const auth = parseBasicAuth(req.headers.authorization);
    if (!auth || auth.username !== config.logsUsername || auth.password !== config.logsPassword) {
      res.set('WWW-Authenticate', 'Basic realm="Logs"');
      res.status(401).type('text/plain').send('Unauthorized');
      return;
    }

    try {
      const logFile = config.logFilePath || path.resolve(process.cwd(), 'logs/local-app.log');
      const text = await readLastLogLines(logFile, 100);
      res.type('text/plain').send(text);
    } catch (error) {
      logger.error('Logs view failed', { error });
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
    const messageTs = event.ts || event.message_ts;
    const dedupeId = messageTs ? `ts:${messageTs}` : event.client_msg_id ? `client:${event.client_msg_id}` : null;
    if (!dedupeId) return true;

    const result = await redis.set(`afk:processed-message:${event.channel}:${dedupeId}`, source, 'EX', 86400, 'NX');
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
      await sendDm(client, userId, text);
      return;
    } catch (error) {
      logger.warn('Could not send status connection prompt by DM; falling back to ephemeral', {
        userId,
        channel: event.channel,
        error
      });
    }

    try {
      await client.chat.postEphemeral({
        channel: event.channel,
        thread_ts: replyThreadTs(event),
        user: userId,
        text
      });
    } catch (error) {
      logger.error('Could not send status connection prompt privately', {
        userId,
        channel: event.channel,
        error
      });
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
