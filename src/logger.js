'use strict';

const winston = require('winston');

const SENSITIVE_KEY = /(token|secret|password|authorization|cookie|key)/i;

function redactValue(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') {
    return value;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack
    };
  }

  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactValue(child, seen)
    ])
  );
}

function createLogger({ env, level }) {
  const redactFormat = winston.format((info) => {
    for (const [key, value] of Object.entries(info)) {
      info[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactValue(value);
    }
    return info;
  })();
  const base = [redactFormat, winston.format.timestamp(), winston.format.errors({ stack: true })];
  const output =
    env === 'production'
      ? winston.format.json()
      : winston.format.combine(
          winston.format.colorize(),
          winston.format.printf(({ level: lvl, message, timestamp, stack, ...meta }) => {
            const suffix = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
            return `${timestamp} ${lvl}: ${stack || message}${suffix}`;
          })
        );

  return winston.createLogger({
    level,
    format: winston.format.combine(...base, output),
    transports: [new winston.transports.Console()]
  });
}

module.exports = { createLogger, redactValue };
