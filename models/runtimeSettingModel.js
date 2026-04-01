const { getDbPool } = require("../config/db");

class RuntimeSettingModel {
  static async findByKey(settingKey) {
    const pool = getDbPool();
    if (!pool) {
      throw new Error("Database connection is required for runtime settings.");
    }

    const normalizedKey = String(settingKey || "").trim();
    if (!normalizedKey) {
      return null;
    }

    const [rows] = await pool.query(
      `SELECT setting_key, setting_value, updated_by, created_at, updated_at
       FROM runtime_settings
       WHERE setting_key = ?
       LIMIT 1`,
      [normalizedKey]
    );

    return rows[0] || null;
  }

  static async upsert(settingKey, settingValue, updatedBy = "") {
    const pool = getDbPool();
    if (!pool) {
      throw new Error("Database connection is required for runtime settings.");
    }

    const normalizedKey = String(settingKey || "").trim();
    if (!normalizedKey) {
      throw new Error("settingKey is required.");
    }

    await pool.query(
      `INSERT INTO runtime_settings (setting_key, setting_value, updated_by)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         setting_value = VALUES(setting_value),
         updated_by = VALUES(updated_by),
         updated_at = CURRENT_TIMESTAMP`,
      [normalizedKey, String(settingValue || ""), String(updatedBy || "").trim() || null]
    );

    return this.findByKey(normalizedKey);
  }
}

module.exports = RuntimeSettingModel;
