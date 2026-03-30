const { getDbPool } = require("../config/db");

class MemberModel {
  static async findByUsername(username) {
    const pool = getDbPool();
    if (!pool) {
      throw new Error("Database connection is required for admin login.");
    }

    const [rows] = await pool.query(
      `SELECT m_id, m_user, m_pass, m_group, m_name, m_position, m_status
       FROM member
       WHERE m_user = ?
       LIMIT 1`,
      [username]
    );

    return rows[0] || null;
  }
}

module.exports = MemberModel;
