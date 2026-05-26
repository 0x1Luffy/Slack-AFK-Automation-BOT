'use strict';

const emoji = require('node-emoji');

const MAX_INPUT_LENGTH = 200;
const MAX_DURATION_MINUTES = 7 * 24 * 60;
const COMMANDS = Object.freeze({
  AFK: 'afk',
  EXTEND: 'extend',
  BACK: 'back'
});

const BACK_RE = /^back$/i;
const DURATION_PART_PATTERN = '[0-9]{1,3}\\s*(?:days|day|d|hours|hour|hrs|hr|h|minutes|minute|mins|min|m)';
const DURATION_PATTERN = `${DURATION_PART_PATTERN}(?:\\s*${DURATION_PART_PATTERN})*`;
const AFK_BODY_RE = /^afk(?:\s+(.+))?$/i;
const AFK_DURATION_FIRST_RE = new RegExp(`^(${DURATION_PATTERN})(?:\\s+(.{1,160}))?$`, 'i');
const AFK_DURATION_LAST_RE = new RegExp(`^(.{1,160}?)\\s+(${DURATION_PATTERN})$`, 'i');
const EXTEND_RE = new RegExp(`^(?:(?:afk\\s+extend|extend|more)\\s+|\\+\\s*)(${DURATION_PATTERN})$`, 'i');
const DURATION_PART_RE = /([0-9]{1,3})\s*(days|day|d|hours|hour|hrs|hr|h|minutes|minute|mins|min|m)/gi;
const MENTION_RE = /<@([UW][A-Z0-9]{2,})>/g;
const EMOJI_RE = /:([a-z0-9_+-]+):/i;
const LUNCH_KEYWORD_RE =
  /\b(?:lunch|lun+ch|luch|lnch|luunch|dinner|din+er|diner|dinnr|dnner|breakfast|brunch|meal|food|eat|eating|snack|snaks|snackng)\b/i;
const MEETING_KEYWORD_RE = /\b(?:meeting|meet|call|standup|sync|interview|demo|discussion)\b/i;
const BREAK_KEYWORD_RE = /\b(?:break|coffee|tea|chai|rest)\b/i;

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

  if (consumed !== source || totalMinutes <= 0 || totalMinutes > MAX_DURATION_MINUTES) {
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

  const afk = AFK_BODY_RE.exec(normalized);
  if (afk) {
    const parsed = parseAfkBody(afk[1]);
    if (!parsed) return null;
    const statusEmoji = extractStatusEmoji(parsed.reason);

    return {
      type: COMMANDS.AFK,
      durationMs: parsed.durationMs,
      reason: parsed.reason,
      statusEmoji
    };
  }

  return null;
}

function parseAfkBody(body) {
  const normalized = normalizeInput(body);
  if (!normalized) return null;

  const durationFirst = AFK_DURATION_FIRST_RE.exec(normalized);
  if (durationFirst) {
    const durationMs = parseDurationToMs(durationFirst[1]);
    if (!durationMs) return null;
    return {
      durationMs,
      reason: sanitizeReason(durationFirst[2] || 'AFK')
    };
  }

  const durationLast = AFK_DURATION_LAST_RE.exec(normalized);
  if (!durationLast) return null;

  const durationMs = parseDurationToMs(durationLast[2]);
  if (!durationMs) return null;
  return {
    durationMs,
    reason: sanitizeReason(durationLast[1] || 'AFK')
  };
}

function sanitizeReason(reason) {
  const normalized = normalizeInput(reason).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120).trim();
  return normalized || 'AFK';
}

function extractStatusEmoji(text) {
  const normalized = normalizeInput(text);
  const match = EMOJI_RE.exec(normalized);
  if (match) return `:${match[1]}:`;

  const unemojified = emoji.unemojify(normalized);
  if (unemojified === normalized) {
    if (LUNCH_KEYWORD_RE.test(normalized)) return ':hamburger:';
    if (MEETING_KEYWORD_RE.test(normalized)) return ':telephone_receiver:';
    if (BREAK_KEYWORD_RE.test(normalized)) return ':coffee:';
    return ':sleeping:';
  }

  const convertedMatch = EMOJI_RE.exec(unemojified);
  if (convertedMatch) return `:${convertedMatch[1]}:`;

  return ':sleeping:';
}

function escapeSlackText(text) {
  return normalizeInput(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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

function formatDurationWords(ms) {
  const totalMinutes = Math.max(0, Math.ceil(ms / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];

  if (days) parts.push(`${days} ${days === 1 ? 'day' : 'days'}`);
  if (hours) parts.push(`${hours} ${hours === 1 ? 'hr' : 'hrs'}`);
  if (minutes || parts.length === 0) parts.push(`${minutes} ${minutes === 1 ? 'min' : 'mins'}`);

  return parts.join(' ');
}

module.exports = {
  COMMANDS,
  MAX_DURATION_MINUTES,
  MAX_INPUT_LENGTH,
  escapeSlackText,
  extractMentionedUserIds,
  extractStatusEmoji,
  formatDuration,
  formatDurationWords,
  normalizeInput,
  parseCommand,
  parseDurationToMs,
  sanitizeReason,
  stripStatusEmoji
};
