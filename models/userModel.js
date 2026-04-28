const { getDbPool } = require("../config/db");
const { DEFAULT_PLAN_DURATION_DAYS } = require("../config/planConfig");
const { normalizePlanCode } = require("../services/planService");

let userNoticeColumnsReadyPromise = null;

async function ensureUserNoticeColumns() {
  const pool = getDbPool();
  if (!pool) {
    return;
  }

  if (!userNoticeColumnsReadyPromise) {
    userNoticeColumnsReadyPromise = (async () => {
      const [versionColumns] = await pool.query(
        "SHOW COLUMNS FROM users LIKE 'law_chatbot_notice_accepted_version'",
      );
      if (!Array.isArray(versionColumns) || versionColumns.length === 0) {
        await pool.query(
          "ALTER TABLE users ADD COLUMN law_chatbot_notice_accepted_version varchar(50) DEFAULT NULL AFTER status",
        );
      }

      const [acceptedAtColumns] = await pool.query(
        "SHOW COLUMNS FROM users LIKE 'law_chatbot_notice_accepted_at'",
      );
      if (!Array.isArray(acceptedAtColumns) || acceptedAtColumns.length === 0) {
        await pool.query(
          "ALTER TABLE users ADD COLUMN law_chatbot_notice_accepted_at timestamp NULL DEFAULT NULL AFTER law_chatbot_notice_accepted_version",
        );
      }

      const [responseToneColumns] = await pool.query(
        "SHOW COLUMNS FROM users LIKE 'response_tone'",
      );
      if (!Array.isArray(responseToneColumns) || responseToneColumns.length === 0) {
        await pool.query(
          "ALTER TABLE users ADD COLUMN response_tone varchar(32) NOT NULL DEFAULT 'semi_formal' AFTER law_chatbot_notice_accepted_at",
        );
      }
    })().catch((error) => {
      userNoticeColumnsReadyPromise = null;
      throw error;
    });
  }

  await userNoticeColumnsReadyPromise;
}

class UserModel {
  static async listForAdmin(options = {}) {
    const pool = getDbPool();
    if (!pool) {
      throw new Error("Database connection is required for admin user listing.");
    }

    await ensureUserNoticeColumns();

    const query = String(options.query || "").trim().toLowerCase();
    const limit = Math.max(1, Math.min(200, Number(options.limit || 50)));
    const offset = Math.max(0, Number(options.offset || 0));
    const where = [];
    const params = [];

    if (query) {
      const like = `%${query}%`;
      where.push(
        "(LOWER(email) LIKE ? OR LOWER(name) LIKE ? OR LOWER(google_id) LIKE ?)"
      );
      params.push(like, like, like);
    }

    const [rows] = await pool.query(
      `SELECT id, google_id, email, name, avatar_url, plan, plan_started_at, plan_expires_at,
              premium_expires_at, status, law_chatbot_notice_accepted_version,
              law_chatbot_notice_accepted_at, response_tone, created_at, updated_at
       FROM users
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY updated_at DESC, id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return rows;
  }

  static async countForAdmin(query = "") {
    const pool = getDbPool();
    if (!pool) {
      throw new Error("Database connection is required for admin user count.");
    }

    await ensureUserNoticeColumns();

    const trimmedQuery = String(query || "").trim().toLowerCase();
    const where = [];
    const params = [];

    if (trimmedQuery) {
      const like = `%${trimmedQuery}%`;
      where.push("(LOWER(email) LIKE ? OR LOWER(name) LIKE ? OR LOWER(google_id) LIKE ?)");
      params.push(like, like, like);
    }

    const [rows] = await pool.query(
      `SELECT COUNT(*) AS total_count
       FROM users
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`,
      params,
    );

    return Number(rows[0]?.total_count || 0);
  }

  static async getAdminStats() {
    const pool = getDbPool();
    if (!pool) {
      throw new Error("Database connection is required for admin user stats.");
    }

    await ensureUserNoticeColumns();

    const [rows] = await pool.query(
      `SELECT
          COUNT(*) AS total_count,
          SUM(CASE WHEN plan = 'free' THEN 1 ELSE 0 END) AS free_count,
         SUM(CASE WHEN plan <> 'free' THEN 1 ELSE 0 END) AS paid_count,
          SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_count
       FROM users`
    );

    return rows[0] || {
      total_count: 0,
      free_count: 0,
      paid_count: 0,
      active_count: 0,
    };
  }

  static async findById(userId) {
    const pool = getDbPool();
    if (!pool) {
      throw new Error("Database connection is required for user lookup.");
    }

    await ensureUserNoticeColumns();

    const normalizedUserId = Number(userId || 0);
    if (!normalizedUserId) {
      return null;
    }

    const [rows] = await pool.query(
      `SELECT id, google_id, email, name, avatar_url, plan, plan_started_at, plan_expires_at,
              premium_expires_at, status, law_chatbot_notice_accepted_version,
              law_chatbot_notice_accepted_at, response_tone, created_at, updated_at
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

    await ensureUserNoticeColumns();

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
              premium_expires_at, status, law_chatbot_notice_accepted_version,
              law_chatbot_notice_accepted_at, response_tone, created_at, updated_at
       FROM users
       WHERE google_id = ? OR email = ?
       ORDER BY id DESC
       LIMIT 1`,
      [googleId, email]
    );

    return rows[0] || null;
  }

  static async markLawChatbotNoticeAccepted(userId, version) {
    const pool = getDbPool();
    if (!pool) {
      throw new Error("Database connection is required for notice acceptance persistence.");
    }

    await ensureUserNoticeColumns();

    const normalizedUserId = Number(userId || 0);
    const normalizedVersion = String(version || "").trim();
    if (!normalizedUserId || !normalizedVersion) {
      return false;
    }

    const [result] = await pool.query(
      `UPDATE users
       SET law_chatbot_notice_accepted_version = ?,
           law_chatbot_notice_accepted_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [normalizedVersion, normalizedUserId],
    );

    return Number(result.affectedRows || 0) > 0;
  }

  static async updateResponseTone(userId, responseTone) {
    const pool = getDbPool();
    if (!pool) {
      throw new Error("Database connection is required for response tone update.");
    }

    await ensureUserNoticeColumns();

    const normalizedUserId = Number(userId || 0);
    const normalizedTone = String(responseTone || "").trim().toLowerCase();
    if (!normalizedUserId || !["formal", "semi_formal", "friendly"].includes(normalizedTone)) {
      return null;
    }

    const [result] = await pool.query(
      `UPDATE users
       SET response_tone = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [normalizedTone, normalizedUserId],
    );

    if (Number(result.affectedRows || 0) <= 0) {
      return null;
    }

    return this.findById(normalizedUserId);
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

  static async setPlanByAdmin(userId, planCode, options = {}) {
    const pool = getDbPool();
    if (!pool) {
      throw new Error("Database connection is required for plan update.");
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
    const planStartedAt =
      normalizedPlanCode === "free"
        ? now
        : options.planStartedAt
          ? new Date(options.planStartedAt)
          : now;
    const planExpiresAt =
      normalizedPlanCode === "free"
        ? null
        : options.planExpiresAt
          ? new Date(options.planExpiresAt)
          : new Date(planStartedAt.getTime() + normalizedDays * 24 * 60 * 60 * 1000);

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
