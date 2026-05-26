# Slack AFK Automation Bot

Production-grade Slack AFK bot for one channel, built with `@slack/bolt` HTTP mode,
BullMQ, Redis, `rate-limiter-flexible`, and winston.

## Commands

- `afk 1h30m reason`
- `afk extend 30m`
- `back`

When an AFK user is mentioned in `AFK_CHANNEL_ID`, the bot replies in the message
thread with their status and remaining time.

## Required Slack Setup

Create a Slack app with:

- Bot token scopes: `chat:write`, `chat:write.public`, `channels:history`
- Event subscription request URL: `https://your-domain/slack/events`
- Bot event: `message.channels`

Install the app into the workspace and invite it to the AFK channel.

## Environment

Copy `.env.example` to `.env` and set:

- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`
- `AFK_CHANNEL_ID`
- `REDIS_URL`

Optional:

- `PORT`
- `LOG_LEVEL`
- `RATE_LIMIT_POINTS`
- `RATE_LIMIT_DURATION_SECONDS`
- `AFK_QUEUE_NAME`
- `SLACK_USER_TOKEN`
- `SLACK_CLIENT_ID`
- `SLACK_CLIENT_SECRET`
- `SLACK_OAUTH_REDIRECT_URI`
- `TOKEN_ENCRYPTION_KEY`
- `SLACK_HISTORY_POLLING_ENABLED`
- `SLACK_HISTORY_POLLING_INTERVAL_MS`
- `SLACK_STATUS_ENABLED`
- `AFK_STATUS_EMOJI`
- `AFK_STATUS_TEXT`

`SLACK_HISTORY_POLLING_ENABLED=true` is enabled by default. It polls the AFK
channel with `conversations.history` as a fallback when Slack Event
Subscriptions are not delivering message events.

## Slack Status Emoji

To automatically show an AFK emoji next to each user's name, Slack requires a
user token for that user, not the bot token. The bot supports per-user OAuth:
the first time a user goes AFK, it posts a one-time connection link. After that,
their token is stored encrypted in Redis and status updates are automatic.

Add this User Token Scope in Slack app settings:

```text
users.profile:write
```

Add this OAuth redirect URL:

```text
https://your-domain/slack/oauth/callback
```

Set these in `.env`:

```text
SLACK_CLIENT_ID=your-client-id
SLACK_CLIENT_SECRET=your-client-secret
SLACK_OAUTH_REDIRECT_URI=https://your-domain/slack/oauth/callback
TOKEN_ENCRYPTION_KEY=long-random-secret
SLACK_STATUS_ENABLED=true
AFK_STATUS_EMOJI=:no_entry:
AFK_STATUS_TEXT=AFK
```

`SLACK_USER_TOKEN` is optional and only acts as a fallback for the one user who
owns that token. For a team, use the OAuth flow above.

Use an emoji that exists in your Slack workspace. `:no_entry:` is a built-in
safe default. If you want `:afk:`, add a custom Slack emoji named `afk` first.

## Local Run

```bash
npm install
npm test
npm start
```

## Docker Compose

Place TLS files at:

- `nginx/certs/fullchain.pem`
- `nginx/certs/privkey.pem`

Then run:

```bash
docker compose up --build
```

Redis is attached only to the internal Docker network and is not exposed to the host.

## Slack Event Delivery

The request URL must be reachable by Slack:

```text
https://your-domain/slack/events
```

Subscribe the bot to this event:

```text
message.channels
```

If the bot is running but does not reply, check whether Nginx logs show
`POST /slack/events` for your messages. If they do not, Slack is not delivering
message events. The history poller will still process new channel messages every
few seconds as long as the bot has `channels:history` and is in the channel.

Ngrok

```
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
```
```
cloudflared tunnel --url https://localhost --no-tls-verify
```

## Health

`GET /health`

```json
{
  "status": "ok",
  "uptime": 12.34,
  "activeSessions": 1,
  "redisConnected": true,
  "queueDepth": 1
}
```
