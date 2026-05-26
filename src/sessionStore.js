'use strict';

const ACTIVE_SET_KEY = 'afk:active-users';

class SessionStore {
  constructor(redis) {
    this.redis = redis;
  }

  key(userId) {
    return `afk:session:${userId}`;
  }

  async set(session) {
    const ttlMs = Math.max(1, session.expiresAt - Date.now());
    const pipeline = this.redis.pipeline();
    pipeline.set(this.key(session.userId), JSON.stringify(session), 'PX', ttlMs);
    pipeline.sadd(ACTIVE_SET_KEY, session.userId);
    await pipeline.exec();
    return session;
  }

  async get(userId) {
    const raw = await this.redis.get(this.key(userId));
    if (!raw) {
      await this.redis.srem(ACTIVE_SET_KEY, userId);
      return null;
    }

    try {
      const session = JSON.parse(raw);
      if (!session.expiresAt || session.expiresAt <= Date.now()) {
        await this.delete(userId);
        return null;
      }
      return session;
    } catch {
      await this.delete(userId);
      return null;
    }
  }

  async delete(userId) {
    const pipeline = this.redis.pipeline();
    pipeline.del(this.key(userId));
    pipeline.srem(ACTIVE_SET_KEY, userId);
    await pipeline.exec();
  }

  async activeCount() {
    const userIds = await this.redis.smembers(ACTIVE_SET_KEY);
    if (userIds.length === 0) return 0;

    const keys = userIds.map((userId) => this.key(userId));
    const exists = await this.redis.mget(keys);
    const stale = userIds.filter((_, index) => !exists[index]);

    if (stale.length > 0) {
      await this.redis.srem(ACTIVE_SET_KEY, ...stale);
    }

    return userIds.length - stale.length;
  }
}

module.exports = { ACTIVE_SET_KEY, SessionStore };
