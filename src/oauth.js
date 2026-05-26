'use strict';

const { WebClient } = require('@slack/web-api');

class SlackOAuthManager {
  constructor({ config, tokenStore, logger }) {
    this.config = config;
    this.tokenStore = tokenStore;
    this.logger = logger;
    this.client = new WebClient();
  }

  isConfigured() {
    return Boolean(this.config.slackClientId && this.config.slackClientSecret && this.config.slackOAuthRedirectUri);
  }

  async createAuthorizeUrl(userId) {
    if (!this.isConfigured()) return null;

    const state = await this.tokenStore.createState(userId);
    const url = new URL('https://slack.com/oauth/v2/authorize');
    url.searchParams.set('client_id', this.config.slackClientId);
    url.searchParams.set('user_scope', 'users.profile:write');
    url.searchParams.set('redirect_uri', this.config.slackOAuthRedirectUri);
    url.searchParams.set('state', state);
    return url.toString();
  }

  registerRoutes(expressApp) {
    expressApp.get('/slack/oauth/callback', async (req, res) => {
      const { code, state, error } = req.query;

      if (error) {
        res.status(400).send(`Slack OAuth failed: ${String(error)}`);
        return;
      }

      if (!code || !state) {
        res.status(400).send('Missing OAuth code or state.');
        return;
      }

      if (!this.isConfigured()) {
        res.status(500).send('Slack OAuth is not configured on this bot.');
        return;
      }

      try {
        const expectedUserId = await this.tokenStore.consumeState(String(state));
        if (!expectedUserId) {
          res.status(400).send('OAuth state expired or invalid. Please run afk again and reconnect.');
          return;
        }

        const result = await this.client.oauth.v2.access({
          client_id: this.config.slackClientId,
          client_secret: this.config.slackClientSecret,
          code: String(code),
          redirect_uri: this.config.slackOAuthRedirectUri
        });

        const authedUser = result.authed_user || {};
        if (!authedUser.id || !authedUser.access_token) {
          res.status(400).send('Slack did not return a user token. Check that users.profile:write is a User Token Scope.');
          return;
        }

        if (authedUser.id !== expectedUserId) {
          res.status(403).send('Connected Slack user does not match the user who requested this link.');
          return;
        }

        await this.tokenStore.saveUserToken(authedUser.id, authedUser.access_token);
        this.logger.info('Slack user OAuth token stored', { userId: authedUser.id });
        res.send('AFK status is connected. You can close this tab and use the AFK bot in Slack.');
      } catch (caughtError) {
        this.logger.error('Slack OAuth callback failed', { error: caughtError });
        res.status(500).send('Slack OAuth callback failed. Check bot logs.');
      }
    });
  }
}

module.exports = { SlackOAuthManager };
