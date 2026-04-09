const { getDbPool } = require("../config/db");
const {
  hasExclusiveMeaningMismatch,
  makeBigrams,
  normalizeForSearch,
  scoreQueryFocusAlignment,
  segmentWords,
  uniqueTokens,
} = require("../services/thaiTextUtils");

const memoryKnowledgeEntries = [];

function normalizeKnowledgeDomain(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["legal", "general", "mixed"].includes(normalized) ? normalized : "general";
}

function normalizeKnowledgeReviewStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["approved", "archived"].includes(normalized) ? normalized : "approved";
}

function normalizeKnowledgeSourceId(value) {
  const normalized = Number(value || 0);
  return normalized > 0 ? normalized : null;
}

function normalizeKnowledgeTarget(value, fallback = "general") {
  const normalized = String(value || "").trim().toLowerCase();
  return ["coop", "group", "all", "general"].includes(normalized) ? normalized : fallback;
}

function normalizeEntry(entry) {
  return {
    domain: normalizeKnowledgeDomain(entry.domain),
    target: normalizeKnowledgeTarget(entry.target),
    title: String(entry.title || "").trim().slice(0, 255),
    lawNumber: String(entry.lawNumber || "").trim().slice(0, 100),
    content: String(entry.content || "").trim(),
    sourceNote: String(entry.sourceNote || "").trim().slice(0, 255),
    sourceId: normalizeKnowledgeSourceId(entry.sourceId || entry.source_id),
    reviewStatus: normalizeKnowledgeReviewStatus(entry.reviewStatus || entry.review_status),
  };
}

function scoreKnowledgeMatch(query, row) {
  const normalizedQuery = normalizeForSearch(query).toLowerCase();
  const rowText = normalizeForSearch(
    `${row.title || ""} ${row.law_number || row.lawNumber || ""} ${row.content || ""} ${row.source_note || row.sourceNote || ""}`,
  ).toLowerCase();
  const queryTokens = uniqueTokens(segmentWords(query));
  const rowTokens = uniqueTokens(segmentWords(rowText));
  const rowTokenSet = new Set(rowTokens);
  const queryBigrams = makeBigrams(queryTokens);

  let score = 0;

  if (normalizedQuery && rowText.includes(normalizedQuery)) {
    score += 28;
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
    `${row.title || ""} ${row.law_number || row.lawNumber || ""} ${row.content || ""} ${row.source_note || row.sourceNote || ""}`,
  );

  if (String(row.title || row.law_number || row.lawNumber || "").trim()) {
    score += 8;
  }

  if (
    hasExclusiveMeaningMismatch(
      query,
      `${row.title || ""} ${row.law_number || row.lawNumber || ""} ${row.content || ""} ${row.source_note || row.sourceNote || ""}`,
    )
  ) {
    score -= 120;
  }

  return score;
}

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

function hasKnowledgeRelevance(query, row) {
  if (
    hasExclusiveMeaningMismatch(
      query,
      `${row.title || ""} ${row.law_number || row.lawNumber || ""} ${row.content || ""} ${row.source_note || row.sourceNote || ""}`,
    )
  ) {
    return false;
  }

  const normalizedQuery = normalizeForSearch(query).toLowerCase();
  const rowText = normalizeForSearch(
    `${row.title || ""} ${row.law_number || row.lawNumber || ""} ${row.content || ""} ${row.source_note || row.sourceNote || ""}`,
  ).toLowerCase();
  const queryTokens = getMeaningfulTokens(query);
  const rowTokenSet = new Set(getMeaningfulTokens(rowText));
  const tokenHits = queryTokens.filter((token) => rowTokenSet.has(token)).length;
  const hasExactPhrase = normalizedQuery && rowText.includes(normalizedQuery);
  const queryBigrams = makeBigrams(queryTokens);
  const hasBigramMatch = queryBigrams.some((bigram) => rowText.includes(bigram));

  if (queryTokens.length === 0) {
    return false;
  }

  // If the query has multiple important words, the document must contain all of them,
  // unless a more specific phrase or bigram matches.
  if (queryTokens.length > 1 && !(hasExactPhrase || hasBigramMatch)) {
    const isTypeOrCountQuestion = /(กี่|จำนวน|ประเภท|ชนิด|แบบ|ลักษณะ|เท่าไร|เท่าไหร่)/.test(normalizedQuery);
    const minimumHits = isTypeOrCountQuestion ? 1 : queryTokens.length;
    return tokenHits >= minimumHits;
  }

  // For single-word queries, at least one hit is required.
  return tokenHits >= 1;
}

function mapRow(row) {
  return {
    id: row.id,
    domain: row.domain || "general",
    target: normalizeKnowledgeTarget(row.target, "general"),
    title: row.title || "ฐานความรู้ภายในระบบ",
    lawNumber: row.law_number || row.lawNumber || "",
    content: row.content || "",
    sourceNote: row.source_note || row.sourceNote || "",
    sourceId: Number(row.source_id || row.sourceId || 0) || null,
    reviewStatus: row.review_status || row.reviewStatus || "approved",
    source: "admin_knowledge",
    reference: row.law_number || row.title || "ฐานความรู้ภายในระบบ",
    comment: row.source_note || row.sourceNote || "",
    score: scoreKnowledgeMatch(row.title || row.content || "", row),
    createdAt: row.created_at || row.createdAt || "",
    updatedAt: row.updated_at || row.updatedAt || "",
  };
}

