const session = require("express-session");
const { getDbPool, hasDbConfig } = require("../config/db");

const DEFAULT_TTL_MS = 1000 * 60 * 60 * 8;
const DEFAULT_CLEANUP_INTERVAL_MS = 1000 * 60 * 15;
const SESSION_TABLE_NAME = "sessions";

function parseSessionExpiry(sessionData, defaultTtlMs) {
  const expiresAt = new Date(sessionData?.cookie?.expires || "").getTime();
  if (Number.isFinite(expiresAt) && expiresAt > 0) {
    return expiresAt;
  }

  const maxAge = Number(
    sessionData?.cookie?.originalMaxAge || sessionData?.cookie?.maxAge || defaultTtlMs
  );
  if (Number.isFinite(maxAge) && maxAge > 0) {
    return Date.now() + maxAge;
  }

  return Date.now() + defaultTtlMs;
}

class MySqlSessionStore extends session.Store {
  constructor(options = {}) {
    super();
    this.defaultTtlMs = Number(options.defaultTtlMs || DEFAULT_TTL_MS);
    this.cleanupIntervalMs = Number(options.cleanupIntervalMs || DEFAULT_CLEANUP_INTERVAL_MS);
    this.fallbackStore = options.fallbackStore || new session.MemoryStore();
    this.lastCleanupAt = 0;
    this.storeType = "mysql";
  }

  getPool() {
    return getDbPool();
  }

  getActiveStoreType() {
    return this.getPool() ? "mysql" : "memory-fallback";
  }

  maybeCleanupExpiredSessions(pool) {
    if (!pool) {
      return Promise.resolve();
    }

    const now = Date.now();
    if (now - this.lastCleanupAt < this.cleanupIntervalMs) {
      return Promise.resolve();
    }

    this.lastCleanupAt = now;
    return pool
      .query(`DELETE FROM ${SESSION_TABLE_NAME} WHERE expires_at < ?`, [now])
      .catch((error) => {
        console.error("Failed to clean up expired sessions:", error.message);
      });
  }

  get(sid, callback) {
    const pool = this.getPool();
    if (!pool) {
      return this.fallbackStore.get(sid, callback);
    }

    pool
      .query(`SELECT sess, expires_at FROM ${SESSION_TABLE_NAME} WHERE sid = ? LIMIT 1`, [sid])
      .then(async ([rows]) => {
        const row = rows[0];
        if (!row) {
          return callback(null, null);
        }

        if (Number(row.expires_at || 0) <= Date.now()) {
          await pool.query(`DELETE FROM ${SESSION_TABLE_NAME} WHERE sid = ?`, [sid]);
          return callback(null, null);
        }

        try {
          return callback(null, JSON.parse(row.sess));
        } catch (error) {
          return callback(error);
        }
      })
      .catch((error) => {
        callback(error);
      });
  }

  set(sid, sessionData, callback) {
    const pool = this.getPool();
    if (!pool) {
      return this.fallbackStore.set(sid, sessionData, callback);
    }

    const serializedSession = JSON.stringify(sessionData);
    const expiresAt = parseSessionExpiry(sessionData, this.defaultTtlMs);

    this.maybeCleanupExpiredSessions(pool);

    pool
      .query(
        `INSERT INTO ${SESSION_TABLE_NAME} (sid, sess, expires_at)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE
           sess = VALUES(sess),
           expires_at = VALUES(expires_at),
           updated_at = CURRENT_TIMESTAMP()`,
        [sid, serializedSession, expiresAt]
      )
      .then(() => callback && callback(null))
      .catch((error) => {
        callback && callback(error);
      });
  }

  touch(sid, sessionData, callback) {
    const pool = this.getPool();
    if (!pool) {
      return this.fallbackStore.touch(sid, sessionData, callback);
    }

    const expiresAt = parseSessionExpiry(sessionData, this.defaultTtlMs);

    this.maybeCleanupExpiredSessions(pool);

    pool
      .query(
        `UPDATE ${SESSION_TABLE_NAME}
         SET expires_at = ?, updated_at = CURRENT_TIMESTAMP()
         WHERE sid = ?`,
        [expiresAt, sid]
      )
      .then(() => callback && callback(null))
      .catch((error) => {
        callback && callback(error);
      });
  }

  destroy(sid, callback) {
    const pool = this.getPool();
    if (!pool) {
      return this.fallbackStore.destroy(sid, callback);
    }

    pool
      .query(`DELETE FROM ${SESSION_TABLE_NAME} WHERE sid = ?`, [sid])
      .then(() => callback && callback(null))
      .catch((error) => {
        callback && callback(error);
      });
  }
}

function createSessionStore(options = {}) {
  if (!hasDbConfig()) {
    const memoryStore = new session.MemoryStore();
    memoryStore.storeType = "memory";
    memoryStore.getActiveStoreType = () => "memory";
    return memoryStore;
  }

  return new MySqlSessionStore(options);
}

module.exports = {
  MySqlSessionStore,
  createSessionStore,
};
