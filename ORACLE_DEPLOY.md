# Oracle Ubuntu Deployment

This deploy path keeps production secrets on the Oracle server and uses GitHub Actions only to pull/build/restart the app.

Server:

```text
ubuntu@140.238.229.225
```

## What Runs Where

- GitHub Actions runs tests on every push to `master`.
- If tests pass, GitHub Actions SSHs into the Oracle server.
- The repo is deployed to `/opt/slack-afk-bot/app`.
- The production `.env` stays only on the server at `/opt/slack-afk-bot/.env`.
- Docker Compose runs `app` and `redis`.
- The app listens only on server-local `127.0.0.1:3000`.
- Put Cloudflare Tunnel or another HTTPS reverse proxy in front of `127.0.0.1:3000`.

## One-Time Server Setup

SSH into the server:

```bash
ssh ubuntu@140.238.229.225
```

Install Git and Docker Engine:

```bash
sudo apt update
sudo apt install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
```

Allow the `ubuntu` user to run Docker without sudo:

```bash
sudo usermod -aG docker ubuntu
```

Log out and SSH back in so the group change applies.

Create the deployment folder:

```bash
sudo mkdir -p /opt/slack-afk-bot
sudo chown ubuntu:ubuntu /opt/slack-afk-bot
chmod 700 /opt/slack-afk-bot
```

## Where To Keep `.env`

Keep production `.env` here:

```text
/opt/slack-afk-bot/.env
```

Create it on the server:

```bash
nano /opt/slack-afk-bot/.env
chmod 600 /opt/slack-afk-bot/.env
```

Use production values. For Docker deployment, Redis must be:

```text
REDIS_URL=redis://redis:6379
```

Example shape:

```text
NODE_ENV=production
PORT=3000
LOG_LEVEL=info
LOG_ACCESS_KEY=use-a-long-random-value
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_USER_TOKEN=xoxp-your-user-token-if-needed
SLACK_CLIENT_ID=your-client-id
SLACK_CLIENT_SECRET=your-client-secret
SLACK_OAUTH_REDIRECT_URI=https://thunder-env.space/slack/oauth/callback
TOKEN_ENCRYPTION_KEY=at-least-32-random-characters
SLACK_SIGNING_SECRET=your-signing-secret
AFK_CHANNEL_ID=C0123456789
REDIS_URL=redis://redis:6379
RATE_LIMIT_POINTS=5
RATE_LIMIT_DURATION_SECONDS=60
AFK_QUEUE_NAME=afk-auto-return
SLACK_HISTORY_POLLING_ENABLED=true
SLACK_HISTORY_POLLING_INTERVAL_MS=5000
SLACK_STATUS_ENABLED=true
AFK_STATUS_EMOJI=:no_entry:
AFK_STATUS_TEXT=AFK
```

Never put production `.env` in GitHub.

## GitHub Actions SSH Setup

Create a deploy key on your own machine:

```bash
ssh-keygen -t ed25519 -C "github-actions-slack-afk" -f ~/.ssh/slack_afk_oracle_deploy
```

Copy the public key to the server:

```bash
ssh-copy-id -i ~/.ssh/slack_afk_oracle_deploy.pub ubuntu@140.238.229.225
```

In GitHub, open the repo:

```text
Settings -> Secrets and variables -> Actions
```

Add these repository secrets:

```text
ORACLE_HOST=140.238.229.225
ORACLE_USER=ubuntu
ORACLE_PORT=22
ORACLE_SSH_KEY=<contents of ~/.ssh/slack_afk_oracle_deploy>
```

Do not use the `.pub` file for `ORACLE_SSH_KEY`. Use the private key file contents.

Optional repository variable:

```text
DEPLOY_ROOT=/opt/slack-afk-bot
```

## Deploy

Push to `master`, or run the workflow manually:

```text
Actions -> Deploy to Oracle Ubuntu -> Run workflow
```

The workflow uses:

```text
.github/workflows/deploy-oracle.yml
```

It runs:

```bash
docker compose -f docker-compose.yml -f docker-compose.server.yml up -d --remove-orphans app redis
```

## Verify On Server

SSH into the server:

```bash
ssh ubuntu@140.238.229.225
```

Check containers:

```bash
cd /opt/slack-afk-bot/app
docker compose -f docker-compose.yml -f docker-compose.server.yml ps
```

Check health:

```bash
curl http://127.0.0.1:3000/health
```

Check protected logs:

```bash
set -a
. /opt/slack-afk-bot/.env
set +a
curl "http://127.0.0.1:3000/logs?key=$LOG_ACCESS_KEY"
```

## HTTPS For Slack

Slack needs HTTPS. The GitHub Action deploys the app on local port `3000`; expose it with Cloudflare Tunnel or another HTTPS proxy.

For Cloudflare Tunnel on the Oracle server, the tunnel service should point to:

```text
http://localhost:3000
```

Then Slack URLs should be:

```text
https://thunder-env.space/slack/events
https://thunder-env.space/slack/oauth/callback
```

Also set the same OAuth callback in `/opt/slack-afk-bot/.env`:

```text
SLACK_OAUTH_REDIRECT_URI=https://thunder-env.space/slack/oauth/callback
```

## Safe Rollback

SSH into the server:

```bash
cd /opt/slack-afk-bot/app
git log --oneline -5
git reset --hard <old-commit-sha>
docker compose -f docker-compose.yml -f docker-compose.server.yml up -d --build app redis
```
