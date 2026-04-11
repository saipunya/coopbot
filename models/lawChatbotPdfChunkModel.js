const { getDbPool } = require("../config/db");
const {
  hasExclusiveMeaningMismatch,
  makeBigrams,
  normalizeForSearch,
  scoreQueryFocusAlignment,
  segmentWords,
  uniqueTokens,
  detectTopicFamily,
} = require("../services/thaiTextUtils");
const {
  createEmbedding,
  bufferToEmbedding,
  cosineSimilarity,
  isEmbeddingEnabled,
} = require("../services/embeddingService");

// Cache for embeddings to avoid repeated DB queries
let embeddingCache = null;
let embeddingCacheTime = 0;
const EMBEDDING_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

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

function looksLikeAmountQuery(query) {
  const text = normalizeForSearch(query).toLowerCase();
  return /เท่าไร|เท่าไหร่|กี่บาท|กี่เปอร์เซ็นต์|กี่ร้อยละ|อัตรา|จำนวนเงิน|ค่าบำรุง|ชำระ|จ่าย/.test(text);
}

function scoreAmountSignals(query, rawText) {
  if (!looksLikeAmountQuery(query)) {
    return 0;
  }

  const text = String(rawText || "");
  let score = 0;

  if (/\d/.test(text)) {
    score += 14;
  }

  if (/บาท|ร้อยละ|เปอร์เซ็นต์|%|อัตรา|จำนวนเงิน|ชำระ|จ่าย/.test(text)) {
    score += 18;
  }

  if (/ค่าบำรุง|สันนิบาต/.test(text)) {
    score += 16;
  }

  if (/\d[\d,]*(?:\.\d+)?\s*(บาท|ร้อยละ|เปอร์เซ็นต์|%)/.test(text)) {
    score += 28;
  }

  return score;
}

function countRegexMatches(text, pattern) {
  return (String(text || "").match(pattern) || []).length;
}

function isOpposingTopicConflict(query, rowText) {
  const normalizedQuery = normalizeForSearch(query).toLowerCase();
  const normalizedRowText = normalizeForSearch(rowText).toLowerCase();
  if (!normalizedQuery || !normalizedRowText) {
    return false;
  }

  const asksFormation = /จัดตั้ง/.test(normalizedQuery);
  const asksDissolution = /(?:เลิก|ชำระบัญชี|ผู้ชำระบัญชี|สั่งเลิก)/.test(normalizedQuery);
  const rowHasFormation = /จัดตั้ง/.test(normalizedRowText);
  const rowHasDissolution = /(?:เลิก|ชำระบัญชี|ผู้ชำระบัญชี|สั่งเลิก)/.test(normalizedRowText);

  if (asksFormation && rowHasDissolution) {
    return true;
  }

  if (asksDissolution && rowHasFormation) {
    return true;
  }

  return false;
}

