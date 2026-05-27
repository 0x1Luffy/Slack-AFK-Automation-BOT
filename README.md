# Slack AFK Automation Bot

Production-ready Slack AFK status automation for an organization workspace. The bot watches only the public `#afk` channel, updates per-user Slack statuses, sends reminders privately, and uses Redis plus BullMQ so timers survive restarts.

## Architecture

```text
Slack Events API
  -> Bolt HTTP receiver at /slack/events
  -> AFK parser and secure event filter
  -> Redis session store
  -> BullMQ delayed reminder and expiry jobs
  -> Slack Web API
```

Runtime components:

- `src/slackApp.js`: Bolt app, Slack event filtering, command handling, health route, Helmet headers.
- `src/parser.js`: bounded AFK parser, duration parser, reason sanitizer, emoji selection.
- `src/sessionStore.js`: Redis-backed active AFK sessions.
- `src/queue.js`: BullMQ reminder and auto-expiry jobs.
- `src/statusManager.js`: per-user Slack status updates.
- `src/oauth.js` and `src/oauthTokenStore.js`: optional per-user OAuth flow with encrypted token storage.
- `nginx/nginx.conf`: HTTPS reverse proxy and security headers.

## Supported Commands

Use these in `#afk` only:

```text
afk 10m
afk 10 mins
afk 1h
afk lunch 30m
afk meeting 1 hr
AFK break 15 mins
extend 10m
afk extend 10m
more 20 mins
+20 mins
back
```

`more ...` and `+...` are intended for quick thread replies. For example, a user can post `afk 30 mins`, then reply in that message thread with `more 20 mins` or `+20 mins` to extend their active AFK session.

Public `#afk` responses:

```text
✅ AFK status updated for 30 mins
✅ AFK extended by 10 mins
✅ Welcome back @user
```

Private DM responses:

```text
⏰ Your AFK ends in 1 minute.
AFK expired automatically.
```

Reminder and auto-expiry messages are never posted publicly.

## Slack Status Behavior

When a user starts AFK, the bot sets:

- `status_text`: `AFK for 30 mins`
- `status_emoji`: dynamic emoji
- `status_expiration`: AFK end time

Emoji mapping:

- generic AFK: `:sleeping:`
- lunch/meal/food: `:hamburger:`
- meeting/call/standup: `:telephone_receiver:`
- break/coffee/tea: `:coffee:`
- explicit emoji in the reason, such as `afk lunch 🍜 30m`, is preserved when Slack accepts it.

Slack requires a user token to update a specific user's profile status. This app supports a secure one-time per-user OAuth connection. The bot token still handles channel messages and DMs.

## Required Slack App Setup

Create a Slack app in the target workspace.

OAuth scopes:

```text
Bot Token Scopes:
channels:history
channels:read
chat:write
im:write

User Token Scopes:
users.profile:write
```

Do not add admin scopes, broad workspace scopes, or `chat:write.public`. Invite the bot to the existing public `#afk` channel instead.

Event subscriptions:

- Request URL: `https://your-domain.example/slack/events`
- Subscribe to bot event: `message.channels`

OAuth redirect URL:

```text
https://your-domain.example/slack/oauth/callback
```

Find the channel ID for `#afk` from Slack channel details and set it as `AFK_CHANNEL_ID`.

## Environment

Copy `.env.example` to `.env` and fill in production values.

Required:

```text
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
AFK_CHANNEL_ID=C0123456789
REDIS_URL=redis://localhost:6379
```

Required for per-user status automation:

```text
SLACK_CLIENT_ID=...
SLACK_CLIENT_SECRET=...
SLACK_OAUTH_REDIRECT_URI=https://your-domain.example/slack/oauth/callback
TOKEN_ENCRYPTION_KEY=at-least-32-random-characters
SLACK_STATUS_ENABLED=true
```

Operational defaults:

```text
PORT=3000
LOG_LEVEL=info
RATE_LIMIT_POINTS=5
RATE_LIMIT_DURATION_SECONDS=60
AFK_QUEUE_NAME=afk-auto-return
SLACK_HISTORY_POLLING_ENABLED=true
SLACK_HISTORY_POLLING_INTERVAL_MS=5000
AFK_STATUS_EMOJI=:sleeping:
AFK_STATUS_TEXT=AFK
```

`SLACK_USER_TOKEN` is optional and only works for the one user who owns that token. For an organization with 30+ active members, use the OAuth flow above.

## Security Design

