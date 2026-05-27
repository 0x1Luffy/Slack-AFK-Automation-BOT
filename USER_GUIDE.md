# Slack AFK Automation Bot User Guide

This guide is for beginners who want to run and use this Slack AFK bot without guessing what each step means.

## What This Tool Does

This bot helps a Slack channel know when someone is away.

- A user writes `afk 30m lunch`.
- The bot saves that AFK status in Redis.
- If someone mentions that user in the configured AFK channel, the bot replies in the message thread with the AFK reason and remaining time.
- When the time expires, the bot automatically clears the AFK session.
- If Slack status support is enabled, the bot can also set and clear the user's Slack status emoji.

## Requirements

You need:

- Node.js 20 or newer
- npm
- Redis
- A Slack workspace where you can create or configure a Slack app
- A public HTTPS URL for Slack Events, unless you only test locally with a tunnel

Check Node and npm:

```bash
node --version
npm --version
```

The Node version should be `v20.x` or newer.

## Install The Project

From the project folder:

```bash
npm install
```

Run the tests:

```bash
npm test
```

If tests pass, the code is installed correctly.

## Easiest Start On This Machine

Use this flow when `cloudflared tunnel --url http://localhost:3000` is already running.

Start only Redis with Docker Compose:

```bash
docker compose up -d redis
```

Make sure `.env` uses host-local Redis:

```text
REDIS_URL=redis://127.0.0.1:6379
PORT=3000
```

If Docker Compose app or Nginx containers are running, stop only those so there is not a second bot instance:

```bash
docker compose stop app nginx
```

Start the bot on `localhost:3000`:

```bash
npm start
```

For a background start:

```bash
mkdir -p logs
setsid npm start > logs/local-app.log 2>&1 < /dev/null &
```

Check that the local app is healthy:

```bash
curl http://localhost:3000/health
```

If the existing tunnel is running, this should also work:

```bash
curl https://your-cloudflared-url/health
```

Do not start another Cloudflare tunnel if one is already running. Keep using the same tunnel URL in Slack:

```text
https://your-cloudflared-url/slack/events
https://your-cloudflared-url/slack/oauth/callback
```

## Create The Environment File

Copy the example environment file:

```bash
cp .env.example .env
```

Open `.env` and fill in your real values.

Required values:

```text
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_SIGNING_SECRET=your-signing-secret
AFK_CHANNEL_ID=C0123456789
REDIS_URL=redis://localhost:6379
```

Important:

- Use `redis://127.0.0.1:6379` or `redis://localhost:6379` when running the app directly with `npm start` and Redis is published on your machine.
- Use `redis://redis:6379` when running with Docker Compose. The compose file already sets this value for the app container.

## Slack App Setup

Create a Slack app at Slack's app management page, then configure these settings.

### Bot Token Scopes

Add these bot token scopes:

```text
chat:write
chat:write.public
channels:history
im:write
```

Install the app into your workspace after adding scopes.

### Event Subscriptions

Enable Event Subscriptions.

Use this request URL:

```text
https://your-domain/slack/events
```

Subscribe to this bot event:

```text
message.channels
```

Save the settings.

### Invite Bot To Channel

Invite the bot to the AFK channel:

```text
/invite @your-bot-name
```

The `AFK_CHANNEL_ID` in `.env` must be the channel ID for this same channel.

## Find A Slack Channel ID

In Slack:

1. Open the channel.
2. Click the channel name.
3. Scroll to the bottom of the channel details.
4. Copy the Channel ID.

It usually looks like:

```text
C0123456789
```

## Run Locally With npm

Start Redis first.

If you have Docker Compose installed, the easiest local Redis command is:

```bash
docker compose up -d redis
```

Another option is plain Docker:

```bash
docker run --rm --name slack-afk-redis -p 6379:6379 redis:7-alpine
```

In a second terminal, start the bot:

```bash
npm start
```

You should see a log message saying the Slack AFK bot started.

Check health:

```bash
curl http://localhost:3000/health
```

Example healthy response:

```json
{
  "status": "ok",
  "uptime": 12.34,
  "activeSessions": 0,
  "redisConnected": true,
  "queueDepth": 0
}
```

## Expose Local App To Slack

Slack needs a public HTTPS URL.

One option is `cloudflared`:

```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb
cloudflared tunnel --url http://localhost:3000
```

Copy the HTTPS URL shown by `cloudflared`.

Use this in Slack Event Subscriptions:

```text
https://your-cloudflared-url/slack/events
```

## Use A Permanent Domain With Cloudflare

Use this when you own a domain such as `thunder-env.space` and want the Slack URLs to stay the same every time.

Requirements:

- The domain is added to your Cloudflare account.
- The domain's nameservers point to Cloudflare.
- `cloudflared` is installed on this machine.
- The bot is running on `localhost:3000`.

