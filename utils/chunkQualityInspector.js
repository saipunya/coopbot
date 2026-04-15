const { normalizeThai } = require("./thaiNormalizer");
const { isGarbageChunk, normalizeChunkText } = require("./chunkSplitter");

const QUALITY_STOPWORDS = new Set([
  "และ",
  "หรือ",
  "ของ",
  "ใน",
  "ที่",
  "ให้",
  "เป็น",
  "ได้",
  "มี",
  "ว่า",
  "กับ",
  "โดย",
  "ตาม",
  "เพื่อ",
  "จาก",
  "แก่",
  "แต่",
  "เมื่อ",
  "ซึ่ง",
  "นั้น",
  "ทุก",
  "ทุกคน",
  "คน",
  "จึง",
  "ต้อง",
  "อาจ",
  "ควร",
  "หาก",
  "ถ้า",
  "เพราะ",
  "ดังนั้น",
  "รวม",
  "ถึง",
  "ยัง",
  "แล้ว",
  "รวมทั้ง",
  "ทั้ง",
  "ดัง",
  "เป็นต้น",
  "อีก",
  "การ",
  "ความ",
  "เรื่อง",
  "ส่วน",
  "ไม่",
  "มาก",
  "น้อย",
  "ประมาณ",
  "เกี่ยวกับ",
  "สำหรับ",
  "ภายใต้",
  "ต่อ",
  "ผ่าน",
]);

const TOPIC_GROUPS = [
  { name: "committee", terms: ["คณะกรรมการดำเนินการ", "กรรมการดำเนินการ", "คณะกรรมการ"] },
  { name: "manager", terms: ["ผู้จัดการสหกรณ์", "ผู้จัดการ"] },
  { name: "staff", terms: ["เจ้าหน้าที่สหกรณ์", "เจ้าหน้าที่"] },
  { name: "member", terms: ["สมาชิกสมทบ", "สมาชิก"] },
  { name: "registrar", terms: ["นายทะเบียนสหกรณ์", "รองนายทะเบียนสหกรณ์", "นายทะเบียน"] },
  { name: "minister", terms: ["รัฐมนตรี"] },
  { name: "dissolution", terms: ["เลิกสหกรณ์", "การเลิกสหกรณ์", "ชำระบัญชี", "ผู้ชำระบัญชี"] },
  { name: "bylaw", terms: ["ข้อบังคับ"] },
  { name: "democracy", terms: ["ประชาธิปไตย"] },
  { name: "qualification", terms: ["คุณสมบัติ", "ลักษณะต้องห้าม", "ขาดคุณสมบัติ"] },
  { name: "duty", terms: ["อำนาจหน้าที่", "มีหน้าที่", "หน้าที่"] },
  { name: "definition", terms: ["หมายความว่า", "หมายถึง"] },
];

const DEFAULT_SHORT_CHUNK_LENGTH = 80;
const DEFAULT_LONG_CHUNK_LENGTH = 350;
const KEYWORD_TOO_SHORT_LENGTH = 4;
const KEYWORD_TOO_LONG_LENGTH = 80;

function normalizeComparisonText(text) {
  return normalizeThai(normalizeChunkText(text)).replace(/\s+/g, " ").trim();
}

function tokenizeMeaningfulTerms(text) {
  return normalizeComparisonText(text)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token && !QUALITY_STOPWORDS.has(token));
}

function uniqueItems(items) {
  return [...new Set((items || []).filter(Boolean))];
}

function containsEnoughTokens(text, tokens) {
  const normalizedText = normalizeComparisonText(text);
  if (!normalizedText || !Array.isArray(tokens) || tokens.length === 0) {
    return false;
  }

  return tokens.every((token) => normalizedText.includes(token));
}

