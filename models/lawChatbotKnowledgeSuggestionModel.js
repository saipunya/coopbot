const { getDbPool } = require("../config/db");
const {
  getQueryFocusProfile,
  hasExclusiveMeaningMismatch,
  makeBigrams,
  normalizeForSearch,
  scoreQueryFocusAlignment,
  segmentWords,
  uniqueTokens,
} = require("../services/thaiTextUtils");

const memorySuggestions = [];

const GENERIC_THAI_TOKENS = new Set([
  "การ",
  "เรื่อง",
  "เกี่ยวกับ",
  "ของ",
  "ใน",
  "ที่",
  "และ",
  "หรือ",
  "ตาม",
  "เพื่อ",
  "จาก",
  "โดย",
  "ให้",
  "ได้",
  "ไม่",
]);

function normalizeEntry(entry = {}) {
  return {
    target: entry.target === "group" ? "group" : "coop",
    title: String(entry.title || "").trim().slice(0, 255),
    content: String(entry.content || "").trim(),
    sourceType: String(entry.sourceType || "text").trim().slice(0, 30) || "text",
    submittedBy: String(entry.submittedBy || "").trim().slice(0, 255),
    submittedByUserId: Number(entry.submittedByUserId || 0) > 0 ? Number(entry.submittedByUserId) : null,
    submitterSession: String(entry.submitterSession || "").trim().slice(0, 255),
    submitterIp: String(entry.submitterIp || "").trim().slice(0, 80),
    status: ["pending", "approved", "rejected"].includes(entry.status) ? entry.status : "pending",
    reviewedBy: String(entry.reviewedBy || "").trim().slice(0, 255),
    reviewNote: String(entry.reviewNote || "").trim().slice(0, 255),
  };
}

function mapRow(row) {
  return {
    id: row.id,
    target: row.target === "group" ? "group" : "coop",
    title: row.title || "",
    content: row.content || "",
    sourceType: row.source_type || row.sourceType || "text",
    submittedBy: row.submitted_by || row.submittedBy || "",
    submittedByUserId: Number(row.submitted_by_user_id || row.submittedByUserId || 0) || null,
    submitterSession: row.submitter_session || row.submitterSession || "",
    submitterIp: row.submitter_ip || row.submitterIp || "",
    status: row.status || "pending",
    reviewedBy: row.reviewed_by || row.reviewedBy || "",
    reviewNote: row.review_note || row.reviewNote || "",
    createdAt: row.created_at || row.createdAt || "",
    reviewedAt: row.reviewed_at || row.reviewedAt || "",
    updatedAt: row.updated_at || row.updatedAt || "",
  };
}

function getMeaningfulTokens(text) {
  return uniqueTokens(segmentWords(text)).filter((token) => {
    const trimmed = String(token || "").trim();
    if (!trimmed) {
      return false;
    }

    if (GENERIC_THAI_TOKENS.has(trimmed)) {
      return false;
    }

    return trimmed.length >= 2;
  });
}

function scoreSuggestionMatch(query, row) {
  const normalizedQuery = normalizeForSearch(query).toLowerCase();
  const focusProfile = getQueryFocusProfile(query);
  const rowText = normalizeForSearch(
    `${row.title || ""} ${row.content || ""} ${row.review_note || row.reviewNote || ""}`,
  ).toLowerCase();
  const queryTokens = uniqueTokens(segmentWords(query));
  const rowTokens = uniqueTokens(segmentWords(rowText));
  const rowTokenSet = new Set(rowTokens);
  const queryBigrams = makeBigrams(queryTokens);

  let score = 0;

  if (normalizedQuery && rowText.includes(normalizedQuery)) {
    score += 26;
  }

  const tokenHits = queryTokens.filter((token) => rowTokenSet.has(token)).length;
  score += tokenHits * 8;

  for (const bigram of queryBigrams) {
    if (rowText.includes(bigram)) {
      score += 10;
    }
  }

  const coverage = queryTokens.length > 0 ? tokenHits / queryTokens.length : 0;
  score += coverage * 18;
  score += scoreQueryFocusAlignment(
    query,
    `${row.title || ""} ${row.content || ""} ${row.review_note || row.reviewNote || ""}`,
  );

  if (String(row.title || "").trim()) {
    score += 6;
  }

  if (
    focusProfile.intent === "identity" &&
    normalizedQuery &&
    normalizeForSearch(row.title || "").toLowerCase() === normalizedQuery
  ) {
    score += 24;
  }

  if (
    hasExclusiveMeaningMismatch(
      query,
      `${row.title || ""} ${row.content || ""} ${row.review_note || row.reviewNote || ""}`,
    )
  ) {
    score -= 120;
  }

  return score;
}

