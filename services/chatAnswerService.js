const { getOpenAiConfig, generateOpenAiCompletion, getOpenAiClient } = require("./openAiService");
const { isAiEnabled } = require("./runtimeSettingsService");
const {
  hasExclusiveMeaningMismatch,
  normalizeForSearch,
  segmentWords,
  uniqueTokens,
} = require("./thaiTextUtils");

const SOURCE_LABELS = {
  tbl_laws: "พรบ.สหกรณ์ พ.ศ. 2542",
  tbl_glaws: "พรฎ.กลุ่มเกษตรกร พ.ศ. 2547",
  tbl_vinichai: "หนังสือวินิจฉัย/ตีความ",
  pdf_chunks: "เอกสารที่อัปโหลด",
  documents: "ทะเบียนเอกสาร",
  internet_search: "ข้อมูลจากอินเทอร์เน็ต",
  knowledge_base: "ฐานความรู้ภายในระบบ",
  admin_knowledge: "ฐานความรู้ที่ผู้ดูแลระบบเพิ่ม/แก้ไข",
  knowledge_suggestion: "ข้อเสนอจากผู้ใช้งานที่ได้รับอนุมัติ",
};
const STRUCTURED_LAW_SOURCES = new Set(["tbl_laws", "tbl_glaws"]);
const GARBLED_TEXT_PATTERN = /[�\uF700-\uF8FF]|[็์ิีุู่้๊๋]{3,}|~็|็~|◊|Ë|‡|∫|≈|¡|¥|å|ì|î|ï|ñ|ó|ô|ö|ù|û|ü/;
const THAI_DIGIT_MAP = {
  "๐": "0",
  "๑": "1",
  "๒": "2",
  "๓": "3",
  "๔": "4",
  "๕": "5",
  "๖": "6",
  "๗": "7",
  "๘": "8",
  "๙": "9",
};
const GENERIC_QUERY_TOKENS = new Set([
  "การ",
  "ใหม่",
  "ต้อง",
  "ควร",
  "ได้",
  "ไหม",
  "หรือไม่",
  "อย่างไร",
  "ยังไง",
  "คือ",
  "อะไร",
  "กรณี",
  "เรื่อง",
  "ขอ",
  "อธิบาย",
  "รายละเอียด",
  "เพิ่มเติม",
  "มี",
  "อย่าง",
  "ใด",
]);

function normalizePlanCode(planCode) {
  return String(planCode || "").trim().toLowerCase();
}

function isFreePlanDisplay(options = {}) {
  return normalizePlanCode(options.planCode || "free") === "free";
}

function isLawPriorityQuestion(message) {
  return /(มาตรา|ข้อ|วรรค|อนุมาตรา)/.test(normalizeForSearch(message).toLowerCase());
}

function getDatabaseOnlySourceOrder(options = {}) {
  if (isFreePlanDisplay(options) && isLawPriorityQuestion(options.originalMessage || options.message || "")) {
    return [
      "tbl_laws",
      "tbl_glaws",
      "admin_knowledge",
      "knowledge_suggestion",
      "tbl_vinichai",
      "pdf_chunks",
      "documents",
      "knowledge_base",
    ];
  }

  if (isFreePlanDisplay(options)) {
    return [
      "admin_knowledge",
      "knowledge_suggestion",
      "tbl_vinichai",
      "tbl_laws",
      "tbl_glaws",
      "pdf_chunks",
      "documents",
      "knowledge_base",
    ];
  }

  return [
    "admin_knowledge",
    "tbl_laws",
    "tbl_glaws",
    "pdf_chunks",
    "tbl_vinichai",
    "documents",
    "knowledge_base",
  ];
}

function getGeminiClient() {
  return getOpenAiClient();
}

function wantsExplanation(message) {
  const text = String(message || "").trim();
  return /อธิบาย|รายละเอียด|ขยายความ|ยกตัวอย่าง/.test(text);
}

function wantsAmountAnswer(message) {
  const text = String(message || "").trim();
  return /เท่าไร|เท่าไหร่|กี่บาท|กี่เปอร์เซ็นต์|กี่ร้อยละ|อัตรา|จำนวนเงิน|ค่าบำรุง|ชำระ|จ่าย/.test(
    text,
  );
}

function wantsDecisionAnswer(message) {
  const text = String(message || "").trim();
  return /หรือไม่|ได้ไหม|ได้หรือไม่|ควรหรือไม่|ต้อง.*ไหม|ต้อง.*หรือไม่|จำเป็นต้อง.*ไหม|จำเป็นต้อง.*หรือไม่/.test(
    text,
  );
}

function buildSourceContext(sources) {
  return dedupeSources(sources)
    .map((source, index) => {
      return [
        `แหล่งข้อมูลที่ ${index + 1}`,
        `ตาราง: ${SOURCE_LABELS[source.source] || source.source || "เอกสารที่อัปโหลด"}`,
        `หัวข้อ: ${source.title || "-"}`,
        `อ้างอิง: ${source.reference || "-"}`,
        `เลขที่หนังสือ: ${source.documentNumber || "-"}`,
        `วันที่หนังสือ: ${source.documentDateText || "-"}`,
        `หน่วยงาน: ${source.documentSource || "-"}`,
        `เนื้อหา: ${source.content || source.chunk_text || "-"}`,
        `หมายเหตุ: ${source.comment || "-"}`,
      ].join("\n");
    })
    .join("\n\n");
}

function formatReferenceLine(source) {
  const tableName = SOURCE_LABELS[source.source] || source.source || "เอกสารที่อัปโหลด";
  const shouldHideSourceLabel = String(source?.source || "").trim().toLowerCase() === "admin_knowledge";
  const primaryReference = cleanLine(source.reference || source.title || "ไม่ระบุอ้างอิง");
  const parts = [primaryReference];
  const documentNumber = cleanLine(source.documentNumber || "");
  const documentDateText = cleanLine(source.documentDateText || "");

  if (documentNumber && documentNumber !== parts[0]) {
    parts.push(`เลขที่ ${documentNumber}`);
  }
  if (documentDateText) {
    parts.push(`ลงวันที่ ${documentDateText}`);
  }
  if (shouldHideSourceLabel) {
    return `- ${parts.filter(Boolean).join(" | ")}`;
  }
  return `- ${tableName}: ${parts.filter(Boolean).join(" | ")}`;
}

function dedupeSources(sources, limit = sources.length) {
  const seen = new Set();
  const results = [];

  for (const source of sources) {
    if (!source) {
      continue;
    }

    const sourceName = String(source.source || "pdf_chunks").trim().toLowerCase();
    const stableIdentity =
      source.id ||
      source.url ||
      source.document_id ||
      source.documentId ||
      "";
    const reference = cleanLine(source.reference || source.title || source.keyword || "");
    const contentPreview = cleanLine(String(source.content || source.chunk_text || "").slice(0, 120));
    const dedupeKey = stableIdentity
      ? [sourceName, String(stableIdentity)].join("::")
      : [sourceName, reference || contentPreview].join("::");

    if (!reference && !contentPreview) {
      continue;
    }

    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    results.push(source);

    if (results.length >= limit) {
      break;
    }
  }

  return results;
}

function buildReferenceSection(sources, limit = 5) {
  const topSources = dedupeSources(sources, limit);
  return ["แหล่งอ้างอิง:", ...topSources.map(formatReferenceLine)].join("\n");
}

function stripStandaloneDoubleSlash(text) {
  return String(text || "")
    .replace(/(^|\n)\s*\/\/\s*/g, "$1")
    .replace(/(^|[\s(])\/\/(?=[\s)]|$)/g, "$1");
}

