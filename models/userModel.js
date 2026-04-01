const { getDbPool } = require("../config/db");

class UserModel {
  static async upsertGoogleUser(payload = {}) {
    const pool = getDbPool();
    if (!pool) {
      throw new Error("Database connection is required for Google user persistence.");
    }

    const googleId = String(payload.googleId || "").trim();
    const email = String(payload.email || "").trim().toLowerCase();
    const name = String(payload.name || "").trim();
    const avatarUrl = String(payload.avatarUrl || "").trim();
    const plan = String(payload.plan || "free").trim() || "free";
    const status = String(payload.status || "active").trim() || "active";

    if (!googleId || !email) {
      throw new Error("googleId and email are required.");
    }

    await pool.query(
      `INSERT INTO users (google_id, email, name, avatar_url, plan, status)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         google_id = VALUES(google_id),
         email = VALUES(email),
         name = VALUES(name),
         avatar_url = VALUES(avatar_url),
         updated_at = CURRENT_TIMESTAMP`,
      [googleId, email, name, avatarUrl, plan, status]
    );

    const [rows] = await pool.query(
      `SELECT id, google_id, email, name, avatar_url, plan, premium_expires_at, status, created_at, updated_at
       FROM users
       WHERE google_id = ? OR email = ?
       ORDER BY id DESC
       LIMIT 1`,
      [googleId, email]
    );

    return rows[0] || null;
  }

  static async activatePremiumPlan(userId, days = 30) {
    const pool = getDbPool();
    if (!pool) {
      throw new Error("Database connection is required for premium activation.");
    }

    const normalizedUserId = Number(userId || 0);
    const normalizedDays = Math.max(1, Number(days || 30));
    if (!normalizedUserId) {
      return false;
    }

    const [result] = await pool.query(
      `UPDATE users
       SET plan = 'premium',
           premium_expires_at = CASE
             WHEN premium_expires_at IS NOT NULL AND premium_expires_at > CURRENT_TIMESTAMP
               THEN DATE_ADD(premium_expires_at, INTERVAL ? DAY)
             ELSE DATE_ADD(CURRENT_TIMESTAMP, INTERVAL ? DAY)
           END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [normalizedDays, normalizedDays, normalizedUserId]
    );

    return result.affectedRows > 0;
  }

  static async downgradeToFree(userId) {
    const pool = getDbPool();
    if (!pool) {
      throw new Error("Database connection is required for plan update.");
    }

    const normalizedUserId = Number(userId || 0);
    if (!normalizedUserId) {
      return false;
    }

    const [result] = await pool.query(
      `UPDATE users
       SET plan = 'free',
           premium_expires_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [normalizedUserId]
    );

    return result.affectedRows > 0;
  }
}

module.exports = UserModel;