- Slack request signatures are validated by Bolt using `SLACK_SIGNING_SECRET`.
- Bolt rejects replayed Slack requests outside Slack's timestamp window.
- Events are processed only when `event.channel === AFK_CHANNEL_ID`.
- Bot messages, message subtypes, and self messages are ignored.
- Slack redeliveries are deduplicated in Redis with a 24-hour processed-message key.
- AFK input is capped at 200 characters and parsed with bounded regexes.
- Reasons are sanitized and public confirmations avoid echoing untrusted reason text.
- Per-user OAuth tokens are encrypted at rest in Redis with AES-256-GCM.
- `TOKEN_ENCRYPTION_KEY` is mandatory in production when OAuth is enabled.
- Rate limiting is Redis-backed per user.
- Redis uses append-only persistence and is published only on `127.0.0.1:6379` for local Node.js testing.
- Nginx terminates HTTPS, redirects HTTP to HTTPS, and sets security headers.
- Docker runs the app as a non-root user with a read-only filesystem and dropped Linux capabilities.
- Structured logs redact token, secret, password, authorization, cookie, and key fields.

## Reliability Notes

- Each active user has one Redis session and two BullMQ jobs: one reminder and one auto-expiry.
- Jobs use deterministic IDs per user, so `extend` replaces old reminder/expiry jobs instead of duplicating timers.
- `back` deletes the Redis session and removes pending reminder/expiry jobs.
- If the process restarts, Redis and BullMQ keep delayed jobs and sessions.
- If Slack Events are delayed or unavailable, optional history polling can process new `#afk` messages using `channels:history`.

## Local Development

```bash
npm install
npm test
npm start
```

For a temporary public HTTPS tunnel during Slack setup, point Slack to a tunnel URL that forwards to local port `3000`.

Example Cloudflare Tunnel flow:

```bash
mkdir -p "$HOME/.local/bin"
curl -L --fail https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o "$HOME/.local/bin/cloudflared"
chmod +x "$HOME/.local/bin/cloudflared"

docker compose up -d redis
npm start
cloudflared tunnel --url http://localhost:3000
```

Use the printed `https://...trycloudflare.com` URL for Slack:

```text
Event Request URL:
https://your-tunnel.trycloudflare.com/slack/events

OAuth Redirect URL:
https://your-tunnel.trycloudflare.com/slack/oauth/callback
```

Set `SLACK_OAUTH_REDIRECT_URI` in `.env` to the same OAuth redirect URL and restart `npm start`.

## Docker Deployment

Target: Oracle VM, AWS EC2, or any Linux host with Docker and Docker Compose.

For the GitHub Actions deployment path used by the Oracle server, see [`ORACLE_DEPLOY.md`](ORACLE_DEPLOY.md).

1. Open only ports `80` and `443` in the cloud firewall/security group.
2. Install Docker and Compose.
3. Create `.env` from `.env.example`.
4. Get a Let's Encrypt certificate for your domain.
5. Start the stack.

Example:

```bash
docker compose up --build -d
docker compose logs -f app
```

Health endpoint:

```text
https://your-domain.example/health
```

Expected shape:

```json
{
  "status": "ok",
  "uptime": 12.34,
  "activeSessions": 1,
  "redisConnected": true,
  "queueDepth": 2
}
```

## HTTPS With Let's Encrypt

The included Nginx config expects:

```text
nginx/certs/fullchain.pem
nginx/certs/privkey.pem
```

One simple bootstrap path on a fresh VM:

```bash
sudo certbot certonly --standalone -d your-domain.example --email admin@example.com --agree-tos --no-eff-email
sudo mkdir -p nginx/certs
sudo cp /etc/letsencrypt/live/your-domain.example/fullchain.pem nginx/certs/fullchain.pem
sudo cp /etc/letsencrypt/live/your-domain.example/privkey.pem nginx/certs/privkey.pem
sudo chown -R "$USER":"$USER" nginx/certs
docker compose up --build -d
```

For renewal, run `certbot renew` from cron or systemd and copy the renewed files into `nginx/certs`, then reload Nginx:

```bash
docker compose exec nginx nginx -s reload
```

## Production Hardening Checklist

- Use a dedicated Slack app for this bot.
- Keep scopes exactly as listed above.
- Rotate `SLACK_BOT_TOKEN`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`, and `TOKEN_ENCRYPTION_KEY` on a schedule.
- Store `.env` outside version control and restrict file permissions.
- Back up the Redis volume if AFK state continuity matters during host recovery.
- Monitor `/health`, container restarts, Redis memory, BullMQ failed jobs, and Slack API errors.
- Set log retention and avoid exporting raw logs to systems without secret redaction.
- Run `npm audit` and rebuild images regularly for base image updates.
- Pin the VM firewall to `80/tcp` and `443/tcp`; keep Redis bound to `127.0.0.1`.
- Keep the bot invited only to `#afk` unless you intentionally expand its scope.

## Test Coverage

Current tests cover:

- supported AFK/extend/back command forms
- reason-before-duration parsing
- duration bounds and formatting
- dynamic emoji selection
- mention extraction and reason escaping helpers
- Redis session store behavior
- OAuth token encryption and one-time state consumption
- DM-only notification helper
- log redaction

Run:

```bash
npm test
```
