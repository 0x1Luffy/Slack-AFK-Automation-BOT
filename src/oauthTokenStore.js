'use strict';

const crypto = require('node:crypto');

class OAuthTokenStore {
  constructor({ redis, encryptionKey }) {
    this.redis = redis;
    this.key = crypto.createHash('sha256').update(String(encryptionKey || 'slack-afk-local-key')).digest();
  }

  tokenKey(userId) {
    return `slack:oauth:user-token:${userId}`;
  }

  stateKey(state) {
    return `slack:oauth:state:${state}`;
  }

  encrypt(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`;
  }

  decrypt(value) {
    const [ivText, tagText, encryptedText] = String(value || '').split('.');
    if (!ivText || !tagText || !encryptedText) return null;

    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivText, 'base64'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedText, 'base64')),
      decipher.final()
    ]).toString('utf8');
  }

  async saveUserToken(userId, token) {
    await this.redis.set(this.tokenKey(userId), this.encrypt(token));
  }

  async getUserToken(userId) {
    const encrypted = await this.redis.get(this.tokenKey(userId));
    return encrypted ? this.decrypt(encrypted) : null;
  }

  async createState(userId) {
    const state = crypto.randomBytes(24).toString('base64url');
    await this.redis.set(this.stateKey(state), userId, 'EX', 600);
    return state;
  }

  async consumeState(state) {
    const key = this.stateKey(state);
    const userId = await this.redis.get(key);
    if (userId) {
      await this.redis.del(key);
    }
    return userId;
  }
}

module.exports = { OAuthTokenStore };
