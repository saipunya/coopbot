const { getDbPool } = require("../config/db");

const inMemorySearchHistory = [];

function normalizeTimestamp(value, fallback = new Date()) {
  const date = value instanceof Date ? value : new Date(value || fallback);
  if (Number.isNaN(date.getTime())) {
    return fallback;
  }
  return date;
}

class UserSearchHistoryModel {
  static async create(payload = {}) {
    const userId = Number(payload.userId || 0);
    const questionText = String(payload.questionText || "").trim();
    if (!userId || !questionText) {
      return null;
    }

    const planCode = String(payload.planCode || "free").trim().toLowerCase() || "free";
    const target = String(payload.target || "all").trim().toLowerCase() || "all";
    const answerPreview = String(payload.answerPreview || "").trim();
    const createdAt = normalizeTimestamp(payload.createdAt);
    const expiresAt = payload.expiresAt ? normalizeTimestamp(payload.expiresAt, createdAt) : null;
    const pool = getDbPool();

    if (!pool) {
      const record = {
        id: inMemorySearchHistory.length + 1,
        user_id: userId,
        plan_code: planCode,
        target,
        question_text: questionText,
        answer_preview: answerPreview,
        created_at: createdAt.toISOString(),
        expires_at: expiresAt ? expiresAt.toISOString() : null,
      };

      inMemorySearchHistory.unshift(record);
      return record;
    }

    const [result] = await pool.query(
      `INSERT INTO user_search_history (
         user_id,
         plan_code,
         target,
         question_text,
         answer_preview,
         created_at,
         expires_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        planCode,
        target,
        questionText,
        answerPreview || null,
        createdAt,
        expiresAt,
      ],
    );

    return {
      id: result.insertId,
      user_id: userId,
      plan_code: planCode,
      target,
      question_text: questionText,
      answer_preview: answerPreview,
      created_at: createdAt,
      expires_at: expiresAt,
    };
  }

  static async listActiveByUserId(userId, limit = 50) {
    const normalizedUserId = Number(userId || 0);
    const normalizedLimit = Math.max(1, Number(limit || 50));
    if (!normalizedUserId) {
      return [];
    }

    const pool = getDbPool();
    if (!pool) {
      const now = Date.now();
      return inMemorySearchHistory
        .filter((item) => {
          if (Number(item.user_id || 0) !== normalizedUserId) {
            return false;
          }

          if (!item.expires_at) {
            return true;
          }

          const expiresAt = new Date(item.expires_at).getTime();
          return !Number.isNaN(expiresAt) && expiresAt > now;
        })
        .sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime())
        .slice(0, normalizedLimit);
    }

    const [rows] = await pool.query(
      `SELECT id, user_id, plan_code, target, question_text, answer_preview, created_at, expires_at
       FROM user_search_history
       WHERE user_id = ?
         AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
      [normalizedUserId, normalizedLimit],
    );

    return rows;
  }

  static async deleteExpired() {
    const pool = getDbPool();
    if (!pool) {
      const now = Date.now();
      for (let index = inMemorySearchHistory.length - 1; index >= 0; index -= 1) {
        const item = inMemorySearchHistory[index];
        if (!item?.expires_at) {
          continue;
        }

        const expiresAt = new Date(item.expires_at).getTime();
        if (!Number.isNaN(expiresAt) && expiresAt <= now) {
          inMemorySearchHistory.splice(index, 1);
        }
      }
      return true;
    }

    await pool.query(
      `DELETE FROM user_search_history
       WHERE expires_at IS NOT NULL
         AND expires_at <= CURRENT_TIMESTAMP`,
    );
    return true;
  }
}

module.exports = UserSearchHistoryModel;
