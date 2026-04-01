const { getDbPool } = require("../config/db");

class PaymentRequestModel {
  static async create(payload = {}) {
    const pool = getDbPool();
    if (!pool) {
      throw new Error("Database connection is required for payment requests.");
    }

    const userId = Number(payload.userId || 0);
    const planName = String(payload.planName || "").trim();
    const amount = Number(payload.amount || 0);
    const slipImage = String(payload.slipImage || "").trim();
    const note = String(payload.note || "").trim();
    const status = String(payload.status || "pending").trim() || "pending";

    if (!userId || !planName || !Number.isFinite(amount) || amount <= 0) {
      throw new Error("Invalid payment request payload.");
    }

    const [result] = await pool.query(
      `INSERT INTO payment_requests (user_id, plan_name, amount, slip_image, note, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, planName, amount, slipImage || null, note || null, status]
    );

    return {
      id: result.insertId,
      userId,
      planName,
      amount,
      slipImage,
      note,
      status,
    };
  }

  static async listByUserId(userId, limit = 10) {
    const pool = getDbPool();
    if (!pool) {
      throw new Error("Database connection is required for payment requests.");
    }

    const [rows] = await pool.query(
      `SELECT id, user_id, plan_name, amount, slip_image, note, status, created_at, updated_at
       FROM payment_requests
       WHERE user_id = ?
       ORDER BY id DESC
       LIMIT ?`,
      [Number(userId || 0), Number(limit || 10)]
    );

    return rows;
  }

  static async listAll(limit = 50) {
    const pool = getDbPool();
    if (!pool) {
      throw new Error("Database connection is required for payment requests.");
    }

    const [rows] = await pool.query(
      `SELECT pr.id, pr.user_id, pr.plan_name, pr.amount, pr.slip_image, pr.note, pr.status,
              pr.reviewed_at, pr.reviewed_by, pr.created_at, pr.updated_at,
              u.email AS user_email, u.name AS user_name, u.plan AS user_plan, u.premium_expires_at
       FROM payment_requests pr
       LEFT JOIN users u ON u.id = pr.user_id
       ORDER BY pr.id DESC
       LIMIT ?`,
      [Number(limit || 50)]
    );

    return rows;
  }

  static async findById(id) {
    const pool = getDbPool();
    if (!pool) {
      throw new Error("Database connection is required for payment requests.");
    }

    const [rows] = await pool.query(
      `SELECT pr.id, pr.user_id, pr.plan_name, pr.amount, pr.slip_image, pr.note, pr.status,
              pr.reviewed_at, pr.reviewed_by, pr.created_at, pr.updated_at,
              u.email AS user_email, u.name AS user_name, u.plan AS user_plan, u.premium_expires_at
       FROM payment_requests pr
       LEFT JOIN users u ON u.id = pr.user_id
       WHERE pr.id = ?
       LIMIT 1`,
      [Number(id || 0)]
    );

    return rows[0] || null;
  }

  static async updateReviewStatus(id, status, reviewedBy) {
    const pool = getDbPool();
    if (!pool) {
      throw new Error("Database connection is required for payment review.");
    }

    const normalizedId = Number(id || 0);
    const normalizedStatus = String(status || "").trim().toLowerCase();
    const normalizedReviewer = String(reviewedBy || "").trim();

    if (!normalizedId || !["approved", "rejected"].includes(normalizedStatus)) {
      return false;
    }

    const [result] = await pool.query(
      `UPDATE payment_requests
       SET status = ?,
           reviewed_at = CURRENT_TIMESTAMP,
           reviewed_by = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'pending'`,
      [normalizedStatus, normalizedReviewer || null, normalizedId]
    );

    return result.affectedRows > 0;
  }
}

module.exports = PaymentRequestModel;
