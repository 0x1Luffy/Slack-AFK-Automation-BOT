'use strict';

const emoji = require('node-emoji');

const MAX_INPUT_LENGTH = 200;
const COMMANDS = Object.freeze({
  AFK: 'afk',
  EXTEND: 'extend',
  BACK: 'back'
});

const BACK_RE = /^back$/i;
const DURATION_PATTERN =
  '[0-9]{1,3}\\s*(?:days|day|d|hours|hour|hrs|hr|h|minutes|minute|mins|min|m)(?:\\s*[0-9]{1,3}\\s*(?:days|day|d|hours|hour|hrs|hr|h|minutes|minute|mins|min|m))*';
const AFK_RE = new RegExp(`^afk\\s+(${DURATION_PATTERN})(?:\\s+(.{1,160}))?$`, 'i');
const EXTEND_RE = new RegExp(`^afk\\s+extend\\s+(${DURATION_PATTERN})$`, 'i');
const DURATION_PART_RE = /([0-9]{1,3})\s*(days|day|d|hours|hour|hrs|hr|h|minutes|minute|mins|min|m)/gi;
const MENTION_RE = /<@([UW][A-Z0-9]{2,})>/g;
const EMOJI_RE = /:([a-z0-9_+-]+):/i;
const FOOD_KEYWORD_RE =
  /\b(?:lunch|lun+ch|luch|lnch|luunch|dinner|din+er|diner|dinnr|dnner|breakfast|brunch|meal|food|eat|eating|snack|snaks|snackng)\b/i;

function normalizeInput(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_INPUT_LENGTH);
}

function parseDurationToMs(input) {
  const source = String(input || '').toLowerCase().replace(/\s+/g, '');
  let totalMinutes = 0;
  let consumed = '';
  let match;

  DURATION_PART_RE.lastIndex = 0;
  while ((match = DURATION_PART_RE.exec(source)) !== null) {
    const amount = Number.parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    consumed += match[0];

    if (unit.startsWith('d')) totalMinutes += amount * 24 * 60;
    if (unit === 'h' || unit.startsWith('hr') || unit.startsWith('hour')) totalMinutes += amount * 60;
    if (unit === 'm' || unit.startsWith('min')) totalMinutes += amount;
  }

  if (consumed !== source || totalMinutes <= 0) {
    return null;
  }

  return totalMinutes * 60 * 1000;
}

function parseCommand(text) {
  const normalized = normalizeInput(text);
  if (!normalized) return null;

  if (BACK_RE.test(normalized)) {
    return { type: COMMANDS.BACK };
  }

  const extend = EXTEND_RE.exec(normalized);
  if (extend) {
    const durationMs = parseDurationToMs(extend[1]);
    return durationMs ? { type: COMMANDS.EXTEND, durationMs } : null;
  }

  const afk = AFK_RE.exec(normalized);
  if (afk) {
    const durationMs = parseDurationToMs(afk[1]);
    if (!durationMs) return null;
    const reason = (afk[2] || 'AFK').trim();
    const statusEmoji = extractStatusEmoji(reason);

    return {
      type: COMMANDS.AFK,
      durationMs,
      reason,
      ...(statusEmoji ? { statusEmoji } : {})
    };
  }

  return null;
}

function extractStatusEmoji(text) {
  const normalized = normalizeInput(text);
  const match = EMOJI_RE.exec(normalized);
  if (match) return `:${match[1]}:`;

  const unemojified = emoji.unemojify(normalized);
  if (unemojified === normalized) {
    return FOOD_KEYWORD_RE.test(normalized) ? ':hamburger:' : null;
  }

  const convertedMatch = EMOJI_RE.exec(unemojified);
  if (convertedMatch) return `:${convertedMatch[1]}:`;

  return null;
}

function stripStatusEmoji(text) {
  const normalized = normalizeInput(text);
  const emojiName = extractStatusEmoji(normalized);
  if (!emojiName) return normalized;

  const withoutShortcode = normalized.replace(emojiName, '').replace(/\s+/g, ' ').trim();
  if (withoutShortcode !== normalized) return withoutShortcode;

  const unemojified = emoji.unemojify(normalized);
  const withoutUnicode = unemojified.replace(emojiName, '').replace(/\s+/g, ' ').trim();
  return emoji.emojify(withoutUnicode);
}

function extractMentionedUserIds(text) {
  const normalized = normalizeInput(text);
  const ids = new Set();
  let match;

  MENTION_RE.lastIndex = 0;
  while ((match = MENTION_RE.exec(normalized)) !== null) {
    ids.add(match[1]);
  }

  return [...ids];
}

function formatDuration(ms) {
  const totalMinutes = Math.max(0, Math.ceil(ms / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];

  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes || parts.length === 0) parts.push(`${minutes}m`);

  return parts.join(' ');
}

module.exports = {
  COMMANDS,
  MAX_INPUT_LENGTH,
  extractMentionedUserIds,
  extractStatusEmoji,
  formatDuration,
  normalizeInput,
  parseCommand,
  parseDurationToMs,
  stripStatusEmoji
};