class LawChatbotKnowledgeModel {
  static async create(entry) {
    const normalized = normalizeEntry(entry);
    const pool = getDbPool();

    if (!pool) {
      const record = {
        id: memoryKnowledgeEntries.length + 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...normalized,
      };
      memoryKnowledgeEntries.unshift(record);
      return mapRow({
        id: record.id,
        domain: record.domain,
        target: record.target,
        title: record.title,
        law_number: record.lawNumber,
        content: record.content,
        source_note: record.sourceNote,
        source_id: record.sourceId,
        review_status: record.reviewStatus,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
      });
    }

    const [result] = await pool.query(
      `INSERT INTO chatbot_knowledge
        (domain, target, title, law_number, content, source_note, source_id, review_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        normalized.domain,
        normalized.target,
        normalized.title || null,
        normalized.lawNumber || null,
        normalized.content || null,
        normalized.sourceNote || null,
        normalized.sourceId,
        normalized.reviewStatus,
      ],
    );

    return {
      id: result.insertId,
      ...normalized,
      source: "admin_knowledge",
      reference: normalized.lawNumber || normalized.title || "ฐานความรู้ภายในระบบ",
      comment: normalized.sourceNote || "",
      score: 0,
    };
  }

  static async count() {
    const pool = getDbPool();

    if (!pool) {
      return memoryKnowledgeEntries.length;
    }

    const [rows] = await pool.query("SELECT COUNT(*) AS total FROM chatbot_knowledge");
    return rows[0]?.total || 0;
  }

  static async findById(id) {
    const normalizedId = Number(id || 0);
    if (!normalizedId) {
      return null;
    }

    const pool = getDbPool();

    if (!pool) {
      const found = memoryKnowledgeEntries.find((row) => Number(row.id) === normalizedId);
      if (!found) {
        return null;
      }

      return mapRow({
        id: found.id,
        domain: found.domain,
        target: found.target,
        title: found.title,
        law_number: found.lawNumber,
        content: found.content,
        source_note: found.sourceNote,
        source_id: found.sourceId,
        review_status: found.reviewStatus,
        created_at: found.createdAt,
        updated_at: found.updatedAt,
      });
    }

    const [rows] = await pool.query(
      `SELECT id, domain, target, title, law_number, content, source_note, source_id, review_status, created_at, updated_at
       FROM chatbot_knowledge
       WHERE id = ?
       LIMIT 1`,
      [normalizedId],
    );

    return rows[0] ? mapRow(rows[0]) : null;
  }

  static async updateById(id, patch = {}) {
    const normalizedId = Number(id || 0);
    if (!normalizedId) {
      return false;
    }

    const existing = await this.findById(normalizedId);
    if (!existing) {
      return false;
    }

    const normalizedPatch = normalizeEntry({
      domain: patch.domain !== undefined ? patch.domain : existing.domain,
      target: patch.target !== undefined ? patch.target : existing.target,
      title: patch.title !== undefined ? patch.title : existing.title,
      lawNumber: patch.lawNumber !== undefined ? patch.lawNumber : existing.lawNumber,
      content: patch.content !== undefined ? patch.content : existing.content,
      sourceNote: patch.sourceNote !== undefined ? patch.sourceNote : existing.sourceNote,
      sourceId: patch.sourceId !== undefined ? patch.sourceId : existing.sourceId,
      reviewStatus: patch.reviewStatus !== undefined ? patch.reviewStatus : existing.reviewStatus,
    });

    if (!normalizedPatch.title || !normalizedPatch.content) {
      return false;
    }

    const pool = getDbPool();

    if (!pool) {
      const found = memoryKnowledgeEntries.find((row) => Number(row.id) === normalizedId);
      if (!found) {
        return false;
      }

      Object.assign(found, {
        domain: normalizedPatch.domain,
        target: normalizedPatch.target,
        title: normalizedPatch.title,
        lawNumber: normalizedPatch.lawNumber,
        content: normalizedPatch.content,
        sourceNote: normalizedPatch.sourceNote,
        sourceId: normalizedPatch.sourceId,
        reviewStatus: normalizedPatch.reviewStatus,
        updatedAt: new Date().toISOString(),
      });
      return true;
    }

    const [result] = await pool.query(
      `UPDATE chatbot_knowledge
       SET domain = ?,
           target = ?,
           title = ?,
           law_number = ?,
           content = ?,
           source_note = ?,
           source_id = ?,
           review_status = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
       LIMIT 1`,
      [
        normalizedPatch.domain,
        normalizedPatch.target,
        normalizedPatch.title || null,
        normalizedPatch.lawNumber || null,
        normalizedPatch.content || null,
        normalizedPatch.sourceNote || null,
        normalizedPatch.sourceId,
        normalizedPatch.reviewStatus,
        normalizedId,
      ],
    );

    return Number(result.affectedRows || 0) > 0;
  }

  static async removeById(id) {
    const normalizedId = Number(id || 0);
    if (!normalizedId) {
      return false;
    }

    const pool = getDbPool();

    if (!pool) {
      const index = memoryKnowledgeEntries.findIndex((row) => Number(row.id) === normalizedId);
      if (index === -1) {
        return false;
      }

      memoryKnowledgeEntries.splice(index, 1);
      return true;
    }

    const [result] = await pool.query(
      "DELETE FROM chatbot_knowledge WHERE id = ? LIMIT 1",
      [normalizedId],
    );

    return Number(result.affectedRows || 0) > 0;
  }

  static async listRecent(limit = 10, offset = 0) {
    const pool = getDbPool();
    const normalizedLimit = Math.max(1, Number(limit || 10));
    const normalizedOffset = Math.max(0, Number(offset || 0));

    if (!pool) {
      return memoryKnowledgeEntries.slice(normalizedOffset, normalizedOffset + normalizedLimit).map((row) => mapRow({
        id: row.id,
        domain: row.domain,
        target: row.target,
        title: row.title,
        law_number: row.lawNumber,
        content: row.content,
        source_note: row.sourceNote,
        source_id: row.sourceId,
        review_status: row.reviewStatus,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
      }));
    }

    const [rows] = await pool.query(
      `SELECT id, domain, target, title, law_number, content, source_note, source_id, review_status, created_at, updated_at
       FROM chatbot_knowledge
       ORDER BY id DESC
       LIMIT ? OFFSET ?`,
      [normalizedLimit, normalizedOffset],
    );

    return rows.map(mapRow);
  }

  static async searchKnowledge(message, target = "all", limit = 5) {
    const terms = uniqueTokens(segmentWords(message)).slice(0, 8);
    if (terms.length === 0) {
      return [];
    }

    const pool = getDbPool();
    const normalizedTarget = normalizeKnowledgeTarget(target, "all");
    const shouldFilterByTarget = normalizedTarget !== "all" && normalizedTarget !== "general";

    if (!pool) {
      return memoryKnowledgeEntries
        .map((row) => {
          const isRelevant = hasKnowledgeRelevance(message, row);
          if (!isRelevant) {
            return null;
          }

          const haystack = normalizeForSearch(
            `${row.title} ${row.lawNumber} ${row.content} ${row.sourceNote}`,
          ).toLowerCase();
          const coarseScore = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
          const score = scoreKnowledgeMatch(message, {
            title: row.title,
            law_number: row.lawNumber,
            content: row.content,
            source_note: row.sourceNote,
          }) + coarseScore;

          return {
            id: row.id,
            domain: row.domain,
            target: row.target,
            title: row.title,
            lawNumber: row.lawNumber,
            content: row.content,
            sourceNote: row.sourceNote,
            sourceId: row.sourceId,
            reviewStatus: row.reviewStatus,
            source: "admin_knowledge",
            reference: row.lawNumber || row.title || "ฐานความรู้ภายในระบบ",
            comment: row.sourceNote || "",
            score,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          };
        })
        .filter(Boolean)
        .filter((row) => {
          if (row.score <= 0) {
            return false;
          }

          if (!shouldFilterByTarget) {
            return true;
          }

          const rowTarget = normalizeKnowledgeTarget(row.target, "general");
          return rowTarget === normalizedTarget || rowTarget === "all" || rowTarget === "general";
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    }

    const whereClause = terms
      .map(
        () =>
          `(LOWER(title) LIKE ? OR LOWER(law_number) LIKE ? OR LOWER(content) LIKE ? OR LOWER(source_note) LIKE ?)`
      )
      .join(" OR ");
    const params = terms.flatMap((term) => {
      const like = `%${term}%`;
      return [like, like, like, like];
    });

    const sql =
      !shouldFilterByTarget
        ? `SELECT id, domain, target, title, law_number, content, source_note, source_id, review_status, created_at, updated_at
           FROM chatbot_knowledge
           WHERE ${whereClause}
           ORDER BY id DESC
           LIMIT 50`
        : `SELECT id, domain, target, title, law_number, content, source_note, source_id, review_status, created_at, updated_at
           FROM chatbot_knowledge
           WHERE target IN (?, 'all', 'general') AND (${whereClause})
           ORDER BY CASE WHEN target = ? THEN 0 ELSE 1 END, id DESC
           LIMIT 50`;
    const sqlParams = !shouldFilterByTarget ? params : [normalizedTarget, ...params, normalizedTarget];

    const [rows] = await pool.query(sql, sqlParams);

    return rows
      .map((row) => {
        const isRelevant = hasKnowledgeRelevance(message, row);
        if (!isRelevant) {
          return null;
        }

        return {
          ...mapRow(row),
          score: scoreKnowledgeMatch(message, row),
        };
      })
      .filter(Boolean)
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

module.exports = LawChatbotKnowledgeModel;
