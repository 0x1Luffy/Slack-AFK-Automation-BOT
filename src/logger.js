'use strict';

const fs = require('node:fs');
const path = require('node:path');
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

function createLogger({ env, level, filePath }) {
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

  const transports = [new winston.transports.Console()];

  if (filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    transports.push(
      new winston.transports.File({
        filename: filePath,
        level,
        maxsize: 10 * 1024 * 1024,
        maxFiles: 5,
        tailable: true
      })
    );
  }

  return winston.createLogger({
    level,
    format: winston.format.combine(...base, output),
    transports
  });
}

module.exports = { createLogger, redactValue };