function computeKeywordCoverage(keyword, chunkText) {
  const keywordTokens = tokenizeMeaningfulTerms(keyword);
  if (keywordTokens.length === 0) {
    return 0;
  }

  const normalizedChunk = normalizeComparisonText(chunkText);
  const directMatch = normalizeComparisonText(keyword);
  if (directMatch && normalizedChunk.includes(directMatch)) {
    return 1;
  }

  const hits = keywordTokens.filter((token) => normalizedChunk.includes(token)).length;
  return hits / keywordTokens.length;
}

function detectTopics(text) {
  const normalized = normalizeComparisonText(text);
  if (!normalized) {
    return [];
  }

  const matched = [];
  TOPIC_GROUPS.forEach((group) => {
    const matchedTerm = group.terms.find((term) => normalized.includes(normalizeComparisonText(term)));
    if (matchedTerm) {
      matched.push({
        name: group.name,
        term: matchedTerm,
      });
    }
  });

  return matched;
}

function isKeywordMessy(keyword) {
  const normalized = normalizeComparisonText(keyword);
  if (!normalized) {
    return true;
  }

  if (normalized.length > KEYWORD_TOO_LONG_LENGTH) {
    return true;
  }

  if (normalized.length < KEYWORD_TOO_SHORT_LENGTH) {
    return true;
  }

  if (/^[^\p{L}\p{M}\p{N}\s]+$/u.test(normalized)) {
    return true;
  }

  if (/^https?:\/\//i.test(normalized) || /^www\./i.test(normalized)) {
    return true;
  }

  const symbolCount = normalized.length - (normalized.match(/[\p{L}\p{M}\p{N}]/gu) || []).length;
  const symbolRatio = normalized.length > 0 ? symbolCount / normalized.length : 1;
  if (symbolRatio > 0.35) {
    return true;
  }

  if (/^[0-9\s.,\-\/()]+$/.test(normalized)) {
    return true;
  }

  return false;
}

function buildSuggestions(flags) {
  const suggestions = [];

  if (flags.includes("chunk_too_short") || flags.includes("chunk_too_long") || flags.includes("multi_topic")) {
    suggestions.push("ควร split");
  }

  if (flags.includes("keyword_too_short") || flags.includes("keyword_too_long") || flags.includes("keyword_messy")) {
    suggestions.push("ควรเปลี่ยน keyword");
  }

  if (flags.includes("keyword_not_in_text") || flags.includes("keyword_low_coverage")) {
    suggestions.push("ควรเปลี่ยน keyword");
  }

  if (flags.includes("chunk_garbage")) {
    suggestions.push("ควรลบหรือแก้ข้อความ");
  }

  if (flags.includes("topic_overlap")) {
    suggestions.push("ควร split เป็นหลาย chunk");
  }

  return uniqueItems(suggestions);
}

