const { getDbPool } = require("../config/db");

class UserMonthlyUsageModel {
  static getYearMonth(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    return `${year}-${month}`;
  }

  static async findByUserAndMonth(userId, usageMonth) {
    const pool = getDbPool();
    if (!pool) {
      throw new Error("Database connection is required for monthly usage tracking.");
    }

    const [rows] = await pool.query(
      `SELECT id, user_id, usage_month, question_count, last_used_at
       FROM user_monthly_usage
       WHERE user_id = ? AND usage_month = ?
       LIMIT 1`,
      [Number(userId || 0), String(usageMonth || "").trim()]
    );

    return rows[0] || null;
  }

  static async incrementQuestionCount(userId, usageMonth) {
    const pool = getDbPool();
    if (!pool) {
      throw new Error("Database connection is required for monthly usage tracking.");
    }

    await pool.query(
      `INSERT INTO user_monthly_usage (user_id, usage_month, question_count, last_used_at)
       VALUES (?, ?, 1, CURRENT_TIMESTAMP)
       ON DUPLICATE KEY UPDATE
         question_count = question_count + 1,
         last_used_at = CURRENT_TIMESTAMP`,
      [Number(userId || 0), String(usageMonth || "").trim()]
    );

    return this.findByUserAndMonth(userId, usageMonth);
  }
}

module.exports = UserMonthlyUsageModel;
