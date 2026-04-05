const { getDbPool } = require("../config/db");

const inMemoryGuestUsage = new Map();

function buildMemoryKey(identityType, identityHash, usageMonth) {
  return [String(identityType || ""), String(identityHash || ""), String(usageMonth || "")].join(":");
}

function normalizeIdentityType(value = "") {
  return String(value || "").trim().toLowerCase();
}

function buildAdminFilters(options = {}) {
  const usageMonth = String(options.usageMonth || "").trim();
  const query = String(options.query || "").trim().toLowerCase();
  const identityType = normalizeIdentityType(options.identityType);

  return { usageMonth, query, identityType };
}

class GuestMonthlyUsageModel {
  static getYearMonth(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    return `${year}-${month}`;
  }

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

  static async listForAdmin(options = {}) {
    const { query, usageMonth, identityType } = buildAdminFilters({
      ...options,
      usageMonth: options.usageMonth || this.getYearMonth(),
    });
    const limit = Math.max(1, Math.min(5000, Number(options.limit || 100)));
    const offset = Math.max(0, Number(options.offset || 0));
    const pool = getDbPool();

    if (!pool) {
      return Array.from(inMemoryGuestUsage.values())
        .filter((item) => {
          if (usageMonth && String(item.usage_month || "") !== usageMonth) {
            return false;
          }

          if (identityType && String(item.identity_type || "").trim().toLowerCase() !== identityType) {
            return false;
          }

          if (!query) {
            return true;
          }

          return [item.identity_type, item.identity_hash, item.usage_month]
            .some((value) => String(value || "").toLowerCase().includes(query));
        })
        .sort((left, right) => new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime())
        .slice(offset, offset + limit);
    }

    const filters = [];
    const params = [];

    if (usageMonth) {
      filters.push("usage_month = ?");
      params.push(usageMonth);
    }

    if (identityType) {
      filters.push("identity_type = ?");
      params.push(identityType);
    }

    if (query) {
      filters.push("(identity_type LIKE ? OR identity_hash LIKE ?)");
      params.push(`%${query}%`, `%${query}%`);
    }

    const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const [rows] = await pool.query(
      `SELECT id, identity_type, identity_hash, usage_month, question_count, last_used_at, created_at, updated_at
       FROM guest_monthly_usage
       ${whereClause}
       ORDER BY question_count DESC, updated_at DESC, id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    return rows;
  }

  static async countForAdmin(options = {}) {
    const { query, usageMonth, identityType } = buildAdminFilters({
      ...options,
      usageMonth: options.usageMonth || this.getYearMonth(),
    });
    const pool = getDbPool();

    if (!pool) {
      return Array.from(inMemoryGuestUsage.values()).filter((item) => {
        if (usageMonth && String(item.usage_month || "") !== usageMonth) {
          return false;
        }

        if (identityType && String(item.identity_type || "").trim().toLowerCase() !== identityType) {
          return false;
        }

        if (!query) {
          return true;
        }

        return [item.identity_type, item.identity_hash, item.usage_month]
          .some((value) => String(value || "").toLowerCase().includes(query));
      }).length;
    }

    const filters = [];
    const params = [];

    if (usageMonth) {
      filters.push("usage_month = ?");
      params.push(usageMonth);
    }

    if (identityType) {
      filters.push("identity_type = ?");
      params.push(identityType);
    }

    if (query) {
      filters.push("(identity_type LIKE ? OR identity_hash LIKE ?)");
      params.push(`%${query}%`, `%${query}%`);
    }

    const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS total_count
       FROM guest_monthly_usage
       ${whereClause}`,
      params,
    );

    return Number(rows[0]?.total_count || 0);
  }