function classifyChunkQuality(row = {}) {
  const rawKeyword = String(row.keyword || "");
  const rawChunkText = String(row.chunk_text || "");
  const rawText = `${rawKeyword} ${rawChunkText}`.trim();
  const normalizedText = normalizeForSearch(rawText).toLowerCase();
  const thaiChars = countRegexMatches(rawText, /[ก-๙]/g);
  const asciiWordChars = countRegexMatches(rawText, /[a-zA-Z]/g);
  const digitChars = countRegexMatches(rawText, /\d/g);
  const replacementGlyphHits = countRegexMatches(rawChunkText, /[\uFFFD\uF700-\uF8FF]/g);
  // Exclude normal whitespace controls (\t,\n,\r) from "control character" filtering.
  const controlCharHits = countRegexMatches(rawChunkText, /[\x00-\x08\x0B\x0C\x0E-\x1F]/g);
  const garbledHits = countRegexMatches(
    rawChunkText,
    /[็์ิีุู่้๊๋]{3,}|~็|็~|◊|Ë|‡|∫|≈|¡|¥|å|ì|î|ï|ñ|ó|ô|ö|ù|û|ü/g,
  );
  // Treat combining marks (\p{M}) as part of letters; Thai text uses them heavily.
  const punctuationHits = countRegexMatches(rawChunkText, /[^\p{L}\p{M}\p{N}\s]/gu);
  const metadataPattern =
    /(?:^|[\s|])(?:หน้า\s*\d+|page\s*\d+|เอกสารแนบ|สิ่งที่ส่งมาด้วย|หมายเหตุ|โทร\.?|โทรสาร|fax|email|www\.|https?:\/\/|เลขที่หนังสือ|ลงวันที่|ที่ตั้งสำนักงาน|ผู้สแกน|scan|scanner)(?:$|[\s|])/i;
  const sourceLabelPattern =
    /(เอกสารที่อัปโหลด|ฐานความรู้ที่ผู้ดูแลระบบเพิ่ม\/แก้ไข|พรบ\.สหกรณ์ พ\.ศ\. 2542|หนังสือวินิจฉัย\/ตีความ|Q&A ที่ผู้ดูแลเตรียมไว้)\s*:/i;
  const fragmentedLineCount = String(rawChunkText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.length <= 24 && !/[.!?ฯ:]$/.test(line)).length;
  const sentenceLikeCount = countRegexMatches(rawChunkText, /[.!?ฯ:]/g);

  const tooManyReplacementGlyphs = replacementGlyphHits >= 3 || (rawChunkText.length > 0 && replacementGlyphHits / rawChunkText.length > 0.01);
  const tooManyControlChars = controlCharHits >= 3;
  const tooManyGarbledHits = garbledHits >= 2;
  const punctuationHeavy = rawChunkText.length > 0 && punctuationHits / rawChunkText.length > 0.2;
  const metadataOnly =
    sourceLabelPattern.test(rawChunkText) ||
    sourceLabelPattern.test(rawKeyword) ||
    metadataPattern.test(rawChunkText) ||
    metadataPattern.test(rawKeyword) ||
    (normalizedText.length > 0 && thaiChars < 12 && sentenceLikeCount === 0 && fragmentedLineCount >= 2);
  const fragmentedText =
    rawChunkText.length > 0 &&
    fragmentedLineCount >= 4 &&
    sentenceLikeCount === 0 &&
    thaiChars < Math.max(40, asciiWordChars + digitChars + 10);

  return {
    rawText,
    normalizedText,
    isHardFiltered:
      !normalizedText ||
      tooManyReplacementGlyphs ||
      tooManyControlChars ||
      tooManyGarbledHits ||
      punctuationHeavy ||
      metadataOnly ||
      fragmentedText,
  };
}

function isCoopFormationQuery(query = "") {
  const normalizedQuery = normalizeForSearch(query).toLowerCase();
  if (!normalizedQuery) {
    return false;
  }

  return /(?:การ)?จัดตั้ง(?:สหกรณ์)?|จดทะเบียนจัดตั้ง|ผู้เริ่มก่อการ|สมาชิกผู้ก่อการ|ประชุมจัดตั้ง/.test(normalizedQuery);
}

function countFamilyTermHits(text = "", terms = []) {
  const normalizedText = String(text || "");
  if (!normalizedText || !Array.isArray(terms) || terms.length === 0) {
    return 0;
  }

  let hits = 0;
  for (const term of terms) {
    const cleaned = normalizeForSearch(String(term || "")).toLowerCase();
    if (cleaned && normalizedText.includes(cleaned)) {
      hits += 1;
    }
  }
  return hits;
}

function applyTopicBoost(row, family, query, baseScore) {
  if (!family || typeof family !== "object") {
    return baseScore;
  }

  const rowText = normalizeForSearch(`${row.keyword} ${row.chunk_text}`).toLowerCase();
  const queryText = normalizeForSearch(query).toLowerCase();
  if (!rowText || !queryText) {
    return baseScore;
  }

  let score = baseScore;
  const boostTerms = Array.isArray(family.boostTerms) ? family.boostTerms : [];
  const penaltyTerms = Array.isArray(family.penaltyTerms) ? family.penaltyTerms : [];
  const weights = family.weights || {};
  const boostPerHit = Number(weights.boostPerHit || 12);
  const penaltyPerHit = Number(weights.penaltyPerHit || 16);

  const boostHits = countFamilyTermHits(rowText, boostTerms);
  const penaltyHits = countFamilyTermHits(rowText, penaltyTerms);
  if (boostHits > 0) {
    score += Math.min(80, boostHits * boostPerHit);
  }
  if (penaltyHits > 0) {
    score -= Math.min(110, penaltyHits * penaltyPerHit);
  }

  // For PDF chunk retrieval, only apply preferredSources when "pdf_chunks" is explicitly preferred.
  const preferredSources = Array.isArray(family.preferredSources) ? family.preferredSources : [];
  if (preferredSources.some((source) => String(source || "").trim().toLowerCase() === "pdf_chunks")) {
    score += 10;
  }

  return score;
}