function inspectChunkQuality(chunkOrRow = {}, context = {}) {
  const row = typeof chunkOrRow === "string" ? { chunk_text: chunkOrRow } : { ...chunkOrRow };
  const keyword = String(row.keyword || row.key || context.keyword || context.baseKeyword || "").trim();
  const chunkText = String(row.chunk_text || row.chunkText || row.text || context.chunkText || "").trim();
  const normalizedKeyword = normalizeComparisonText(keyword);
  const normalizedChunkText = normalizeComparisonText(chunkText);
  const chunkLength = normalizedChunkText.length;
  const keywordLength = normalizedKeyword.length;
  const sentenceCount = normalizedChunkText
    ? normalizedChunkText.split(/[.!?ฯ]\s+|\n+/u).map((part) => part.trim()).filter(Boolean).length
    : 0;

  const flags = [];
  let score = 100;

  if (!chunkText) {
    flags.push("chunk_empty");
    score -= 60;
  }

  if (isGarbageChunk(chunkText)) {
    flags.push("chunk_garbage");
    score -= 45;
  }

  if (chunkLength > 0 && chunkLength < DEFAULT_SHORT_CHUNK_LENGTH) {
    flags.push("chunk_too_short");
    score -= 25;
  }

  if (chunkLength > DEFAULT_LONG_CHUNK_LENGTH) {
    flags.push("chunk_too_long");
    score -= 20;
  }

  if (!normalizedKeyword) {
    flags.push("keyword_empty");
    score -= 25;
  } else {
    if (keywordLength < KEYWORD_TOO_SHORT_LENGTH) {
      flags.push("keyword_too_short");
      score -= 12;
    }

    if (keywordLength > KEYWORD_TOO_LONG_LENGTH) {
      flags.push("keyword_too_long");
      score -= 15;
    }

    if (isKeywordMessy(keyword)) {
      flags.push("keyword_messy");
      score -= 12;
    }
  }

  const keywordCoverage = normalizedKeyword ? computeKeywordCoverage(keyword, chunkText) : 0;
  if (normalizedKeyword && normalizedChunkText && !normalizedChunkText.includes(normalizedKeyword)) {
    flags.push("keyword_not_in_text");
    score -= 18;
  }

  if (normalizedKeyword && keywordCoverage > 0 && keywordCoverage < 0.5) {
    flags.push("keyword_low_coverage");
    score -= 12;
  }

  const matchedTopics = detectTopics(chunkText);
  const distinctTopicCount = uniqueItems(matchedTopics.map((topic) => topic.name)).length;
  const strongMultiTopicSignal =
    distinctTopicCount >= 3 || (distinctTopicCount >= 2 && (chunkLength > 180 || sentenceCount >= 3));
  if (strongMultiTopicSignal) {
    flags.push("multi_topic");
    score -= 18;
  }

  if (
    matchedTopics.some((topic) => topic.name === "committee") &&
    matchedTopics.some((topic) => topic.name === "manager") &&
    matchedTopics.some((topic) => topic.name === "staff")
  ) {
    flags.push("topic_overlap");
    score -= 10;
  }

  const suggestions = buildSuggestions(flags);
  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    score,
    flags: uniqueItems(flags),
    suggestions,
    metrics: {
      keywordLength,
      chunkLength,
      sentenceCount,
      keywordCoverage: Number(keywordCoverage.toFixed(2)),
      matchedTopics: uniqueItems(matchedTopics.map((topic) => topic.name)),
      matchedTopicTerms: uniqueItems(matchedTopics.map((topic) => topic.term)),
    },
  };
}

function inspectChunkQualityRows(rows = [], context = {}) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const inspection = inspectChunkQuality(row, context);
    return {
      ...row,
      inspection,
    };
  });
}

function summarizeChunkQualityInspection(inspections = []) {
  const summary = {
    totalRows: 0,
    averageScore: 0,
    suspiciousRows: 0,
    flaggedRows: 0,
    flagCounts: {},
    worstScore: null,
    bestScore: null,
  };

  const rows = Array.isArray(inspections) ? inspections : [];
  summary.totalRows = rows.length;

  if (rows.length === 0) {
    return summary;
  }

  let scoreSum = 0;

  rows.forEach((row) => {
    const score = Number(row?.inspection?.score);
    if (Number.isFinite(score)) {
      scoreSum += score;
      summary.worstScore = summary.worstScore === null ? score : Math.min(summary.worstScore, score);
      summary.bestScore = summary.bestScore === null ? score : Math.max(summary.bestScore, score);
      if (score < 80) {
        summary.suspiciousRows += 1;
      }
    }

    const flags = Array.isArray(row?.inspection?.flags) ? row.inspection.flags : [];
    if (flags.length > 0) {
      summary.flaggedRows += 1;
    }

    flags.forEach((flag) => {
      summary.flagCounts[flag] = (summary.flagCounts[flag] || 0) + 1;
    });
  });

  summary.averageScore = Number((scoreSum / rows.length).toFixed(2));
  return summary;
}

module.exports = {
  inspectChunkQuality,
  inspectChunkQualityRows,
  summarizeChunkQualityInspection,
};