  static async getAdminStats(options = {}) {
    const { usageMonth, identityType } = buildAdminFilters({
      ...options,
      usageMonth: options.usageMonth || this.getYearMonth(),
    });
    const blockedThreshold = Math.max(1, Number(options.blockedThreshold || 2));
    const pool = getDbPool();

    if (!pool) {
      const rows = await this.listForAdmin({ usageMonth, identityType, limit: 5000 });
      const identityTypeCounts = rows.reduce((counts, item) => {
        const key = String(item.identity_type || "unknown");
        counts[key] = Number(counts[key] || 0) + 1;
        return counts;
      }, {});

      return {
        totalCount: rows.length,
        blockedCount: rows.filter((item) => Number(item.question_count || 0) >= blockedThreshold).length,
        maxQuestionCount: rows.reduce((max, item) => Math.max(max, Number(item.question_count || 0)), 0),
        cookieCount: Number(identityTypeCounts.cookie || 0),
        networkCount: Number(identityTypeCounts.network || 0),
        deviceHintCount: Number(identityTypeCounts.device_hint || 0),
      };
    }

    const filters = ["usage_month = ?"];
    const params = [blockedThreshold, usageMonth];
    if (identityType) {
      filters.push("identity_type = ?");
      params.push(identityType);
    }

    const [rows] = await pool.query(
      `SELECT
         COUNT(*) AS total_count,
         SUM(CASE WHEN question_count >= ? THEN 1 ELSE 0 END) AS blocked_count,
         MAX(question_count) AS max_question_count,
         SUM(CASE WHEN identity_type = 'cookie' THEN 1 ELSE 0 END) AS cookie_count,
         SUM(CASE WHEN identity_type = 'network' THEN 1 ELSE 0 END) AS network_count,
         SUM(CASE WHEN identity_type = 'device_hint' THEN 1 ELSE 0 END) AS device_hint_count
       FROM guest_monthly_usage
       WHERE ${filters.join(" AND ")}`,
      params,
    );

    const stats = rows[0] || {};
    return {
      totalCount: Number(stats.total_count || 0),
      blockedCount: Number(stats.blocked_count || 0),
      maxQuestionCount: Number(stats.max_question_count || 0),
      cookieCount: Number(stats.cookie_count || 0),
      networkCount: Number(stats.network_count || 0),
      deviceHintCount: Number(stats.device_hint_count || 0),
    };
  }

  static async deleteForAdmin(options = {}) {
    const id = Number(options.id || 0);
    const { usageMonth, query, identityType } = buildAdminFilters({
      ...options,
      usageMonth: options.usageMonth || this.getYearMonth(),
    });
    const pool = getDbPool();

    if (!pool) {
      let deletedCount = 0;
      Array.from(inMemoryGuestUsage.entries()).forEach(([key, item]) => {
        const matchesId = id ? String(item.id) === String(id) : true;
        const matchesMonth = usageMonth ? String(item.usage_month || "") === usageMonth : true;
        const matchesType = identityType ? String(item.identity_type || "").trim().toLowerCase() === identityType : true;
        const matchesQuery = query
          ? [item.identity_type, item.identity_hash, item.usage_month].some((value) => String(value || "").toLowerCase().includes(query))
          : true;

        if (matchesId && matchesMonth && matchesType && matchesQuery) {
          inMemoryGuestUsage.delete(key);
          deletedCount += 1;
        }
      });

      return deletedCount;
    }

    const filters = [];
    const params = [];

    if (id) {
      filters.push("id = ?");
      params.push(id);
    }

    if (usageMonth) {
      filters.push("usage_month = ?");
      params.push(usageMonth);
    }

    if (identityType) {
      filters.push("identity_type = ?");
      params.push(identityType);
    }

    if (query) {
      filters.push("(identity_type LIKE ? OR identity_hash LIKE ?)");
      params.push(`%${query}%`, `%${query}%`);
    }

    if (!filters.length) {
      return 0;
    }

    const [result] = await pool.query(
      `DELETE FROM guest_monthly_usage WHERE ${filters.join(" AND ")}`,
      params,
    );

    return Number(result.affectedRows || 0);
  }
}

module.exports = GuestMonthlyUsageModel;