function hasSuggestionRelevance(query, row) {
  if (
    hasExclusiveMeaningMismatch(
      query,
      `${row.title || ""} ${row.content || ""} ${row.review_note || row.reviewNote || ""}`,
    )
  ) {
    return false;
  }

  const normalizedQuery = normalizeForSearch(query).toLowerCase();
  const focusProfile = getQueryFocusProfile(query);
  const rowText = normalizeForSearch(
    `${row.title || ""} ${row.content || ""} ${row.review_note || row.reviewNote || ""}`,
  ).toLowerCase();
  const queryTokens = getMeaningfulTokens(query);
  const rowTokenSet = new Set(getMeaningfulTokens(rowText));
  const tokenHits = queryTokens.filter((token) => rowTokenSet.has(token)).length;
  const hasExactPhrase = normalizedQuery && rowText.includes(normalizedQuery);
  const queryBigrams = makeBigrams(queryTokens);
  const hasBigramMatch = queryBigrams.some((bigram) => rowText.includes(bigram));
  const focusScore = scoreQueryFocusAlignment(query, rowText);
  const primaryTopic = focusProfile.topics[0]?.primary || "";
  const matchesPrimaryTopic = primaryTopic ? rowText.includes(primaryTopic) : false;

  if (queryTokens.length === 0) {
    return false;
  }

  if (focusProfile.intent === "identity") {
    return hasExactPhrase || hasBigramMatch || matchesPrimaryTopic || focusScore >= 24 || tokenHits >= 2;
  }

  if (queryTokens.length > 1 && !(hasExactPhrase || hasBigramMatch)) {
    const isTypeOrCountQuestion = /(กี่|จำนวน|ประเภท|ชนิด|แบบ|ลักษณะ|เท่าไร|เท่าไหร่)/.test(normalizedQuery);
    const minimumHits = isTypeOrCountQuestion ? 1 : queryTokens.length;
    return tokenHits >= minimumHits;
  }

  return tokenHits >= 1;
}

let tableReadyPromise = null;

