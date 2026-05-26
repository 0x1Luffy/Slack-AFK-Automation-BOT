'use strict';

const { WebClient } = require('@slack/web-api');

class SlackStatusManager {
  constructor({ token, enabled, emoji, text, tokenStore, oauthManager, logger }) {
    this.enabled = enabled;
    this.emoji = emoji;
    this.text = text;
    this.logger = logger;
    this.fallbackClient = token ? new WebClient(token) : null;
    this.fallbackUserId = null;
    this.tokenStore = tokenStore;
    this.oauthManager = oauthManager;
    this.warnedMissingToken = false;
    this.warnedMismatchedUserIds = new Set();
  }

  async init() {
    if (!this.enabled || !this.fallbackClient) return;

    try {
      const auth = await this.fallbackClient.auth.test();
      this.fallbackUserId = auth.user_id;
      this.logger.info('Slack fallback status token authenticated', { userId: this.fallbackUserId });
    } catch (error) {
      this.logger.error('Slack fallback status token authentication failed', { error });
    }
  }

  async getClientForUser(userId) {
    if (!this.enabled) return { ok: false, reason: 'disabled' };

    const storedToken = this.tokenStore ? await this.tokenStore.getUserToken(userId) : null;
    if (storedToken) {
      return { ok: true, client: new WebClient(storedToken), source: 'oauth' };
    }

    if (this.fallbackClient && this.fallbackUserId === userId) {
      return { ok: true, client: this.fallbackClient, source: 'fallback' };
    }

    if (this.fallbackClient && this.fallbackUserId && this.fallbackUserId !== userId) {
      if (!this.warnedMismatchedUserIds.has(userId)) {
        this.warnedMismatchedUserIds.add(userId);
        this.logger.warn('Fallback Slack user token cannot update this user status', {
          commandUserId: userId,
          tokenUserId: this.fallbackUserId
        });
      }
    }

    if (!this.warnedMissingToken) {
      this.warnedMissingToken = true;
      this.logger.warn('Slack status updates need per-user OAuth connection');
    }

    const connectUrl = this.oauthManager ? await this.oauthManager.createAuthorizeUrl(userId) : null;
    return { ok: false, reason: 'missing_user_oauth', connectUrl };
  }

  async setAfk(userId, expiresAt, reason, statusEmoji) {
    const target = await this.getClientForUser(userId);
    if (!target.ok) return target;

    const emoji = statusEmoji || this.emoji;

    try {
      await target.client.users.profile.set({
        profile: {
          status_text: `${this.text}: ${String(reason || '').slice(0, 90)}`.slice(0, 100),
          status_emoji: emoji,
          status_expiration: Math.floor(expiresAt / 1000)
        }
      });
      this.logger.info('Slack AFK status set', { userId, emoji, expiresAt, source: target.source });
      return { ok: true };
    } catch (error) {
      if (statusEmoji && error && error.data && error.data.error === 'profile_status_set_failed_not_valid_emoji') {
        this.logger.warn('Command emoji is not valid for Slack status; falling back to configured emoji', {
          userId,
          statusEmoji,
          fallbackEmoji: this.emoji
        });
        await this.setAfk(userId, expiresAt, reason, null);
        return { ok: true };
      }

      this.logger.error('Failed to set Slack AFK status', { userId, emoji, error });
      return { ok: false, reason: 'slack_error' };
    }
  }

  async clearAfk(userId) {
    const target = await this.getClientForUser(userId);
    if (!target.ok) return target;

    try {
      await target.client.users.profile.set({
        profile: {
          status_text: '',
          status_emoji: ''
        }
      });
      this.logger.info('Slack AFK status cleared', { userId, source: target.source });
      return { ok: true };
    } catch (error) {
      this.logger.error('Failed to clear Slack AFK status', { userId, error });
      return { ok: false, reason: 'slack_error' };
    }
  }
}

module.exports = { SlackStatusManager };
