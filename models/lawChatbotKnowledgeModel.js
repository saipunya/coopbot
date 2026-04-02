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

function normalizeEntry(entry) {
  return {
    target: entry.target === "group" ? "group" : "coop",
    title: String(entry.title || "").trim().slice(0, 255),
    lawNumber: String(entry.lawNumber || "").trim().slice(0, 100),
    content: String(entry.content || "").trim(),
    sourceNote: String(entry.sourceNote || "").trim().slice(0, 255),
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
    return tokenHits >= queryTokens.length;
  }

  // For single-word queries, at least one hit is required.
  return tokenHits >= 1;
}

function mapRow(row) {
  return {
    id: row.id,
    target: row.target,
    title: row.title || "ฐานความรู้ภายในระบบ",
    lawNumber: row.law_number || row.lawNumber || "",
    content: row.content || "",
    sourceNote: row.source_note || row.sourceNote || "",
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
        target: record.target,
        title: record.title,
        law_number: record.lawNumber,
        content: record.content,
        source_note: record.sourceNote,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
      });
    }

    const [result] = await pool.query(
      `INSERT INTO chatbot_knowledge
        (target, title, law_number, content, source_note)
       VALUES (?, ?, ?, ?, ?)`,
      [normalized.target, normalized.title || null, normalized.lawNumber || null, normalized.content || null, normalized.sourceNote || null],
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

  static async listRecent(limit = 10) {
    const pool = getDbPool();

    if (!pool) {
      return memoryKnowledgeEntries.slice(0, limit).map((row) => mapRow({
        id: row.id,
        target: row.target,
        title: row.title,
        law_number: row.lawNumber,
        content: row.content,
        source_note: row.sourceNote,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
      }));
    }

    const [rows] = await pool.query(
      `SELECT id, target, title, law_number, content, source_note, created_at, updated_at
       FROM chatbot_knowledge
       ORDER BY id DESC
       LIMIT ?`,
      [Number(limit || 10)],
    );

    return rows.map(mapRow);
  }

  static async searchKnowledge(message, target = "all", limit = 5) {
    const terms = uniqueTokens(segmentWords(message)).slice(0, 8);
    if (terms.length === 0) {
      return [];
    }

    const pool = getDbPool();

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
            target: row.target,
            title: row.title,
            lawNumber: row.lawNumber,
            content: row.content,
            sourceNote: row.sourceNote,
            source: "admin_knowledge",
            reference: row.lawNumber || row.title || "ฐานความรู้ภายในระบบ",
            comment: row.sourceNote || "",
            score,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          };
        })
        .filter(Boolean)
        .filter((row) => (target === "all" ? true : row.target === target) && row.score > 0)
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
      target === "all"
        ? `SELECT id, target, title, law_number, content, source_note, created_at, updated_at
           FROM chatbot_knowledge
           WHERE ${whereClause}
           ORDER BY id DESC
           LIMIT 50`
        : `SELECT id, target, title, law_number, content, source_note, created_at, updated_at
           FROM chatbot_knowledge
           WHERE target = ? AND (${whereClause})
           ORDER BY id DESC
           LIMIT 50`;
    const sqlParams = target === "all" ? params : [target, ...params];

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
