const { getDbPool } = require("../config/db");

const inMemoryGuestUsage = new Map();

function buildMemoryKey(identityType, identityHash, usageMonth) {
  return [String(identityType || ""), String(identityHash || ""), String(usageMonth || "")].join(":");
}

class GuestMonthlyUsageModel {
  static async findByIdentity(identityType, identityHash, usageMonth) {
    const normalizedType = String(identityType || "").trim();
    const normalizedHash = String(identityHash || "").trim();
    const normalizedMonth = String(usageMonth || "").trim();
    if (!normalizedType || !normalizedHash || !normalizedMonth) {
      return null;
    }

    const pool = getDbPool();
    if (!pool) {
      return inMemoryGuestUsage.get(buildMemoryKey(normalizedType, normalizedHash, normalizedMonth)) || null;
    }

    const [rows] = await pool.query(
      `SELECT id, identity_type, identity_hash, usage_month, question_count, last_used_at, created_at, updated_at
       FROM guest_monthly_usage
       WHERE identity_type = ? AND identity_hash = ? AND usage_month = ?
       LIMIT 1`,
      [normalizedType, normalizedHash, normalizedMonth],
    );

    return rows[0] || null;
  }

  static async setQuestionCount(identityType, identityHash, usageMonth, questionCount) {
    const normalizedType = String(identityType || "").trim();
    const normalizedHash = String(identityHash || "").trim();
    const normalizedMonth = String(usageMonth || "").trim();
    const normalizedCount = Math.max(0, Number(questionCount || 0));
    if (!normalizedType || !normalizedHash || !normalizedMonth) {
      return null;
    }

    const pool = getDbPool();
    if (!pool) {
      const record = {
        id: buildMemoryKey(normalizedType, normalizedHash, normalizedMonth),
        identity_type: normalizedType,
        identity_hash: normalizedHash,
        usage_month: normalizedMonth,
        question_count: normalizedCount,
        last_used_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      inMemoryGuestUsage.set(buildMemoryKey(normalizedType, normalizedHash, normalizedMonth), record);
      return record;
    }

    await pool.query(
      `INSERT INTO guest_monthly_usage (
         identity_type,
         identity_hash,
         usage_month,
         question_count,
         last_used_at,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON DUPLICATE KEY UPDATE
         question_count = GREATEST(question_count, VALUES(question_count)),
         last_used_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP`,
      [normalizedType, normalizedHash, normalizedMonth, normalizedCount],
    );

    return this.findByIdentity(normalizedType, normalizedHash, normalizedMonth);
  }

  static async syncQuestionCount(identities = [], usageMonth, questionCount) {
    const normalizedMonth = String(usageMonth || "").trim();
    const normalizedCount = Math.max(0, Number(questionCount || 0));
    const uniqueIdentities = Array.from(
      new Map(
        (Array.isArray(identities) ? identities : [])
          .map((identity) => {
            const identityType = String(identity?.identityType || "").trim();
            const identityHash = String(identity?.identityHash || "").trim();
            if (!identityType || !identityHash) {
              return null;
            }

            return [buildMemoryKey(identityType, identityHash, normalizedMonth), { identityType, identityHash }];
          })
          .filter(Boolean),
      ).values(),
    );

    if (!normalizedMonth || !uniqueIdentities.length) {
      return [];
    }

    const results = [];
    for (const identity of uniqueIdentities) {
      results.push(
        await this.setQuestionCount(identity.identityType, identity.identityHash, normalizedMonth, normalizedCount),
      );
    }
    return results;
  }
}

module.exports = GuestMonthlyUsageModel;