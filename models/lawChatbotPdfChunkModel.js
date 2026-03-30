const { getDbPool } = require("../config/db");
const {
  makeBigrams,
  normalizeForSearch,
  segmentWords,
  uniqueTokens,
} = require("../services/thaiTextUtils");

function scoreChunkMatch(query, row) {
  const normalizedQuery = normalizeForSearch(query).toLowerCase();
  const rowText = normalizeForSearch(`${row.keyword} ${row.chunk_text}`).toLowerCase();
  const rawKeyword = String(row.keyword || "");
  const rawChunkText = String(row.chunk_text || "");
  const queryTokens = uniqueTokens(segmentWords(query));
  const rowTokens = uniqueTokens(segmentWords(rowText));
  const rowTokenSet = new Set(rowTokens);
  const queryBigrams = makeBigrams(queryTokens);

  let score = 0;

  if (normalizedQuery && rowText.includes(normalizedQuery)) {
    score += 30;
  }

  const tokenHits = queryTokens.filter((token) => rowTokenSet.has(token)).length;
  score += tokenHits * 8;

  for (const bigram of queryBigrams) {
    if (rowText.includes(bigram)) {
      score += 10;
    }
  }

  if (normalizedQuery && String(row.keyword || "").toLowerCase().includes(normalizedQuery)) {
    score += 18;
  }

  const keywordTokens = uniqueTokens(segmentWords(row.keyword || ""));
  const keywordHits = queryTokens.filter((token) => keywordTokens.includes(token)).length;
  score += keywordHits * 12;

  const coverage = queryTokens.length > 0 ? tokenHits / queryTokens.length : 0;
  score += coverage * 20;

  if (rawKeyword.trim()) {
    score += 12;
  } else {
    score -= 18;
  }

  const replacementGlyphHits = (rawChunkText.match(/�||||||||||||||/g) || []).length;
  score -= Math.min(replacementGlyphHits, 20) * 2;

  if (rawChunkText.length > 0 && replacementGlyphHits / rawChunkText.length > 0.02) {
    score -= 20;
  }

  return score;
}

const uploadedFiles = [];
const memoryChunks = [];

class LawChatbotPdfChunkModel {
  static createUpload(entry) {
    const record = {
      id: uploadedFiles.length + 1,
      createdAt: new Date().toISOString(),
      status: "queued",
      processingMessage: "",
      insertedChunkCount: 0,
      ...entry,
    };

    uploadedFiles.unshift(record);
    return record;
  }

  static updateUpload(id, patch) {
    const record = uploadedFiles.find((item) => item.id === id);
    if (!record) {
      return null;
    }

    Object.assign(record, patch, {
      updatedAt: new Date().toISOString(),
    });

    return record;
  }

  static countDocuments() {
    return uploadedFiles.length;
  }

  static list(limit = 10) {
    return uploadedFiles.slice(0, limit);
  }

  static async insertChunks(chunks) {
    const normalizedChunks = chunks.map((chunk) => ({
      keyword: String(chunk.keyword || "").slice(0, 255),
      chunkText: String(chunk.chunkText || ""),
    }));

    const pool = getDbPool();

    if (!pool) {
      normalizedChunks.forEach((chunk, index) => {
        memoryChunks.unshift({
          id: memoryChunks.length + index + 1,
          keyword: chunk.keyword,
          chunk_text: chunk.chunkText,
          created_at: new Date().toISOString(),
        });
      });
      return normalizedChunks.length;
    }

    const values = normalizedChunks.map((chunk) => [chunk.keyword, chunk.chunkText]);
    if (values.length > 0) {
      await pool.query("INSERT INTO pdf_chunks (keyword, chunk_text) VALUES ?", [values]);
    }
    return values.length;
  }

  static async countChunks() {
    const pool = getDbPool();

    if (!pool) {
      return memoryChunks.length;
    }

    const [rows] = await pool.query("SELECT COUNT(*) AS total FROM pdf_chunks");
    return rows[0]?.total || 0;
  }

  static async searchChunks(message, limit = 5) {
    const normalizedMessage = normalizeForSearch(message).toLowerCase();
    const terms = [...new Set([normalizedMessage, ...segmentWords(message)])]
      .filter(Boolean)
      .slice(0, 8);

    if (terms.length === 0) {
      return [];
    }

    const pool = getDbPool();

    if (!pool) {
      return memoryChunks
        .map((row) => {
          const haystack = normalizeForSearch(`${row.keyword} ${row.chunk_text}`).toLowerCase();
          const coarseScore = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
          const score = scoreChunkMatch(message, row) + coarseScore;
          return { ...row, score };
        })
        .filter((row) => row.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    }

    const whereClause = terms
      .map(() => "(LOWER(keyword) LIKE ? OR LOWER(chunk_text) LIKE ?)")
      .join(" OR ");
    const params = terms.flatMap((term) => [`%${term}%`, `%${term}%`]);
    const [rows] = await pool.query(
      `SELECT id, keyword, chunk_text, created_at
       FROM pdf_chunks
       WHERE ${whereClause}
       ORDER BY id DESC
       LIMIT 50`,
      params
    );

    return rows
      .map((row) => {
        const haystack = normalizeForSearch(`${row.keyword} ${row.chunk_text}`).toLowerCase();
        const coarseScore = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
        const score = scoreChunkMatch(message, row) + coarseScore;
        return { ...row, score };
      })
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

module.exports = LawChatbotPdfChunkModel;
