const { getDbPool } = require("../config/db");
const { DEFAULT_PLAN_DURATION_DAYS } = require("../config/planConfig");
const { normalizePlanCode } = require("../services/planService");

class UserModel {
  static async findById(userId) {
    const pool = getDbPool();
    if (!pool) {
      throw new Error("Database connection is required for user lookup.");
    }

    const normalizedUserId = Number(userId || 0);
    if (!normalizedUserId) {
      return null;
    }

    const [rows] = await pool.query(
      `SELECT id, google_id, email, name, avatar_url, plan, plan_started_at, plan_expires_at,
              premium_expires_at, status, created_at, updated_at
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [normalizedUserId]
    );

    return rows[0] || null;
  }

  static async upsertGoogleUser(payload = {}) {
    const pool = getDbPool();
    if (!pool) {
      throw new Error("Database connection is required for Google user persistence.");
    }

    const googleId = String(payload.googleId || "").trim();
    const email = String(payload.email || "").trim().toLowerCase();
    const name = String(payload.name || "").trim();
    const avatarUrl = String(payload.avatarUrl || "").trim();
    const plan = normalizePlanCode(payload.plan || "free");
    const status = String(payload.status || "active").trim() || "active";

    if (!googleId || !email) {
      throw new Error("googleId and email are required.");
    }

    await pool.query(
      `INSERT INTO users (google_id, email, name, avatar_url, plan, plan_started_at, status)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
       ON DUPLICATE KEY UPDATE
         google_id = VALUES(google_id),
         email = VALUES(email),
         name = VALUES(name),
         avatar_url = VALUES(avatar_url),
         updated_at = CURRENT_TIMESTAMP`,
      [googleId, email, name, avatarUrl, plan, status]
    );

    const [rows] = await pool.query(
      `SELECT id, google_id, email, name, avatar_url, plan, plan_started_at, plan_expires_at,
              premium_expires_at, status, created_at, updated_at
       FROM users
       WHERE google_id = ? OR email = ?
       ORDER BY id DESC
       LIMIT 1`,
      [googleId, email]
    );

    return rows[0] || null;
  }

  static async activatePlan(userId, planCode, options = {}) {
    const pool = getDbPool();
    if (!pool) {
      throw new Error("Database connection is required for plan activation.");
    }

    const normalizedUserId = Number(userId || 0);
    const normalizedPlanCode = normalizePlanCode(planCode);
    const normalizedDays = Math.max(
      1,
      Number(options.durationDays || DEFAULT_PLAN_DURATION_DAYS),
    );
    if (!normalizedUserId) {
      return false;
    }

    const currentUser = await this.findById(normalizedUserId);
    if (!currentUser) {
      return false;
    }

    const now = new Date();
    const currentPlanCode = normalizePlanCode(currentUser.plan || "free");
    const currentExpiry = currentUser.plan_expires_at || currentUser.premium_expires_at || null;
    const currentExpiryDate = currentExpiry ? new Date(currentExpiry) : null;
    const isSameActivePlan =
      normalizedPlanCode === currentPlanCode &&
      currentExpiryDate instanceof Date &&
      !Number.isNaN(currentExpiryDate.getTime()) &&
      currentExpiryDate > now;

    const planStartedAt =
      normalizedPlanCode === "free"
        ? now
        : isSameActivePlan && currentUser.plan_started_at
          ? new Date(currentUser.plan_started_at)
          : now;
    const planExpiresAt =
      normalizedPlanCode === "free"
        ? null
        : isSameActivePlan
          ? new Date(currentExpiryDate.getTime() + normalizedDays * 24 * 60 * 60 * 1000)
          : new Date(now.getTime() + normalizedDays * 24 * 60 * 60 * 1000);

    const [result] = await pool.query(
      `UPDATE users
       SET plan = ?,
           plan_started_at = ?,
           plan_expires_at = ?,
           premium_expires_at = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        normalizedPlanCode,
        planStartedAt,
        planExpiresAt,
        normalizedPlanCode === "premium" ? planExpiresAt : null,
        normalizedUserId,
      ]
    );

    return result.affectedRows > 0;
  }

  static async activatePremiumPlan(userId, days = DEFAULT_PLAN_DURATION_DAYS) {
    return this.activatePlan(userId, "premium", {
      durationDays: days,
    });
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
           plan_started_at = CURRENT_TIMESTAMP,
           plan_expires_at = NULL,
           premium_expires_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [normalizedUserId]
    );

    return result.affectedRows > 0;
  }
}

module.exports = UserModel;
