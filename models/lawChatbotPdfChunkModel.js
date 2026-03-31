const { getDbPool } = require("../config/db");
const {
  makeBigrams,
  normalizeForSearch,
  segmentWords,
  uniqueTokens,
} = require("../services/thaiTextUtils");

const GENERIC_QUERY_TOKENS = new Set([
  "ค่า",
  "สหกรณ์",
  "กลุ่ม",
  "เกษตรกร",
  "กฎหมาย",
  "พระราชบัญญัติ",
  "พรบ",
  "พร",
  "บ",
  "มาตรา",
  "ข้อ",
  "ระเบียบ",
]);

function buildCandidateTerms(message) {
  const normalizedMessage = normalizeForSearch(message).toLowerCase();
  const queryTokens = uniqueTokens(segmentWords(message));
  const specificTokens = queryTokens.filter(
    (token) => token && token.length >= 3 && !GENERIC_QUERY_TOKENS.has(token),
  );

  const terms = uniqueTokens([
    normalizedMessage,
    ...specificTokens,
  ]).filter(Boolean);

  if (terms.length > 0) {
    return terms.slice(0, 8);
  }

  const fallbackTokens = queryTokens.filter((token) => token && token.length >= 3);
  return uniqueTokens([normalizedMessage, ...fallbackTokens].filter(Boolean)).slice(0, 8);
}

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

function getMinimumTokenHits(queryTokens) {
  if (queryTokens.length >= 5) {
    return 2;
  }

  if (queryTokens.length >= 3) {
    return 1;
  }

  return 1;
}

