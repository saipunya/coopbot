const fs = require("node:fs/promises");
const path = require("node:path");
const { getDbPool } = require("../config/db");
const { normalizeThai } = require("../utils/thaiNormalizer");
const { expandKeywords } = require("../utils/synonyms");
const {
  hasExclusiveMeaningMismatch,
  makeBigrams,
  expandSearchConcepts,
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
let pdfChunkFulltextSearchConfigCache = null;
let pdfChunkColumnMetadataCache = null;
const SEARCH_MISS_LOG_PATH = path.join(__dirname, "..", "logs", "search-misses.jsonl");
const SEARCH_MISS_LOG_COOLDOWN_MS = 10 * 60 * 1000;
const HYBRID_SEMANTIC_FALLBACK_MIN_SCORE = Number(
  process.env.HYBRID_SEMANTIC_FALLBACK_MIN_SCORE || 70,
);
const searchMissLogTimestamps = new Map();
let searchMissLogWarned = false;

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

function normalizeSearchKeyword(text) {
  return normalizeThai(normalizeForSearch(text));
}

function compactThaiText(text) {
  return normalizeSearchKeyword(text).replace(/\s+/g, "");
}

function isFulltextMatchingKeyError(error) {
  return Boolean(
    error &&
      (error.code === "ER_FT_MATCHING_KEY_NOT_FOUND" ||
        /FULLTEXT index matching the column list/i.test(String(error.message || ""))),
  );
}

function makeCharacterBigrams(text) {
  const compact = compactThaiText(text);
  if (compact.length < 2) {
    return compact ? [compact] : [];
  }

  const grams = [];
  for (let index = 0; index < compact.length - 1; index += 1) {
    grams.push(compact.slice(index, index + 2));
  }
  return grams;
}

function calculateDiceCoefficient(leftText, rightText) {
  const leftBigrams = makeCharacterBigrams(leftText);
  const rightBigrams = makeCharacterBigrams(rightText);

  if (leftBigrams.length === 0 || rightBigrams.length === 0) {
    return 0;
  }

  const rightCounts = new Map();
  rightBigrams.forEach((gram) => {
    rightCounts.set(gram, (rightCounts.get(gram) || 0) + 1);
  });

  let overlap = 0;
  leftBigrams.forEach((gram) => {
    const count = rightCounts.get(gram) || 0;
    if (count > 0) {
      overlap += 1;
      rightCounts.set(gram, count - 1);
    }
  });

  return (2 * overlap) / (leftBigrams.length + rightBigrams.length);
}

function isGarbage(text) {
  const rawText = String(text || "");
  const normalizedText = normalizeSearchKeyword(rawText);
  if (!normalizedText) {
    return true;
  }

  if (normalizedText.replace(/\s+/g, "").length < 4) {
    return true;
  }

  const suspiciousSymbolHits = countRegexMatches(rawText, /[\uFFFD\uF700-\uF8FF~^_=<>[\]{}|\\`]/g);
  if (suspiciousSymbolHits >= 3) {
    return true;
  }

  const usefulChars = countRegexMatches(rawText, /[ก-๙a-zA-Z0-9\s]/g);
  if (rawText.length >= 12 && usefulChars / rawText.length < 0.45) {
    return true;
  }

  return false;
}

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

function buildRowSearchCorpus(row = {}) {
  return [
    row.keyword,
    row.chunk_text,
    row.clean_text,
    row.title,
    row.document_number,
    row.document_date_text,
    row.document_source,
    row.originalname,
  ]
    .filter(Boolean)
    .join(" ");
}

function applyTopicBoost(row, family, query, baseScore) {
  if (!family || typeof family !== "object") {
    return baseScore;
  }

  const rowText = normalizeForSearch(buildRowSearchCorpus(row)).toLowerCase();
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
  const rowText = normalizeForSearch(buildRowSearchCorpus(row)).toLowerCase();
  const rawKeyword = String(row.keyword || "");
  const rawChunkText = String(row.chunk_text || "");
  const rawTitle = String(row.title || "");
  const rawDocumentNumber = String(row.document_number || "");
  const rawDocumentSource = String(row.document_source || "");
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

  if (normalizedQuery && rawTitle.toLowerCase().includes(normalizedQuery)) {
    score += 24;
  }

  if (normalizedQuery && rawDocumentNumber.toLowerCase().includes(normalizedQuery)) {
    score += 20;
  }

  const keywordTokens = uniqueTokens(segmentWords(row.keyword || ""));
  const keywordHits = queryTokens.filter((token) => keywordTokens.includes(token)).length;
  score += keywordHits * 12;

  const titleTokens = uniqueTokens(segmentWords(rawTitle));
  const titleHits = queryTokens.filter((token) => titleTokens.includes(token)).length;
  score += titleHits * 10;

  const documentNumberTokens = uniqueTokens(segmentWords(rawDocumentNumber));
  const documentNumberHits = queryTokens.filter((token) => documentNumberTokens.includes(token)).length;
  score += documentNumberHits * 9;

  const sourceTokens = uniqueTokens(segmentWords(rawDocumentSource));
  const sourceHits = queryTokens.filter((token) => sourceTokens.includes(token)).length;
  score += sourceHits * 6;

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
  const titleLower = rawTitle.toLowerCase();
  const documentNumberLower = rawDocumentNumber.toLowerCase();

  const topicFamily = detectTopicFamily(query);
  if (topicFamily) {
    score = applyTopicBoost(row, topicFamily, query, score);
  }

  if (queryLower && (titleLower.includes(queryLower) || documentNumberLower.includes(queryLower))) {
    score += 18;
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

function buildSmartSearchTerms(message) {
  const normalizedMessage = normalizeSearchKeyword(message);
  const expandedConceptText = normalizeSearchKeyword(expandSearchConcepts(message));
  const baseTerms = buildCandidateTerms(message).map((term) => normalizeSearchKeyword(term));
  const queryTokens = uniqueTokens([
    ...segmentWords(message),
    ...segmentWords(normalizedMessage),
    ...segmentWords(expandedConceptText),
  ])
    .map((token) => normalizeSearchKeyword(token))
    .filter((token) => token && token.length >= 2);
  const expandedTerms = uniqueTokens([
    normalizedMessage,
    expandedConceptText,
    ...baseTerms,
    ...expandKeywords(normalizedMessage),
    ...expandKeywords(expandedConceptText),
    ...queryTokens.flatMap((token) => expandKeywords(token)),
  ]).filter(Boolean);
  const genericExpansionTerms = new Set([...GENERIC_QUERY_TOKENS, "coop", "สหกรณ"]);
  const specificExpandedTerms = expandedTerms.filter((term) => !genericExpansionTerms.has(term));
  const filteredTerms =
    specificExpandedTerms.length > 0
      ? uniqueTokens([normalizedMessage, ...specificExpandedTerms])
      : expandedTerms;
  const fallbackSourceTerms = filteredTerms.filter(
    (term) => term && (term.length <= 8 || filteredTerms.length === 1),
  );

  const searchTerms = filteredTerms.slice(0, 12);
  const fallbackTerms = uniqueTokens(
    fallbackSourceTerms.flatMap((term) => {
      const compact = compactThaiText(term);
      if (!compact) {
        return [];
      }

      if (compact.length <= 3) {
        return [compact];
      }

      const candidates = [compact.slice(0, 3), compact.slice(-3)];
      if (compact.length >= 5) {
        candidates.push(compact.slice(0, 2), compact.slice(-2));
      }
      return candidates;
    }),
  )
    .filter((term) => term && term.length >= 2 && term.length <= 3)
    .slice(0, 8);

  return {
    normalizedMessage,
    expandedConceptText,
    searchTerms,
    fallbackTerms,
    queryTokens: queryTokens.filter((token) => token.length >= 2 && !GENERIC_QUERY_TOKENS.has(token)),
  };
}

function buildBooleanModeQuery(terms = []) {
  const booleanTerms = uniqueTokens(
    terms
      .flatMap((term) => String(term || "").split(/\s+/))
      .map((term) => normalizeSearchKeyword(term))
      .filter((term) => term && term.length >= 2),
  )
    .slice(0, 6)
    .map((term) => `${term}*`);

  return booleanTerms.join(" ");
}

function scoreApproximateTokenHits(queryTokens = [], rowTokens = []) {
  if (!Array.isArray(queryTokens) || !Array.isArray(rowTokens) || queryTokens.length === 0 || rowTokens.length === 0) {
    return 0;
  }

  const limitedRowTokens = rowTokens
    .map((token) => compactThaiText(token))
    .filter((token) => token && token.length >= 2 && token.length <= 32)
    .slice(0, 80);

  let score = 0;
  queryTokens
    .filter((token) => token && token.length >= 3)
    .slice(0, 6)
    .forEach((queryToken) => {
      const compactQuery = compactThaiText(queryToken);
      if (!compactQuery) {
        return;
      }

      let bestSimilarity = 0;
      for (const rowToken of limitedRowTokens) {
        if (!rowToken) {
          continue;
        }

        const lengthRatio =
          Math.min(rowToken.length, compactQuery.length) /
          Math.max(rowToken.length, compactQuery.length);
        if ((rowToken.includes(compactQuery) || compactQuery.includes(rowToken)) && lengthRatio >= 0.75) {
          bestSimilarity = 1;
          break;
        }

        if (Math.abs(rowToken.length - compactQuery.length) > 2) {
          continue;
        }

        bestSimilarity = Math.max(bestSimilarity, calculateDiceCoefficient(compactQuery, rowToken));
      }

      if (bestSimilarity >= 0.92) {
        score += 12;
      } else if (bestSimilarity >= 0.82) {
        score += 7;
      } else if (bestSimilarity >= 0.72) {
        score += 3;
      }
    });

  return score;
}

function buildRowPresentation(row) {
  return {
    ...row,
    source: "pdf_chunks",
    title: row.title || row.originalname || row.keyword || "เอกสารที่อัปโหลด",
    reference:
      row.document_number || row.title || row.originalname || row.keyword || "เอกสารที่อัปโหลด",
    documentNumber: row.document_number || "",
    documentDateText: row.document_date_text || "",
    documentSource: row.document_source || "",
  };
}

function evaluateSearchMissReason(results = []) {
  if (!Array.isArray(results) || results.length === 0) {
    return "no_results";
  }

  const topScore = Number(results[0]?.score || 0);
  if (topScore < 45) {
    return "low_top_score";
  }

  if (results.length === 1 && topScore < 70) {
    return "thin_result_set";
  }

  return "";
}

function shouldAppendSearchMissLog(record = {}) {
  const normalizedQuery = String(record.normalizedQuery || "").trim().toLowerCase();
  const reason = String(record.reason || "").trim().toLowerCase();
  const topKeyword = String(record.topResultKeyword || "").trim().toLowerCase();
  const topScoreBucket = Math.floor(Number(record.topResultScore || 0) / 10);
  const key = `${normalizedQuery}|${reason}|${topKeyword}|${topScoreBucket}`;
  const now = Date.now();
  const lastLoggedAt = searchMissLogTimestamps.get(key) || 0;

  if (now - lastLoggedAt < SEARCH_MISS_LOG_COOLDOWN_MS) {
    return false;
  }

  searchMissLogTimestamps.set(key, now);
  return true;
}

async function appendSearchMissLog(record = {}) {
  try {
    if (!shouldAppendSearchMissLog(record)) {
      return;
    }

    await fs.mkdir(path.dirname(SEARCH_MISS_LOG_PATH), { recursive: true });
    await fs.appendFile(SEARCH_MISS_LOG_PATH, `${JSON.stringify(record)}\n`, "utf8");
  } catch (error) {
    if (!searchMissLogWarned) {
      searchMissLogWarned = true;
      console.warn(`Search miss log warning: ${error.message || error}`);
    }
  }
}

function logSearchMissIfNeeded(message, searchContext, results) {
  const reason = evaluateSearchMissReason(results);
  if (!reason) {
    return;
  }

  const topResult = Array.isArray(results) && results.length > 0 ? results[0] : null;
  void appendSearchMissLog({
    timestamp: new Date().toISOString(),
    reason,
    originalQuery: String(message || ""),
    normalizedQuery: searchContext?.normalizedMessage || "",
    expandedTerms: Array.isArray(searchContext?.searchTerms) ? searchContext.searchTerms : [],
    totalResults: Array.isArray(results) ? results.length : 0,
    topResultKeyword: topResult?.keyword || "",
    topResultScore: Number(topResult?.score || 0),
  });
}

function rankChunkRows(message, rows, searchContext, limit) {
  const minTokenHits = getMinimumTokenHits(searchContext.queryTokens);

  return rows
    .map((row) => {
      const combinedText = buildRowSearchCorpus(row).trim();
      const haystack = normalizeSearchKeyword(combinedText);
      const rowTokens = uniqueTokens([
        ...segmentWords(row.keyword || ""),
        ...segmentWords(row.chunk_text || ""),
        ...segmentWords(row.clean_text || ""),
        ...segmentWords(row.title || ""),
        ...segmentWords(row.document_number || ""),
        ...segmentWords(row.document_source || ""),
        ...segmentWords(row.originalname || ""),
        ...segmentWords(haystack),
      ])
        .map((token) => normalizeSearchKeyword(token))
        .filter(Boolean);
      const rowTokenSet = new Set(rowTokens);
      const tokenHits = searchContext.queryTokens.filter((token) => rowTokenSet.has(token)).length;
      const hasExactPhrase =
        searchContext.normalizedMessage && haystack.includes(searchContext.normalizedMessage);
      const coarseScore = searchContext.searchTerms.reduce(
        (sum, term) => sum + (haystack.includes(term) ? (term.length >= 4 ? 2 : 1) : 0),
        0,
      );
      const fallbackScore = searchContext.fallbackTerms.reduce(
        (sum, term) => sum + (compactThaiText(haystack).includes(term) ? 1 : 0),
        0,
      );
      const fuzzyScore = scoreApproximateTokenHits(searchContext.queryTokens, rowTokens);
      const fulltextScore = Number(row.fulltext_score || 0);
      const qualityScore = Number(row.quality_score);
      const qualityScoreBoost = Number.isFinite(qualityScore)
        ? Math.round(Math.max(0, Math.min(100, qualityScore)) / 10)
        : 0;

      if (Number(row.is_active ?? 1) === 0) {
        return null;
      }

      if (classifyChunkQuality(row).isHardFiltered || isGarbage(combinedText)) {
        return null;
      }

      if (
        searchContext.queryTokens.length > 0 &&
        !hasExactPhrase &&
        tokenHits < minTokenHits &&
        coarseScore < 1 &&
        fallbackScore < 2 &&
        fuzzyScore < 7 &&
        fulltextScore <= 0
      ) {
        return null;
      }

      const score =
        scoreChunkMatch(message, row) +
        Number(row.sql_score || 0) +
        coarseScore +
        fallbackScore +
        fuzzyScore +
        qualityScoreBoost +
        Math.round(fulltextScore * 10);

      return {
        ...buildRowPresentation(row),
        score,
      };
    })
    .filter(Boolean)
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

const uploadedFiles = [];
const memoryChunks = [];
const memoryDocuments = [];

class LawChatbotPdfChunkModel {
  static clearEmbeddingCache() {
    embeddingCache = null;
    embeddingCacheTime = 0;
  }

  static __resetTestState() {
    uploadedFiles.length = 0;
    memoryChunks.length = 0;
    memoryDocuments.length = 0;
    this.clearEmbeddingCache();
    pdfChunkFulltextSearchConfigCache = null;
    pdfChunkColumnMetadataCache = null;
  }

  static __seedTestSearchData({ documents = [], chunks = [] } = {}) {
    this.__resetTestState();

    documents.forEach((document, index) => {
      memoryDocuments.push({
        id: Number(document.id || index + 1),
        title: String(document.title || ""),
        documentNumber: String(document.documentNumber || ""),
        documentDateText: String(document.documentDateText || ""),
        documentSource: String(document.documentSource || ""),
        originalname: String(document.originalname || ""),
        isSearchable: document.isSearchable === false || Number(document.isSearchable) === 0 ? 0 : 1,
        created_at: document.created_at || new Date().toISOString(),
      });
    });

    chunks.forEach((chunk, index) => {
      memoryChunks.push({
        id: Number(chunk.id || index + 1),
        keyword: String(chunk.keyword || ""),
        chunk_text: String(chunk.chunk_text || chunk.chunkText || ""),
        clean_text: String(chunk.clean_text || chunk.cleanText || ""),
        is_active: chunk.is_active === false || Number(chunk.is_active) === 0 ? 0 : 1,
        quality_score: Number.isFinite(Number(chunk.quality_score))
          ? Number(chunk.quality_score)
          : null,
        document_id: chunk.document_id || chunk.documentId || null,
        created_at: chunk.created_at || new Date().toISOString(),
      });
    });
  }

  static async resolvePdfChunkFulltextSearchConfig(pool, columnMetadata = null) {
    if (!pool) {
      return {
        enabled: false,
        columns: [],
      };
    }

    if (pdfChunkFulltextSearchConfigCache) {
      return pdfChunkFulltextSearchConfigCache;
    }

    try {
      const [rows] = await pool.query("SHOW INDEX FROM pdf_chunks WHERE Index_type = 'FULLTEXT'");
      const effectiveColumnMetadata = columnMetadata || (await this.resolvePdfChunkColumnMetadata(pool));
      const indexColumnsByName = new Map();

      (rows || []).forEach((row) => {
        const indexName = String(row.Key_name || "").trim();
        const columnName = String(row.Column_name || "").trim().toLowerCase();
        const sequence = Number(row.Seq_in_index || 0);
        if (!indexName || !columnName || !sequence) {
          return;
        }

        const columns = indexColumnsByName.get(indexName) || [];
        columns[sequence - 1] = columnName;
        indexColumnsByName.set(indexName, columns);
      });

      const candidateColumnSets = [];
      if (effectiveColumnMetadata.hasCleanText) {
        candidateColumnSets.push(["keyword", "chunk_text", "clean_text"]);
      }
      candidateColumnSets.push(["keyword", "chunk_text"]);
      if (
        effectiveColumnMetadata.hasTitle &&
        effectiveColumnMetadata.hasQuestion &&
        effectiveColumnMetadata.hasAnswer &&
        effectiveColumnMetadata.hasCleanText
      ) {
        candidateColumnSets.push(["keyword", "title", "question", "answer", "chunk_text", "clean_text"]);
      }

      const matchingColumns =
        candidateColumnSets.find((candidateColumns) =>
          [...indexColumnsByName.values()].some((indexColumns) =>
            indexColumns.length === candidateColumns.length &&
            indexColumns.every((columnName, index) => columnName === candidateColumns[index]),
          ),
        ) || [];

      pdfChunkFulltextSearchConfigCache = {
        enabled: matchingColumns.length > 0,
        columns: matchingColumns,
      };
    } catch (_error) {
      pdfChunkFulltextSearchConfigCache = {
        enabled: false,
        columns: [],
      };
    }

    return pdfChunkFulltextSearchConfigCache;
  }

  static async resolvePdfChunkColumnMetadata(pool) {
    if (!pool) {
      return {
        hasCleanText: false,
        hasIsActive: false,
        hasQualityScore: false,
        hasOriginalText: false,
        hasChunkType: false,
        hasSortOrder: false,
      };
    }

    if (pdfChunkColumnMetadataCache) {
      return pdfChunkColumnMetadataCache;
    }

    try {
      const [rows] = await pool.query("SHOW COLUMNS FROM pdf_chunks");
      const fields = new Set((rows || []).map((row) => String(row.Field || "").trim().toLowerCase()));
      pdfChunkColumnMetadataCache = {
        hasCleanText: fields.has("clean_text"),
        hasIsActive: fields.has("is_active"),
        hasQualityScore: fields.has("quality_score"),
        hasOriginalText: fields.has("original_text"),
        hasChunkType: fields.has("chunk_type"),
        hasSortOrder: fields.has("sort_order"),
        hasTitle: fields.has("title"),
        hasQuestion: fields.has("question"),
        hasAnswer: fields.has("answer"),
      };
    } catch (_error) {
      pdfChunkColumnMetadataCache = {
        hasCleanText: false,
        hasIsActive: false,
        hasQualityScore: false,
        hasOriginalText: false,
        hasChunkType: false,
        hasSortOrder: false,
        hasTitle: false,
        hasQuestion: false,
        hasAnswer: false,
      };
    }

    return pdfChunkColumnMetadataCache;
  }

  static async queryChunkRows(pool, searchTerms, options = {}) {
    const normalizedTerms = uniqueTokens(searchTerms.map((term) => normalizeSearchKeyword(term)).filter(Boolean));
    const limitedTerms = normalizedTerms
      .filter((term) => term.length >= (options.fallback ? 2 : 3))
      .slice(0, options.fallback ? 8 : 12);

    const fulltextConfig = options.fulltextConfig && options.fulltextConfig.enabled ? options.fulltextConfig : null;
    const hasFulltext = Boolean(fulltextConfig && options.fulltextQuery);
    if (limitedTerms.length === 0 && !hasFulltext) {
      return [];
    }
    const columnMetadata = options.columnMetadata || (await this.resolvePdfChunkColumnMetadata(pool));
    const cleanTextSelect = columnMetadata.hasCleanText ? "c.clean_text AS clean_text" : "NULL AS clean_text";
    const isActiveSelect = columnMetadata.hasIsActive ? "c.is_active AS is_active" : "1 AS is_active";
    const qualityScoreSelect = columnMetadata.hasQualityScore
      ? "c.quality_score AS quality_score"
      : "NULL AS quality_score";

    const whereParts = [];
    const whereParams = [];
    const scoreParts = [];
    const scoreParams = [];

    if (options.normalizedMessage) {
      const exactLike = `%${options.normalizedMessage}%`;
      scoreParts.push("CASE WHEN LOWER(c.keyword) LIKE ? THEN 18 ELSE 0 END");
      scoreParts.push("CASE WHEN LOWER(c.chunk_text) LIKE ? THEN 9 ELSE 0 END");
      scoreParams.push(exactLike, exactLike);
    }

    limitedTerms.forEach((term) => {
      const like = `%${term}%`;
      const cleanTextLikeSql = columnMetadata.hasCleanText ? " OR LOWER(c.clean_text) LIKE ?" : "";
      whereParts.push(
        `(LOWER(c.keyword) LIKE ? OR LOWER(c.chunk_text) LIKE ?${cleanTextLikeSql} OR LOWER(COALESCE(d.title, '')) LIKE ? OR LOWER(COALESCE(d.document_number, '')) LIKE ? OR LOWER(COALESCE(d.document_source, '')) LIKE ? OR LOWER(COALESCE(d.originalname, '')) LIKE ?)`,
      );
      whereParams.push(
        like,
        like,
        ...(columnMetadata.hasCleanText ? [like] : []),
        like,
        like,
        like,
        like,
      );

      scoreParts.push(`CASE WHEN LOWER(c.keyword) LIKE ? THEN ${options.fallback ? 6 : 12} ELSE 0 END`);
      scoreParts.push(`CASE WHEN LOWER(c.chunk_text) LIKE ? THEN ${options.fallback ? 3 : 7} ELSE 0 END`);
      if (columnMetadata.hasCleanText) {
        scoreParts.push(`CASE WHEN LOWER(c.clean_text) LIKE ? THEN ${options.fallback ? 3 : 7} ELSE 0 END`);
      }
      scoreParts.push(`CASE WHEN LOWER(COALESCE(d.title, '')) LIKE ? THEN ${options.fallback ? 5 : 11} ELSE 0 END`);
      scoreParts.push(
        `CASE WHEN LOWER(COALESCE(d.document_number, '')) LIKE ? THEN ${options.fallback ? 4 : 9} ELSE 0 END`,
      );
      scoreParts.push(
        `CASE WHEN LOWER(COALESCE(d.document_source, '')) LIKE ? THEN ${options.fallback ? 2 : 5} ELSE 0 END`,
      );
      scoreParts.push(`CASE WHEN LOWER(COALESCE(d.originalname, '')) LIKE ? THEN ${options.fallback ? 2 : 4} ELSE 0 END`);
      scoreParams.push(
        like,
        like,
        ...(columnMetadata.hasCleanText ? [like] : []),
        like,
        like,
        like,
        like,
      );
    });

    let fulltextSelect = "0 AS fulltext_score";
    if (hasFulltext) {
      const matchColumnSql = fulltextConfig.columns.map((columnName) => `c.${columnName}`).join(", ");
      fulltextSelect = `MATCH(${matchColumnSql}) AGAINST (? IN BOOLEAN MODE) AS fulltext_score`;
      whereParts.push(`MATCH(${matchColumnSql}) AGAINST (? IN BOOLEAN MODE)`);
      scoreParams.push(options.fulltextQuery);
      whereParams.push(options.fulltextQuery);
    }

    const sqlScoreExpression = scoreParts.length > 0 ? scoreParts.join(" + ") : "0";
    const fetchLimit = options.fetchLimit || 250;

    try {
      const [rows] = await pool.query(
        `SELECT c.id, c.keyword, c.chunk_text, c.created_at, c.document_id,
                d.title, d.document_number, d.document_date_text, d.document_source, d.originalname,
                ${cleanTextSelect},
                ${isActiveSelect},
                ${qualityScoreSelect},
                (${sqlScoreExpression}) AS sql_score,
                ${fulltextSelect}
         FROM pdf_chunks AS c
         LEFT JOIN documents AS d ON d.id = c.document_id
         WHERE (${whereParts.join(" OR ")})
           AND (d.id IS NULL OR d.is_searchable = 1)
         ORDER BY sql_score DESC, fulltext_score DESC, c.id DESC
         LIMIT ?`,
        [...scoreParams, ...whereParams, fetchLimit],
      );

      return rows;
    } catch (error) {
      if (hasFulltext && isFulltextMatchingKeyError(error)) {
        pdfChunkFulltextSearchConfigCache = {
          enabled: false,
          columns: [],
        };
        return this.queryChunkRows(pool, searchTerms, {
          ...options,
          fulltextConfig: null,
        });
      }

      throw error;
    }
  }

  static getSearchDebugContext(message) {
    return buildSmartSearchTerms(message);
  }

  static async debugSearch(message, limit = 10) {
    const normalizedLimit = Math.max(1, Number(limit || 10));
    const searchContext = buildSmartSearchTerms(message);

    if (searchContext.searchTerms.length === 0 && searchContext.fallbackTerms.length === 0) {
      return {
        query: String(message || ""),
        normalizedQuery: searchContext.normalizedMessage,
        searchContext,
        totalResults: 0,
        rawCandidateCount: 0,
        usedFallback: false,
        fulltextEnabled: false,
        results: [],
      };
    }

    const pool = getDbPool();

    if (!pool) {
      const primaryRows = memoryChunks
        .map((row) => {
          const document = memoryDocuments.find((item) => item.id === row.document_id);
          if (document && document.isSearchable === 0) {
            return null;
          }

          return {
            ...row,
            title: document?.title || row.keyword || "เอกสารที่อัปโหลด",
            document_number: document?.documentNumber || "",
            document_date_text: document?.documentDateText || "",
            document_source: document?.documentSource || "",
            originalname: document?.originalname || "",
            sql_score: searchContext.searchTerms.reduce((sum, term) => {
              const haystack = normalizeSearchKeyword(
                `${row.keyword || ""} ${row.chunk_text || ""} ${row.clean_text || ""}`,
              );
              return sum + (haystack.includes(term) ? 1 : 0);
            }, 0),
            fulltext_score: 0,
          };
        })
        .filter(Boolean);

      let rankedResults = rankChunkRows(message, primaryRows, searchContext, Number.MAX_SAFE_INTEGER);
      let usedFallback = false;
      let rawCandidateCount = primaryRows.length;

      if (rankedResults.length === 0 && searchContext.fallbackTerms.length > 0) {
        usedFallback = true;
        const fallbackRows = memoryChunks
          .map((row) => {
            const document = memoryDocuments.find((item) => item.id === row.document_id);
            if (document && document.isSearchable === 0) {
              return null;
            }

            return {
              ...row,
              title: document?.title || row.keyword || "เอกสารที่อัปโหลด",
              document_number: document?.documentNumber || "",
              document_date_text: document?.documentDateText || "",
              document_source: document?.documentSource || "",
              originalname: document?.originalname || "",
              sql_score: searchContext.fallbackTerms.reduce((sum, term) => {
                const haystack = compactThaiText(
                  `${row.keyword || ""} ${row.chunk_text || ""} ${row.clean_text || ""}`,
                );
                return sum + (haystack.includes(term) ? 1 : 0);
              }, 0),
              fulltext_score: 0,
            };
          })
          .filter(Boolean);

        rawCandidateCount = fallbackRows.length;
        rankedResults = rankChunkRows(
          message,
          fallbackRows,
          {
            ...searchContext,
            searchTerms: searchContext.fallbackTerms,
          },
          Number.MAX_SAFE_INTEGER,
        );
      }

      return {
        query: String(message || ""),
        normalizedQuery: searchContext.normalizedMessage,
        searchContext,
        totalResults: rankedResults.length,
        rawCandidateCount,
        usedFallback,
        fulltextEnabled: false,
        results: rankedResults.slice(0, normalizedLimit),
      };
    }

    const columnMetadata = await this.resolvePdfChunkColumnMetadata(pool);
    const fulltextConfig = await this.resolvePdfChunkFulltextSearchConfig(pool, columnMetadata);
    const fulltextQuery = buildBooleanModeQuery(searchContext.searchTerms);

    const primaryRows = await this.queryChunkRows(pool, searchContext.searchTerms, {
      columnMetadata,
      normalizedMessage: searchContext.normalizedMessage,
      fulltextQuery,
      fulltextConfig,
      fetchLimit: 1000,
      fallback: false,
    });

    let rankedResults = rankChunkRows(message, primaryRows, searchContext, Number.MAX_SAFE_INTEGER);
    let rawCandidateCount = primaryRows.length;
    let usedFallback = false;

    if (rankedResults.length === 0 && searchContext.fallbackTerms.length > 0) {
      usedFallback = true;
      const fallbackRows = await this.queryChunkRows(pool, searchContext.fallbackTerms, {
        columnMetadata,
        normalizedMessage: searchContext.normalizedMessage,
        fulltextQuery,
        fulltextConfig,
        fetchLimit: 1000,
        fallback: true,
      });

      rawCandidateCount = fallbackRows.length;
      rankedResults = rankChunkRows(
        message,
        fallbackRows,
        {
          ...searchContext,
          searchTerms:
            searchContext.fallbackTerms.length > 0
              ? searchContext.fallbackTerms
              : searchContext.searchTerms,
        },
        Number.MAX_SAFE_INTEGER,
      );
    }

    return {
      query: String(message || ""),
      normalizedQuery: searchContext.normalizedMessage,
      searchContext,
      totalResults: rankedResults.length,
      rawCandidateCount,
      usedFallback,
      fulltextEnabled: Boolean(fulltextConfig.enabled),
      results: rankedResults.slice(0, normalizedLimit),
    };
  }

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
      this.clearEmbeddingCache();
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

    this.clearEmbeddingCache();

    return {
      id: result.insertId,
      ...normalizedEntry,
    };
  }

  static async insertChunks(chunks, documentId = null) {
    const normalizedChunks = chunks.map((chunk) => ({
      keyword: String(chunk.keyword || "").slice(0, 255),
      chunkText: String(chunk.chunkText || ""),
      originalText: String(chunk.originalText || chunk.original_text || chunk.chunkText || ""),
      cleanText: String(chunk.cleanText || chunk.clean_text || normalizeThai(String(chunk.chunkText || ""))),
      chunkType: String(chunk.chunkType || chunk.chunk_type || "").slice(0, 20),
      sortOrder: Number.isFinite(Number(chunk.sortOrder || chunk.sort_order))
        ? Number(chunk.sortOrder || chunk.sort_order)
        : 0,
      isActive: chunk.isActive === false || Number(chunk.isActive) === 0 ? 0 : 1,
      qualityScore: Number.isFinite(Number(chunk.qualityScore))
        ? Number(chunk.qualityScore)
        : Number.isFinite(Number(chunk.quality_score))
          ? Number(chunk.quality_score)
          : null,
      documentId: documentId || chunk.documentId || null,
    }));

    const pool = getDbPool();

    if (!pool) {
      normalizedChunks.forEach((chunk, index) => {
        memoryChunks.unshift({
          id: memoryChunks.length + index + 1,
          keyword: chunk.keyword,
          chunk_text: chunk.chunkText,
          original_text: chunk.originalText,
          clean_text: chunk.cleanText,
          chunk_type: chunk.chunkType,
          sort_order: chunk.sortOrder,
          is_active: chunk.isActive,
          quality_score: chunk.qualityScore,
          document_id: chunk.documentId,
          created_at: new Date().toISOString(),
        });
      });
      this.clearEmbeddingCache();
      return normalizedChunks.length;
    }

    const columnMetadata = await this.resolvePdfChunkColumnMetadata(pool);
    const columns = ["keyword", "chunk_text"];
    if (columnMetadata.hasCleanText) {
      columns.push("clean_text");
    }
    if (columnMetadata.hasOriginalText) {
      columns.push("original_text");
    }
    if (columnMetadata.hasChunkType) {
      columns.push("chunk_type");
    }
    if (columnMetadata.hasSortOrder) {
      columns.push("sort_order");
    }
    if (columnMetadata.hasIsActive) {
      columns.push("is_active");
    }
    if (columnMetadata.hasQualityScore) {
      columns.push("quality_score");
    }
    columns.push("document_id");

    const values = normalizedChunks.map((chunk) => {
      const rowValues = [chunk.keyword, chunk.chunkText];
      if (columnMetadata.hasCleanText) {
        rowValues.push(chunk.cleanText);
      }
      if (columnMetadata.hasOriginalText) {
        rowValues.push(chunk.originalText);
      }
      if (columnMetadata.hasChunkType) {
        rowValues.push(chunk.chunkType);
      }
      if (columnMetadata.hasSortOrder) {
        rowValues.push(chunk.sortOrder);
      }
      if (columnMetadata.hasIsActive) {
        rowValues.push(chunk.isActive);
      }
      if (columnMetadata.hasQualityScore) {
        rowValues.push(chunk.qualityScore);
      }
      rowValues.push(chunk.documentId);
      return rowValues;
    });

    if (values.length > 0) {
      await pool.query(`INSERT INTO pdf_chunks (${columns.join(", ")}) VALUES ?`, [values]);
      this.clearEmbeddingCache();
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
    return this.searchChunksSmart(message, limit);
  }

  static async searchChunksSmart(message, limit = 5, options = {}) {
    const searchContext = buildSmartSearchTerms(message);
    const shouldLogMiss = options.logMiss !== false;

    if (searchContext.searchTerms.length === 0 && searchContext.fallbackTerms.length === 0) {
      if (shouldLogMiss) {
        logSearchMissIfNeeded(message, searchContext, []);
      }
      return [];
    }

    const pool = getDbPool();

    if (!pool) {
      let results = rankChunkRows(
        message,
        memoryChunks
          .map((row) => {
            const document = memoryDocuments.find((item) => item.id === row.document_id);
            if (document && document.isSearchable === 0) {
              return null;
            }

            return {
              ...row,
              title: document?.title || row.keyword || "เอกสารที่อัปโหลด",
              document_number: document?.documentNumber || "",
              document_date_text: document?.documentDateText || "",
              document_source: document?.documentSource || "",
              originalname: document?.originalname || "",
              sql_score: searchContext.searchTerms.reduce((sum, term) => {
                const haystack = normalizeSearchKeyword(
                  `${row.keyword || ""} ${row.chunk_text || ""} ${row.clean_text || ""}`,
                );
                return sum + (haystack.includes(term) ? 1 : 0);
              }, 0),
              fulltext_score: 0,
            };
          })
          .filter(Boolean),
        searchContext,
        limit,
      );

      if (results.length === 0 && searchContext.fallbackTerms.length > 0) {
        results = rankChunkRows(
          message,
          memoryChunks
            .map((row) => {
              const document = memoryDocuments.find((item) => item.id === row.document_id);
              if (document && document.isSearchable === 0) {
                return null;
              }

              return {
                ...row,
                title: document?.title || row.keyword || "เอกสารที่อัปโหลด",
                document_number: document?.documentNumber || "",
                document_date_text: document?.documentDateText || "",
                document_source: document?.documentSource || "",
                originalname: document?.originalname || "",
                sql_score: searchContext.fallbackTerms.reduce((sum, term) => {
                  const haystack = compactThaiText(
                    `${row.keyword || ""} ${row.chunk_text || ""} ${row.clean_text || ""}`,
                  );
                  return sum + (haystack.includes(term) ? 1 : 0);
                }, 0),
                fulltext_score: 0,
              };
            })
            .filter(Boolean),
          {
            ...searchContext,
            searchTerms: searchContext.fallbackTerms,
          },
          limit,
        );
      }

      if (shouldLogMiss) {
        logSearchMissIfNeeded(message, searchContext, results);
      }
      return results;
    }

    const columnMetadata = await this.resolvePdfChunkColumnMetadata(pool);
    const fulltextConfig = await this.resolvePdfChunkFulltextSearchConfig(pool, columnMetadata);
    const fulltextQuery = buildBooleanModeQuery(searchContext.searchTerms);

    const primaryRows = await this.queryChunkRows(pool, searchContext.searchTerms, {
      columnMetadata,
      normalizedMessage: searchContext.normalizedMessage,
      fulltextQuery,
      fulltextConfig,
      fetchLimit: 300,
      fallback: false,
    });

    let results = rankChunkRows(message, primaryRows, searchContext, limit);

    if (results.length === 0) {
      const fallbackRows = await this.queryChunkRows(pool, searchContext.fallbackTerms, {
        columnMetadata,
        normalizedMessage: searchContext.normalizedMessage,
        fulltextQuery,
        fulltextConfig,
        fetchLimit: 200,
        fallback: true,
      });

      results = rankChunkRows(
        message,
        fallbackRows,
        {
          ...searchContext,
          searchTerms:
            searchContext.fallbackTerms.length > 0
              ? searchContext.fallbackTerms
              : searchContext.searchTerms,
        },
        limit,
      );
    }

    if (shouldLogMiss) {
      logSearchMissIfNeeded(message, searchContext, results);
    }
    return results;
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
    const keywordResults = await this.searchChunksSmart(message, limit, { logMiss: false });
    const topKeywordScore = Number(keywordResults[0]?.score || 0);
    const shouldUseSemanticFallback =
      keywordResults.length === 0 || topKeywordScore < HYBRID_SEMANTIC_FALLBACK_MIN_SCORE;
    const semanticResults = shouldUseSemanticFallback
      ? await this.semanticSearch(message, limit)
      : [];

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
    const results = Array.from(resultMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    logSearchMissIfNeeded(message, buildSmartSearchTerms(message), results);
    return results;
  }
}

module.exports = LawChatbotPdfChunkModel;