function scoreChunkMatch(query, row) {
  const normalizedQuery = normalizeForSearch(query).toLowerCase();
  const rowText = normalizeForSearch(`${row.keyword} ${row.chunk_text}`).toLowerCase();
  const rawKeyword = String(row.keyword || "");
  const rawChunkText = String(row.chunk_text || "");
  const quality = classifyChunkQuality(row);
  const queryTokens = uniqueTokens(segmentWords(query));
  const rowTokens = uniqueTokens(segmentWords(rowText));
  const rowTokenSet = new Set(rowTokens);
  const queryBigrams = makeBigrams(queryTokens);
  const overviewStyleQuery =
    /(ความรู้ทั่วไป|ความรู้เกี่ยวกับ|ทั่วไปเกี่ยวกับ|เกี่ยวกับสหกรณ์|เบื้องต้น|ภาพรวม|สรุป|นิยาม|ความหมาย|หมายถึง|สหกรณ์คืออะไร|คืออะไร|ประโยชน์|ข้อดี|ดีอย่างไร|ช่วยอะไร)/.test(
      normalizedQuery,
    );
  const benefitQuery = /(ประโยชน์|ข้อดี|ดีอย่างไร|ช่วยอะไร)/.test(normalizedQuery);
  const legalIntentQuery =
    /(มาตรา\s*\d+|มาตรา|วรรค|อนุมาตรา|ข้อ\s*\d+|นายทะเบียน|อำนาจหน้าที่|พระราชบัญญัติ|กฎกระทรวง|ระเบียบ|ข้อบังคับ|พ\\.ศ\\.)/.test(
      normalizedQuery,
    );

  if (quality.isHardFiltered) {
    return Number.NEGATIVE_INFINITY;
  }

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
  score += scoreQueryFocusAlignment(query, `${rawKeyword} ${rawChunkText}`);

  if (hasExclusiveMeaningMismatch(query, `${row.keyword || ""} ${row.chunk_text || ""}`)) {
    score -= 120;
  }

  if (isOpposingTopicConflict(query, `${row.keyword || ""} ${row.chunk_text || ""}`)) {
    score -= 140;
  }

  if (rawKeyword.trim()) {
    score += 12;
  } else {
    score -= 18;
  }

  const replacementGlyphHits = (rawChunkText.match(/[\uFFFD\uF700-\uF8FF]/g) || []).length;
  score -= Math.min(replacementGlyphHits, 20) * 2;

  if (rawChunkText.length > 0 && replacementGlyphHits / rawChunkText.length > 0.02) {
    score -= 20;
  }

  // Overview queries should avoid pulling statute-by-section chunks unless users clearly ask legal questions.
  if (overviewStyleQuery && !legalIntentQuery) {
    if (/(มาตรา\s*\d+|มาตรา|วรรค|อนุมาตรา|พระราชบัญญัติ|กฎกระทรวง|ระเบียบ|ข้อบังคับ|นายทะเบียน|อำนาจหน้าที่)/.test(rowText)) {
      score -= 90;
    }
    if (/(นิยาม|ความหมาย|หมายถึง|คือ|ประโยชน์|ข้อดี|วัตถุประสงค์|หลักการ|ทั่วไป|เบื้องต้น|ภาพรวม)/.test(rowText)) {
      score += 22;
    }
  }

  if (benefitQuery) {
    if (/(ประโยชน์|ข้อดี|ผลดี|ช่วยเหลือ|ได้รับจากสหกรณ์)/.test(rowText)) {
      score += 32;
    }
    if (/(ผลประโยชน์ของสหกรณ์หรือสมาชิก|เสื่อมเสียผลประโยชน์|รักษาผลประโยชน์)/.test(rowText)) {
      // Risk note: legal/admin passages often mention "ผลประโยชน์" in a supervisory context, not member benefits.
      score -= 24;
    }
  }

  // Penalize chunks with control characters or garbled OCR text
  const controlCharHits = (rawChunkText.match(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g) || []).length;
  if (controlCharHits > 5) {
    score -= Math.min(controlCharHits, 30) * 2;
  }

  // Boost chunks where keyword/content contains specific query terms
  const keywordLower = rawKeyword.toLowerCase();
  const chunkLower = rawChunkText.toLowerCase();
  const queryLower = normalizedQuery;
  const combinedLower = `${keywordLower} ${chunkLower}`;

  const topicFamily = detectTopicFamily(query);
  if (topicFamily) {
    score = applyTopicBoost(row, topicFamily, query, score);
  }

  // Legacy, keep for safety: union-fee keyword shaping (family-driven rules also apply).
  if (!topicFamily && (queryLower.includes("บำรุง") || queryLower.includes("สันนิบาต"))) {
    // Strong boost for chunks directly about ค่าบำรุงสันนิบาต
    if (keywordLower.includes("บำรุง") && keywordLower.includes("สันนิบาต")) {
      score += 40;
    } else if (keywordLower.includes("บำรุง") || keywordLower.includes("สันนิบาต")) {
      score += 20;
    }
    
    // Boost for content mentioning อัตรา, กฎกระทรวง, ร้อยละ (rate/regulation terms)
    if (chunkLower.includes("อัตรา") || chunkLower.includes("กฎกระทรวง") || chunkLower.includes("ร้อยละ")) {
      score += 15;
    }
    
    // Penalize unrelated topics
    if (keywordLower.includes("เดินทาง") || keywordLower.includes("ฝึกอบรม")) {
      score -= 40;
    }
    if (keywordLower.includes("ชำระบัญชี") || keywordLower.includes("จ่ายคืนค่าหุ้น")) {
      score -= 25;
    }
    if (keywordLower.includes("สมาชิกสมทบ") || keywordLower.includes("ข้อบังคับ")) {
      score -= 20;
    }
    // Penalize chunks about unrelated financial operations
    if (keywordLower.includes("เฉลี่ยค่าหุ้น") || keywordLower.includes("จ่ายคืนค่าหุ้น") || keywordLower.includes("ปันผล")) {
      score -= 35;
    }
    if (keywordLower.includes("องค์ความรู้") || keywordLower.includes("km")) {
      score -= 25;
    }
  }

  // Legacy, keep for safety: coop formation shaping (family-driven rules also apply).
  if (!topicFamily && isCoopFormationQuery(query)) {
    const strongFormationPatterns = [
      /ผู้เริ่มก่อการ/,
      /สมาชิกผู้ก่อการ/,
      /จดทะเบียนจัดตั้ง/,
      /คำขอจดทะเบียน/,
      /ประชุมจัดตั้ง/,
      /จัดตั้งสหกรณ์/,
    ];
    const supportingFormationPatterns = [
      /ข้อบังคับ/,
      /ผู้จัดตั้งสหกรณ์/,
      /เพื่อดำเนินการจัดตั้งสหกรณ์/,
      /ขอจดทะเบียน/,
      /ยื่นจดทะเบียน/,
    ];
    const registrarPowerPatterns = [
      /นายทะเบียน(?:สหกรณ์)?มีอำนาจหน้าที่/,
      /ตรวจสอบ/,
      /ไต่สวน/,
      /ระงับการดำเนินงาน/,
      /เลิกสหกรณ์/,
      /ถอนชื่อออกจากทะเบียน/,
      /ชำระบัญชี/,
    ];

    const strongFormationHits = strongFormationPatterns.filter((pattern) => pattern.test(combinedLower)).length;
    const supportingFormationHits = supportingFormationPatterns.filter((pattern) => pattern.test(combinedLower)).length;
    const registrarPowerHits = registrarPowerPatterns.filter((pattern) => pattern.test(combinedLower)).length;

    if (strongFormationHits > 0) {
      score += strongFormationHits * 26;
    }

    if (supportingFormationHits > 0) {
      score += supportingFormationHits * 12;
    }

    // If this chunk mainly mentions registrar powers without formation details, push it down hard.
    if (/นายทะเบียน/.test(combinedLower) && strongFormationHits === 0 && supportingFormationHits === 0) {
      score -= 42;
    }

    if (registrarPowerHits > 0) {
      score -= registrarPowerHits * 28;
    }
  }

  // Heavy penalty for garbled OCR text (Thai encoding issues)
  const thaiGarbledHits = (rawChunkText.match(/[็์ิีุู่้๊๋]{3,}|~็|็~|◊|Ë|‡|∫|≈|¡|¥|å|ì|î|ï|ñ|ó|ô|ö|ù|û|ü/g) || []).length;
  if (thaiGarbledHits > 0) {
    score -= Math.min(thaiGarbledHits, 30) * 5;
  }

  score += scoreAmountSignals(query, `${rawKeyword} ${rawChunkText}`);

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

  static list(limit = 10, offset = 0) {
    const normalizedLimit = Math.max(1, Number(limit || 10));
    const normalizedOffset = Math.max(0, Number(offset || 0));
    return uploadedFiles.slice(normalizedOffset, normalizedOffset + normalizedLimit);
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
      extractionMethod: String(entry.extractionMethod || "").slice(0, 50),
      extractionQualityScore: Number.isFinite(Number(entry.extractionQualityScore))
        ? Number(entry.extractionQualityScore)
        : null,
      extractionNotes: String(entry.extractionNotes || "").slice(0, 2000),
      isSearchable: entry.isSearchable === false ? 0 : 1,
      qualityStatus: String(entry.qualityStatus || "accepted").slice(0, 20) || "accepted",
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
        (title, document_number, document_date, document_date_text, document_source, filename, originalname, mimetype, file_size, extraction_method, extraction_quality_score, extraction_notes, is_searchable, quality_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        normalizedEntry.extractionMethod || null,
        normalizedEntry.extractionQualityScore,
        normalizedEntry.extractionNotes || null,
        normalizedEntry.isSearchable,
        normalizedEntry.qualityStatus,
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

  static async findChunkById(id) {
    const normalizedId = Number(id || 0);
    if (!normalizedId) {
      return null;
    }

    const pool = getDbPool();

    if (!pool) {
      const row = memoryChunks.find((item) => Number(item.id) === normalizedId);
      if (!row) {
        return null;
      }

      const document = memoryDocuments.find((item) => Number(item.id) === Number(row.document_id));
      if (document && document.isSearchable === 0) {
        return null;
      }

      return {
        ...row,
        source: "pdf_chunks",
        content: row.chunk_text || "",
        title: document?.title || row.keyword || "เอกสารที่อัปโหลด",
        reference:
          document?.documentNumber ||
          document?.title ||
          row.keyword ||
          "เอกสารที่อัปโหลด",
        documentNumber: document?.documentNumber || "",
        documentDateText: document?.documentDateText || "",
        documentSource: document?.documentSource || "",
        documentId: row.document_id || null,
      };
    }

    const [rows] = await pool.query(
      `SELECT c.id, c.keyword, c.chunk_text, c.created_at, c.document_id,
              d.title, d.document_number, d.document_date_text, d.document_source, d.originalname, d.is_searchable
       FROM pdf_chunks AS c
       LEFT JOIN documents AS d ON d.id = c.document_id
       WHERE c.id = ?
       LIMIT 1`,
      [normalizedId],
    );

    const row = rows[0];
    if (!row || Number(row.is_searchable || 1) === 0) {
      return null;
    }

    return {
      ...row,
      source: "pdf_chunks",
      content: row.chunk_text || "",
      title: row.title || row.originalname || row.keyword || "เอกสารที่อัปโหลด",
      reference: row.document_number || row.title || row.originalname || row.keyword || "เอกสารที่อัปโหลด",
      documentNumber: row.document_number || "",
      documentDateText: row.document_date_text || "",
      documentSource: row.document_source || "",
      documentId: row.document_id || null,
    };
  }

  static async listChunksByDocumentId(documentId, options = {}) {
    const normalizedDocumentId = Number(documentId || 0);
    const normalizedLimit = Math.max(1, Number(options.limit || 3));
    const afterChunkId = Math.max(0, Number(options.afterChunkId || 0));
    if (!normalizedDocumentId) {
      return [];
    }

    const pool = getDbPool();

    if (!pool) {
      const document = memoryDocuments.find((item) => Number(item.id) === normalizedDocumentId);
      if (document && document.isSearchable === 0) {
        return [];
      }

      return memoryChunks
        .filter((row) => Number(row.document_id) === normalizedDocumentId && Number(row.id) > afterChunkId)
        .sort((a, b) => Number(a.id) - Number(b.id))
        .slice(0, normalizedLimit)
        .map((row) => ({
          ...row,
          source: "pdf_chunks",
          content: row.chunk_text || "",
          title: document?.title || row.keyword || "เอกสารที่อัปโหลด",
          reference:
            document?.documentNumber ||
            document?.title ||
            row.keyword ||
            "เอกสารที่อัปโหลด",
          documentNumber: document?.documentNumber || "",
          documentDateText: document?.documentDateText || "",
          documentSource: document?.documentSource || "",
          documentId: row.document_id || null,
        }));
    }

    const [rows] = await pool.query(
      `SELECT c.id, c.keyword, c.chunk_text, c.created_at, c.document_id,
              d.title, d.document_number, d.document_date_text, d.document_source, d.originalname, d.is_searchable
       FROM pdf_chunks AS c
       LEFT JOIN documents AS d ON d.id = c.document_id
       WHERE c.document_id = ?
         AND c.id > ?
         AND (d.id IS NULL OR d.is_searchable = 1)
       ORDER BY c.id ASC
       LIMIT ?`,
      [normalizedDocumentId, afterChunkId, normalizedLimit],
    );

    return rows.map((row) => ({
      ...row,
      source: "pdf_chunks",
      content: row.chunk_text || "",
      title: row.title || row.originalname || row.keyword || "เอกสารที่อัปโหลด",
      reference: row.document_number || row.title || row.originalname || row.keyword || "เอกสารที่อัปโหลด",
      documentNumber: row.document_number || "",
      documentDateText: row.document_date_text || "",
      documentSource: row.document_source || "",
      documentId: row.document_id || null,
    }));
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

          if (classifyChunkQuality(row).isHardFiltered) {
            return null;
          }

          const score = scoreChunkMatch(message, row) + coarseScore;
          const document = memoryDocuments.find((item) => item.id === row.document_id);
          if (document && document.isSearchable === 0) {
            return null;
          }
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

    // Build relevance ordering: prioritize specific token combinations in keyword
    // This helps surface chunks with compound terms like "ค่าบำรุงสันนิบาต" over generic matches
    // Exclude full phrase and common question words from ordering tokens
    const specificTokens = terms.filter(
      (t) =>
        t &&
        t.length >= 4 &&
        t.length <= 20 &&
        !["ต้อง", "จ่าย", "ไหม", "หรือไม่", "ได้ไหม"].includes(t),
    );
    const orderParams = [];
    let orderClause = "c.id DESC";

    if (specificTokens.length >= 2) {
      // Prioritize rows where keyword contains multiple specific tokens
      const keywordConditions = specificTokens
        .slice(0, 3)
        .map(() => "LOWER(c.keyword) LIKE ?")
        .join(" AND ");
      orderClause = `
        CASE
          WHEN ${keywordConditions} THEN 0
          WHEN LOWER(c.keyword) LIKE ? THEN 1
          ELSE 2
        END ASC,
        c.id DESC`;
      orderParams.push(
        ...specificTokens.slice(0, 3).map((t) => `%${t}%`),
        `%${specificTokens[0]}%`,
      );
    } else if (specificTokens.length === 1) {
      orderClause = `
        CASE
          WHEN LOWER(c.keyword) LIKE ? THEN 0
          ELSE 1
        END ASC,
        c.id DESC`;
      orderParams.push(`%${specificTokens[0]}%`);
    }

    const [rows] = await pool.query(
      `SELECT c.id, c.keyword, c.chunk_text, c.created_at, c.document_id,
              d.title, d.document_number, d.document_date_text, d.document_source, d.originalname
       FROM pdf_chunks
       AS c
       LEFT JOIN documents AS d ON d.id = c.document_id
       WHERE ${whereClause}
         AND (d.id IS NULL OR d.is_searchable = 1)
       ORDER BY ${orderClause}
       LIMIT 500`,
      [...params, ...orderParams]
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

        if (classifyChunkQuality(row).isHardFiltered) {
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
        .filter((row) => row.isSearchable !== 0)
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
       WHERE (${whereClause})
         AND is_searchable = 1
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

  /**
   * Load and cache embeddings from database
   */
  static async loadEmbeddingCache() {
    const now = Date.now();
    if (embeddingCache && now - embeddingCacheTime < EMBEDDING_CACHE_TTL_MS) {
      return embeddingCache;
    }

    const pool = getDbPool();
    if (!pool) {
      return [];
    }

    const [rows] = await pool.query(`
      SELECT c.id, c.keyword, c.chunk_text, c.embedding, c.document_id,
             d.title, d.document_number, d.document_date_text, d.document_source, d.originalname
      FROM pdf_chunks AS c
      LEFT JOIN documents AS d ON d.id = c.document_id
      WHERE c.embedding IS NOT NULL
        AND (d.id IS NULL OR d.is_searchable = 1)
    `);

    // Pre-convert embeddings to Float32Array
    embeddingCache = rows.map((row) => ({
      ...row,
      embeddingVector: bufferToEmbedding(row.embedding),
      embedding: undefined,
    })).filter((row) => row.embeddingVector);

    embeddingCacheTime = now;
    return embeddingCache;
  }

  /**
   * Semantic search using embeddings
   * @param {string} message - User query
   * @param {number} limit - Max results
   * @returns {Promise<Array>} - Semantically similar chunks
   */
  static async semanticSearch(message, limit = 10) {
    // Allow temporarily disabling embeddings to control API cost.
    if (!isEmbeddingEnabled()) {
      return [];
    }

    // Create embedding for query
    const queryEmbedding = await createEmbedding(message);
    if (!queryEmbedding) {
      return [];
    }

    // Get cached embeddings
    const cachedRows = await this.loadEmbeddingCache();
    if (cachedRows.length === 0) {
      return [];
    }

    // Calculate similarity scores
    const scored = cachedRows
      .map((row) => {
        const similarity = cosineSimilarity(queryEmbedding, row.embeddingVector);
        return {
          id: row.id,
          keyword: row.keyword,
          chunk_text: row.chunk_text,
          document_id: row.document_id,
          title: row.title,
          document_number: row.document_number,
          document_date_text: row.document_date_text,
          document_source: row.document_source,
          originalname: row.originalname,
          similarity,
          source: "pdf_chunks",
          reference: row.document_number || row.title || row.originalname || row.keyword || "เอกสารที่อัปโหลด",
          documentNumber: row.document_number || "",
          documentDateText: row.document_date_text || "",
          documentSource: row.document_source || "",
          // Convert similarity (0-1) to score scale similar to keyword search
          score: Math.round(similarity * 200),
        };
      })
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);

    return scored;
  }

  /**
   * Hybrid search combining keyword and semantic search
   * @param {string} message - User query
   * @param {number} limit - Max results
   * @returns {Promise<Array>} - Combined results
   */
  static async hybridSearch(message, limit = 10) {
    // Run keyword and semantic search in parallel
    const [keywordResults, semanticResults] = await Promise.all([
      this.searchChunks(message, limit),
      this.semanticSearch(message, limit),
    ]);

    // Merge results, preferring keyword matches but boosting with semantic scores
    const resultMap = new Map();

    // Add keyword results first
    keywordResults.forEach((result) => {
      resultMap.set(result.id, {
        ...result,
        keywordScore: result.score,
        semanticScore: 0,
      });
    });

    // Add/merge semantic results
    semanticResults.forEach((result) => {
      if (resultMap.has(result.id)) {
        // Boost existing result with semantic score
        const existing = resultMap.get(result.id);
        existing.semanticScore = result.score;
        existing.score = existing.keywordScore + Math.round(result.score * 0.3); // 30% semantic boost
      } else {
        // Add new semantic-only result
        resultMap.set(result.id, {
          ...result,
          keywordScore: 0,
          semanticScore: result.score,
        });
      }
    });

    // Sort by combined score and return top results
    return Array.from(resultMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

module.exports = LawChatbotPdfChunkModel;