async function ensureTable() {
  const pool = getDbPool();
  if (!pool) {
    return;
  }

  if (!tableReadyPromise) {
    tableReadyPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS chatbot_knowledge_suggestions (
          id INT AUTO_INCREMENT PRIMARY KEY,
          target ENUM('coop', 'group') NOT NULL DEFAULT 'coop',
          title VARCHAR(255) NOT NULL,
          content TEXT NOT NULL,
          source_type VARCHAR(30) NOT NULL DEFAULT 'text',
          submitted_by VARCHAR(255) NULL,
          submitter_session VARCHAR(255) NULL,
          submitter_ip VARCHAR(80) NULL,
          status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
          reviewed_by VARCHAR(255) NULL,
          review_note VARCHAR(255) NULL,
          reviewed_at DATETIME NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_chatbot_knowledge_suggestions_status_created (status, created_at),
          INDEX idx_chatbot_knowledge_suggestions_target_status (target, status)
        )
      `);

      const [submittedByUserIdColumns] = await pool.query(
        "SHOW COLUMNS FROM chatbot_knowledge_suggestions LIKE 'submitted_by_user_id'",
      );

      if (!Array.isArray(submittedByUserIdColumns) || submittedByUserIdColumns.length === 0) {
        await pool.query(`
          ALTER TABLE chatbot_knowledge_suggestions
            ADD COLUMN submitted_by_user_id INT NULL AFTER submitted_by,
            ADD INDEX idx_chatbot_knowledge_suggestions_submitter_user_status (submitted_by_user_id, status)
        `);
      }
    })().catch((error) => {
      tableReadyPromise = null;
      throw error;
    });
  }

  await tableReadyPromise;
}

class LawChatbotKnowledgeSuggestionModel {
  static async create(entry) {
    const normalized = normalizeEntry(entry);
    const pool = getDbPool();

    if (!pool) {
      const record = {
        id: memorySuggestions.length + 1,
        createdAt: new Date().toISOString(),
        ...normalized,
      };
      memorySuggestions.unshift(record);
      return mapRow(record);
    }

    await ensureTable();
    const [result] = await pool.query(
      `INSERT INTO chatbot_knowledge_suggestions
        (target, title, content, source_type, submitted_by, submitted_by_user_id, submitter_session, submitter_ip, status, reviewed_by, review_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        normalized.target,
        normalized.title,
        normalized.content,
        normalized.sourceType,
        normalized.submittedBy || null,
        normalized.submittedByUserId,
        normalized.submitterSession || null,
        normalized.submitterIp || null,
        normalized.status,
        normalized.reviewedBy || null,
        normalized.reviewNote || null,
      ],
    );

    return {
      id: result.insertId,
      ...normalized,
      createdAt: new Date().toISOString(),
    };
  }

  static async countPending() {
    const pool = getDbPool();
    if (!pool) {
      return memorySuggestions.filter((item) => item.status === "pending").length;
    }

    await ensureTable();
    const [rows] = await pool.query(
      "SELECT COUNT(*) AS total FROM chatbot_knowledge_suggestions WHERE status = 'pending'",
    );
    return rows[0]?.total || 0;
  }

  static async countApprovedByContributor(contributor = {}) {
    const normalizedUserId = Number(contributor.userId || contributor.submittedByUserId || 0);
    if (!normalizedUserId) {
      return 0;
    }

    const pool = getDbPool();
    if (!pool) {
      return memorySuggestions.filter(
        (item) => item.status === "approved" && Number(item.submittedByUserId || 0) === normalizedUserId,
      ).length;
    }

    await ensureTable();
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS total
         FROM chatbot_knowledge_suggestions
        WHERE status = 'approved'
          AND submitted_by_user_id = ?`,
      [normalizedUserId],
    );

    return Number(rows[0]?.total || 0);
  }

  static async listPending(limit = 20, offset = 0) {
    const pool = getDbPool();
    const normalizedLimit = Math.max(1, Number(limit || 20));
    const normalizedOffset = Math.max(0, Number(offset || 0));
    if (!pool) {
      return memorySuggestions
        .filter((item) => item.status === "pending")
        .slice(normalizedOffset, normalizedOffset + normalizedLimit)
        .map(mapRow);
    }

    await ensureTable();
    const [rows] = await pool.query(
      `SELECT id, target, title, content, source_type, submitted_by, submitter_session,
              submitter_ip, status, reviewed_by, review_note, reviewed_at, created_at
         FROM chatbot_knowledge_suggestions
        WHERE status = 'pending'
        ORDER BY id DESC
        LIMIT ? OFFSET ?`,
      [normalizedLimit, normalizedOffset],
    );

    return rows.map(mapRow);
  }

  static async findById(id) {
    const normalizedId = Number(id || 0);
    if (!normalizedId) {
      return null;
    }

    const pool = getDbPool();
    if (!pool) {
      const found = memorySuggestions.find((item) => Number(item.id) === normalizedId);
      return found ? mapRow(found) : null;
    }

    await ensureTable();
    const [rows] = await pool.query(
      `SELECT id, target, title, content, source_type, submitted_by, submitter_session,
              submitter_ip, status, reviewed_by, review_note, reviewed_at, created_at, updated_at
         FROM chatbot_knowledge_suggestions
        WHERE id = ?
        LIMIT 1`,
      [normalizedId],
    );

    return rows[0] ? mapRow(rows[0]) : null;
  }

  static async updatePendingSuggestion(id, patch = {}) {
    const normalizedId = Number(id || 0);
    if (!normalizedId) {
      return false;
    }

    const normalizedPatch = {
      target: patch.target === "group" ? "group" : "coop",
      title: String(patch.title || "").trim().slice(0, 255),
      content: String(patch.content || "").trim(),
      reviewNote: String(patch.reviewNote || "").trim().slice(0, 255),
    };

    if (!normalizedPatch.title || !normalizedPatch.content) {
      return false;
    }

    const pool = getDbPool();
    if (!pool) {
      const record = memorySuggestions.find(
        (item) => Number(item.id) === normalizedId && item.status === "pending",
      );
      if (!record) {
        return false;
      }

      Object.assign(record, {
        target: normalizedPatch.target,
        title: normalizedPatch.title,
        content: normalizedPatch.content,
        reviewNote: normalizedPatch.reviewNote,
        updatedAt: new Date().toISOString(),
      });
      return true;
    }

    await ensureTable();
    const [result] = await pool.query(
      `UPDATE chatbot_knowledge_suggestions
       SET target = ?,
           title = ?,
           content = ?,
           review_note = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
         AND status = 'pending'`,
      [
        normalizedPatch.target,
        normalizedPatch.title,
        normalizedPatch.content,
        normalizedPatch.reviewNote || null,
        normalizedId,
      ],
    );

    return result.affectedRows > 0;
  }

  static async searchApproved(message, target = "all", limit = 5) {
    const terms = uniqueTokens(segmentWords(message)).slice(0, 8);
    if (terms.length === 0) {
      return [];
    }

    const pool = getDbPool();
    if (!pool) {
      return memorySuggestions
        .filter((item) => item.status === "approved")
        .map((row) => {
          const isRelevant = hasSuggestionRelevance(message, row);
          if (!isRelevant) {
            return null;
          }

          const haystack = normalizeForSearch(
            `${row.title || ""} ${row.content || ""} ${row.reviewNote || ""}`,
          ).toLowerCase();
          const coarseScore = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
          const score =
            scoreSuggestionMatch(message, {
              title: row.title,
              content: row.content,
              reviewNote: row.reviewNote,
            }) + coarseScore;

          return {
            id: row.id,
            target: row.target,
            title: row.title,
            content: row.content,
            source: "knowledge_suggestion",
            reference: row.title || "ข้อเสนอจากผู้ใช้งานที่ได้รับอนุมัติ",
            comment: row.reviewNote || "",
            score,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt || row.reviewedAt || "",
          };
        })
        .filter(Boolean)
        .filter((row) => (target === "all" ? true : row.target === target) && row.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    }

    await ensureTable();
    const whereClause = terms
      .map(() => "(LOWER(title) LIKE ? OR LOWER(content) LIKE ? OR LOWER(review_note) LIKE ?)")
      .join(" OR ");
    const params = terms.flatMap((term) => {
      const like = `%${term}%`;
      return [like, like, like];
    });

    const sql =
      target === "all"
        ? `SELECT id, target, title, content, review_note, created_at, updated_at
           FROM chatbot_knowledge_suggestions
           WHERE status = 'approved' AND (${whereClause})
           ORDER BY id DESC
           LIMIT 50`
        : `SELECT id, target, title, content, review_note, created_at, updated_at
           FROM chatbot_knowledge_suggestions
           WHERE status = 'approved' AND target = ? AND (${whereClause})
           ORDER BY id DESC
           LIMIT 50`;
    const sqlParams = target === "all" ? params : [target, ...params];

    const [rows] = await pool.query(sql, sqlParams);

    return rows
      .map((row) => {
        if (!hasSuggestionRelevance(message, row)) {
          return null;
        }

        return {
          id: row.id,
          target: row.target === "group" ? "group" : "coop",
          title: row.title || "",
          content: row.content || "",
          source: "knowledge_suggestion",
          reference: row.title || "ข้อเสนอจากผู้ใช้งานที่ได้รับอนุมัติ",
          comment: row.review_note || "",
          score: scoreSuggestionMatch(message, row),
          createdAt: row.created_at || "",
          updatedAt: row.updated_at || "",
        };
      })
      .filter(Boolean)
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  static async updateStatus(id, status, reviewMeta = {}) {
    const normalizedId = Number(id || 0);
    if (!normalizedId || !["approved", "rejected"].includes(status)) {
      return false;
    }

    const normalizedMeta = normalizeEntry({
      status,
      reviewedBy: reviewMeta.reviewedBy || "",
      reviewNote: reviewMeta.reviewNote || "",
    });

    const pool = getDbPool();
    if (!pool) {
      const found = memorySuggestions.find((item) => Number(item.id) === normalizedId);
      if (!found) {
        return false;
      }

      found.status = status;
      found.reviewedBy = normalizedMeta.reviewedBy;
      found.reviewNote = normalizedMeta.reviewNote;
      found.reviewedAt = new Date().toISOString();
      return true;
    }

    await ensureTable();
    const [result] = await pool.query(
      `UPDATE chatbot_knowledge_suggestions
          SET status = ?, reviewed_by = ?, review_note = ?, reviewed_at = NOW()
        WHERE id = ? AND status = 'pending'
        LIMIT 1`,
      [
        status,
        normalizedMeta.reviewedBy || null,
        normalizedMeta.reviewNote || null,
        normalizedId,
      ],
    );

    return Number(result.affectedRows || 0) > 0;
  }
}

module.exports = LawChatbotKnowledgeSuggestionModel;
