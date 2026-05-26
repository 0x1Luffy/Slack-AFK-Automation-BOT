'use strict';

const { escapeSlackText, formatDuration, formatDurationWords } = require('./parser');

const messages = {
  afkUpdated(durationMs) {
    return `✅ AFK status updated for ${formatDurationWords(durationMs)}`;
  },

  afkExtended(durationMs) {
    return `✅ AFK extended by ${formatDurationWords(durationMs)}`;
  },

  alreadyAfk(userId) {
    return `<@${userId}>, you are already AFK. Reply with \`more 10m\`, \`+10m\`, or \`extend 10m\` to add time.`;
  },

  back(userId) {
    return `✅ Welcome back <@${userId}>`;
  },

  notAfk(userId) {
    return `<@${userId}>, you are not currently marked AFK.`;
  },

  rateLimited(retryAfterSeconds) {
    return `Slow down a touch. You can use AFK commands again in ${retryAfterSeconds}s.`;
  },

  rateLimitedPublic(userId, retryAfterSeconds) {
    return `<@${userId}>, ${messages.rateLimited(retryAfterSeconds)}`;
  },

  statusConnectPrompt(userId, connectUrl) {
    if (connectUrl) {
      return `<@${userId}>, AFK tracking is on. To also set your Slack status emoji automatically, connect once: ${connectUrl}`;
    }

    return `<@${userId}>, AFK tracking is on. Automatic Slack status emoji needs OAuth setup by an admin.`;
  },

  mentionStatus(session, now = Date.now()) {
    return `<@${session.userId}> is AFK for ${formatDuration(session.expiresAt - now)}: ${escapeSlackText(
      session.reason
    )}`;
  },

  reminder() {
    return '⏰ Your AFK ends in 1 minute.';
  },

  expired() {
    return 'AFK expired automatically.';
  }
};

module.exports = { messages };