Log in to Cloudflare once:

```bash
cloudflared tunnel login
```

Create a named tunnel:

```bash
cloudflared tunnel create slack-afk-bot
```

Create the tunnel config file:

```bash
mkdir -p ~/.cloudflared
nano ~/.cloudflared/config.yml
```

Use this config:

```yaml
tunnel: slack-afk-bot
credentials-file: /home/tejas/.cloudflared/YOUR-TUNNEL-ID.json

ingress:
  - hostname: thunder-env.space
    service: http://localhost:3000
  - hostname: www.thunder-env.space
    service: http://localhost:3000
  - service: http_status:404
```

Replace `YOUR-TUNNEL-ID.json` with the JSON credentials file that `cloudflared tunnel create` prints.

Create Cloudflare DNS records for the tunnel:

```bash
cloudflared tunnel route dns slack-afk-bot thunder-env.space
cloudflared tunnel route dns slack-afk-bot www.thunder-env.space
```

Start the permanent tunnel:

```bash
cloudflared tunnel run slack-afk-bot
```

Now use these stable Slack URLs:

```text
https://thunder-env.space/slack/events
https://thunder-env.space/slack/oauth/callback
```

Also update `.env`:

```text
SLACK_OAUTH_REDIRECT_URI=https://thunder-env.space/slack/oauth/callback
```

Then restart the bot:

```bash
pkill -f "node src/index.js"
setsid npm start > logs/local-app.log 2>&1 < /dev/null &
```

Check the domain:

```bash
curl https://thunder-env.space/health
```

After this works, you no longer need the temporary command:

```bash
cloudflared tunnel --url http://localhost:3000
```

If you use the Docker Compose Nginx setup with local TLS, you may tunnel to HTTPS instead:

```bash
cloudflared tunnel --url https://localhost --no-tls-verify
```

## Run With Docker Compose

Docker Compose starts:

- the app
- Redis
- Nginx

Place TLS certificate files here:

```text
nginx/certs/fullchain.pem
nginx/certs/privkey.pem
```

Then run:

```bash
docker compose up --build
```

Check logs:

```bash
docker compose logs -f app
```

Use this mode only when you want Docker Compose to run the app and Nginx too. If you are using `cloudflared tunnel --url http://localhost:3000`, the simpler local setup is usually `docker compose up -d redis` plus `npm start`.

Check health through Nginx:

```bash
curl -k https://localhost/health
```

Stop everything:

```bash
docker compose down
```

Stop and remove Redis data too:

```bash
docker compose down -v
```

## Slack Commands Users Can Type

Use commands inside the configured AFK channel.

### Go AFK

```text
afk 30m lunch
```

```text
afk 1h30m meeting
```

```text
afk 2d vacation
```

The bot replies:

```text
@user is AFK for 30m: lunch
```

### Go AFK Without A Reason

```text
afk 30 min
```

The reason becomes `AFK`.

### Extend AFK Time

```text
afk extend 30m
```

The user must already be AFK.

### Come Back Early

```text
back
```

The bot clears the AFK session and replies:

```text
Welcome back, @user.
```

### Mention An AFK User

If someone writes:

```text
Can @teammate review this?
```

and `@teammate` is AFK, the bot replies in the thread with the remaining time and reason.

## Supported Time Formats

The bot understands days, hours, and minutes.

Examples:

```text
afk 15m coffee
afk 30 min lunch
afk 1h focus time
afk 1h30m appointment
afk 2d vacation
afk 2 days 3 hours 4 minutes travel
```

Invalid examples:

```text
afk 0m test
afk 1x test
please afk 1h
```

Commands must start directly with `afk`, `afk extend`, or `back`.

## Slack Status Emoji Setup

The bot can track AFK without changing Slack profile status.

To automatically set a user's Slack status emoji, Slack requires a user token for that user. A bot token is not enough.

For team use, configure OAuth.

Add this user token scope:

```text
users.profile:write
```

Add this OAuth redirect URL:

```text
https://your-domain/slack/oauth/callback
```

Set these values in `.env`:

```text
SLACK_CLIENT_ID=your-client-id
SLACK_CLIENT_SECRET=your-slack-client-secret
SLACK_OAUTH_REDIRECT_URI=https://your-domain/slack/oauth/callback
TOKEN_ENCRYPTION_KEY=change-this-long-random-secret
SLACK_STATUS_ENABLED=true
AFK_STATUS_EMOJI=:no_entry:
AFK_STATUS_TEXT=AFK
```

When a user goes AFK for the first time, the bot posts a one-time connection link in the thread. After the user connects, their token is stored encrypted in Redis.

You can also use this optional fallback for one user:

```text
SLACK_USER_TOKEN=xoxp-your-user-token-with-users.profile.write
```