const uploadedFiles = [];
const memoryChunks = [];
const memoryDocuments = [];

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

  static async createDocument(entry) {
    const normalizedEntry = {
      title: String(entry.title || "").slice(0, 255),
      documentNumber: String(entry.documentNumber || "").slice(0, 100),
      documentDate: entry.documentDate || null,
      documentDateText: String(entry.documentDateText || "").slice(0, 100),
      documentSource: String(entry.documentSource || "").slice(0, 255),
      filename: String(entry.filename || "").slice(0, 255),
      originalname: String(entry.originalname || "").slice(0, 255),
      mimetype: String(entry.mimetype || "").slice(0, 150),
      fileSize: Number(entry.fileSize || 0),
    };

    const pool = getDbPool();

    if (!pool) {
      const record = {
        id: memoryDocuments.length + 1,
        created_at: new Date().toISOString(),
        ...normalizedEntry,
      };
      memoryDocuments.unshift(record);
      return record;
    }

    const [result] = await pool.query(
      `INSERT INTO documents
        (title, document_number, document_date, document_date_text, document_source, filename, originalname, mimetype, file_size)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        normalizedEntry.title || null,
        normalizedEntry.documentNumber || null,
        normalizedEntry.documentDate || null,
        normalizedEntry.documentDateText || null,
        normalizedEntry.documentSource || null,
        normalizedEntry.filename || null,
        normalizedEntry.originalname || null,
        normalizedEntry.mimetype || null,
        normalizedEntry.fileSize || 0,
      ],
    );

    return {
      id: result.insertId,
      ...normalizedEntry,
    };
  }

  static async insertChunks(chunks, documentId = null) {
    const normalizedChunks = chunks.map((chunk) => ({
      keyword: String(chunk.keyword || "").slice(0, 255),
      chunkText: String(chunk.chunkText || ""),
      documentId: documentId || chunk.documentId || null,
    }));

    const pool = getDbPool();

    if (!pool) {
      normalizedChunks.forEach((chunk, index) => {
        memoryChunks.unshift({
          id: memoryChunks.length + index + 1,
          keyword: chunk.keyword,
          chunk_text: chunk.chunkText,
          document_id: chunk.documentId,
          created_at: new Date().toISOString(),
        });
      });
      return normalizedChunks.length;
    }

    const values = normalizedChunks.map((chunk) => [chunk.keyword, chunk.chunkText, chunk.documentId]);
    if (values.length > 0) {
      await pool.query("INSERT INTO pdf_chunks (keyword, chunk_text, document_id) VALUES ?", [values]);
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
    const terms = buildCandidateTerms(message);
    const queryTokens = uniqueTokens(segmentWords(message));
    const minTokenHits = getMinimumTokenHits(queryTokens);

    if (terms.length === 0) {
      return [];
    }

    const pool = getDbPool();

    if (!pool) {
      return memoryChunks
        .map((row) => {
          const haystack = normalizeForSearch(`${row.keyword} ${row.chunk_text}`).toLowerCase();
          const rowTokenSet = new Set(uniqueTokens(segmentWords(haystack)));
          const tokenHits = queryTokens.filter((token) => rowTokenSet.has(token)).length;
          const hasExactPhrase = normalizedMessage && haystack.includes(normalizedMessage);
          const coarseScore = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);

          if (
            queryTokens.length > 0 &&
            !hasExactPhrase &&
            tokenHits < minTokenHits &&
            coarseScore < 1
          ) {
            return null;
          }

          const score = scoreChunkMatch(message, row) + coarseScore;
          const document = memoryDocuments.find((item) => item.id === row.document_id);
          return {
            ...row,
            title: document?.title || row.keyword || "เอกสารที่อัปโหลด",
            reference:
              document?.documentNumber ||
              document?.title ||
              row.keyword ||
              "เอกสารที่อัปโหลด",
            documentNumber: document?.documentNumber || "",
            documentDateText: document?.documentDateText || "",
            documentSource: document?.documentSource || "",
            source: "pdf_chunks",
            score,
          };
        })
        .filter(Boolean)
        .filter((row) => row.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    }

    const whereClause = terms
      .map(() => "(LOWER(keyword) LIKE ? OR LOWER(chunk_text) LIKE ?)")
      .join(" OR ");
    const params = terms.flatMap((term) => [`%${term}%`, `%${term}%`]);
    const [rows] = await pool.query(
      `SELECT c.id, c.keyword, c.chunk_text, c.created_at, c.document_id,
              d.title, d.document_number, d.document_date_text, d.document_source, d.originalname
       FROM pdf_chunks
       AS c
       LEFT JOIN documents AS d ON d.id = c.document_id
       WHERE ${whereClause}
       ORDER BY c.id DESC
       LIMIT 200`,
      params
    );

    return rows
      .map((row) => {
        const haystack = normalizeForSearch(`${row.keyword} ${row.chunk_text}`).toLowerCase();
        const rowTokenSet = new Set(uniqueTokens(segmentWords(haystack)));
        const tokenHits = queryTokens.filter((token) => rowTokenSet.has(token)).length;
        const hasExactPhrase = normalizedMessage && haystack.includes(normalizedMessage);
        const coarseScore = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);

        if (
          queryTokens.length > 0 &&
          !hasExactPhrase &&
          tokenHits < minTokenHits &&
          coarseScore < 1
        ) {
          return null;
        }

        const score = scoreChunkMatch(message, row) + coarseScore;
        return {
          ...row,
          source: "pdf_chunks",
          title: row.title || row.originalname || row.keyword || "เอกสารที่อัปโหลด",
          reference:
            row.document_number || row.title || row.originalname || row.keyword || "เอกสารที่อัปโหลด",
          documentNumber: row.document_number || "",
          documentDateText: row.document_date_text || "",
          documentSource: row.document_source || "",
          score,
        };
      })
      .filter(Boolean)
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  static async searchDocuments(message, limit = 5) {
    const normalizedMessage = normalizeForSearch(message).toLowerCase();
    const terms = [...new Set([normalizedMessage, ...segmentWords(message)])]
      .filter(Boolean)
      .slice(0, 8);

    if (terms.length === 0) {
      return [];
    }

    const pool = getDbPool();

    if (!pool) {
      return memoryDocuments
        .map((row) => {
          const rowText = normalizeForSearch(
            `${row.title || ""} ${row.documentNumber || ""} ${row.documentDateText || ""} ${row.documentSource || ""} ${row.originalname || ""}`,
          ).toLowerCase();
          const coarseScore = terms.reduce((sum, term) => sum + (rowText.includes(term) ? 1 : 0), 0);
          const score = scoreChunkMatch(message, {
            keyword: `${row.title || ""} ${row.documentNumber || ""}`,
            chunk_text: `${row.documentSource || ""} ${row.documentDateText || ""} ${row.originalname || ""}`,
          }) + coarseScore;

          return {
            id: row.id,
            source: "documents",
            title: row.title || row.originalname || "เอกสารที่อัปโหลด",
            reference: row.documentNumber || row.title || row.originalname || "เอกสารที่อัปโหลด",
            content: [row.documentSource, row.documentDateText, row.originalname].filter(Boolean).join(" | "),
            documentNumber: row.documentNumber || "",
            documentDateText: row.documentDateText || "",
            documentSource: row.documentSource || "",
            score,
          };
        })
        .filter((row) => row.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    }

    const whereClause = terms
      .map(
        () =>
          "(LOWER(title) LIKE ? OR LOWER(document_number) LIKE ? OR LOWER(document_date_text) LIKE ? OR LOWER(document_source) LIKE ? OR LOWER(originalname) LIKE ?)",
      )
      .join(" OR ");
    const params = terms.flatMap((term) => {
      const like = `%${term}%`;
      return [like, like, like, like, like];
    });

    const [rows] = await pool.query(
      `SELECT id, title, document_number, document_date_text, document_source, originalname
       FROM documents
       WHERE ${whereClause}
       ORDER BY id DESC
       LIMIT 50`,
      params,
    );

    return rows
      .map((row) => {
        const rowText = normalizeForSearch(
          `${row.title || ""} ${row.document_number || ""} ${row.document_date_text || ""} ${row.document_source || ""} ${row.originalname || ""}`,
        ).toLowerCase();
        const coarseScore = terms.reduce((sum, term) => sum + (rowText.includes(term) ? 1 : 0), 0);
        const score = scoreChunkMatch(message, {
          keyword: `${row.title || ""} ${row.document_number || ""}`,
          chunk_text: `${row.document_source || ""} ${row.document_date_text || ""} ${row.originalname || ""}`,
        }) + coarseScore;

        return {
          id: row.id,
          source: "documents",
          title: row.title || row.originalname || "เอกสารที่อัปโหลด",
          reference: row.document_number || row.title || row.originalname || "เอกสารที่อัปโหลด",
          content: [row.document_source, row.document_date_text, row.originalname].filter(Boolean).join(" | "),
          documentNumber: row.document_number || "",
          documentDateText: row.document_date_text || "",
          documentSource: row.document_source || "",
          score,
        };
      })
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

module.exports = LawChatbotPdfChunkModel;