function cleanLine(text) {
  return stripStandaloneDoubleSlash(text)
    .replace(/^#{1,6}\s*/, "")
    .replace(/^[*-]\s*/, "")
    .replace(/^สรุป:\s*/i, "")
    .replace(/^สรุปสาระสำคัญ:\s*/i, "")
    .replace(/^อธิบายเพิ่มเติม:\s*/i, "")
    .replace(/^รายละเอียดเพิ่มเติม:\s*/i, "")
    .replace(/^สรุปคำตอบดังนี้:?\s*/i, "")
    .replace(/^คำตอบ(?:สรุป)?ดังนี้:?\s*/i, "")
    .replace(/^ข้อมูลที่พบจากฐานข้อมูลกฎหมาย(?:\s*\([^)]*\))?:?\s*/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isNoisyLine(text) {
  const line = String(text || "").trim();
  if (!line) {
    return true;
  }

  if (GARBLED_TEXT_PATTERN.test(line)) {
    return true;
  }

  // Common OCR/header-footer noise patterns from scanned PDF pages.
  if (
    /^พัก\s*[:|]/.test(line) ||
    /\|\s*ฝ่ายบริหารทั่วไป/.test(line) ||
    /เล่ม\s*\d+.*ราชกิจจานุเบกษา/.test(line) ||
    /ส่วนเกิน\s*แห่งข้อมูล/.test(line)
  ) {
    return true;
  }

  const pipeCount = (line.match(/\|/g) || []).length;
  if (pipeCount >= 2 && !/(มาตรา|ข้อ|วรรค|บาท|ร้อยละ|เปอร์เซ็นต์|%)/.test(line)) {
    return true;
  }

  const disallowed = line.replace(/[\u0E00-\u0E7Fa-zA-Z0-9\s.,:%()\-\/]/g, "");
  const ratio = disallowed.length / Math.max(line.length, 1);
  return ratio > 0.22;
}

function isSectionHeading(line) {
  return /^(สรุปใจความสำคัญ|ประเด็นสำคัญ|คำอธิบายเพิ่มเติม|รายละเอียดเพิ่มเติม|อธิบายเพิ่มเติม|แหล่งอ้างอิง)$/.test(
    cleanLine(line),
  );
}

function uniqueCleanLines(lines, limit) {
  const seen = new Set();
  const results = [];

  for (const line of lines) {
    const cleaned = cleanLine(line);
    if (!cleaned || isSectionHeading(cleaned) || isNoisyLine(cleaned)) {
      continue;
    }

    const key = cleaned.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    results.push(cleaned);

    if (results.length >= limit) {
      break;
    }
  }

  return results;
}

function getQueryTokens(message) {
  return uniqueTokens(segmentWords(message)).filter((token) => String(token || "").trim().length >= 2);
}

function getFocusQueryTokens(message) {
  return getQueryTokens(message).filter((token) => !GENERIC_QUERY_TOKENS.has(String(token || "").trim().toLowerCase()));
}

function normalizeComparisonText(text) {
  return normalizeForSearch(cleanLine(text))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function hasSubstantiveAnswerSignal(line) {
  const text = cleanLine(line);
  return /(ต้อง|ไม่ต้อง|ได้|ไม่ได้|ให้|กำหนด|จัดสรร|ชำระ|จ่าย|อัตรา|กำไรสุทธิ|มีหน้าที่|จำเป็นต้อง|ไม่จำเป็นต้อง|สามารถ|อาจ|ภายใน|เกิน|บาท|ร้อยละ|เปอร์เซ็นต์|%|ตามมาตรา|มาตรา|ข้อ|วรรค)/.test(
    text,
  );
}

function lineRepeatsOriginalQuestion(line, originalMessage = "") {
  const cleanedLine = cleanLine(line);
  const cleanedQuestion = cleanLine(originalMessage);
  if (!cleanedLine || !cleanedQuestion) {
    return false;
  }

  const normalizedLine = normalizeComparisonText(cleanedLine);
  const normalizedQuestion = normalizeComparisonText(cleanedQuestion);
  if (!normalizedLine || !normalizedQuestion) {
    return false;
  }

  if (normalizedLine === normalizedQuestion) {
    return true;
  }

  const questionLikePattern = /เท่าไร|เท่าไหร่|อย่างไร|ยังไง|หรือไม่|ได้ไหม|ได้หรือไม่|คืออะไร|หมายถึง|กี่/;
  if (!questionLikePattern.test(cleanedLine)) {
    return false;
  }

  const lineTokens = new Set(getFocusQueryTokens(cleanedLine));
  const questionTokens = getFocusQueryTokens(cleanedQuestion);
  if (!questionTokens.length) {
    return false;
  }

  const tokenHits = questionTokens.filter((token) => lineTokens.has(token)).length;
  return tokenHits >= Math.max(2, questionTokens.length - 1);
}

function lineLooksLikeSourceMetadata(line, sources = []) {
  const cleanedLine = cleanLine(line);
  if (!cleanedLine) {
    return false;
  }

  if (hasSubstantiveAnswerSignal(cleanedLine)) {
    return false;
  }

  if (/^(เรื่อง|เลขที่|ลงวันที่|ทะเบียนเอกสาร|ข้อมูลจากอินเทอร์เน็ต)\b/i.test(cleanedLine)) {
    return true;
  }

  const normalizedLine = normalizeComparisonText(cleanedLine);
  if (!normalizedLine) {
    return false;
  }

  const candidates = dedupeSources(sources, Math.max(Array.isArray(sources) ? sources.length : 0, 8))
    .flatMap((source) => [
      source?.reference,
      source?.title,
      source?.keyword,
      source?.documentNumber,
      source?.documentDateText,
    ])
    .filter(Boolean);

  return candidates.some((candidate) => {
    const normalizedCandidate = normalizeComparisonText(candidate);
    if (!normalizedCandidate || normalizedCandidate.length < 6) {
      return false;
    }

    if (normalizedLine === normalizedCandidate) {
      return true;
    }

    if (cleanedLine.length <= 120 && normalizedLine.startsWith(normalizedCandidate)) {
      return true;
    }

    if (cleanedLine.length <= 90 && normalizedCandidate.startsWith(normalizedLine)) {
      return true;
    }

    return false;
  });
}

function shouldDropModelOutputLine(line, sources, options = {}) {
  const cleanedLine = cleanLine(line);
  if (!cleanedLine) {
    return true;
  }

  if (isNoisyLine(cleanedLine)) {
    return true;
  }

  if (lineRepeatsOriginalQuestion(cleanedLine, options.originalMessage || "")) {
    return true;
  }

  if (lineLooksLikeSourceMetadata(cleanedLine, sources)) {
    return true;
  }

  return false;
}

function countFocusTokenHits(line, message) {
  const tokens = getFocusQueryTokens(message);
  if (!tokens.length) {
    return 0;
  }

  const normalizedLine = normalizeForSearch(line).toLowerCase();
  const lineTokenSet = new Set(uniqueTokens(segmentWords(line)));
  return tokens.filter((token) => lineTokenSet.has(token) || normalizedLine.includes(token)).length;
}

function hasFocusTokenMatch(line, message) {
  return countFocusTokenHits(line, message) > 0;
}

function buildSourceSearchText(source) {
  return normalizeForSearch(
    [
      source?.reference,
      source?.title,
      source?.keyword,
      source?.content,
      source?.chunk_text,
      source?.comment,
      source?.documentNumber,
      source?.documentDateText,
      source?.documentSource,
    ]
      .filter(Boolean)
      .join(" "),
  ).toLowerCase();
}

function sourceMatchesAmountFocus(source, message) {
  const query = normalizeForSearch(message).toLowerCase();
  const sourceText = buildSourceSearchText(source);
  if (!query || !sourceText) {
    return false;
  }

  const focusHits = countFocusTokenHits(sourceText, message);
  const hasUnionPhrase = /ค่าบำรุง\s*สันนิบาต|บำรุง\s*สันนิบาต/.test(sourceText);
  const asksUnionFee = /ค่าบำรุง|บำรุง/.test(query) && /สันนิบาต/.test(query);
  const queryNeedsUnion = /สันนิบาต/.test(query);
  const queryNeedsFee = /ค่าบำรุง|บำรุง/.test(query);
  const queryNeedsPayment = /ชำระ|จ่าย/.test(query);

  if (asksUnionFee && hasUnionPhrase) {
    return true;
  }

  if (queryNeedsUnion && !/สันนิบาต/.test(sourceText)) {
    return false;
  }

  if (queryNeedsFee && !/ค่าบำรุง|บำรุง/.test(sourceText)) {
    return false;
  }

  if (queryNeedsPayment && !/ชำระ|จ่าย|เรียกเก็บ|อัตรา|ร้อยละ|เปอร์เซ็นต์|บาท/.test(sourceText)) {
    return false;
  }

  if (focusHits >= 2) {
    return true;
  }

  return asksUnionFee && /สันนิบาต/.test(sourceText) && /(อัตรา|ร้อยละ|เปอร์เซ็นต์|บาท|ชำระ|จ่าย)/.test(sourceText);
}

function filterSourcesByAnswerFocus(sources, options = {}) {
  const normalizedSources = Array.isArray(sources) ? sources.filter(Boolean) : [];
  if (!normalizedSources.length) {
    return [];
  }

  const message = String(options.originalMessage || options.message || "").trim();
  if (!message) {
    return normalizedSources;
  }

  if (options.amountMode) {
    const amountFocused = normalizedSources.filter((source) => sourceMatchesAmountFocus(source, message));
    if (amountFocused.length > 0) {
      return amountFocused;
    }
  }

  return normalizedSources;
}

function scoreLineByQuery(line, message) {
  const tokens = getQueryTokens(message);
  if (!tokens.length) {
    return 0;
  }

  if (hasExclusiveMeaningMismatch(message, line)) {
    return -12;
  }

  const normalizedLine = normalizeForSearch(line).toLowerCase();
  const lineTokenSet = new Set(uniqueTokens(segmentWords(line)));
  const tokenHits = tokens.filter((token) => lineTokenSet.has(token) || normalizedLine.includes(token)).length;
  const coverage = tokenHits / tokens.length;
  return tokenHits * 2 + coverage * 6;
}

function hasCoreLegalSignal(line) {
  return /(มาตรา|ข้อ|วรรค|ค่าบำรุง|สันนิบาต|ชำระ|จ่าย|ต้อง|ไม่ต้อง|บาท|ร้อยละ|เปอร์เซ็นต์|%)/.test(
    String(line || ""),
  );
}

function splitExplainSections(lines, options = {}) {
  const summary = [];
  const detail = [];
  let current = "summary";

  for (const rawLine of lines) {
    const line = cleanLine(rawLine);
    if (!line) {
      continue;
    }

    if (/^คำอธิบายเพิ่มเติม|^รายละเอียดเพิ่มเติม|^อธิบายเพิ่มเติม/.test(line)) {
      current = "detail";
      continue;
    }

    if (/^สรุปใจความสำคัญ|^ประเด็นสำคัญ/.test(line)) {
      current = "summary";
      continue;
    }

    if (current === "detail") {
      detail.push(line);
    } else {
      summary.push(line);
    }
  }

  const summaryLimit = Math.max(1, Number(options.summaryLimit || 6));
  const detailLimit = Math.max(1, Number(options.detailLimit || 6));

  return {
    summary: uniqueCleanLines(summary, summaryLimit),
    detail: uniqueCleanLines(detail, detailLimit),
  };
}

function normalizeParagraph(text) {
  return stripStandaloneDoubleSlash(text)
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function joinSentences(lines, limit = 5) {
  return uniqueCleanLines(lines, limit)
    .map((line) => line.replace(/[.;]+$/g, "").trim())
    .filter(Boolean)
    .join(" ");
}

function buildSectionLines(lines, limit = 5) {
  return uniqueCleanLines(lines, limit)
    .map((line) => line.replace(/[.;]+$/g, "").trim())
    .filter(Boolean);
}

function shouldDisplayContentHeading(heading, options = {}) {
  const text = cleanLine(heading);
  if (!text) {
    return false;
  }

  if (options.questionIntent === "law_section") {
    return /^(มาตรา|ข้อ|วรรค|อนุมาตรา)\s*\d+/i.test(text);
  }

  return /^(มาตรา|ข้อ|วรรค|อนุมาตรา)\s*\d+/i.test(text);
}

function buildSourceContentFallbackLines(sources, limit = 5, options = {}) {
  const lines = [];

  for (const source of dedupeSources(sources, Math.max(limit * 2, 8))) {
    const extractedSegments = extractRelevantSegmentsFromSource(
      source,
      options.originalMessage || options.message || "",
      {
        explainMode: options.explainMode,
        questionIntent: options.questionIntent,
        preserveMoreContent: options.preserveMoreContent === true,
      },
    );

    if (extractedSegments.length > 0) {
      lines.push(...extractedSegments);
      continue;
    }

    const fallbackText = cleanLine(String(source.content || source.chunk_text || "").slice(0, options.explainMode ? 320 : 220));
    if (fallbackText && !isNoisyLine(fallbackText)) {
      lines.push(fallbackText);
    }
  }

  return uniqueCleanLines(lines, limit);
}

function buildParagraphSummary(summaryLines, detailLines, explainMode, options = {}) {
  const summaryLimit = Math.max(1, Number(options.summaryLimit || 6));
  const detailLimit = Math.max(1, Number(options.detailLimit || (explainMode ? 6 : 4)));
  const summaryItems = buildSectionLines(summaryLines, summaryLimit);
  const detailItems = buildSectionLines(detailLines, detailLimit);
  const blocks = [];

  if (summaryItems.length) {
    blocks.push(`สรุปสาระสำคัญ:\n${summaryItems.join("\n")}`);
  }

  if (explainMode && detailItems.length) {
    blocks.push(`รายละเอียดเพิ่มเติม:\n${detailItems.join("\n")}`);
  }

  return blocks.join("\n\n").trim();
}

function extractAmountHighlights(sources, limit = 4) {
  const amountPattern =
    /[^\n]{0,80}\d[\d,]*(?:\.\d+)?\s*(?:บาท|ร้อยละ|เปอร์เซ็นต์|%|ต่อปี|ต่อเดือน|ต่อราย|ต่อรายปี)?[^\n]{0,120}/g;
  const scored = [];

  for (const source of dedupeSources(sources, 8)) {
    const rawText = String(
      [source.reference, source.title, source.content, source.chunk_text, source.comment]
        .filter(Boolean)
        .join(" "),
    );
    const matches = rawText.match(amountPattern) || [];

    for (const match of matches) {
      const cleaned = cleanLine(match);
      if (!cleaned) {
        continue;
      }

      let score = 0;
      if (/(ค่าบำรุง|สันนิบาต)/.test(cleaned)) score += 4;
      if (/(บาท|ร้อยละ|เปอร์เซ็นต์|%)/.test(cleaned)) score += 4;
      if (/(อัตรา|จำนวนเงิน|ชำระ|จ่าย)/.test(cleaned)) score += 3;
      if (/\d/.test(cleaned)) score += 2;

      scored.push({
        score,
        text: cleaned,
      });
    }
  }

  return uniqueCleanLines(
    scored.sort((a, b) => b.score - a.score).map((item) => item.text),
    limit,
  );
}

function splitContentSegments(text) {
  return String(text || "")
    .split(/[\n\r]+|(?<=\.)\s+|(?<=;)\s+|(?<=:)\s+/)
    .map((segment) => cleanLine(segment))
    .filter(Boolean);
}

function extractQueryLawNumber(message) {
  const match = String(message || "").match(/(?:มาตรา|ข้อ|วรรค|อนุมาตรา)?\s*(\d{1,4})/);
  return match ? match[1] : "";
}

function normalizeThaiDigits(text) {
  return String(text || "").replace(/[๐-๙]/g, (character) => THAI_DIGIT_MAP[character] || character);
}

function normalizeClauseNumber(value) {
  const digits = normalizeThaiDigits(value).replace(/\D/g, "");
  if (!digits) {
    return "";
  }

  return String(Number(digits));
}

function extractClauseNumberFromLine(line) {
  const cleaned = cleanLine(line);
  const match = cleaned.match(/^(?:ข้อ\s*)?(?:\(?([0-9๐-๙]{1,3})\)|([0-9๐-๙]{1,3})[.)])\s*/);
  return normalizeClauseNumber(match?.[1] || match?.[2] || "");
}

function extractNumberedClauses(text) {
  const normalizedText = String(text || "")
    .replace(/\r/g, "\n")
    .replace(/([^\n])\s+(?=(?:ข้อ\s*)?(?:\(?[1-9๐-๙][0-9๐-๙]{0,2}\)|[1-9๐-๙][0-9๐-๙]{0,2}[.)]))/g, "$1\n");

  if (!normalizedText.trim()) {
    return [];
  }

  const clauses = [];
  const seen = new Set();
  const clausePattern =
    /(?:^|\n)\s*(?:ข้อ\s*)?(?:\(?([0-9๐-๙]{1,3})\)|([0-9๐-๙]{1,3})[.)])\s*([\s\S]*?)(?=(?:\n\s*(?:ข้อ\s*)?(?:\(?[0-9๐-๙]{1,3}\)|[0-9๐-๙]{1,3}[.)])\s*)|$)/g;

  let match = null;
  while ((match = clausePattern.exec(normalizedText))) {
    const number = normalizeClauseNumber(match[1] || match[2] || "");
    const detail = cleanLine(match[3] || "");
    const formattedLine = number && detail ? `${number}. ${detail}` : "";
    const dedupeKey = `${number}::${detail.toLowerCase()}`;

    if (!number || !detail || isNoisyLine(detail) || seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    clauses.push({
      number,
      line: formattedLine,
    });
  }

  return clauses;
}

function getPrimaryStructuredLawClauses(sources, options = {}) {
  if (options.questionIntent !== "law_section") {
    return [];
  }

  const queryLawNumber = extractQueryLawNumber(options.originalMessage || "");
  const candidates = dedupeSources(sources, Array.isArray(sources) ? sources.length : 0)
    .filter((source) => STRUCTURED_LAW_SOURCES.has(String(source?.source || "").trim().toLowerCase()))
    .sort((left, right) => {
      const leftMatchesQuery =
        queryLawNumber &&
        extractQueryLawNumber(`${left.reference || ""} ${left.title || ""}`) === queryLawNumber;
      const rightMatchesQuery =
        queryLawNumber &&
        extractQueryLawNumber(`${right.reference || ""} ${right.title || ""}`) === queryLawNumber;

      if (leftMatchesQuery !== rightMatchesQuery) {
        return rightMatchesQuery ? 1 : -1;
      }

      const scoreDiff = Number(right?.score || 0) - Number(left?.score || 0);
      if (scoreDiff !== 0) {
        return scoreDiff;
      }

      return getSourceStableOrderValue(left) - getSourceStableOrderValue(right);
    });

  for (const source of candidates) {
    const clauses = extractNumberedClauses([source.content, source.comment].filter(Boolean).join("\n"));
    if (clauses.length >= 2) {
      return clauses.map((item) => item.line);
    }
  }

  return [];
}

function ensureStructuredLawSummaryCompleteness(lines, sources, options = {}) {
  const normalizedLines = Array.isArray(lines)
    ? lines.map((line) => cleanLine(line)).filter(Boolean)
    : [];
  const sourceClauseLines = getPrimaryStructuredLawClauses(sources, options);
  const baseSummaryLimit = Math.max(1, Number(options.summaryLimit || normalizedLines.length || 6));

  if (sourceClauseLines.length === 0) {
    return {
      lines: normalizedLines,
      summaryLimit: baseSummaryLimit,
    };
  }

  const existingNumbers = new Set(normalizedLines.map((line) => extractClauseNumberFromLine(line)).filter(Boolean));
  const missingClauses = sourceClauseLines.filter((line) => !existingNumbers.has(extractClauseNumberFromLine(line)));

  if (missingClauses.length === 0) {
    return {
      lines: normalizedLines,
      summaryLimit: Math.max(baseSummaryLimit, normalizedLines.length, sourceClauseLines.length + 1),
    };
  }

  const mergedLines = [...normalizedLines];
  const lastNumberedIndex = mergedLines.reduce((lastIndex, line, index) => {
    return extractClauseNumberFromLine(line) ? index : lastIndex;
  }, -1);
  const insertAt = lastNumberedIndex >= 0 ? lastNumberedIndex + 1 : Math.min(1, mergedLines.length);

  mergedLines.splice(insertAt, 0, ...missingClauses);

  return {
    lines: mergedLines,
    summaryLimit: Math.max(baseSummaryLimit, mergedLines.length, sourceClauseLines.length + 1),
  };
}

function getSourceDisplayPriority(sourceName, questionIntent = "general") {
  const normalized = String(sourceName || "").trim().toLowerCase();

  if (questionIntent === "law_section") {
    if (STRUCTURED_LAW_SOURCES.has(normalized)) return 100;
    if (normalized === "admin_knowledge") return 70;
    if (normalized === "knowledge_suggestion") return 65;
    if (normalized === "tbl_vinichai") return 60;
    if (normalized === "documents") return 40;
    if (normalized === "pdf_chunks") return 30;
    if (normalized === "knowledge_base") return 20;
    return 0;
  }

  if (normalized === "admin_knowledge") return 90;
  if (normalized === "knowledge_suggestion") return 75;
  if (STRUCTURED_LAW_SOURCES.has(normalized)) return 80;
  if (normalized === "tbl_vinichai") return 70;
  if (normalized === "documents") return 60;
  if (normalized === "pdf_chunks") return 50;
  if (normalized === "knowledge_base") return 40;
  if (normalized === "internet_search") return 10;
  return 0;
}

function getDatabaseOnlyDisplayPriority(sourceName, options = {}) {
  const sourceOrder = getDatabaseOnlySourceOrder(options);
  const normalized = String(sourceName || "").trim().toLowerCase();
  const index = sourceOrder.indexOf(normalized);

  if (index >= 0) {
    return sourceOrder.length - index;
  }

  return 0;
}

function extractDisplaySequenceNumber(source = {}) {
  const candidates = [
    source.lawNumber,
    source.reference,
    source.title,
    source.keyword,
  ];

  for (const candidate of candidates) {
    const text = String(candidate || "");
    const lawMatch = text.match(/(?:มาตรา|ข้อ|วรรค|อนุมาตรา)\s*(\d{1,4})/);
    if (lawMatch) {
      return Number(lawMatch[1]);
    }

    const genericMatch = text.match(/\d{1,6}/);
    if (genericMatch) {
      return Number(genericMatch[0]);
    }
  }

  return Number.POSITIVE_INFINITY;
}

function getSourceStableOrderValue(source = {}) {
  const numericId = Number(source.id || source.document_id || source.documentId || 0);
  if (Number.isFinite(numericId) && numericId > 0) {
    return numericId;
  }

  const createdAtValue = Date.parse(source.created_at || source.createdAt || source.updated_at || source.updatedAt || "");
  if (Number.isFinite(createdAtValue)) {
    return createdAtValue;
  }

  return Number.POSITIVE_INFINITY;
}

function compareDatabaseOnlySourceDisplayOrder(left, right) {
  const leftSource = String(left?.source || "").trim().toLowerCase();
  const rightSource = String(right?.source || "").trim().toLowerCase();
  if (leftSource !== rightSource) {
    return 0;
  }

  const leftSequence = extractDisplaySequenceNumber(left);
  const rightSequence = extractDisplaySequenceNumber(right);
  if (Number.isFinite(leftSequence) || Number.isFinite(rightSequence)) {
    if (leftSequence !== rightSequence) {
      return leftSequence - rightSequence;
    }
  }

  const leftDocumentId = Number(left?.document_id || left?.documentId || 0);
  const rightDocumentId = Number(right?.document_id || right?.documentId || 0);
  if (leftDocumentId || rightDocumentId) {
    if (leftDocumentId !== rightDocumentId) {
      return leftDocumentId - rightDocumentId;
    }
  }

  const leftStableOrder = getSourceStableOrderValue(left);
  const rightStableOrder = getSourceStableOrderValue(right);
  if (leftStableOrder !== rightStableOrder) {
    return leftStableOrder - rightStableOrder;
  }

  return 0;
}

function orderSourcesForDatabaseOnly(sources, options = {}) {
  const sourceLimit = Math.max(1, Number(options.sourceLimit || 8));
  const quotaBySource = {
    admin_knowledge: 3,
    knowledge_suggestion: options.questionIntent === "law_section" ? 2 : 1,
    tbl_laws: options.questionIntent === "law_section" ? 4 : 3,
    tbl_glaws: options.questionIntent === "law_section" ? 4 : 3,
    pdf_chunks: options.explainMode ? 4 : 3,
    tbl_vinichai: 2,
    documents: 2,
    knowledge_base: 1,
  };
  const deduped = dedupeSources(sources, sourceLimit * 5);
  const grouped = new Map();

  deduped.forEach((source) => {
    const sourceName = String(source?.source || "").trim().toLowerCase();
    if (!grouped.has(sourceName)) {
      grouped.set(sourceName, []);
    }
    grouped.get(sourceName).push(source);
  });

  grouped.forEach((items, key) => {
    const rankedItems = [...items].sort((left, right) => {
      const scoreDiff = Number(right.score || 0) - Number(left.score || 0);
      if (scoreDiff !== 0) {
        return scoreDiff;
      }

      return scoreLineByQuery(
        String(right.content || right.chunk_text || right.reference || right.title || ""),
        options.originalMessage || "",
      ) - scoreLineByQuery(
        String(left.content || left.chunk_text || left.reference || left.title || ""),
        options.originalMessage || "",
      );
    });
    grouped.set(key, rankedItems);
  });

  const ordered = [];
  const databaseOnlySourceOrder = getDatabaseOnlySourceOrder(options);
  const pushSourceItems = (sourceName, limit) => {
    const items = grouped.get(sourceName) || [];
    const selectedItems = items
      .slice(0, Math.max(0, limit))
      .sort(compareDatabaseOnlySourceDisplayOrder);
    selectedItems.forEach((item) => ordered.push(item));
    grouped.delete(sourceName);
  };

  databaseOnlySourceOrder.forEach((sourceName) => {
    pushSourceItems(sourceName, quotaBySource[sourceName] || 0);
  });

  const remainder = Array.from(grouped.entries())
    .flatMap(([, items]) => items)
    .sort((left, right) => {
      const priorityDiff =
        getDatabaseOnlyDisplayPriority(right.source, options) -
        getDatabaseOnlyDisplayPriority(left.source, options);
      if (priorityDiff !== 0) {
        return priorityDiff;
      }

      const displayPriorityDiff =
        getSourceDisplayPriority(right.source, options.questionIntent) -
        getSourceDisplayPriority(left.source, options.questionIntent);
      if (displayPriorityDiff !== 0) {
        return displayPriorityDiff;
      }

      return Number(right.score || 0) - Number(left.score || 0);
    });

  return [...ordered, ...remainder].slice(0, sourceLimit);
}

function scoreSourceSegment(segment, message, source, options = {}) {
  let score = scoreLineByQuery(segment, message);
  const focusHits = countFocusTokenHits(segment, message);

  if (hasCoreLegalSignal(segment)) score += 6;
  if (/(มาตรา|ข้อ|วรรค|อนุมาตรา)/.test(segment)) score += 5;
  if (STRUCTURED_LAW_SOURCES.has(String(source?.source || "").trim().toLowerCase())) score += 4;
  if (String(source?.source || "").trim().toLowerCase() === "admin_knowledge") score += 3;
  if (focusHits > 0) score += focusHits * 5;

  const queryLawNumber = extractQueryLawNumber(message);
  if (queryLawNumber && segment.includes(queryLawNumber)) {
    score += 8;
  }

  if (options.questionIntent === "law_section") {
    if (STRUCTURED_LAW_SOURCES.has(String(source?.source || "").trim().toLowerCase())) {
      score += 12;
    }
    if (score < 2 && !/(มาตรา|ข้อ|วรรค|อนุมาตรา)/.test(segment)) {
      score -= 12;
    }
  } else if (
    focusHits === 0 &&
    (options.questionIntent === "short_answer" || options.questionIntent === "qa" || options.questionIntent === "general")
  ) {
    score -= 8;
  }

  if (segment.length > 420) {
    score -= 2;
  }

  return score;
}

function extractRelevantSegmentsFromSource(source, message, options = {}) {
  const rawText = [source.content, source.chunk_text, source.comment].filter(Boolean).join("\n");
  const segments = splitContentSegments(rawText);
  const preserveMoreContent = options.preserveMoreContent === true;
  const focusTokens = getFocusQueryTokens(message);
  const scoredSegments = segments
    .map((segment, index) => ({
      index,
      text: segment,
      score: scoreSourceSegment(segment, message, source, options),
    }))
    .filter((item) => !isNoisyLine(item.text))
    .filter((item) => item.text.length >= 12)
    .filter((item) => {
      if (options.questionIntent === "law_section") {
        const minimumScore = preserveMoreContent ? 2 : 4;
        return item.score >= minimumScore || /(มาตรา|ข้อ|วรรค|อนุมาตรา)/.test(item.text);
      }
      if (
        focusTokens.length > 0 &&
        (options.questionIntent === "short_answer" || options.questionIntent === "qa" || options.questionIntent === "general") &&
        !hasFocusTokenMatch(item.text, message) &&
        item.score < 8
      ) {
        return false;
      }
      const minimumScore = preserveMoreContent ? 1 : 2;
      return item.score >= minimumScore || hasCoreLegalSignal(item.text);
    })
    .sort((left, right) => right.score - left.score);

  const segmentLimit =
    preserveMoreContent
      ? options.questionIntent === "law_section"
        ? 12
        : options.explainMode
          ? 10
          : 8
      : options.questionIntent === "law_section"
        ? 6
        : options.explainMode
          ? 5
          : 4;
  const selectedSegments = (preserveMoreContent ? scoredSegments : scoredSegments.slice(0, segmentLimit))
    .sort((left, right) => left.index - right.index)
    .map((item) => item.text)
    .slice(0, segmentLimit);
  const uniqueSegments = uniqueCleanLines(selectedSegments, segmentLimit);

  if (uniqueSegments.length > 0) {
    return uniqueSegments;
  }

  const fallbackText = cleanLine(
    String(rawText || "").slice(0, preserveMoreContent ? 720 : options.explainMode ? 420 : 280),
  );
  if (fallbackText && !isNoisyLine(fallbackText)) {
    return [fallbackText];
  }

  return [];
}

function formatDatabaseOnlySourceBlock(source, message, options = {}) {
  const label = SOURCE_LABELS[source.source] || source.source || "ฐานข้อมูลภายในระบบ";
  const reference = cleanLine(source.reference || source.title || source.keyword || label);
  const title = cleanLine(source.title || "");
  const heading = reference && title && title !== reference ? `${reference} | ${title}` : reference || title || label;

  const segments = extractRelevantSegmentsFromSource(source, message, options);
  if (segments.length === 0) {
    return "";
  }

  const displayLines = [];
  if (shouldDisplayContentHeading(heading, options)) {
    displayLines.push(heading);
  }
  displayLines.push(...segments);

  return displayLines.join("\n");
}

function buildCompactDatabaseOnlyAnswer(sources, options = {}) {
  const explainMode = Boolean(options.explainMode);
  const shortDecisionMode = options.questionIntent === "short_answer" && options.decisionMode;
  const summaryLimit =
    shortDecisionMode
      ? 2
      : options.questionIntent === "short_answer"
        ? 3
      : options.questionIntent === "document"
        ? 5
        : explainMode
          ? 6
          : 5;
  const detailLimit = explainMode ? 5 : 0;
  const substantiveLimit =
    shortDecisionMode
      ? 1
      : options.questionIntent === "short_answer"
        ? 2
        : explainMode
          ? 6
          : 4;
  const fallbackLimit =
    shortDecisionMode
      ? 1
      : options.questionIntent === "short_answer"
        ? 2
        : explainMode
          ? 6
          : 4;
  const visibleSources = dedupeSources(
    orderSourcesForDatabaseOnly(sources, {
      questionIntent: options.questionIntent,
      explainMode,
      originalMessage: options.originalMessage || "",
      planCode: options.planCode,
      sourceLimit: explainMode ? 8 : 6,
    }),
    explainMode ? 8 : 6,
  );

  const decisionLead = options.decisionMode ? inferDecisionLead(options.originalMessage || "", visibleSources) : "";
  const substantiveSegments = extractSubstantiveSegments(visibleSources, substantiveLimit, {
    message: options.originalMessage || "",
    requireFocus: true,
  });
  const numericEvidence = options.amountMode ? extractNumericEvidence(visibleSources, explainMode ? 4 : 2) : [];
  const fallbackLines = buildSourceContentFallbackLines(visibleSources, fallbackLimit, {
    ...options,
    explainMode,
  });
  const summaryLines = uniqueCleanLines(
    [decisionLead, ...substantiveSegments, ...numericEvidence, ...fallbackLines],
    summaryLimit,
  );
  const detailLines = explainMode
    ? buildSourceContentFallbackLines(visibleSources, detailLimit, {
        ...options,
        explainMode: true,
        preserveMoreContent: true,
      })
    : [];

  if (summaryLines.length === 0) {
    return "";
  }

  const referenceLimit =
    shortDecisionMode
      ? 2
      : options.questionIntent === "short_answer"
        ? 3
        : explainMode
          ? 5
          : 4;
  const referenceSources = [...visibleSources].sort((left, right) => {
    const sourcePriorityDiff =
      getDatabaseOnlyDisplayPriority(right?.source, options) -
      getDatabaseOnlyDisplayPriority(left?.source, options);
    if (sourcePriorityDiff !== 0) {
      return sourcePriorityDiff;
    }

    const scoreDiff = Number(right?.score || 0) - Number(left?.score || 0);
    if (scoreDiff !== 0) {
      return scoreDiff;
    }

    return getSourceDisplayPriority(right?.source, options.questionIntent) - getSourceDisplayPriority(left?.source, options.questionIntent);
  });

  return [
    buildParagraphSummary(summaryLines, detailLines, explainMode, {
      summaryLimit,
      detailLimit: Math.max(detailLimit, 1),
    }),
    buildReferenceSection(referenceSources, Math.min(referenceSources.length, referenceLimit)),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildDatabaseOnlyAnswer(sources, options = {}) {
  if (options.questionIntent !== "law_section") {
    const compactAnswer = buildCompactDatabaseOnlyAnswer(sources, options);
    if (compactAnswer) {
      return compactAnswer;
    }
  }

  const orderedSources = orderSourcesForDatabaseOnly(sources, {
    questionIntent: options.questionIntent,
    explainMode: options.explainMode,
    originalMessage: options.originalMessage || "",
    planCode: options.planCode,
    sourceLimit:
      Math.max(
        Number(options.sourceLimit || 0),
        Array.isArray(sources) ? sources.length : 0,
        options.questionIntent === "law_section" ? 12 : options.explainMode ? 14 : 12,
      ),
  });
  const displayedSources = [];
  const sourceBlocks = orderedSources
    .map((source) => {
      const block = formatDatabaseOnlySourceBlock(source, options.originalMessage || "", {
        explainMode: options.explainMode,
        questionIntent: options.questionIntent,
        preserveMoreContent: true,
      });
      if (block) {
        displayedSources.push(source);
      }
      return block;
    })
    .filter(Boolean);

  if (sourceBlocks.length === 0) {
    return "ไม่ปรากฏข้อมูลที่เกี่ยวข้องอย่างชัดเจนในฐานข้อมูล กรุณาระบุคำค้นหรือประเด็นที่ต้องการสอบถามเพิ่มเติม";
  }

  const referenceSources = [...displayedSources].sort((left, right) => {
    const sourcePriorityDiff =
      getDatabaseOnlyDisplayPriority(right?.source, options) -
      getDatabaseOnlyDisplayPriority(left?.source, options);
    if (sourcePriorityDiff !== 0) {
      return sourcePriorityDiff;
    }

    const scoreDiff = Number(right?.score || 0) - Number(left?.score || 0);
    if (scoreDiff !== 0) {
      return scoreDiff;
    }

    return getSourceDisplayPriority(right?.source, options.questionIntent) - getSourceDisplayPriority(left?.source, options.questionIntent);
  });

  return [...sourceBlocks, buildReferenceSection(referenceSources, referenceSources.length)]
    .filter(Boolean)
    .join("\n\n");
}

function extractNumericEvidence(sources, limit = 5) {
  const scored = [];

  for (const source of dedupeSources(sources, 10)) {
    const segments = splitContentSegments(
      [source.content, source.chunk_text, source.comment].filter(Boolean).join("\n"),
    );

    for (const segment of segments) {
      if (!/\d/.test(segment)) {
        continue;
      }

      let score = 0;
      if (/(บาท|ร้อยละ|เปอร์เซ็นต์|%)/.test(segment)) score += 8;
      if (/(อัตรา|จำนวนเงิน|ค่าบำรุง|ชำระ|จ่าย|เรียกเก็บ)/.test(segment)) score += 7;
      if (/\d[\d,]*(?:\.\d+)?\s*(บาท|ร้อยละ|เปอร์เซ็นต์|%)/.test(segment)) score += 12;
      if (source.source === "pdf_chunks") score += 4;
      if ((source.reference || source.title || source.keyword) && segment.length < 240) score += 2;

      scored.push({
        score,
        text: segment,
      });
    }
  }

  return uniqueCleanLines(
    scored.sort((a, b) => b.score - a.score).map((item) => item.text),
    limit,
  );
}

function extractSubstantiveSegments(sources, limit = 5, options = {}) {
  const scored = [];
  const message = String(options.message || "").trim();
  const requireFocus = options.requireFocus === true;
  const focusTokens = getFocusQueryTokens(message);

  for (const source of dedupeSources(sources, 10)) {
    const joined = [source.content, source.chunk_text, source.comment].filter(Boolean).join("\n");
    const segments = splitContentSegments(joined);

    for (const segment of segments) {
      if (segment.length < 18 || isNoisyLine(segment)) {
        continue;
      }

      let score = 0;
      const queryScore = scoreLineByQuery(segment, message);
      const focusHit = focusTokens.length > 0 ? hasFocusTokenMatch(segment, message) : false;
      if (source.source === "admin_knowledge") score += 10;
      if (/ต้อง|ไม่ต้อง|ให้.*ชำระ|ให้.*จ่าย|มีหน้าที่|ต้องชำระ|ต้องจ่าย|จำเป็นต้อง/.test(segment)) score += 8;
      if (/ค่าบำรุง|สันนิบาต/.test(segment)) score += 7;
      if (/บาท|ร้อยละ|เปอร์เซ็นต์|%/.test(segment)) score += 5;
      if (source.reference || source.title || source.keyword) score += 2;
      if (focusHit) score += 8;
      score += queryScore;

      if (focusTokens.length > 0 && !focusHit && queryScore < 4) {
        continue;
      }

      if (requireFocus && source.source !== "admin_knowledge") {
        if (queryScore < 2 && !hasCoreLegalSignal(segment)) {
          continue;
        }
      }

      scored.push({
        score,
        text: segment,
      });
    }
  }

  return uniqueCleanLines(
    scored.sort((a, b) => b.score - a.score).map((item) => item.text),
    limit,
  );
}

function inferDecisionLead(message, sources) {
  if (!wantsDecisionAnswer(message)) {
    return "";
  }

  const segments = extractSubstantiveSegments(sources, 4, { message, requireFocus: true });
  const decisive = segments.find((line) => /ไม่ต้อง|ไม่จำเป็นต้อง|ได้รับยกเว้น/.test(line));
  if (decisive) {
    return decisive;
  }

  const affirmative = segments.find((line) => /ต้อง|ให้.*ชำระ|ให้.*จ่าย|มีหน้าที่.*ชำระ|มีหน้าที่.*จ่าย|ต้องชำระ|ต้องจ่าย/.test(line));
  if (affirmative) {
    return affirmative;
  }

  if (segments[0]) {
    return segments[0];
  }

  return "ยังไม่พบข้อความยืนยันที่ชัดเจนว่า ต้องหรือไม่ต้อง ตามแหล่งข้อมูลที่มีอยู่";
}

function decorateConversationalAnswer(answerText, options = {}) {
  const text = String(answerText || "").trim();
  if (!text) {
    return text;
  }

  if (!options.conversationalFollowUp) {
    return text;
  }

  const topicLabel = cleanLine(options.topicLabel || "");
  const intro = topicLabel ? `ในกรณี${topicLabel} ` : "ในกรณีนี้ ";

  return text
    .replace(/^สรุปสาระสำคัญ:\s*/i, `สรุปสาระสำคัญ:\n${intro}`)
    .replace(/\n\nรายละเอียดเพิ่มเติม:\s*/i, "\n\nรายละเอียดเพิ่มเติม: ")
    .trim();
}

function normalizeModelSummary(text, explainMode, sources, options = {}) {
  const raw = normalizeParagraph(text);

  if (!raw) {
    return "";
  }

  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !shouldDropModelOutputLine(line, sources, options));
  const structuredLawClauseLines = getPrimaryStructuredLawClauses(sources, options);
  const minimumSummaryLimit = Math.max(
    explainMode ? 6 : 7,
    structuredLawClauseLines.length ? structuredLawClauseLines.length + 2 : 0,
  );

  if (explainMode) {
    const { summary, detail } = splitExplainSections(lines, {
      summaryLimit: minimumSummaryLimit,
      detailLimit: Math.max(6, Number(options.detailLimit || 6)),
    });
    const fallbackSummary = summary.length
      ? summary
      : buildSourceContentFallbackLines(sources, Math.max(4, minimumSummaryLimit), {
          ...options,
          explainMode,
        });
    const fallbackDetail = detail.length
      ? detail
      : buildSourceContentFallbackLines(sources, 3, {
          ...options,
          explainMode: true,
          preserveMoreContent: true,
        });
    const completedSummary = ensureStructuredLawSummaryCompleteness(fallbackSummary, sources, {
      ...options,
      summaryLimit: minimumSummaryLimit,
    });

    return decorateConversationalAnswer(
      buildParagraphSummary(completedSummary.lines, fallbackDetail, true, {
        summaryLimit: completedSummary.summaryLimit,
      }),
      options,
    );
  }

  const conciseLines = uniqueCleanLines(lines, minimumSummaryLimit);

  if (conciseLines.length === 0) {
    return "";
  }

  if (options.amountMode) {
    const amountHighlights = extractAmountHighlights(sources, 3);
    const numericEvidence = extractNumericEvidence(sources, 3);
    const hasNumericLine = conciseLines.some((line) =>
      /\d[\d,]*(?:\.\d+)?\s*(?:บาท|ร้อยละ|เปอร์เซ็นต์|%)/.test(line),
    );
    const mergedLines = hasNumericLine
      ? conciseLines
      : uniqueCleanLines([...numericEvidence, ...amountHighlights, ...conciseLines], minimumSummaryLimit);
    const completedLines = ensureStructuredLawSummaryCompleteness(mergedLines, sources, {
      ...options,
      summaryLimit: minimumSummaryLimit,
    });

    return decorateConversationalAnswer(
      buildParagraphSummary(completedLines.lines, [], false, {
        summaryLimit: completedLines.summaryLimit,
      }),
      options,
    );
  }

  if (options.decisionMode) {
    const decisionLead = inferDecisionLead(options.originalMessage || "", sources);
    const decisionSupport = extractSubstantiveSegments(sources, 2, {
      message: options.originalMessage || "",
      requireFocus: true,
    });
    const hasDecisionLine = conciseLines.some((line) =>
      /ไม่ต้อง|ต้อง|ได้|ไม่ได้|ควร|ไม่ควร|จำเป็นต้อง|ไม่จำเป็นต้อง/.test(line),
    );
    const mergedLines = hasDecisionLine
      ? conciseLines
      : uniqueCleanLines([decisionLead, ...decisionSupport, ...conciseLines], minimumSummaryLimit);
    const completedLines = ensureStructuredLawSummaryCompleteness(mergedLines, sources, {
      ...options,
      summaryLimit: minimumSummaryLimit,
    });

    return decorateConversationalAnswer(
      buildParagraphSummary(completedLines.lines, [], false, {
        summaryLimit: completedLines.summaryLimit,
      }),
      options,
    );
  }

  const completedLines = ensureStructuredLawSummaryCompleteness(conciseLines, sources, {
    ...options,
    summaryLimit: minimumSummaryLimit,
  });

  return decorateConversationalAnswer(
    buildParagraphSummary(completedLines.lines, [], false, {
      summaryLimit: completedLines.summaryLimit,
    }),
    options,
  );
}

function buildFallbackSummary(sources, explainMode, options = {}) {
  if (options.databaseOnlyMode) {
    return buildDatabaseOnlyAnswer(sources, {
      ...options,
      explainMode,
    });
  }

  const topSources = dedupeSources(sources, 5);
  const amountHighlights = options.amountMode ? extractAmountHighlights(topSources, explainMode ? 5 : 3) : [];
  const numericEvidence = options.amountMode ? extractNumericEvidence(topSources, explainMode ? 5 : 3) : [];
  const decisionLead = options.decisionMode ? inferDecisionLead(options.originalMessage || "", topSources) : "";
  const substantiveSegments = options.decisionMode
    ? extractSubstantiveSegments(topSources, explainMode ? 5 : 3, {
        message: options.originalMessage || "",
      })
    : [];
  const importantPoints = uniqueCleanLines(
    [
      decisionLead,
      ...substantiveSegments,
      ...numericEvidence,
      ...amountHighlights,
      ...buildSourceContentFallbackLines(topSources, explainMode ? 8 : 5, {
        ...options,
        explainMode,
      }),
    ],
    explainMode ? 8 : 5,
  );
  const detailPoints = uniqueCleanLines(
    [
      ...numericEvidence,
      ...topSources.map((source) =>
        String(source.comment || source.content || source.chunk_text || "").slice(0, explainMode ? 420 : 260),
      ),
    ],
    explainMode ? 6 : 4,
  );

  if (topSources.length === 0) {
    return "ไม่ปรากฏข้อมูลที่เกี่ยวข้องอย่างชัดเจน กรุณาระบุคำค้นหรือประเด็นที่ต้องการสอบถามเพิ่มเติม";
  }

  const answerText = buildParagraphSummary(
    importantPoints,
    detailPoints.length
      ? detailPoints
      : ["หากต้องการรายละเอียดเพิ่ม สามารถพิมพ์คำว่า อธิบาย แล้วตามด้วยประเด็นที่ต้องการได้"],
    explainMode,
  );

  return [decorateConversationalAnswer(answerText, options), buildReferenceSection(topSources)]
    .filter(Boolean)
    .join("\n\n");
}

function filterHighQualitySources(sources, topScore, limit = 4) {
  // Filter out sources with garbled OCR text or very low scores
  // Use stricter threshold: 70% of top score to focus on most relevant sources
  const minScore = Math.max(topScore * 0.7, 80);
  const garbledPattern = /[็์ิีุู่้๊๋]{3,}|~็|็~|◊|Ë|‡|∫|≈|¡|¥|å|ì|î|ï|ñ|ó|ô|ö|ù|û|ü/g;
  
  const filtered = sources.filter((source) => {
    if ((source.score || 0) < minScore) {
      return false;
    }
    
    const content = String(source.content || source.chunk_text || source.preview || "");
    const garbledHits = (content.match(garbledPattern) || []).length;
    if (garbledHits > 2) {
      return false;
    }
    
    return true;
  });
  
  // Limit effective sources by prompt profile to keep AI focused and cost-controlled.
  return filtered.slice(0, Math.max(1, Number(limit || 4)));
}

async function generateChatSummary(message, sources, options = {}) {
  const explainMode = wantsExplanation(message);
  const amountMode = wantsAmountAnswer(message);
  const decisionMode = wantsDecisionAnswer(message);
  const openAiConfig = getOpenAiConfig();
  const aiEnabled = await isAiEnabled();
  const promptProfile = options.promptProfile || {
    code: explainMode ? "detailed" : "brief",
    instructionTone: "",
    summaryRange: explainMode ? "5 ถึง 8 ข้อ" : "4 ถึง 6 ข้อ",
    detailRange: explainMode ? "4 ถึง 8 ข้อ" : "3 ถึง 5 ข้อ",
    aiSourceLimit: explainMode ? 5 : 4,
    compareSources: false,
  };
  const aiSourceLimit = Math.max(1, Number(promptProfile.aiSourceLimit || (explainMode ? 5 : 4)));
  const databaseOnlyMode = Boolean(options.databaseOnlyMode) || !aiEnabled || !openAiConfig;
  const answerInputSources = filterSourcesByAnswerFocus(sources, {
    ...options,
    amountMode,
    decisionMode,
    originalMessage: message,
  });

  // Filter out low-quality sources before sending to Gemini
  const topScore =
    answerInputSources.length > 0 ? Math.max(...answerInputSources.map((s) => s.score || 0)) : 0;
  const filteredSources = filterHighQualitySources(answerInputSources, topScore, aiSourceLimit);
  const effectiveSources =
    filteredSources.length > 0
      ? filteredSources
      : answerInputSources.slice(0, aiSourceLimit);

  if (options.forceFallback || databaseOnlyMode || effectiveSources.length === 0) {
    return buildFallbackSummary(answerInputSources, explainMode, {
      ...options,
      amountMode,
      decisionMode,
      databaseOnlyMode,
      originalMessage: message,
    });
  }

  const amountInstruction = amountMode
    ? "หากข้อมูลอ้างอิงมีจำนวนเงิน อัตรา ร้อยละ เปอร์เซ็นต์ หรือยอดที่ต้องชำระ ให้ระบุค่านั้นอย่างชัดเจนเป็นข้อแรกของ 'สรุปสาระสำคัญ:' พร้อมถ้อยคำที่บอกว่าเป็นจำนวนหรืออัตราเท่าใด และห้ามตอบกว้าง ๆ เฉพาะชื่อแหล่งที่มาโดยไม่บอกตัวเลข"
    : "";
  const continuationInstruction =
    explainMode && options.conversationalFollowUp
      ? "คำถามนี้เป็นการขออธิบายเพิ่มเติมจากเรื่องก่อนหน้า ให้ดึงข้อมูลที่เกี่ยวข้องกับเรื่องเดิมมาอธิบายให้ครบที่สุดก่อน หากข้อมูลมากให้สรุปอย่างกระชับแต่ต้องคงข้อเท็จจริง เงื่อนไข ขั้นตอน ข้อยกเว้น ตัวเลข และข้อความสำคัญที่จำเป็นไว้"
      : "";
  const planToneInstruction = promptProfile.instructionTone
    ? `${promptProfile.instructionTone} `
    : "";
  const compareInstruction = promptProfile.compareSources
    ? "หากมีข้อมูลจากหลายแหล่ง ให้เปรียบเทียบประเด็นที่สอดคล้องหรือแตกต่างกันอย่างกระชับ โดยไม่แต่งข้อมูลนอกแหล่งอ้างอิง "
    : "";
  const depthInstruction =
    promptProfile.code === "brief"
      ? "ให้ตัดรายละเอียดรองที่ไม่จำเป็นออก และเน้นเฉพาะข้อสรุปที่ผู้ใช้ต้องรู้ก่อน "
      : promptProfile.code === "deep"
        ? "ให้คงรายละเอียดสำคัญ เงื่อนไข ข้อยกเว้น และลำดับเหตุผลมากกว่าปกติ "
        : "ให้คงรายละเอียดที่จำเป็นต่อการตัดสินใจหรือความเข้าใจประเด็น ";
  const decisionInstruction = decisionMode
    ? "หากคำถามมีลักษณะถามว่า ต้องหรือไม่ ได้หรือไม่ หรือควรหรือไม่ ให้ตอบข้อแรกอย่างชัดเจนว่า ต้อง ไม่ต้อง ได้ ไม่ได้ ควร หรือไม่ควร ตามข้อมูลที่ปรากฏก่อน แล้วจึงอธิบายเหตุผลหรือเงื่อนไขที่เกี่ยวข้อง ห้ามตอบอ้อมหรือสรุปเฉพาะชื่อมาตราโดยไม่ตอบผลลัพธ์"
    : "";
  const lawSectionInstruction =
    options.questionIntent === "law_section"
      ? "หากแหล่งอ้างอิงมีรายการลำดับข้อ เช่น 1. 2. 3. หรือ (1) (2) ให้ถ่ายทอดให้ครบทุกข้อ คงหมายเลขเดิมตามแหล่งอ้างอิง ห้ามตกหล่น ห้ามรวมหลายข้อเป็นข้อเดียว และห้ามสลับลำดับ "
      : "";
  const metadataExclusionInstruction =
    "ห้ามคัดลอกคำถามของผู้ใช้มาเป็นบรรทัดคำตอบ และห้ามใส่ชื่อเรื่องเอกสาร ชื่อแหล่งข้อมูล เลขที่หนังสือ ลงวันที่ หรือ metadata ของเอกสารเป็นบรรทัดสรุป เว้นแต่ข้อมูลนั้นเป็นสาระคำตอบโดยตรง ";
  const instruction = explainMode
    ? `อ่านและพิจารณาข้อมูลจากทุกแหล่งที่ให้มาครบถ้วน แล้วอธิบายจากข้อมูลที่มีอยู่ให้มากที่สุดก่อน โดยไม่ตัดสาระสำคัญทิ้ง ${planToneInstruction}${depthInstruction}${compareInstruction}${continuationInstruction}ใช้ภาษาไทยสุภาพแบบราชการ ห้ามเดาข้อมูลนอกแหล่งอ้างอิง ${amountInstruction} ${decisionInstruction} ${lawSectionInstruction}${metadataExclusionInstruction}ให้ตอบเป็น plain text เท่านั้น โดยขึ้นต้นด้วย 'สรุปสาระสำคัญ:' แล้วตามด้วยข้อความสั้น ๆ แยกคนละบรรทัดประมาณ ${promptProfile.summaryRange || "5 ถึง 8 ข้อ"} และย่อหน้าถัดไปขึ้นต้นด้วย 'รายละเอียดเพิ่มเติม:' แล้วตามด้วยข้อความสั้น ๆ แยกคนละบรรทัดประมาณ ${promptProfile.detailRange || "4 ถึง 8 ข้อ"} ห้ามใช้ markdown heading หากเป็นคำถามต่อเนื่อง ให้ตอบเสมือนเป็นบทสนทนาในเรื่องเดิมต่อเนื่องกัน โดยยังคงถ้อยคำทางราชการ และหลีกเลี่ยงคำลงท้ายแบบภาษาพูด`
    : `อ่านและพิจารณาข้อมูลจากทุกแหล่งที่ให้มาครบถ้วน แล้วสรุปรวมกันเป็นคำตอบภาษาไทยที่ตรงประเด็น ${planToneInstruction}${depthInstruction}${compareInstruction}พร้อมใช้ภาษาราชการที่สุภาพ ห้ามเดาข้อมูลนอกแหล่งอ้างอิง ${amountInstruction} ${decisionInstruction} ${lawSectionInstruction}${metadataExclusionInstruction}ให้ตอบเป็น plain text เท่านั้น โดยขึ้นต้นด้วย 'สรุปสาระสำคัญ:' แล้วตามด้วยข้อความสั้น ๆ แยกคนละบรรทัดประมาณ ${promptProfile.summaryRange || "4 ถึง 6 ข้อ"} ห้ามใช้ markdown heading หากเป็นคำถามต่อเนื่อง ให้ตอบเสมือนเป็นบทสนทนาในเรื่องเดิมต่อเนื่องกัน โดยยังคงถ้อยคำทางราชการ และหลีกเลี่ยงคำลงท้ายแบบภาษาพูด`;

  try {
    const conversationNote = options.conversationalFollowUp
      ? `\nบริบทก่อนหน้า: คำถามนี้เป็นคำถามต่อเนื่องเกี่ยวกับหัวข้อ "${options.topicLabel || "เรื่องเดิม"}"`
      : "";
    const responseText = await generateOpenAiCompletion({
      systemInstruction: instruction,
      contents: `คำถามผู้ใช้: ${message}${conversationNote}\n\nข้อมูลอ้างอิง:\n${buildSourceContext(effectiveSources)}`,
      timeoutMs: options.aiTimeoutMs,
      config: {
        systemInstruction: instruction,
      },
    });

    const normalized = normalizeModelSummary(
      String(responseText || "").trim(),
      explainMode,
      effectiveSources,
      {
        ...options,
        amountMode,
        decisionMode,
        originalMessage: message,
      },
    );
    if (!normalized) {
      return buildFallbackSummary(answerInputSources, explainMode, {
        ...options,
        amountMode,
        decisionMode,
        originalMessage: message,
      });
    }
    return [normalized, buildReferenceSection(effectiveSources.length > 0 ? effectiveSources : answerInputSources)].join("\n\n");
  } catch (error) {
    return buildFallbackSummary(answerInputSources, explainMode, {
      ...options,
      amountMode,
      decisionMode,
      originalMessage: message,
    });
  }
}

module.exports = {
  generateChatSummary,
  wantsExplanation,
  SOURCE_LABELS,
};