That fallback token can only update the Slack status for the user who owns that token.

## Emoji In AFK Reasons

If the AFK reason contains an emoji, the bot can use that emoji for Slack status.

Examples:

```text
afk 30m lunch
afk 30m lunch :ramen:
afk 30m eating :ramen:
```

Food words like `lunch`, `dinner`, `breakfast`, and `snack` are treated as food reasons and can use `:hamburger:` as the status emoji.
Unicode emoji in the reason can also be detected by the bot, then converted to a Slack emoji shortcode when possible.

Use an emoji that exists in your Slack workspace. `:no_entry:` is a safe built-in default.

## Useful Terminal Commands

Install dependencies:

```bash
npm install
```

Run tests:

```bash
npm test
```

Start the app:

```bash
npm start
```

Start local Redis with Docker:

```bash
docker run --rm --name slack-afk-redis -p 6379:6379 redis:7-alpine
```

Check app health:

```bash
curl http://localhost:3000/health
```

View the last 100 local app log lines as JSON:

```bash
curl "http://localhost:3000/logs?key=$LOG_ACCESS_KEY"
```

View plain text logs:

```bash
curl "http://localhost:3000/logs?key=$LOG_ACCESS_KEY&format=text"
```

The `/logs` endpoint reads `logs/local-app.log` and only works when `LOG_ACCESS_KEY` is set in `.env`.

Run everything with Docker Compose:

```bash
docker compose up --build
```

Follow app logs:

```bash
docker compose logs -f app
```

Follow Nginx logs:

```bash
docker compose logs -f nginx
```

Restart the app container:

```bash
docker compose restart app
```

Stop Docker Compose:

```bash
docker compose down
```

## Troubleshooting

### Bot Starts But Does Not Reply

Check that:

- The bot is invited to the AFK channel.
- `AFK_CHANNEL_ID` is correct.
- Slack Event Subscriptions request URL ends with `/slack/events`.
- The Slack app has the `message.channels` bot event.
- The Slack app has `channels:history`.

Check logs:

```bash
docker compose logs -f app
```

If events are not reaching the app, check Nginx logs:

```bash
docker compose logs -f nginx
```

The history poller is enabled by default with:

```text
SLACK_HISTORY_POLLING_ENABLED=true
```

This lets the bot poll channel history as a fallback when Slack Events are not delivered.

### Redis Connection Error

If running with `npm start`, use:

```text
REDIS_URL=redis://127.0.0.1:6379
```

If running with Docker Compose, use:

```text
REDIS_URL=redis://redis:6379
```

### BullMQ Says Custom Id Cannot Contain Colon

Upgrade to the current code and restart the bot. BullMQ does not allow `:` in custom job IDs, so the bot now uses colon-free reminder and auto-return job IDs.

```bash
npm test
pkill -f "node src/index.js"
setsid npm start > logs/local-app.log 2>&1 < /dev/null &
```

Then check health:

```bash
curl http://localhost:3000/health
```

### Slack Status Is Not Updating

Check that:

- `SLACK_STATUS_ENABLED=true`
- OAuth is configured if multiple users need status updates.
- The user clicked the connection link.
- The Slack app has `users.profile:write`.
- The emoji exists in your Slack workspace.

AFK tracking can still work even when Slack status updates are not configured.

### Reminder Or Expiry DM Is Not Sent

The bot sends reminders and automatic expiry messages by opening a Slack DM with the user. Your Slack app must have this Bot Token Scope:

```text
im:write
```

After adding `im:write` in Slack app settings, reinstall the Slack app to the workspace so the bot token gets the new scope.

Then restart the bot:

```bash
pkill -f "node src/index.js"
setsid npm start > logs/local-app.log 2>&1 < /dev/null &
```

For a quick test, type this in the AFK channel:

```text
afk 2mins
```

Expected behavior:

- The bot replies in the thread immediately.
- Around 1 minute later, the bot sends a DM reminder.
- Around 2 minutes later, the bot sends the expiry DM and clears the AFK session.

### Rate Limit Message Appears

The bot limits AFK commands per user.

Defaults:

```text
RATE_LIMIT_POINTS=5
RATE_LIMIT_DURATION_SECONDS=60
```

That means each user can use 5 AFK commands per 60 seconds.

## Quick Start Checklist

1. Run `npm install`.
2. Copy `.env.example` to `.env`.
3. Fill in Slack tokens, signing secret, channel ID, and Redis URL.
4. Start Redis with `docker compose up -d redis`.
5. Run `npm test`.
6. Run `npm start`.
7. Expose the app with an HTTPS tunnel or deploy it behind HTTPS.
8. Set Slack Event Subscriptions to `https://your-domain/slack/events`.
9. Invite the bot to the AFK channel.
10. Test in Slack with `afk 5m testing`.
