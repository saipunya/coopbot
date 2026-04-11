const { getOpenAiConfig, generateOpenAiCompletion, getOpenAiClient } = require("./openAiService");
const { isAiEnabled } = require("./runtimeSettingsService");
const {
  getQueryFocusProfile,
  hasExclusiveMeaningMismatch,
  normalizeForSearch,
  isTaxQuestion: isTaxQuestionQuery,
  scoreQueryFocusAlignment,
  segmentWords,
  uniqueTokens,
  detectTopicFamily,
  isTimeFollowUpQuestion,
} = require("./thaiTextUtils");

const SOURCE_LABELS = {
  managed_suggested_question: "Q&A ที่ผู้ดูแลเตรียมไว้ (chatbot_suggested_questions)",
  tbl_laws: "พรบ.สหกรณ์ พ.ศ. 2542",
  tbl_glaws: "พรฎ.กลุ่มเกษตรกร พ.ศ. 2547",
  tbl_vinichai: "หนังสือวินิจฉัย/ตีความ",
  pdf_chunks: "เอกสารที่อัปโหลด",
  documents: "ทะเบียนเอกสาร",
  internet_search: "ข้อมูลจากอินเทอร์เน็ต",
  knowledge_base: "ฐานความรู้ภายในระบบ",
  admin_knowledge: "ฐานความรู้ที่ผู้ดูแลระบบเพิ่ม/แก้ไข (chatbot_knowledge)",
  knowledge_suggestion: "ข้อเสนอจากผู้ใช้งานที่ได้รับอนุมัติ (chatbot_knowledge_suggestions)",
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
const VINICHAI_SUBTOPIC_RULES = [
  {
    key: "annual_150_days",
    label: "150 วัน",
    patterns: ["150 วัน", "วันสิ้นปี", "วันสิ้นปีบัญชี", "เกินกำหนด", "มาตรา 54"],
  },
  {
    key: "quorum",
    label: "องค์ประชุม",
    patterns: ["องค์ประชุม", "ไม่ครบองค์ประชุม", "กึ่งหนึ่ง", "100 คน", "หนึ่งร้อยคน", "มาตรา 57", "มาตรา 58"],
  },
  {
    key: "representative_members",
    label: "ผู้แทนสมาชิก",
    patterns: ["ผู้แทนสมาชิก", "โดยผู้แทน", "ประชุมโดยผู้แทน", "มาตรา 56"],
  },
  {
    key: "agenda",
    label: "วาระประชุม",
    patterns: ["วาระเพิ่มเติม", "วาระอื่นๆ", "เสนอวาระ", "เพิ่มวาระ", "เรื่องพิจารณา"],
  },
  {
    key: "election_units",
    label: "เลือกตั้ง/หน่วยเลือกตั้ง",
    patterns: ["หน่วยเลือกตั้ง", "เลือกตั้ง", "สรรหา", "ลงคะแนน", "เปิดหีบ", "ปิดหีบ", "กรรมการ"],
  },
  {
    key: "meeting_pause",
    label: "พักการประชุม",
    patterns: ["พักการประชุม", "สั่งพักการประชุม", "มติที่ประชุมใหญ่"],
  },
  {
    key: "meeting_compensation",
    label: "ค่าตอบแทน/โบนัส/เบี้ยประชุม",
    patterns: ["เบี้ยประชุม", "ค่าตอบแทน", "โบนัส", "ผู้จัดการ", "เจ้าหน้าที่", "กรรมการ", "ประชุมสัมมนา"],
  },
];

function normalizePlanCode(planCode) {
  return String(planCode || "").trim().toLowerCase();
}

function isFreePlanDisplay(options = {}) {
  return normalizePlanCode(options.planCode || "free") === "free";
}

function isLawPriorityQuestion(message) {
  return /(มาตรา|ข้อ|วรรค|อนุมาตรา)/.test(normalizeForSearch(message).toLowerCase());
}

function isVinichaiPriorityQuestion(message) {
  const normalized = normalizeForSearch(message).toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    /แนววินิจฉัย|วินิจฉัย|ตีความ|ข้อหารือ|ถามตอบ|คำถามคำตอบ/.test(normalized) ||
    (
      /(โบนัส|เงินโบนัส|เบี้ยประชุม|ค่าใช้จ่ายประชุม|ค่าใช้จ่ายในการประชุม|ประชุมสัมมนา|ค่าใช้จ่ายสัมมนา|ค่าตอบแทน)/.test(normalized) &&
      /(ผู้จัดการ|เจ้าหน้าที่|ฝ่ายจัดการ|กรรมการ|ประชุมใหญ่|ประชุมคณะกรรมการ|ประชุมกรรมการ|งบประมาณ|แผนงาน)/.test(normalized)
    )
  );
}

function resolvePreferredStructuredLawSources(options = {}) {
  const normalizedMessage = normalizeForSearch(options.originalMessage || options.message || "").toLowerCase();
  const normalizedTarget = String(options.target || "all").trim().toLowerCase();
  const mentionsGroupLaw = /กลุ่มเกษตรกร|พรบ\.?\s*กลุ่มเกษตรกร|พระราชกฤษฎีกากลุ่มเกษตรกร|กฎหมายกลุ่มเกษตรกร/.test(
    normalizedMessage,
  );
  const mentionsCoopLaw = /สหกรณ์|พรบ\.?\s*สหกรณ์|พระราชบัญญัติสหกรณ์|กฎหมายสหกรณ์/.test(
    normalizedMessage,
  );

  if (normalizedTarget === "group" || (mentionsGroupLaw && !mentionsCoopLaw)) {
    return {
      primaryLawSource: "tbl_glaws",
      secondaryLawSource: "tbl_laws",
    };
  }

  return {
    primaryLawSource: "tbl_laws",
    secondaryLawSource: "tbl_glaws",
  };
}

function getDatabaseOnlySourceOrder(options = {}) {
  const { primaryLawSource, secondaryLawSource } = resolvePreferredStructuredLawSources(options);
  if (options.questionIntent === "qa") {
    return [
      "managed_suggested_question",
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

  if (isVinichaiPriorityQuestion(options.originalMessage || options.message || "")) {
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

  if (isFreePlanDisplay(options) && isLiquidationQuestion(options.originalMessage || options.message || "")) {
    return [
      primaryLawSource,
      "admin_knowledge",
      "tbl_vinichai",
      "knowledge_suggestion",
      "documents",
      secondaryLawSource,
      "pdf_chunks",
      "knowledge_base",
    ];
  }

  if (isFreePlanDisplay(options) && isCoopDissolutionQuestion(options.originalMessage || options.message || "")) {
    return [
      primaryLawSource,
      "admin_knowledge",
      "tbl_vinichai",
      "knowledge_suggestion",
      "documents",
      secondaryLawSource,
      "pdf_chunks",
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
    "knowledge_suggestion",
    "tbl_vinichai",
    "tbl_laws",
    "tbl_glaws",
    "pdf_chunks",
    "documents",
    "knowledge_base",
  ];
}

function getGeminiClient() {
  return getOpenAiClient();
}

function wantsExplanation(message) {
  const text = String(message || "").trim();
  return /อธิบาย|แสดงรายละเอียด|รายละเอียด|ขยายความ|ยกตัวอย่าง|ใจความทั้งหมด|ฉันไม่เข้าใจ|ไม่เข้าใจ|ยังไม่ครบ|แจ้งเพิ่มเติม/.test(text);
}

function wantsStepAnswer(message) {
  const text = normalizeForSearch(String(message || "")).toLowerCase();
  if (!text) {
    return false;
  }

  return /ขั้นตอน|ลำดับขั้น|วิธีการ|ทำอย่างไร/.test(text);
}

function wantsAmountAnswer(message) {
  const text = String(message || "").trim();
  return /เท่าไร|เท่าไหร่|กี่บาท|กี่เปอร์เซ็นต์|กี่ร้อยละ|อัตรา|จำนวนเงิน|ค่าบำรุง|ชำระ|จ่าย/.test(
    text,
  );
}

function isUnionFeeQuestion(message) {
  const text = normalizeForSearch(String(message || "")).toLowerCase();
  if (!text) {
    return false;
  }

  return /(ค่าบำรุง|บำรุง)/.test(text) && /สันนิบาต/.test(text);
}

function isLiquidationQuestion(message) {
  const text = normalizeForSearch(String(message || "")).toLowerCase();
  if (!text) {
    return false;
  }

  return /ชำระบัญชี|ผู้ชำระบัญชี/.test(text);
}

function isCoopDissolutionQuestion(message) {
  const text = normalizeForSearch(String(message || "")).toLowerCase();
  if (!text || /ชำระบัญชี|ผู้ชำระบัญชี/.test(text)) {
    return false;
  }

  return /(?:การเลิกสหกรณ์|เลิกสหกรณ์|สั่งเลิกสหกรณ์|สหกรณ์(?:ย่อม)?(?:ต้อง)?เลิก)/.test(text);
}

function isTaxQuestion(message) {
  return isTaxQuestionQuery(message);
}

function buildTaxCautiousAnswer(sources, options = {}) {
  const message = String(options.originalMessage || options.message || "").trim();
  if (!isTaxQuestion(message)) {
    return "";
  }

  const candidateSources = dedupeSources(sources, 8);
  const taxSignals = /(ภาษี|อากร|ภาษีเงินได้|ภาษีมูลค่าเพิ่ม|ภาษีธุรกิจเฉพาะ|ภาษีหัก ณ ที่จ่าย)/;
  const feeSignals = /(ค่าธรรมเนียม|ค่าจดทะเบียน|ยกเว้นค่าธรรมเนียม|ค่าธรรมเนียมการจดทะเบียน|ค่าธรรมเนียมการโอน|ค่าธรรมเนียมการจดทะเบียนอสังหาริมทรัพย์)/;

  let directTaxEvidence = null;
  let feeOnlyEvidence = null;

  for (const source of candidateSources) {
    const text = normalizeForSearch(buildSourceSearchText(source)).toLowerCase();
    if (!text) {
      continue;
    }

    if (taxSignals.test(text)) {
      directTaxEvidence = source;
      break;
    }

    if (!feeOnlyEvidence && feeSignals.test(text)) {
      feeOnlyEvidence = source;
    }
  }

  if (directTaxEvidence) {
    return "";
  }

  const cautionLines = [
    "จากข้อมูลที่พบ ยังไม่พบข้อความที่ระบุเรื่องภาษีของสหกรณ์โดยตรง",
  ];

  if (feeOnlyEvidence) {
    cautionLines.push("แต่พบข้อความเกี่ยวกับค่าธรรมเนียมหรือการยกเว้นค่าธรรมเนียม ซึ่งไม่ใช่เรื่องภาษีโดยตรง");
  } else {
    cautionLines.push("จึงยังสรุปเรื่องภาษีของสหกรณ์จากหลักฐานชุดนี้ไม่ได้");
  }

  cautionLines.push("หากต้องการ ผมสามารถช่วยค้นบทบัญญัติเรื่องภาษีหรืออากรที่ตรงประเด็นต่อได้");

  const referenceSources = feeOnlyEvidence ? [feeOnlyEvidence] : [];

  return [
    buildParagraphSummary(cautionLines, [], false, { summaryLimit: 3 }),
    buildReferenceSection(referenceSources, 1),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function cleanupAnswerText(answerText, sources = [], options = {}) {
  const raw = normalizeParagraph(answerText);
  if (!raw) {
    return "";
  }

  const bannedBodyLabelPattern =
    /^(?:เอกสารที่อัปโหลด|ฐานความรู้ที่ผู้ดูแลระบบเพิ่ม\/แก้ไข|พรบ\.สหกรณ์ พ\.ศ\. 2542|หนังสือวินิจฉัย\/ตีความ|Q&A ที่ผู้ดูแลเตรียมไว้)(?:\s*\([^)]*\))?\s*:?\s*$/i;
  const bannedBodyLabelPrefixPattern =
    /^(?:เอกสารที่อัปโหลด|ฐานความรู้ที่ผู้ดูแลระบบเพิ่ม\/แก้ไข|พรบ\.สหกรณ์ พ\.ศ\. 2542|หนังสือวินิจฉัย\/ตีความ|Q&A ที่ผู้ดูแลเตรียมไว้)(?:\s*\([^)]*\))?\s*:/i;
  const looksLikeBareSourceLabel =
    (line) =>
      bannedBodyLabelPattern.test(cleanLine(line)) ||
      bannedBodyLabelPattern.test(String(line || "").trim()) ||
      bannedBodyLabelPrefixPattern.test(cleanLine(line)) ||
      bannedBodyLabelPrefixPattern.test(String(line || "").trim());

  const cleanedLines = [];
  const seen = [];

  for (const line of mergeProtectedYearLines(
    raw
      .split("\n")
      .map((item) => cleanLine(item))
      .filter(Boolean),
  )) {
    if (looksLikeBareSourceLabel(line) || isNoisyLine(line)) {
      continue;
    }

    if (isSectionHeading(line)) {
      if (cleanedLines.some((existing) => normalizeComparisonText(existing) === normalizeComparisonText(line))) {
        continue;
      }
      cleanedLines.push(line);
      seen.push(line);
      continue;
    }

    if (seen.some((existing) => linesLookSemanticallyDuplicate(existing, line))) {
      continue;
    }

    cleanedLines.push(line);
    seen.push(line);
  }

  while (cleanedLines.length > 0) {
    const lastLine = cleanedLines[cleanedLines.length - 1];
    const normalizedLast = normalizeComparisonText(lastLine);
    const looksLikeFragment =
      normalizedLast.length > 0 &&
      normalizedLast.length < 14 &&
      !/[.!?。:]$/.test(lastLine) &&
      !/(มาตรา|ข้อ|ภาษี|อากร|ค่าธรรมเนียม|สรุปสาระสำคัญ|รายละเอียดเพิ่มเติม)/.test(lastLine);

    if (!looksLikeFragment) {
      break;
    }

    cleanedLines.pop();
  }

  return cleanedLines.join("\n").trim();
}

function isBroadVinichaiListingQuestion(message) {
  const normalized = normalizeForSearch(String(message || "")).toLowerCase();
  if (!isVinichaiPriorityQuestion(normalized)) {
    return false;
  }

  if (/^แนววินิจฉัย(?:เรื่อง)?\s*/.test(normalized) || /^ข้อหารือ(?:เรื่อง)?\s*/.test(normalized)) {
    return !/(เท่าไร|เท่าไหร่|กี่|อย่างไร|ได้หรือไม่|ต้อง|ควร|มาตรา|ข้อ|วรรค|\d)/.test(normalized);
  }

  return /แนววินิจฉัย|ข้อหารือ|ตีความ/.test(normalized) && !/(มาตรา|ข้อ|วรรค|\d|เท่าไร|เท่าไหร่|กี่|อย่างไร)/.test(normalized);
}

function detectLegalEntityScope(message) {
  const normalized = normalizeForSearch(String(message || "")).toLowerCase();
  const asksCoop = /พรบ|พระราชบัญญัติ|สหกรณ์/.test(normalized);
  const asksGroup = /พรฎ|พระราชกฤษฎีกา|กลุ่มเกษตรกร/.test(normalized);

  if (asksCoop && !asksGroup) {
    return "coop";
  }

  if (asksGroup && !asksCoop) {
    return "group";
  }

  return "all";
}

function detectLiquidationScope(message) {
  const scope = detectLegalEntityScope(message);
  return scope === "all" ? "coop" : scope;
}

function isReserveFundQuestion(message) {
  const text = normalizeForSearch(String(message || "")).toLowerCase();
  return Boolean(text) && /ทุนสำรอง/.test(text);
}

function containsReserveFundPhrase(text) {
  const raw = String(text || "");
  if (!raw) {
    return false;
  }

  if (/ทุนสำรอง/u.test(raw)) {
    return true;
  }

  return /ทุนสำรอง/.test(normalizeForSearch(raw).toLowerCase());
}

function isReserveFundEvidence(text) {
  const raw = String(text || "");
  if (!containsReserveFundPhrase(raw)) {
    return false;
  }

  const normalized = normalizeForSearch(raw).toLowerCase();
  const hasProfit = /(กำไรสุทธิ|กําไรสุทธิ)/u.test(raw) || /กำไรสุทธิ/.test(normalized);
  const hasMinimum = /ไม่น้อยกว่า/u.test(raw) || /ไม่น้อยกว่า/.test(normalized);
  const hasTenPercent =
    /ร้อยละ(?:สิบ| 10)?|(?:^|[^0-9])10(?:[^0-9]|$)|๑๐/u.test(raw) ||
    /ร้อยละสิบ|ร้อยละ10|10ของกำไรสุทธิ|สิบของกำไรสุทธิ/.test(normalized);

  return hasProfit && hasMinimum && hasTenPercent;
}

function scoreReserveFundEvidence(line, source = {}) {
  const raw = String(line || "");
  const normalized = normalizeForSearch(raw).toLowerCase();
  const sourceName = String(source?.source || "").trim().toLowerCase();
  let score = Number(source?.score || 0) * 0.15;

  if (containsReserveFundPhrase(raw)) {
    score += 36;
  }
  if (/(กำไรสุทธิ|กําไรสุทธิ)/u.test(raw) || /กำไรสุทธิ/.test(normalized)) {
    score += 20;
  }
  if (/ไม่น้อยกว่า/u.test(raw) || /ไม่น้อยกว่า/.test(normalized)) {
    score += 18;
  }
  if (/ร้อยละ(?:สิบ| 10)?|10|๑๐/u.test(raw) || /ร้อยละสิบ|ร้อยละ10/.test(normalized)) {
    score += 24;
  }
  if (sourceName === "tbl_laws" || sourceName === "tbl_glaws") {
    score += 20;
  }

  return score;
}

function isDividendQuestion(message) {
  const text = normalizeForSearch(String(message || "")).toLowerCase();
  if (!text) {
    return false;
  }

  if (!/(เงินปันผล|ปันผล)/.test(text)) {
    return false;
  }

  if (/(สมาชิกสมทบ|ผู้รับโอนประโยชน์|ตาย|มรดก|ขาดจากสมาชิกภาพ|ออกจากสหกรณ์|ออกจากสมาชิกภาพ)/.test(text)) {
    return false;
  }

  return true;
}

function containsDividendPhrase(text) {
  const raw = String(text || "");
  if (!raw) {
    return false;
  }

  if (/(เงินปันผล|ปันผล)/u.test(raw)) {
    return true;
  }

  return /(เงินปันผล|ปันผล)/.test(normalizeForSearch(raw).toLowerCase());
}

function isDividendEvidence(text) {
  const raw = String(text || "");
  if (!containsDividendPhrase(raw)) {
    return false;
  }

  const normalized = normalizeForSearch(raw).toLowerCase();
  const hasPaidShares = /(หุ้นที่ชำระแล้ว|หุ้นที่ชําระแล้ว)/u.test(raw) || /หุ้นที่ชำระแล้ว/.test(normalized);
  const hasRateControl =
    /(อัตราที่กำหนดในกฎกระทรวง|อัตราที่นายทะเบียนสหกรณ์กำหนด)/u.test(raw) ||
    /อัตราที่กำหนดในกฎกระทรวง|อัตราที่นายทะเบียนสหกรณ์กำหนด/.test(normalized);

  return hasPaidShares && hasRateControl;
}

function scoreDividendEvidence(line, source = {}, scope = "all") {
  const raw = String(line || "");
  const normalized = normalizeForSearch(raw).toLowerCase();
  const sourceName = String(source?.source || "").trim().toLowerCase();
  let score = Number(source?.score || 0) * 0.15;

  if (containsDividendPhrase(raw)) {
    score += 34;
  }
  if (/(หุ้นที่ชำระแล้ว|หุ้นที่ชําระแล้ว)/u.test(raw) || /หุ้นที่ชำระแล้ว/.test(normalized)) {
    score += 20;
  }
  if (/อัตรา/u.test(raw) || /อัตรา/.test(normalized)) {
    score += 18;
  }
  if (/กฎกระทรวง|นายทะเบียนสหกรณ์กำหนด/u.test(raw) || /กฎกระทรวง|นายทะเบียนสหกรณ์กำหนด/.test(normalized)) {
    score += 18;
  }
  if (sourceName === "tbl_laws" || sourceName === "tbl_glaws") {
    score += 20;
  }
  if (scope === "coop" && sourceName === "tbl_laws") {
    score += 16;
  }
  if (scope === "group" && sourceName === "tbl_glaws") {
    score += 16;
  }
  if (scope === "all" && sourceName === "tbl_laws") {
    score += 8;
  }

  return score;
}

function buildReserveFundFocusedAnswer(sources, options = {}) {
  const message = String(options.originalMessage || options.message || "").trim();
  if (!isReserveFundQuestion(message)) {
    return "";
  }

  const candidateSources = dedupeSources(sources, 10);
  let selectedEvidence = null;

  for (const source of candidateSources) {
    const segments = splitContentSegments(buildSourceRawContentText(source));
    const candidateSegments = [];

    for (let index = 0; index < segments.length; index += 1) {
      const first = cleanLine(segments[index]);
      const second = cleanLine(segments[index + 1] || "");
      if (first) {
        candidateSegments.push(first);
      }
      if (first && second) {
        candidateSegments.push(cleanLine(`${first} ${second}`));
      }
    }

    for (const segment of candidateSegments) {
      const cleaned = cleanLine(segment);
      if (!cleaned || looksLikeAttachmentFilename(cleaned) || lineLooksLikeSourceMetadata(cleaned, [source])) {
        continue;
      }

      if (!isReserveFundEvidence(cleaned)) {
        continue;
      }

      const scoredEvidence = {
        text: cleaned,
        source,
        score: scoreReserveFundEvidence(cleaned, source),
      };
      if (!selectedEvidence || scoredEvidence.score > selectedEvidence.score) {
        selectedEvidence = scoredEvidence;
      }
    }
  }

  if (!selectedEvidence) {
    const fallbackSource = candidateSources
      .map((source) => ({
        source,
        score: scoreReserveFundEvidence(buildSourceSearchText(source), source),
        searchText: buildSourceSearchText(source),
      }))
      .filter((item) => containsReserveFundPhrase(item.searchText))
      .filter((item) => /(กำไรสุทธิ|ไม่น้อยกว่า|ร้อยละสิบ|ร้อยละ10)/.test(item.searchText))
      .sort((left, right) => right.score - left.score)[0];

    if (fallbackSource) {
      selectedEvidence = {
        text: "",
        source: fallbackSource.source,
        score: fallbackSource.score,
      };
    }
  }

  if (!selectedEvidence) {
    return "";
  }

  return [
    buildParagraphSummary(
      ["สหกรณ์ต้องจัดสรรกำไรสุทธิประจำปีเป็นทุนสำรองไม่น้อยกว่าร้อยละสิบของกำไรสุทธิ"],
      [],
      false,
      { summaryLimit: 1 },
    ),
    buildReferenceSection([selectedEvidence.source], 1),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildDividendFocusedAnswer(sources, options = {}) {
  const message = String(options.originalMessage || options.message || "").trim();
  if (!isDividendQuestion(message)) {
    return "";
  }

  const scope = detectLegalEntityScope(message);
  const candidateSources = dedupeSources(sources, 10);
  let selectedEvidence = null;

  for (const source of candidateSources) {
    const sourceName = String(source?.source || "").trim().toLowerCase();
    if (sourceName !== "tbl_laws" && sourceName !== "tbl_glaws") {
      continue;
    }

    const segments = splitContentSegments(buildSourceRawContentText(source));
    const candidateSegments = [];

    for (let index = 0; index < segments.length; index += 1) {
      const first = cleanLine(segments[index]);
      const second = cleanLine(segments[index + 1] || "");
      const third = cleanLine(segments[index + 2] || "");
      if (first) {
        candidateSegments.push(first);
      }
      if (first && second) {
        candidateSegments.push(cleanLine(`${first} ${second}`));
      }
      if (first && second && third) {
        candidateSegments.push(cleanLine(`${first} ${second} ${third}`));
      }
    }

    for (const segment of candidateSegments) {
      const cleaned = cleanLine(segment);
      if (!cleaned || lineLooksLikeSourceMetadata(cleaned, [source])) {
        continue;
      }

      if (!isDividendEvidence(cleaned)) {
        continue;
      }

      const scoredEvidence = {
        text: cleaned,
        source,
        score: scoreDividendEvidence(cleaned, source, scope),
      };
      if (!selectedEvidence || scoredEvidence.score > selectedEvidence.score) {
        selectedEvidence = scoredEvidence;
      }
    }
  }

  if (!selectedEvidence) {
    const fallbackSource = candidateSources
      .filter((source) => {
        const sourceName = String(source?.source || "").trim().toLowerCase();
        return sourceName === "tbl_laws" || sourceName === "tbl_glaws";
      })
      .map((source) => ({
        source,
        score: scoreDividendEvidence(buildSourceSearchText(source), source, scope),
        searchText: buildSourceSearchText(source),
      }))
      .filter((item) => containsDividendPhrase(item.searchText))
      .filter((item) => /(หุ้นที่ชำระแล้ว|อัตราที่กำหนดในกฎกระทรวง|อัตราที่นายทะเบียนสหกรณ์กำหนด)/.test(item.searchText))
      .sort((left, right) => right.score - left.score)[0];

    if (fallbackSource) {
      selectedEvidence = {
        text: "",
        source: fallbackSource.source,
        score: fallbackSource.score,
      };
    }
  }

  if (!selectedEvidence) {
    return "";
  }

  const sourceName = String(selectedEvidence.source?.source || "").trim().toLowerCase();
  const summaryLine =
    sourceName === "tbl_glaws"
      ? "กลุ่มเกษตรกรอาจจ่ายเงินปันผลตามหุ้นที่ชำระแล้ว แต่ต้องไม่เกินอัตราที่นายทะเบียนสหกรณ์กำหนด"
      : "สหกรณ์อาจจ่ายเงินปันผลตามหุ้นที่ชำระแล้ว แต่ต้องไม่เกินอัตราที่กำหนดในกฎกระทรวงสำหรับสหกรณ์แต่ละประเภท";

  return [
    buildParagraphSummary([summaryLine], [], false, { summaryLimit: 1 }),
    buildReferenceSection([selectedEvidence.source], 1),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function selectBestLawSourceByNumbers(sources, numbers = [], allowedSources = []) {
  const targetNumbers = new Set(numbers.map((item) => normalizeClauseNumber(item)).filter(Boolean));
  const allowedSourceNames = new Set(allowedSources.map((item) => String(item || "").trim().toLowerCase()));
  if (targetNumbers.size === 0 || allowedSourceNames.size === 0) {
    return null;
  }

  return dedupeSources(sources, Math.max(Array.isArray(sources) ? sources.length : 0, 12))
    .filter((source) => allowedSourceNames.has(String(source?.source || "").trim().toLowerCase()))
    .filter((source) => targetNumbers.has(getSourcePrimaryLawNumber(source)))
    .sort((left, right) => Number(right?.score || 0) - Number(left?.score || 0))[0] || null;
}

function buildLiquidationFocusedAnswer(sources, options = {}) {
  const message = String(options.originalMessage || options.message || "").trim();
  if (!isLiquidationQuestion(message)) {
    return "";
  }

  const explainMode = options.explainMode === true || wantsExplanation(options.message || "");
  const stepMode = options.stepMode === true || wantsStepAnswer(message);
  const scope = detectLiquidationScope(message);
  const allowedSources = scope === "group" ? ["tbl_glaws"] : ["tbl_laws"];
  const references = [];
  const summaryLines = [];
  const detailLines = [];
  const pushUniqueReference = (source) => {
    if (!source) {
      return;
    }

    if (!references.find((item) => String(item?.source || "") === String(source?.source || "") && String(item?.id || "") === String(source?.id || ""))) {
      references.push(source);
    }
  };

  if (scope === "group") {
    const bankruptcySource = selectBestLawSourceByNumbers(sources, ["34"], allowedSources);
    const remainingAssetSource = selectBestLawSourceByNumbers(sources, ["35"], allowedSources);
    const transitionalSource = selectBestLawSourceByNumbers(sources, ["44"], allowedSources);

    if (bankruptcySource) {
      summaryLines.push("ถ้ากลุ่มเกษตรกรล้มละลาย การชำระบัญชีให้เป็นไปตามกฎหมายว่าด้วยล้มละลาย");
      summaryLines.push("ถ้าเลิกเพราะเหตุอื่น ให้นำบทบัญญัติเกี่ยวกับการชำระบัญชีตามกฎหมายว่าด้วยสหกรณ์มาใช้บังคับโดยอนุโลม");
      summaryLines.push("แม้กลุ่มเกษตรกรจะเลิกแล้ว ก็ยังถือว่าดำรงอยู่เท่าที่จำเป็นเพื่อการชำระบัญชี");
      detailLines.push("หากกลุ่มเกษตรกรล้มละลาย การชำระบัญชีจะดำเนินไปตามกฎหมายล้มละลาย ไม่ใช้ขั้นตอนปกติของการเลือกตั้งผู้ชำระบัญชี");
      pushUniqueReference(bankruptcySource);
    }

    if (remainingAssetSource) {
      summaryLines.push("เมื่อชำระหนี้แล้ว หากยังมีทรัพย์สินเหลืออยู่ ให้ผู้ชำระบัญชีจัดการตามลำดับที่กฎหมายกำหนด");
      detailLines.push("หลังจากชำระหนี้ครบแล้ว ผู้ชำระบัญชีต้องจัดการทรัพย์สินที่เหลือตามลำดับและหลักเกณฑ์ที่กฎหมายกำหนด ไม่สามารถจัดการตามดุลพินิจลอย ๆ ได้");
      pushUniqueReference(remainingAssetSource);
    }

    if (transitionalSource) {
      summaryLines.push("ในบางกรณีที่กฎหมายเฉพาะยังไม่มีระเบียบรอง ให้ใช้บทบัญญัติการชำระบัญชีตามกฎหมายสหกรณ์ไปก่อน");
      detailLines.push("กรณีที่กฎหมายเฉพาะของกลุ่มเกษตรกรยังไม่มีรายละเอียดเพียงพอ ระบบกฎหมายจะให้อาศัยบทบัญญัติการชำระบัญชีตามกฎหมายสหกรณ์โดยอนุโลม");
      pushUniqueReference(transitionalSource);
    }
  } else {
    const openingSource = selectBestLawSourceByNumbers(sources, ["73"], allowedSources);
    const bankruptcySource = selectBestLawSourceByNumbers(sources, ["74"], allowedSources);
    const appointmentSource = selectBestLawSourceByNumbers(sources, ["75"], allowedSources);
    const continuitySource = selectBestLawSourceByNumbers(sources, ["76"], allowedSources);
    const dutySource =
      selectBestLawSourceByNumbers(sources, ["77"], allowedSources) ||
      selectBestLawSourceByNumbers(sources, ["81"], allowedSources);
    const completionSource = selectBestLawSourceByNumbers(sources, ["87"], allowedSources);

    if (openingSource) {
      summaryLines.push("เมื่อสหกรณ์เลิกตามเหตุที่กฎหมายกำหนด ต้องจัดการชำระบัญชีตามหมวด 4 ว่าด้วยการชำระบัญชี");
      detailLines.push("จุดเริ่มต้นของการชำระบัญชีคือการที่สหกรณ์เลิกตามเหตุที่กฎหมายกำหนดไว้ก่อน แล้วจึงเข้าสู่กระบวนการสะสางทรัพย์สินและหนี้สินตามหมวด 4");
      pushUniqueReference(openingSource);
    }

    if (bankruptcySource) {
      summaryLines.push("ถ้าสหกรณ์ล้มละลาย การชำระบัญชีให้เป็นไปตามกฎหมายว่าด้วยล้มละลาย");
      detailLines.push("ถ้าสหกรณ์ล้มละลาย จะไม่ใช้ขั้นตอนปกติของการตั้งผู้ชำระบัญชีตามที่ประชุมใหญ่ แต่ต้องดำเนินการตามกฎหมายล้มละลายโดยตรง");
      pushUniqueReference(bankruptcySource);
    }

    if (appointmentSource) {
      summaryLines.push("ถ้าเลิกด้วยเหตุอื่นนอกจากล้มละลาย ที่ประชุมใหญ่ต้องตั้งผู้ชำระบัญชีโดยได้รับความเห็นชอบจากนายทะเบียนสหกรณ์ภายในกำหนดเวลา และหากไม่ตั้งหรือตั้งแล้วไม่ผ่านความเห็นชอบ นายทะเบียนสหกรณ์มีอำนาจตั้งผู้ชำระบัญชีได้");
      detailLines.push("มาตรา 75 กำหนดให้ที่ประชุมใหญ่เลือกตั้งผู้ชำระบัญชีภายในสามสิบวันนับแต่วันที่เลิก และต้องได้รับความเห็นชอบจากนายทะเบียนสหกรณ์");
      detailLines.push("ถ้าที่ประชุมใหญ่ไม่เลือกตั้งภายในกำหนด หรือเลือกตั้งแล้วไม่ได้รับความเห็นชอบ นายทะเบียนสหกรณ์มีอำนาจตั้งผู้ชำระบัญชีแทนได้");
      pushUniqueReference(appointmentSource);
    }

    if (continuitySource) {
      detailLines.push("แม้สหกรณ์จะเลิกแล้ว มาตรา 76 ยังถือว่าสหกรณ์ดำรงอยู่ต่อไปเท่าที่จำเป็นเพื่อให้การชำระบัญชีดำเนินจนเสร็จ");
      pushUniqueReference(continuitySource);
    }

    if (dutySource) {
      summaryLines.push("ผู้ชำระบัญชีมีหน้าที่ชำระสะสางกิจการ ชำระหนี้ และจัดการทรัพย์สินของสหกรณ์ให้เสร็จตามขั้นตอนของกฎหมาย");
      detailLines.push("ในทางปฏิบัติ ผู้ชำระบัญชีต้องรวบรวมทรัพย์สิน ตรวจสอบเจ้าหนี้และลูกหนี้ ชำระหนี้ตามลำดับ และจัดการทรัพย์สินของสหกรณ์ภายใต้กรอบอำนาจหน้าที่ตามมาตรา 81");
      pushUniqueReference(dutySource);
    }

    if (completionSource) {
      summaryLines.push("เมื่อชำระบัญชีเสร็จ ผู้ชำระบัญชีต้องทำรายงานการชำระบัญชีและเสนอต่อนายทะเบียนสหกรณ์เพื่อให้การชำระบัญชีสิ้นสุดตามกฎหมาย");
      detailLines.push("ขั้นตอนสุดท้ายคือการสรุปรายงานการชำระบัญชีเสนอให้นายทะเบียนสหกรณ์ตรวจรับ เพื่อให้กระบวนการชำระบัญชีสิ้นสุดลงอย่างสมบูรณ์ตามกฎหมาย");
      pushUniqueReference(completionSource);
    }
  }

  const normalizedSummaryLines = uniqueCleanLines(summaryLines, 6);
  if (normalizedSummaryLines.length === 0) {
    return "";
  }

  const normalizedDetailLines = explainMode ? uniqueCleanLines(detailLines, 6) : [];

  const answerBody = buildParagraphSummary(normalizedSummaryLines, normalizedDetailLines, explainMode, {
      summaryLimit: normalizedSummaryLines.length,
      detailLimit: normalizedDetailLines.length || 4,
      orderedSummary: stepMode,
      summaryHeading: stepMode ? "ขั้นตอนสำคัญ:" : "สรุปสาระสำคัญ:",
    });

  return [
    decorateConversationalAnswer(answerBody, options),
    buildReferenceSection(references, Math.min(references.length || 1, 5)),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildCoopDissolutionFocusedAnswer(sources, options = {}) {
  const message = String(options.originalMessage || options.message || "").trim();
  if (!isCoopDissolutionQuestion(message)) {
    return "";
  }

  const allowedSources = ["tbl_laws"];
  const references = [];
  const summaryLines = [];
  const pushUniqueReference = (source) => {
    if (!source) {
      return;
    }

    if (!references.find((item) => String(item?.source || "") === String(source?.source || "") && String(item?.id || "") === String(source?.id || ""))) {
      references.push(source);
    }
  };

  const openingSource = selectBestLawSourceByNumbers(sources, ["70"], allowedSources);
  const registrarSource = selectBestLawSourceByNumbers(sources, ["71"], allowedSources);
  const specialRegistrarSource = selectBestLawSourceByNumbers(sources, ["89/3"], allowedSources);

  if (openingSource || registrarSource) {
    summaryLines.push("สหกรณ์ต้องเลิกได้ 2 ช่องทางหลัก คือ เลิกเพราะเกิดเหตุที่กฎหมายกำหนดในมาตรา 70 หรือถูกนายทะเบียนสหกรณ์สั่งให้เลิกตามมาตรา 71");
  }

  if (openingSource) {
    summaryLines.push("เหตุเลิกตามมาตรา 70 ได้แก่ มีเหตุตามที่กำหนดในข้อบังคับ สมาชิกเหลือน้อยกว่าสิบคน ที่ประชุมใหญ่ลงมติให้เลิก ล้มละลาย หรือถูกนายทะเบียนสหกรณ์สั่งให้เลิกตามมาตรา 71");
    pushUniqueReference(openingSource);
  }

  if (registrarSource) {
    summaryLines.push("นายทะเบียนสหกรณ์สั่งเลิกได้เมื่อสหกรณ์ไม่เริ่มดำเนินกิจการภายในหนึ่งปี หยุดดำเนินกิจการติดต่อกันสองปี ไม่ส่งรายงานประจำปีและงบการเงินเป็นเวลาสามปีติดต่อกัน หรือดำเนินกิจการไม่เป็นผลดีหรือก่อให้เกิดความเสียหายแก่สหกรณ์หรือประโยชน์ส่วนรวม");
    pushUniqueReference(registrarSource);
  }

  if (specialRegistrarSource) {
    summaryLines.push("สำหรับสหกรณ์ออมทรัพย์หรือสหกรณ์เครดิตยูเนี่ยน หากฝ่าฝืนกฎกระทรวงและอาจก่อให้เกิดความเสียหายอย่างร้ายแรง นายทะเบียนสหกรณ์มีอำนาจสั่งให้เลิกได้ตามมาตรา 89/3");
    pushUniqueReference(specialRegistrarSource);
  }

  const normalizedSummaryLines = uniqueCleanLines(summaryLines, 5);
  if (normalizedSummaryLines.length === 0) {
    return "";
  }

  return [
    buildParagraphSummary(normalizedSummaryLines, [], false, {
      summaryLimit: normalizedSummaryLines.length,
    }),
    buildReferenceSection(references, Math.min(references.length || 1, 5)),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildCoopDissolutionDeadlineFocusedAnswer(sources, options = {}) {
  const message = String(options.originalMessage || options.message || "").trim();
  if (!message || !isTimeFollowUpQuestion(message)) {
    return "";
  }

  const family = detectTopicFamily(message);
  if (!family || String(family.id || "").trim().toLowerCase() !== "coop_dissolution") {
    return "";
  }

  const references = [];
  const summaryLines = [];
  const detailLines = [];
  const explainMode = wantsExplanation(String(options.message || "").trim());

  const allowedSourceNames = new Set(["tbl_laws", "tbl_vinichai", "admin_knowledge", "knowledge_suggestion"]);
  const candidateSources = dedupeSources(sources, 12).filter((source) => {
    const sourceName = String(source?.source || "").trim().toLowerCase();
    if (!allowedSourceNames.has(sourceName)) {
      return false;
    }

    const text = normalizeForSearch(buildSourceSearchText(source)).toLowerCase();
    if (!text) {
      return false;
    }

    // Drop meeting-timeline sources hard.
    if (/(150 วัน|วันสิ้นปีทางบัญชี|ประชุมใหญ่|มาตรา 54|มาตรา 56|มาตรา 57|มาตรา 58)/.test(text)) {
      return /(เลิกสหกรณ์|มาตรา 70|มาตรา 71|ชำระบัญชี|ผู้ชำระบัญชี|สั่งเลิกสหกรณ์)/.test(text);
    }

    return /(เลิกสหกรณ์|สหกรณ์(?:ย่อม)?เลิก|เลิก\b|มาตรา 70|มาตรา 71|ชำระบัญชี|ผู้ชำระบัญชี|สั่งเลิกสหกรณ์|แจ้ง)/.test(
      text,
    );
  });

  const notifyEvidence = candidateSources
    .map((source) => ({
      source,
      text: normalizeForSearch(buildSourceSearchText(source)).toLowerCase(),
      score: Number(source?.score || 0),
    }))
    .filter((item) => /แจ้ง/.test(item.text) || /ภายใน/.test(item.text))
    .sort((a, b) => b.score - a.score)[0];

  const fifteenDayEvidence = candidateSources
    .map((source) => ({
      source,
      text: normalizeForSearch(buildSourceSearchText(source)).toLowerCase(),
      score: Number(source?.score || 0),
    }))
    .filter((item) => /(15\s*วัน|สิบห้า\s*วัน)/.test(item.text))
    .sort((a, b) => b.score - a.score)[0];

  const section70 = selectBestLawSourceByNumbers(sources, ["70"], ["tbl_laws"]);
  const section71 = selectBestLawSourceByNumbers(sources, ["71"], ["tbl_laws"]);

  if (fifteenDayEvidence) {
    summaryLines.push("ต้องแจ้งภายใน 15 วัน นับแต่วันที่เลิก");
    references.push(fifteenDayEvidence.source);
  } else if (notifyEvidence) {
    summaryLines.push("ในแหล่งอ้างอิงที่ดึงมา พบว่า “ต้องมีการแจ้งการเลิก/การดำเนินการที่เกี่ยวข้องภายในกำหนดเวลา” แต่ไม่พบตัวเลขจำนวนวันชัดเจน");
    references.push(notifyEvidence.source);
  } else {
    // Safe fallback: avoid drifting to other families.
    summaryLines.push("ในแหล่งอ้างอิงที่ดึงมา ยังไม่พบกำหนด “ภายในกี่วัน/ภายในวันที่เท่าไร” เกี่ยวกับการแจ้งการเลิกอย่างชัดเจน");
  }

  if (section70) {
    detailLines.push("มาตรา 70: ระบุเหตุที่สหกรณ์ย่อมเลิก (ใช้ประกอบการยืนยันจุดเริ่มนับเหตุเลิก)");
    references.push(section70);
  }
  if (section71) {
    detailLines.push("มาตรา 71: ระบุกรณีนายทะเบียนสั่งให้เลิก (ใช้ประกอบการยืนยันเงื่อนไข/คำสั่งที่เกี่ยวข้อง)");
    references.push(section71);
  }

  const normalizedSummary = uniqueCleanLines(summaryLines, 3);
  const normalizedDetail = explainMode ? uniqueCleanLines(detailLines, 2) : [];
  const uniqueRefs = dedupeSources(references, 4);

  return [
    buildParagraphSummary(normalizedSummary, normalizedDetail, explainMode, {
      summaryLimit: normalizedSummary.length,
      detailLimit: normalizedDetail.length || 0,
    }),
    buildReferenceSection(uniqueRefs, Math.min(uniqueRefs.length || 1, 4)),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function isGroupFormationQuestion(message) {
  const family = detectTopicFamily(message);
  if (!family || String(family.id || "").trim().toLowerCase() !== "group_formation") {
    return false;
  }

  const text = normalizeForSearch(String(message || "")).toLowerCase();
  return !/(เลิกกลุ่มเกษตรกร|สั่งเลิกกลุ่มเกษตรกร|ชำระบัญชี|ผู้ชำระบัญชี|ถอนชื่อออกจากทะเบียน)/.test(text);
}

function buildGroupFormationFocusedAnswer(sources, options = {}) {
  const message = String(options.originalMessage || options.message || "").trim();
  if (!isGroupFormationQuestion(message)) {
    return "";
  }

  const allowedSources = ["tbl_glaws"];
  const references = [];
  const summaryLines = [];
  const detailLines = [];
  const explainMode = wantsExplanation(String(options.message || "").trim());

  const section5Source = selectBestLawSourceByNumbers(sources, ["5"], allowedSources);
  if (!section5Source) {
    return "";
  }

  references.push(section5Source);
  const sourceText = normalizeForSearch(buildSourceSearchText(section5Source)).toLowerCase();

  const hasFarmer = /(บุคคลผู้ประกอบอาชีพเกษตรกรรม|ประกอบอาชีพเกษตรกรรม)/.test(sourceText);
  const hasThirty = /(ไม่น้อยกว่าสามสิบคน|สามสิบคน|30\s*คน)/.test(sourceText);
  const hasMutual = /(วัตถุประสงค์เพื่อช่วยเหลือซึ่งกันและกัน|ช่วยเหลือซึ่งกันและกัน)/.test(sourceText);
  const hasAdultLocal = /(บรรลุนิติภาวะ|ภูมิลำเนา|กิจการในท้องที่)/.test(sourceText);

  if (hasFarmer && hasThirty) {
    summaryLines.push("ต้องมีบุคคลผู้ประกอบอาชีพเกษตรกรรมเป็นหลักไม่น้อยกว่า 30 คน จัดตั้งเป็นกลุ่มเกษตรกร");
  } else {
    summaryLines.push("มาตรา 5 กำหนดเงื่อนไขหลักของการจัดตั้งกลุ่มเกษตรกร (จำนวน/คุณสมบัติสมาชิกและวัตถุประสงค์)");
  }

  if (hasMutual) {
    summaryLines.push("ต้องมีวัตถุประสงค์เพื่อช่วยเหลือซึ่งกันและกันในการประกอบอาชีพเกษตรกรรม");
  }

  if (hasAdultLocal) {
    summaryLines.push("สมาชิกต้องบรรลุนิติภาวะ และมีภูมิลำเนาหรือกิจการอยู่ในท้องที่ที่กลุ่มเกษตรกรดำเนินการ");
  }

  if (explainMode) {
    detailLines.push("คำว่า “ตั้งกลุ่มเกษตรกร” ในทางกฎหมายโดยทั่วไปหมายถึง “จัดตั้ง/จดทะเบียนจัดตั้งกลุ่มเกษตรกร” ตามเงื่อนไขในมาตรา 5");
  }

  const normalizedSummaryLines = uniqueCleanLines(summaryLines, 4);
  const normalizedDetailLines = explainMode ? uniqueCleanLines(detailLines, 3) : [];

  if (normalizedSummaryLines.length === 0) {
    return "";
  }

  return [
    buildParagraphSummary(normalizedSummaryLines, normalizedDetailLines, explainMode, {
      summaryLimit: normalizedSummaryLines.length,
      detailLimit: normalizedDetailLines.length || 0,
    }),
    buildReferenceSection(references, 1),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function isCoopFormationQuestion(message) {
  const text = normalizeForSearch(String(message || "")).toLowerCase();
  if (!text) {
    return false;
  }

  return /(?:การ)?จัดตั้ง(?:สหกรณ์)?|จดทะเบียนจัดตั้ง|ผู้เริ่มก่อการ|สมาชิกผู้ก่อการ|ประชุมจัดตั้ง/.test(text);
}

function buildCoopFormationFocusedAnswer(sources, options = {}) {
  const message = String(options.originalMessage || options.message || "").trim();
  if (!isCoopFormationQuestion(message)) {
    return "";
  }

  const explainMode = wantsExplanation(String(options.message || "").trim());

  const candidateSources = dedupeSources(sources, 10).filter((source) => {
    const sourceText = normalizeForSearch(buildSourceSearchText(source)).toLowerCase();
    if (!sourceText) {
      return false;
    }

    const hasStrongFormationSignal =
      /ผู้เริ่มก่อการ|สมาชิกผู้ก่อการ|จดทะเบียนจัดตั้ง|คำขอจดทะเบียน|ประชุมจัดตั้ง/.test(sourceText);
    const hasSupportingFormationSignal =
      /จัดตั้งสหกรณ์|ผู้จัดตั้งสหกรณ์|ข้อบังคับ|ขอจดทะเบียน|ยื่นจดทะเบียน/.test(sourceText);
    const hasFormationSignal = hasStrongFormationSignal || hasSupportingFormationSignal;

    const hasRegistrarPowerSignal =
      /นายทะเบียน(?:สหกรณ์)?มีอำนาจหน้าที่|ตรวจสอบ|ไต่สวน|ระงับการดำเนินงาน|ถอนชื่อออกจากทะเบียน|เลิกสหกรณ์|ชำระบัญชี/.test(
        sourceText,
      );
    // If the source is mainly about registrar powers (e.g. mentions "เกี่ยวกับการจัดตั้ง" in passing),
    // do not let it drive "การจัดตั้งสหกรณ์" answers.
    const mostlyRegistrarPower = hasRegistrarPowerSignal && !hasStrongFormationSignal;

    return hasFormationSignal && !mostlyRegistrarPower;
  });

  if (candidateSources.length === 0) {
    const normalized = normalizeForSearch(message).toLowerCase();
    const hints = /สหกรณ์/.test(normalized)
      ? " เช่น ประเภทสหกรณ์, จำนวนสมาชิกผู้ก่อการ, เอกสารที่ต้องยื่น หรือขั้นตอนจดทะเบียน"
      : " เช่น จัดตั้งสหกรณ์ประเภทใด, ต้องการทราบขั้นตอน, เอกสาร หรือคุณสมบัติของผู้ก่อการ";
    return `เพื่อสรุปขั้นตอนการจัดตั้งให้ตรงขึ้น รบกวนระบุรายละเอียดเพิ่มเติมอีกนิด${hints}`;
  }

  const references = [];
  const summaryLines = [];
  const detailLines = [];
  const pushUniqueReference = (source) => {
    if (!source) {
      return;
    }

    if (!references.find((item) => String(item?.source || "") === String(source?.source || "") && String(item?.reference || item?.title || "") === String(source?.reference || source?.title || ""))) {
      references.push(source);
    }
  };

  let hasFormationLead = false;
  let hasApplicationStep = false;
  let hasMeetingStep = false;
  let hasBylawStep = false;

  for (const source of candidateSources) {
    const sourceText = normalizeForSearch(buildSourceSearchText(source)).toLowerCase();
    if (!sourceText) {
      continue;
    }

    if (!hasFormationLead && /ผู้เริ่มก่อการ|สมาชิกผู้ก่อการ|ผู้จัดตั้งสหกรณ์/.test(sourceText)) {
      summaryLines.push("การจัดตั้งสหกรณ์โดยหลักต้องมีผู้เริ่มก่อการหรือสมาชิกผู้ก่อการตามเกณฑ์ที่กฎหมายกำหนด เพื่อดำเนินการขอจดทะเบียนจัดตั้ง");
      hasFormationLead = true;
      pushUniqueReference(source);
    }

    if (!hasBylawStep && /ข้อบังคับ/.test(sourceText)) {
      summaryLines.push("ก่อนยื่นขอจัดตั้ง ต้องจัดทำข้อบังคับและสาระสำคัญของการดำเนินงานให้ครบถ้วนตามหลักเกณฑ์ของกฎหมาย");
      hasBylawStep = true;
      pushUniqueReference(source);
    }

    if (!hasMeetingStep && /ประชุมจัดตั้ง/.test(sourceText)) {
      summaryLines.push("เมื่อเตรียมการครบแล้ว ต้องมีการประชุมจัดตั้งเพื่อรับรองการจัดตั้งและเอกสารสำคัญที่ใช้ประกอบการจดทะเบียน");
      hasMeetingStep = true;
      pushUniqueReference(source);
    }

    if (!hasApplicationStep && /จดทะเบียนจัดตั้ง|คำขอจดทะเบียน|ขอจดทะเบียน|ยื่นจดทะเบียน/.test(sourceText)) {
      summaryLines.push("ขั้นตอนสำคัญถัดมาคือยื่นคำขอจดทะเบียนจัดตั้งสหกรณ์พร้อมเอกสารประกอบต่อนายทะเบียนสหกรณ์");
      if (explainMode) {
        detailLines.push("ผู้เริ่มก่อการ/สมาชิกผู้ก่อการ: ตรวจคุณสมบัติและจำนวนให้ครบตามเกณฑ์ที่กฎหมายกำหนด");
        detailLines.push("ข้อบังคับ: จัดทำสาระสำคัญและรายการที่กฎหมายกำหนดให้ครบถ้วนก่อนยื่นคำขอ");
        detailLines.push("ประชุมจัดตั้ง: รับรองมติและเอกสารสำคัญที่ใช้ประกอบการจดทะเบียนให้ถูกต้องครบถ้วน");
        detailLines.push("ยื่นคำขอจดทะเบียน: ตรวจรายการเอกสารแนบและความถูกต้องของข้อมูลก่อนยื่นต่อนายทะเบียน");
        detailLines.push("การรับจดทะเบียน: นายทะเบียนพิจารณาตามเงื่อนไขและเอกสารที่ถูกต้องครบถ้วน (ควรยืนยันจากมาตราที่เกี่ยวข้อง)");
      } else {
        detailLines.push("ประเด็นที่ควรตรวจจากแหล่งอ้างอิงคือคุณสมบัติของผู้ก่อการ รายการเอกสาร และเนื้อหาข้อบังคับที่ต้องยื่นพร้อมคำขอจดทะเบียน");
      }
      hasApplicationStep = true;
      pushUniqueReference(source);
    }
  }

  const normalizedSummaryLines = uniqueCleanLines(summaryLines, 5);
  if (normalizedSummaryLines.length === 0) {
    return "เพื่อสรุปขั้นตอนการจัดตั้งสหกรณ์ให้ตรงขึ้น รบกวนระบุว่าต้องการทราบ \"ขั้นตอน\", \"เอกสารที่ต้องยื่น\", หรือ \"คุณสมบัติ/จำนวนผู้ก่อการ\"";
  }

  const normalizedDetailLines = explainMode ? uniqueCleanLines(detailLines, 6) : [];
  const summaryHeading = explainMode ? "สรุปสาระสำคัญ:" : "ขั้นตอนสำคัญ:";
  const answerBody = [
    `${summaryHeading}\n- ${normalizedSummaryLines.join("\n- ")}`,
    explainMode && normalizedDetailLines.length > 0
      ? `รายละเอียดเพิ่มเติม:\n- ${normalizedDetailLines.join("\n- ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return [
    decorateConversationalAnswer(answerBody, options),
    buildReferenceSection(references, Math.min(references.length || 1, 4)),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function containsUnionFeePhrase(text) {
  const raw = String(text || "");
  if (!raw) {
    return false;
  }

  if (/ค่าบ(?:ำ|ํา)รุง[\s\S]{0,40}สันนิบาต|สันนิบาต[\s\S]{0,40}ค่าบ(?:ำ|ํา)รุง/u.test(raw)) {
    return true;
  }

  const normalized = normalizeForSearch(raw).toLowerCase();
  return /(?:ค่าบำรุง|บำรุง).{0,20}สันนิบาต|สันนิบาต.{0,20}(?:ค่าบำรุง|บำรุง)/.test(normalized);
}

function isUnionFeeFormulaEvidence(text) {
  const raw = String(text || "");
  if (!containsUnionFeePhrase(raw)) {
    return false;
  }

  const normalized = normalizeForSearch(raw).toLowerCase();
  const hasProfit = /(กำไรสุทธิ|กําไรสุทธิ)/u.test(raw) || /กำไรสุทธิ/.test(normalized);
  const hasRate =
    /ร้อยละ(?:หนึ่ง| 1)?|(?:^|[^0-9])1(?:[^0-9]|$)|๑/u.test(raw) ||
    /ร้อยละหนึ่ง|ร้อยละ1|อัตรา1|อัตราหนึ่ง|หนึ่งของกำไรสุทธิ/.test(normalized);
  const hasCap =
    /สามหมื่นบาท|30,000|30000/u.test(raw) ||
    /สามหมื่นบาท|30000|30000บาท/.test(normalized);

  return hasProfit && hasRate && hasCap;
}

function isUnionFeeLegalCapEvidence(text) {
  const raw = String(text || "");
  if (!containsUnionFeePhrase(raw)) {
    return false;
  }

  const normalized = normalizeForSearch(raw).toLowerCase();
  const hasProfit = /(กำไรสุทธิ|กําไรสุทธิ)/u.test(raw) || /กำไรสุทธิ/.test(normalized);
  const hasCapVerb = /ไม่เกิน/u.test(raw) || /ไม่เกิน/.test(normalized);
  const hasFivePercent =
    /ร้อยละ(?:ห้า| 5)?|(?:^|[^0-9])5(?:[^0-9]|$)|๕/u.test(raw) ||
    /ร้อยละห้า|ร้อยละ5|ห้าของกำไรสุทธิ|5ของกำไรสุทธิ/.test(normalized);

  return hasProfit && hasCapVerb && hasFivePercent;
}

function scoreUnionFeeEvidence(line, source = {}, kind = "formula") {
  const raw = String(line || "");
  const normalized = normalizeForSearch(raw).toLowerCase();
  const sourceName = String(source?.source || "").trim().toLowerCase();
  let score = Number(source?.score || 0) * 0.15;

  if (containsUnionFeePhrase(raw)) {
    score += 40;
  }

  if (/(กำไรสุทธิ|กําไรสุทธิ)/u.test(raw) || /กำไรสุทธิ/.test(normalized)) {
    score += 18;
  }

  if (/อัตรา|จัดสรร|กฎกระทรวง/u.test(raw) || /อัตรา|จัดสรร|กฎกระทรวง/.test(normalized)) {
    score += 14;
  }

  if (kind === "formula") {
    if (isUnionFeeFormulaEvidence(raw)) {
      score += 45;
    }
    if (/สามหมื่นบาท|30,000|30000/u.test(raw) || /สามหมื่นบาท|30000/.test(normalized)) {
      score += 24;
    }
    if (sourceName === "pdf_chunks" || sourceName === "documents") {
      score += 16;
    }
  } else {
    if (isUnionFeeLegalCapEvidence(raw)) {
      score += 40;
    }
    if (/ไม่เกิน/u.test(raw) || /ไม่เกิน/.test(normalized)) {
      score += 18;
    }
    if (sourceName === "tbl_laws" || sourceName === "tbl_glaws") {
      score += 16;
    }
  }

  return score;
}

function lineMatchesUnionFeeFocus(line) {
  const text = normalizeForSearch(String(line || "")).toLowerCase();
  if (!text || !/สันนิบาต/.test(text)) {
    return false;
  }

  return /(อัตรา|ร้อยละ|เปอร์เซ็นต์|กำไรสุทธิ|กฎกระทรวง|จัดสรร|ชำระ|จ่าย|คำนวณ|ไม่เกิน)/.test(
    text,
  );
}

function filterUnionFeeFocusedLines(lines, message, limit = 8) {
  const cleaned = uniqueCleanLines(lines, Math.max(limit * 2, limit));
  if (!isUnionFeeQuestion(message)) {
    return cleaned.slice(0, limit);
  }

  const focused = cleaned.filter((line) => lineMatchesUnionFeeFocus(line) && !looksLikeAttachmentFilename(line));
  if (focused.length > 0) {
    return uniqueCleanLines(focused, limit);
  }

  return cleaned.slice(0, limit);
}

function buildUnionFeeFocusedAnswer(sources, options = {}) {
  const message = String(options.originalMessage || options.message || "").trim();
  if (!isUnionFeeQuestion(message)) {
    return "";
  }

  const asksAmount = wantsAmountAnswer(message);

  let ministerialRuleEvidence = null;
  let legalCapEvidence = null;
  const candidateSources = dedupeSources(sources, 10);

  for (const source of candidateSources) {
    const segments = splitContentSegments(buildSourceRawContentText(source));
    const candidateSegments = [];

    for (let index = 0; index < segments.length; index += 1) {
      const first = cleanLine(segments[index]);
      const second = cleanLine(segments[index + 1] || "");
      const third = cleanLine(segments[index + 2] || "");

      if (first) {
        candidateSegments.push(first);
      }
      if (first && second) {
        candidateSegments.push(cleanLine(`${first} ${second}`));
      }
      if (first && second && third) {
        candidateSegments.push(cleanLine(`${first} ${second} ${third}`));
      }
    }

    for (const segment of candidateSegments) {
      const cleaned = cleanLine(segment);
      if (!cleaned || looksLikeAttachmentFilename(cleaned) || lineLooksLikeSourceMetadata(cleaned, [source])) {
        continue;
      }

      if (isUnionFeeFormulaEvidence(cleaned)) {
        const scoredEvidence = {
          text: cleaned,
          source,
          score: scoreUnionFeeEvidence(cleaned, source, "formula"),
        };
        if (!ministerialRuleEvidence || scoredEvidence.score > ministerialRuleEvidence.score) {
          ministerialRuleEvidence = scoredEvidence;
        }
      }

      if (isUnionFeeLegalCapEvidence(cleaned)) {
        const scoredEvidence = {
          text: cleaned,
          source,
          score: scoreUnionFeeEvidence(cleaned, source, "cap"),
        };
        if (!legalCapEvidence || scoredEvidence.score > legalCapEvidence.score) {
          legalCapEvidence = scoredEvidence;
        }
      }
    }
  }

  if (!ministerialRuleEvidence && asksAmount) {
    const fallbackMinisterialSource = candidateSources
      .map((source) => ({
        source,
        score: scoreUnionFeeEvidence(buildSourceSearchText(source), source, "formula"),
        searchText: buildSourceSearchText(source),
      }))
      .filter((item) => containsUnionFeePhrase(item.searchText))
      .filter((item) => /(กฎกระทรวง|กำหนดอัตรา|ร้อยละหนึ่ง|สามหมื่นบาท|ค่าบำรุงสันนิบาต)/.test(item.searchText))
      .sort((left, right) => right.score - left.score)[0];

    if (fallbackMinisterialSource) {
      ministerialRuleEvidence = {
        text: "",
        source: fallbackMinisterialSource.source,
        score: fallbackMinisterialSource.score,
      };
    }
  }

  if (!legalCapEvidence) {
    const fallbackLegalCapSource = candidateSources
      .map((source) => ({
        source,
        score: scoreUnionFeeEvidence(buildSourceSearchText(source), source, "cap"),
        searchText: buildSourceSearchText(source),
      }))
      .filter((item) => containsUnionFeePhrase(item.searchText))
      .filter((item) => /(มาตรา60|กฎกระทรวง|ไม่เกิน|ร้อยละห้า|ร้อยละ5)/.test(item.searchText))
      .sort((left, right) => right.score - left.score)[0];

    if (fallbackLegalCapSource) {
      legalCapEvidence = {
        text: "",
        source: fallbackLegalCapSource.source,
        score: fallbackLegalCapSource.score,
      };
    }
  }

  if (!ministerialRuleEvidence && !legalCapEvidence) {
    return "";
  }

  const summaryLines = [];
  if (ministerialRuleEvidence) {
    summaryLines.push(
      "ค่าบำรุงสันนิบาตสหกรณ์แห่งประเทศไทย ให้จัดสรรจากกำไรสุทธิประจำปีของสหกรณ์ ในอัตราร้อยละหนึ่งของกำไรสุทธิ แต่ไม่เกินสามหมื่นบาท",
    );
  }

  if (legalCapEvidence) {
    summaryLines.push(
      "ตามมาตรา 60 กฎหมายกำหนดกรอบว่า อัตราที่กำหนดในกฎกระทรวงต้องไม่เกินร้อยละห้าของกำไรสุทธิ",
    );
  }

  const normalizedLines = uniqueCleanLines(summaryLines, 3);
  if (normalizedLines.length === 0) {
    return "";
  }

  const supportingMinisterialSource = candidateSources
    .map((source) => ({
      source,
      sourceName: String(source?.source || "").trim().toLowerCase(),
      searchText: buildSourceSearchText(source),
      score: scoreUnionFeeEvidence(buildSourceSearchText(source), source, "formula"),
    }))
    .filter((item) => item.sourceName === "pdf_chunks" || item.sourceName === "documents")
    .filter((item) => containsUnionFeePhrase(item.searchText))
    .filter((item) => /(กฎกระทรวง|กำหนดอัตรา|ร้อยละหนึ่ง|สามหมื่นบาท|ค่าบำรุงสันนิบาต)/.test(item.searchText))
    .sort((left, right) => right.score - left.score)[0]?.source;

  const referenceSources = dedupeSources(
    [supportingMinisterialSource, ministerialRuleEvidence?.source, legalCapEvidence?.source].filter(Boolean),
    3,
  );
  return [
    buildParagraphSummary(normalizedLines, [], false, {
      summaryLimit: normalizedLines.length,
    }),
    buildReferenceSection(
      referenceSources.length > 0 ? referenceSources : dedupeSources(sources, 2),
      Math.min(referenceSources.length || 1, 3),
    ),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function wantsDecisionAnswer(message) {
  const text = String(message || "").trim();
  return /หรือไม่|ได้ไหม|ได้หรือไม่|ควรหรือไม่|ต้อง.*ไหม|ต้อง.*หรือไม่|จำเป็นต้อง.*ไหม|จำเป็นต้อง.*หรือไม่/.test(
    text,
  );
}

function truncateContextText(text, limit = 0) {
  const normalized = cleanLine(text);
  const safeLimit = Math.max(0, Number(limit || 0));
  if (!normalized || safeLimit <= 0 || normalized.length <= safeLimit) {
    return normalized;
  }

  return `${normalized.slice(0, safeLimit).trim()}...`;
}

function buildSourceBodyText(source = {}) {
  return cleanLine(
    [source.content, source.chunk_text, source.comment]
      .filter(Boolean)
      .join(" "),
  );
}

function captureContinuationDiagnostics(answerDiagnostics, sources, promptProfile = {}) {
  if (!answerDiagnostics || typeof answerDiagnostics !== "object") {
    return;
  }

  const perSourceCharLimit = Math.max(280, Number(promptProfile.aiSourceContextCharLimit || 700));
  answerDiagnostics.usedSources = dedupeSources(Array.isArray(sources) ? sources : [])
    .map((source) => {
      const sourceName = String(source?.source || "").trim().toLowerCase();
      const bodyText = buildSourceBodyText(source);
      const documentId = Number(
        source?.documentId || source?.document_id || (sourceName === "documents" ? source?.id || 0 : 0),
      );

      if (sourceName === "documents" || sourceName === "pdf_chunks") {
        const chunkId = Number(source?.continuationChunkId || (sourceName === "pdf_chunks" ? source?.id || 0 : 0));
        const chunkOffset = Math.max(0, Number(source?.continuationChunkOffset || 0));
        const totalLength = Math.max(0, Number(source?.continuationTotalLength || bodyText.length));
        const consumedChars = Math.max(0, Math.min(perSourceCharLimit, Math.max(0, totalLength - chunkOffset)));
        const nextChunkOffset = Math.min(totalLength, chunkOffset + consumedChars);

        return {
          id: source?.id || null,
          source: source?.source || "",
          title: source?.title || "",
          reference: source?.reference || source?.title || "",
          lawNumber: source?.lawNumber || "",
          url: source?.url || "",
          score: Number(source?.score || 0),
          keyword: source?.keyword || "",
          documentId: documentId || null,
          content: bodyText,
          continuationMode: "document_chunks",
          continuationChunkId: chunkId || null,
          continuationChunkOffset: nextChunkOffset,
          continuationTotalLength: totalLength,
          continuationHasMore:
            source?.continuationHasMore === true ||
            nextChunkOffset < totalLength ||
            documentId > 0,
        };
      }

      const currentOffset = Math.max(0, Number(source?.continuationNextOffset || source?.continuationCursor || 0));
      const totalLength = Math.max(0, Number(source?.continuationTotalLength || bodyText.length));
      const consumedChars = Math.max(0, Math.min(perSourceCharLimit, Math.max(0, totalLength - currentOffset)));
      const nextOffset = Math.min(totalLength, currentOffset + consumedChars);

      return {
        id: source?.id || null,
        source: source?.source || "",
        title: source?.title || "",
        reference: source?.reference || source?.title || "",
        lawNumber: source?.lawNumber || "",
        url: source?.url || "",
        score: Number(source?.score || 0),
        keyword: source?.keyword || "",
        documentId: documentId || null,
        content: bodyText,
        continuationMode: source?.continuationMode || "text",
        continuationCursor: currentOffset,
        continuationNextOffset: nextOffset,
        continuationTotalLength: totalLength,
        continuationHasMore: source?.continuationHasMore === true || nextOffset < totalLength,
      };
    })
    .slice(0, 6);
}

function buildSourceContext(sources, options = {}) {
  const promptProfile = options.promptProfile || {};
  const perSourceCharLimit = Math.max(280, Number(promptProfile.aiSourceContextCharLimit || 700));
  return dedupeSources(sources)
    .map((source, index) => {
      const bodyText = sourceHasSubstantiveContent(source)
        ? truncateContextText(
            buildSourceBodyText(source),
            perSourceCharLimit,
          )
        : "";
      const title = cleanLine(source.title || "");
      const reference = cleanLine(source.reference || "");
      return [
        `แหล่งข้อมูลที่ ${index + 1}`,
        `ประเภท: ${SOURCE_LABELS[source.source] || source.source || "เอกสารที่อัปโหลด"}`,
        `หัวข้อ: ${title || "-"}`,
        `อ้างอิง: ${reference || "-"}`,
        `เนื้อหาที่เกี่ยวข้อง: ${bodyText || "-"}`,
      ].join("\n");
    })
    .join("\n\n");
}

function cleanReferencePrimaryText(text, source = {}) {
  const cleaned = cleanLine(text);
  if (!cleaned) {
    return "";
  }

  const normalizedSource = String(source?.source || "").trim().toLowerCase();
  let result = cleaned;

  if (normalizedSource === "documents" || normalizedSource === "pdf_chunks") {
    result = result
      .replace(/\s*\|\s*ลงวันที่[\s\S]*$/u, "")
      .replace(/\s*\|\s*เลขที่[\s\S]*$/u, "")
      .replace(/\s*\|\s*(?:พ\.ศ\.|ค\.ศ\.)[\s\S]*$/u, "")
      .trim();
  }

  return cleanLine(result);
}

function formatReferenceLine(source) {
  const tableName = SOURCE_LABELS[source.source] || source.source || "เอกสารที่อัปโหลด";
  const fallbackPrimaryReference = cleanReferencePrimaryText(source.title || source.keyword || "", source);
  const primaryReference =
    cleanReferencePrimaryText(source.reference || "", source) ||
    fallbackPrimaryReference ||
    "ไม่ระบุอ้างอิง";
  const parts = [primaryReference];
  const documentNumber = cleanLine(source.documentNumber || "");
  const documentDateText = cleanLine(source.documentDateText || "");

  if (documentNumber && documentNumber !== parts[0]) {
    parts.push(`เลขที่ ${documentNumber}`);
  }
  if (documentDateText) {
    parts.push(`ลงวันที่ ${documentDateText}`);
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
  const topSources = dedupeSources(sources, Math.max(limit * 2, limit));
  const lines = [];
  const seen = new Set();

  for (const source of topSources) {
    const line = formatReferenceLine(source);
    if (!line || seen.has(line)) {
      continue;
    }

    seen.add(line);
    lines.push(line);

    if (lines.length >= limit) {
      break;
    }
  }

  return ["แหล่งอ้างอิง:", ...lines].join("\n");
}

function normalizeVinichaiTopicText(text) {
  return normalizeForSearch(String(text || "")).toLowerCase();
}

function buildVinichaiTopicSearchText(source = {}) {
  return normalizeVinichaiTopicText([
    source?.reference,
    source?.title,
  ].filter(Boolean).join(" "));
}

function getVinichaiSubtopicMatches(source = {}) {
  const text = buildVinichaiTopicSearchText(source);
  if (!text) {
    return [];
  }

  return VINICHAI_SUBTOPIC_RULES.filter((rule) =>
    (rule.patterns || []).some((pattern) => text.includes(normalizeVinichaiTopicText(pattern))),
  );
}

function getPriorityVinichaiSubtopics(message) {
  const normalizedMessage = normalizeVinichaiTopicText(message);
  if (!normalizedMessage) {
    return [];
  }

  return VINICHAI_SUBTOPIC_RULES.filter((rule) =>
    (rule.patterns || []).some((pattern) => normalizedMessage.includes(normalizeVinichaiTopicText(pattern))),
  );
}

function selectVinichaiOverviewSources(vinichaiSources, focusMessage, limit = 4) {
  const dedupedSources = dedupeSources(vinichaiSources, Math.max(limit * 2, limit + 2));
  const prioritySubtopics = getPriorityVinichaiSubtopics(focusMessage);
  const selected = [];
  const usedIdentity = new Set();
  const usedSubtopics = new Set();

  const pushSource = (source, preferredSubtopic = null) => {
    if (!source) {
      return;
    }

    const identity = `${String(source?.source || "").trim().toLowerCase()}::${String(source?.id || source?.reference || source?.title || "")}`;
    if (usedIdentity.has(identity)) {
      return;
    }

    usedIdentity.add(identity);
    selected.push({
      ...source,
      __vinichaiSubtopics: getVinichaiSubtopicMatches(source),
      __vinichaiPreferredSubtopic: preferredSubtopic,
    });

    if (preferredSubtopic?.key) {
      usedSubtopics.add(preferredSubtopic.key);
      return;
    }

    const primaryMatch = getVinichaiSubtopicMatches(source)[0];
    if (primaryMatch?.key) {
      usedSubtopics.add(primaryMatch.key);
    }
  };

  prioritySubtopics.forEach((subtopic) => {
    if (selected.length >= limit) {
      return;
    }

    const match = dedupedSources.find((source) =>
      getVinichaiSubtopicMatches(source).some((item) => item.key === subtopic.key),
    );
    pushSource(match, subtopic);
  });

  dedupedSources.forEach((source) => {
    if (selected.length >= limit) {
      return;
    }

    const matches = getVinichaiSubtopicMatches(source);
    const unusedMatch = matches.find((item) => !usedSubtopics.has(item.key));
    if (unusedMatch) {
      pushSource(source, unusedMatch);
    }
  });

  dedupedSources.forEach((source) => {
    if (selected.length >= limit) {
      return;
    }

    pushSource(source);
  });

  return selected.slice(0, limit);
}

function formatVinichaiOverviewLine(source = {}) {
  const title = cleanLine(source?.title || source?.reference || "");
  if (!title) {
    return "";
  }

  const preferredSubtopic = source?.__vinichaiPreferredSubtopic || source?.__vinichaiSubtopics?.[0];
  const label = cleanLine(preferredSubtopic?.label || "");
  if (!label) {
    return title;
  }

  const normalizedTitle = normalizeVinichaiTopicText(title);
  const normalizedLabel = normalizeVinichaiTopicText(label);
  if (normalizedLabel && normalizedTitle.includes(normalizedLabel)) {
    return title;
  }

  return `${label}: ${title}`;
}

function buildVinichaiOverviewAnswer(sources, options = {}) {
  const focusMessage = String(options.focusMessage || options.originalMessage || "").trim();
  if (!isBroadVinichaiListingQuestion(focusMessage)) {
    return "";
  }

  const vinichaiSources = dedupeSources(
    sources.filter((source) => String(source?.source || "").trim().toLowerCase() === "tbl_vinichai"),
    6,
  );

  if (vinichaiSources.length === 0) {
    return "";
  }

  const overviewSources = selectVinichaiOverviewSources(vinichaiSources, focusMessage, 4);
  const listingLines = buildSectionLines(
    overviewSources
      .map((source) => formatVinichaiOverviewLine(source))
      .filter(Boolean),
    Math.min(overviewSources.length, 4),
  );

  if (listingLines.length === 0) {
    return "";
  }

  const heading = listingLines.length > 1 ? "แนววินิจฉัยที่เกี่ยวข้อง:" : "แนววินิจฉัยที่เกี่ยวข้อง";
  return [
    buildParagraphSummary(listingLines, [], false, {
      orderedSummary: true,
      summaryHeading: heading,
      summaryLimit: Math.min(listingLines.length, 4),
    }),
    buildReferenceSection(overviewSources, Math.min(overviewSources.length, 4)),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function stripStandaloneDoubleSlash(text) {
  return String(text || "")
    .replace(/(^|\n)\s*\/\/\s*/g, "$1")
    .replace(/(^|[\s(])\/\/(?=[\s)]|$)/g, "$1");
}

function buildSourceRawContentText(source = {}) {
  return [
    source?.content,
    source?.chunk_text,
    source?.comment,
  ]
    .filter(Boolean)
    .join(" ");
}

function sourceHasSubstantiveContent(source = {}) {
  const rawContent = cleanLine(buildSourceRawContentText(source));
  const referenceText = cleanLine(source?.reference || source?.title || source?.keyword || "");
  const normalizedRawContent = normalizeComparisonText(rawContent);
  const normalizedReference = normalizeComparisonText(referenceText);

  if (!rawContent) {
    return false;
  }

  if (hasSubstantiveAnswerSignal(rawContent)) {
    return true;
  }

  if (lineLooksLikeSourceMetadata(rawContent, [source])) {
    return false;
  }

  if (
    String(source?.source || "").trim().toLowerCase() === "internet_search" &&
    normalizedRawContent &&
    normalizedReference &&
    normalizedRawContent === normalizedReference
  ) {
    return false;
  }

  return rawContent.length >= 40;
}

function cleanLine(text) {
  return stripStandaloneDoubleSlash(text)
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/^#{1,6}\s*/, "")
    .replace(/^[*-]\s*/, "")
    .replace(/^สรุป:\s*/i, "")
    // Only strip these headings when they appear inline with content.
    .replace(/^สรุปสาระสำคัญ:\s*(?=\S)/i, "")
    .replace(/^อธิบายเพิ่มเติม:\s*(?=\S)/i, "")
    .replace(/^รายละเอียดเพิ่มเติม:\s*(?=\S)/i, "")
    .replace(/^สรุปคำตอบดังนี้:?\s*/i, "")
	    .replace(/^คำตอบ(?:สรุป)?ดังนี้:?\s*/i, "")
	    .replace(/^(?:เอกสารที่อัปโหลด|ฐานความรู้ที่ผู้ดูแลระบบเพิ่ม\/แก้ไข|พรบ\.สหกรณ์ พ\.ศ\. 2542|หนังสือวินิจฉัย\/ตีความ|Q&A ที่ผู้ดูแลเตรียมไว้)(?:\s*\([^)]*\))?\s*:\s*/i, "")
	    .replace(/^ข้อมูลที่พบจากฐานข้อมูลกฎหมาย(?:\s*\([^)]*\))?:?\s*/u, "")
	    // Only strip inline "แหล่งอ้างอิง:" when it is followed by content on the same line.
	    .replace(/^แหล่งอ้างอิง\s*:\s*(?=\S)/iu, "")
	    .replace(/\s+/g, " ")
	    .trim();
}

function normalizeProtectedLineBreaks(text) {
  return String(text || "")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(
      /((?:พ\.ศ\.?|ค\.ศ\.?|(?:[\u0E01-\u0E2E]{1,2}\.){2,}))\s*[\r\n]+\s*(?=[0-9๐-๙]{4}(?:\b|$))/gu,
      "$1 ",
    );
}

function shouldMergeProtectedYearLine(currentLine, nextLine) {
  const current = cleanLine(currentLine);
  const next = cleanLine(nextLine);

  if (!current || !next) {
    return false;
  }

  return (
    /(?:พ\.ศ\.?|ค\.ศ\.?|(?:[\u0E01-\u0E2E]{1,2}\.){2,})$/u.test(current) &&
    /^(?:[0-9๐-๙]{4})(?:\b|$)/u.test(next)
  );
}

function mergeProtectedYearLines(lines = []) {
  const merged = [];

  for (let index = 0; index < lines.length; index += 1) {
    const current = String(lines[index] || "").trim();
    const next = String(lines[index + 1] || "").trim();

    if (!current) {
      continue;
    }

    if (next && shouldMergeProtectedYearLine(current, next)) {
      merged.push(cleanLine(`${current} ${next}`));
      index += 1;
      continue;
    }

    merged.push(current);
  }

  return merged;
}

function isNoisyLine(text) {
  const line = String(text || "").trim();
  if (!line) {
    return true;
  }

  if (
    /^(?:เอกสารที่อัปโหลด|ฐานความรู้ที่ผู้ดูแลระบบเพิ่ม\/แก้ไข|พรบ\.สหกรณ์ พ\.ศ\. 2542|หนังสือวินิจฉัย\/ตีความ|Q&A ที่ผู้ดูแลเตรียมไว้)(?:\s*\([^)]*\))?\s*:?\s*$/i.test(line) ||
    /^(?:เอกสารที่อัปโหลด|ฐานความรู้ที่ผู้ดูแลระบบเพิ่ม\/แก้ไข|พรบ\.สหกรณ์ พ\.ศ\. 2542|หนังสือวินิจฉัย\/ตีความ|Q&A ที่ผู้ดูแลเตรียมไว้)(?:\s*\([^)]*\))?\s*:/i.test(line)
  ) {
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
  if (
    line.length <= 14 &&
    !hasSubstantiveAnswerSignal(line) &&
    !/[.!?ฯ:]$/.test(line) &&
    /(เอกสาร|ฐานความรู้|พรบ\.|วินิจฉัย|Q&A|นายทะเบียน|สหกรณ์)/i.test(line)
  ) {
    return true;
  }
  return ratio > 0.22;
}

function isSectionHeading(line) {
  return /^(สรุปใจความสำคัญ|ประเด็นสำคัญ|คำอธิบายเพิ่มเติม|รายละเอียดเพิ่มเติม|อธิบายเพิ่มเติม|แหล่งอ้างอิง)$/.test(
    cleanLine(line),
  );
}

function uniqueCleanLines(lines, limit) {
  const results = [];

  for (const line of mergeProtectedYearLines(lines)) {
    const cleaned = cleanLine(line);
    if (!cleaned || isSectionHeading(cleaned) || isNoisyLine(cleaned)) {
      continue;
    }

    if (results.some((existingLine) => linesLookSemanticallyDuplicate(existingLine, cleaned))) {
      continue;
    }

    results.push(cleaned);

    if (results.length >= limit) {
      break;
    }
  }

  return results;
}

function tokenizeComparisonWords(text) {
  const normalized = normalizeForSearch(cleanLine(text)).toLowerCase();
  return Array.from(normalized.matchAll(/[\p{L}\p{N}]+/gu))
    .map((match) => match[0])
    .filter(Boolean);
}

function linesLookSemanticallyDuplicate(left, right) {
  const normalizedLeft = normalizeComparisonText(left);
  const normalizedRight = normalizeComparisonText(right);
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }

  if (normalizedLeft === normalizedRight) {
    return true;
  }

  if (
    normalizedLeft.length >= 14 &&
    normalizedRight.length >= 14 &&
    (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft))
  ) {
    return true;
  }

  const leftTokens = tokenizeComparisonWords(left);
  const rightTokens = tokenizeComparisonWords(right);
  if (leftTokens.length < 4 || rightTokens.length < 4) {
    return false;
  }

  const rightSet = new Set(rightTokens);
  const overlapCount = leftTokens.filter((token) => rightSet.has(token)).length;
  const overlapRatio = overlapCount / Math.max(Math.min(leftTokens.length, rightTokens.length), 1);
  return overlapRatio >= 0.8;
}

function getQueryTokens(message) {
  return uniqueTokens(segmentWords(message)).filter((token) => String(token || "").trim().length >= 2);
}

function getFocusQueryTokens(message) {
  const baseTokens = getQueryTokens(message).filter(
    (token) => !GENERIC_QUERY_TOKENS.has(String(token || "").trim().toLowerCase()),
  );
  const topicTokens = getQueryFocusProfile(message).topics.flatMap((topic) =>
    String(topic.primary || "")
      .split(/\s+/)
      .map((token) => String(token || "").trim().toLowerCase())
      .filter(Boolean),
  );
  return uniqueTokens([...baseTokens, ...topicTokens]);
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

function looksLikeAttachmentFilename(line) {
  const text = cleanLine(line);
  if (!text) {
    return false;
  }

  return /\b[^\s|]+\.(?:pdf|docx?|xlsx?|pptx?|txt)\b/i.test(text);
}

function looksLikeBareDocumentTitle(line, sources = []) {
  const text = cleanLine(line);
  if (!text) {
    return false;
  }

  if (hasSubstantiveAnswerSignal(text)) {
    return false;
  }

  if (looksLikeAttachmentFilename(text)) {
    return true;
  }

  if (/^(?:เรื่อง|ทะเบียนเอกสาร)\b/i.test(text)) {
    return true;
  }

  if (text.length > 120) {
    return false;
  }

  const normalizedLine = normalizeComparisonText(text);
  if (!normalizedLine) {
    return false;
  }

  const candidates = dedupeSources(sources, Math.max(Array.isArray(sources) ? sources.length : 0, 8))
    .flatMap((source) => [source?.reference, source?.title, source?.keyword])
    .filter(Boolean);

  return candidates.some((candidate) => {
    const normalizedCandidate = normalizeComparisonText(candidate);
    if (!normalizedCandidate || normalizedCandidate.length < 6) {
      return false;
    }

    return normalizedLine === normalizedCandidate;
  });
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

  if (looksLikeBareDocumentTitle(cleanedLine, sources)) {
    return true;
  }

  if (hasSubstantiveAnswerSignal(cleanedLine)) {
    return false;
  }

  if (/^(เรื่อง|เลขที่|ลงวันที่|ทะเบียนเอกสาร|ข้อมูลจากอินเทอร์เน็ต)\b/i.test(cleanedLine)) {
    return true;
  }

  if (/\|\s*(?:ลงวันที่|เลขที่)\b/u.test(cleanedLine)) {
    return true;
  }

  if (
    /ลงวันที่\s*[0-9๐-๙]{1,2}\s*[ก-๙]+\s*(?:พ\.ศ\.?|ค\.ศ\.?)\s*[0-9๐-๙]{0,4}/u.test(cleanedLine)
  ) {
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

function sourceMatchesCoopDissolutionFocus(source, message) {
  const query = normalizeForSearch(message).toLowerCase();
  const sourceText = buildSourceSearchText(source);
  const sourceName = String(source?.source || "").trim().toLowerCase();
  const referenceText = normalizeForSearch(
    [source?.reference, source?.title, source?.lawNumber].filter(Boolean).join(" "),
  ).toLowerCase();
  if (!query || !sourceText) {
    return false;
  }

  if (!isCoopDissolutionQuestion(query)) {
    return false;
  }

  if (sourceName === "tbl_laws") {
    return /(มาตรา 70|มาตรา70|มาตรา 71|มาตรา71|มาตรา 89 3|มาตรา89 3|89 3)/.test(referenceText);
  }

  if (sourceName === "admin_knowledge" || sourceName === "knowledge_suggestion") {
    const focusScore = scoreQueryFocusAlignment(message, sourceText);
    if (focusScore >= 18) {
      return true;
    }

    // If the source explicitly talks about dissolution/notification timelines, keep it even when focus scoring is weak.
    return /(สหกรณ์(?:ย่อม)?เลิก|สั่งเลิกสหกรณ์|เลิกสหกรณ์|ชำระบัญชี|ผู้ชำระบัญชี|แจ้ง(?:การ)?เลิก|แจ้ง.*ภายใน|ภายใน\s*(?:15|สิบห้า)\s*วัน)/.test(
      sourceText,
    );
  }

  return scoreQueryFocusAlignment(message, sourceText) >= 24;
}

function isDefectCorrectionQuestion(message) {
  const query = normalizeForSearch(message).toLowerCase();
  return /แก้ไขข้อบกพร่อง|ข้อสังเกตข้อบกพร่อง|ขั้นตอนการแก้ไขข้อบกพร่อง|แนวทางการแก้ไขข้อบกพร่อง/.test(
    query,
  );
}

function sourceMatchesDefectCorrectionFocus(source, message) {
  const query = normalizeForSearch(message).toLowerCase();
  const sourceText = buildSourceSearchText(source);
  const sourceName = String(source?.source || "").trim().toLowerCase();
  if (!query || !sourceText || !isDefectCorrectionQuestion(query)) {
    return false;
  }

  const hasDefectPhrase = /ข้อบกพร่อง|ข้อสังเกต/.test(sourceText);
  const hasCorrectionSignal = /แก้ไข|แนวทาง|ตรวจการ|รายงานผล|กำหนดระยะเวลา|ติดตามผล|ปรับปรุง/.test(
    sourceText,
  );

  if (hasDefectPhrase && hasCorrectionSignal) {
    return true;
  }

  const focusScore = scoreQueryFocusAlignment(message, sourceText);
  if (sourceName === "knowledge_base") {
    return focusScore >= 20;
  }

  if (sourceName === "internet_search" || sourceName === "documents" || sourceName === "pdf_chunks") {
    return focusScore >= 16;
  }

  return focusScore >= 18;
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

  if (options.questionIntent === "law_section") {
    const scopedLawSectionSources = getScopedLawSectionSources(normalizedSources, options);
    if (scopedLawSectionSources.length > 0) {
      return scopedLawSectionSources;
    }
  }

  const focusProfile = getQueryFocusProfile(message);

  if (isCoopDissolutionQuestion(message)) {
    const dissolutionFocused = normalizedSources.filter((source) => sourceMatchesCoopDissolutionFocus(source, message));
    if (dissolutionFocused.length > 0) {
      return dissolutionFocused;
    }
  }

  if (isDefectCorrectionQuestion(message)) {
    const defectCorrectionFocused = normalizedSources.filter((source) =>
      sourceMatchesDefectCorrectionFocus(source, message),
    );
    if (defectCorrectionFocused.length > 0) {
      return defectCorrectionFocused;
    }
  }

  if (isTaxQuestion(message)) {
    const taxFocusedSources = normalizedSources.filter((source) => {
      return scoreQueryFocusAlignment(message, buildSourceSearchText(source)) >= 14;
    });

    if (taxFocusedSources.length > 0) {
      return taxFocusedSources;
    }
  }

  if (options.amountMode) {
    const amountFocused = normalizedSources.filter((source) => sourceMatchesAmountFocus(source, message));
    if (amountFocused.length > 0) {
      return amountFocused;
    }
  }

  if (focusProfile.topics.length > 0) {
    const minimumFocusScore = focusProfile.intent === "general" ? 10 : 18;
    const topicFocusedSources = normalizedSources.filter((source) => {
      return scoreQueryFocusAlignment(message, buildSourceSearchText(source)) >= minimumFocusScore;
    });

    if (topicFocusedSources.length > 0) {
      return topicFocusedSources;
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
  return tokenHits * 2 + coverage * 6 + scoreQueryFocusAlignment(message, line);
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

  for (const rawLine of mergeProtectedYearLines(lines)) {
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
  return normalizeProtectedLineBreaks(stripStandaloneDoubleSlash(text))
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

function buildOrderedLines(lines = []) {
  return lines
    .map((line, index) => `${index + 1}. ${String(line || "").trim()}`)
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
  const unionFeeQuestion = options.amountMode === true && isUnionFeeQuestion(options.originalMessage || options.message || "");

  for (const source of dedupeSources(sources, Math.max(limit * 2, 8))) {
    if (!sourceHasSubstantiveContent(source)) {
      continue;
    }

    const extractedSegments = extractRelevantSegmentsFromSource(
      source,
      options.originalMessage || options.message || "",
      {
        explainMode: options.explainMode,
        amountMode: options.amountMode === true,
        questionIntent: options.questionIntent,
        preserveMoreContent: options.preserveMoreContent === true,
      },
    );

    if (extractedSegments.length > 0) {
      lines.push(...extractedSegments);
      continue;
    }

    const fallbackText = cleanLine(String(source.content || source.chunk_text || "").slice(0, options.explainMode ? 320 : 220));
    if (
      fallbackText &&
      !isNoisyLine(fallbackText) &&
      !lineLooksLikeSourceMetadata(fallbackText, [source]) &&
      (!unionFeeQuestion || lineMatchesUnionFeeFocus(fallbackText))
    ) {
      lines.push(fallbackText);
    }
  }

  return uniqueCleanLines(lines, limit);
}

function looksLikeOutcomeQuestion(message) {
  const text = normalizeForSearch(String(message || "")).toLowerCase();
  if (!text) {
    return false;
  }

  return /เกินกว่า|เกิน|ภายใน|ล่าช้า|ทัน|ครบกำหนด|ได้ไหม|ได้หรือไม่|หรือไม่|ต้อง|ควร|สามารถ/.test(
    text,
  );
}

function getConclusionLinePriority(line, options = {}) {
  const text = cleanLine(line);
  if (!text) {
    return -1;
  }

  let priority = 0;

  if (/^(ดังนั้น|สรุป|จึง)/.test(text)) {
    priority += 8;
  }

  if (/สามารถ|ได้|ไม่ได้|ต้อง|ไม่ต้อง|ควร|ไม่ควร|จำเป็นต้อง|ไม่จำเป็นต้อง/.test(text)) {
    priority += 6;
  }

  if (/เกินกว่า|ภายใน|ล่าช้า|ทัน|ครบกำหนด/.test(text)) {
    priority += 4;
  }

  if (
    String(options.questionIntent || "") === "short_answer" &&
    looksLikeOutcomeQuestion(options.originalMessage || "")
  ) {
    priority += 2;
  }

  return priority;
}

function prioritizeConclusionLines(lines, options = {}) {
  const normalizedLines = Array.isArray(lines) ? lines.filter(Boolean) : [];
  if (normalizedLines.length <= 1) {
    return normalizedLines;
  }

  return [...normalizedLines].sort((left, right) => {
    const priorityDiff = getConclusionLinePriority(right, options) - getConclusionLinePriority(left, options);
    if (priorityDiff !== 0) {
      return priorityDiff;
    }

    return 0;
  });
}

function buildParagraphSummary(summaryLines, detailLines, explainMode, options = {}) {
  const summaryLimit = Math.max(1, Number(options.summaryLimit || 6));
  const detailLimit = Math.max(1, Number(options.detailLimit || (explainMode ? 6 : 4)));
  const summaryItems = buildSectionLines(summaryLines, summaryLimit);
  const detailItems = buildSectionLines(detailLines, detailLimit);
  const blocks = [];
  const orderedSummary = options.orderedSummary === true;
  const summaryHeading = String(
    options.summaryHeading || (orderedSummary ? "ขั้นตอนสำคัญ:" : "สรุปสาระสำคัญ:"),
  ).trim();
  const followUpPrompt = !explainMode ? cleanLine(options.followUpPrompt || "") : "";
  const renderedSummaryItems = orderedSummary ? buildOrderedLines(summaryItems) : summaryItems;
  const renderedSummaryWithPrompt =
    followUpPrompt && !renderedSummaryItems.some((line) => line.includes(followUpPrompt))
      ? [...renderedSummaryItems, followUpPrompt]
      : renderedSummaryItems;

  if (renderedSummaryWithPrompt.length) {
    blocks.push(`${summaryHeading}\n${renderedSummaryWithPrompt.join("\n")}`);
  }

  if (explainMode && detailItems.length) {
    blocks.push(`รายละเอียดเพิ่มเติม:\n${detailItems.join("\n")}`);
  }

  return blocks.join("\n\n").trim();
}

function getSummaryShapeOptions(options = {}, explainMode = false) {
  const promptProfile = options.promptProfile || {};
  const configuredSummaryLimit = explainMode
    ? Number(promptProfile.explainSummaryLineLimit || promptProfile.summaryLineLimit || 6)
    : Number(promptProfile.summaryLineLimit || 4);
  const summaryLimit = Math.max(1, configuredSummaryLimit);
  const detailLimit = Math.max(1, Number(promptProfile.detailLineLimit || (explainMode ? 5 : 4)));
  const followUpPrompt = !explainMode
    ? cleanLine(
        promptProfile.followUpPrompt ||
          (promptProfile.followUpStrength === "deep"
            ? "หากต้องการเจาะลึกต่อ พิมพ์: อธิบาย, แสดงรายละเอียด, รายละเอียด, ใจความทั้งหมด, ฉันไม่เข้าใจ หรือ แจ้งเพิ่มเติม"
            : "หากต้องการเพิ่มเติม พิมพ์: อธิบาย, แสดงรายละเอียด, รายละเอียด, ใจความทั้งหมด, ฉันไม่เข้าใจ หรือ แจ้งเพิ่มเติม"),
        )
      : "";

  return {
    summaryLimit,
    detailLimit,
    followUpPrompt,
    summaryContentLimit: followUpPrompt ? Math.max(1, summaryLimit - 1) : summaryLimit,
  };
}

function finalizeGeneratedAnswer(answerText, explainMode, options = {}) {
  const raw = normalizeParagraph(answerText);
  if (!raw) {
    return "";
  }

  const cleanupSources = Array.isArray(options.sources)
    ? options.sources
    : Array.isArray(options.answerSources)
      ? options.answerSources
      : [];

  const referenceMatch = raw.match(/\n\s*\nแหล่งอ้างอิง:\s*\n([\s\S]*)$/i);
  const bodyText = referenceMatch ? raw.slice(0, referenceMatch.index).trim() : raw.trim();
  const referenceText = referenceMatch ? String(referenceMatch[1] || "").trim() : "";
  const lines = mergeProtectedYearLines(
    bodyText
      .split("\n")
      .map((line) => cleanLine(line))
      .filter(Boolean),
  );
  const shape = getSummaryShapeOptions(options, explainMode);
  const summaryHeading = lines.find((line) => /^ขั้นตอนสำคัญ:?$|^สรุปสาระสำคัญ:?$/i.test(line)) || "สรุปสาระสำคัญ:";
  const orderedSummary = /^ขั้นตอนสำคัญ:?$/i.test(summaryHeading);
  const summaryLines = [];
  const detailLines = [];
  let mode = "summary";

  for (const line of lines) {
    if (/^ขั้นตอนสำคัญ:?$|^สรุปสาระสำคัญ:?$/i.test(line)) {
      mode = "summary";
      continue;
    }
    if (/^รายละเอียดเพิ่มเติม:?$/i.test(line)) {
      mode = "detail";
      continue;
    }

    if (mode === "detail") {
      detailLines.push(line);
    } else {
      summaryLines.push(line);
    }
  }

  const normalizedSummaryLines = uniqueCleanLines(summaryLines, shape.summaryContentLimit);
  const normalizedDetailLines = explainMode ? uniqueCleanLines(detailLines, shape.detailLimit) : [];
  const rebuilt = buildParagraphSummary(normalizedSummaryLines, normalizedDetailLines, explainMode, {
    summaryHeading,
    orderedSummary,
    summaryLimit: shape.summaryContentLimit,
    detailLimit: shape.detailLimit,
    followUpPrompt: shape.followUpPrompt,
  });

  return cleanupAnswerText(
    [
      rebuilt,
      referenceText ? `แหล่งอ้างอิง:\n${referenceText}` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    cleanupSources,
    options,
  );
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
  const rawSegments = normalizeProtectedLineBreaks(text)
    .split(/[\n\r]+|(?<=\.)\s+|(?<=;)\s+|(?<=:)\s+/)
    .map((segment) => cleanLine(segment))
    .filter(Boolean);

  const mergedSegments = mergeProtectedYearLines(rawSegments);

  return mergedSegments;
}

function extractQueryLawNumber(message) {
  const match = String(message || "").match(/(?:มาตรา|ข้อ|วรรค|อนุมาตรา)?\s*(\d{1,4})/);
  return match ? match[1] : "";
}

function isStructuredLawSource(source = {}) {
  return STRUCTURED_LAW_SOURCES.has(String(source?.source || "").trim().toLowerCase());
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

function extractPrimaryLawNumberFromText(text) {
  const normalized = normalizeThaiDigits(String(text || ""));
  const match = normalized.match(/(?:มาตรา|ข้อ|วรรค|อนุมาตรา)\s*([0-9]{1,4})/i);
  return normalizeClauseNumber(match?.[1] || "");
}

function getSourcePrimaryLawNumber(source = {}) {
  const candidates = [source?.lawNumber, source?.reference, source?.title, source?.keyword];

  for (const candidate of candidates) {
    const number = extractPrimaryLawNumberFromText(candidate);
    if (number) {
      return number;
    }
  }

  return "";
}

function sourceMatchesQueryLawNumber(source, queryLawNumber) {
  const normalizedQueryLawNumber = normalizeClauseNumber(queryLawNumber);
  if (!normalizedQueryLawNumber) {
    return false;
  }

  return getSourcePrimaryLawNumber(source) === normalizedQueryLawNumber;
}

function extractLawSubsectionOrder(source = {}) {
  const candidates = [source?.reference, source?.title, source?.keyword, source?.lawNumber]
    .map((item) => cleanLine(item))
    .filter(Boolean);
  const ordinalMap = new Map([
    ["แรก", 1],
    ["หนึ่ง", 1],
    ["1", 1],
    ["๑", 1],
    ["สอง", 2],
    ["2", 2],
    ["๒", 2],
    ["สาม", 3],
    ["3", 3],
    ["๓", 3],
    ["สี่", 4],
    ["4", 4],
    ["๔", 4],
    ["ห้า", 5],
    ["5", 5],
    ["๕", 5],
    ["หก", 6],
    ["6", 6],
    ["๖", 6],
    ["เจ็ด", 7],
    ["7", 7],
    ["๗", 7],
    ["แปด", 8],
    ["8", 8],
    ["๘", 8],
    ["เก้า", 9],
    ["9", 9],
    ["๙", 9],
    ["สิบ", 10],
    ["10", 10],
  ]);

  for (const candidate of candidates) {
    const normalized = normalizeThaiDigits(String(candidate || "")).toLowerCase();
    const paragraphMatch = normalized.match(/วรรค\s*(แรก|หนึ่ง|สอง|สาม|สี่|ห้า|หก|เจ็ด|แปด|เก้า|สิบ|[0-9]{1,2})/i);
    if (paragraphMatch) {
      return ordinalMap.get(paragraphMatch[1]) || Number(paragraphMatch[1]) || Number.POSITIVE_INFINITY;
    }

    const subsectionMatch = normalized.match(/(?:ข้อ|อนุมาตรา)\s*([0-9]{1,3})/i);
    if (subsectionMatch) {
      return Number(subsectionMatch[1]);
    }
  }

  return Number.POSITIVE_INFINITY;
}

function sortLawSectionSources(left, right, queryLawNumber = "") {
  const normalizedQueryLawNumber = normalizeClauseNumber(queryLawNumber);
  const leftExact = normalizedQueryLawNumber ? sourceMatchesQueryLawNumber(left, normalizedQueryLawNumber) : false;
  const rightExact = normalizedQueryLawNumber ? sourceMatchesQueryLawNumber(right, normalizedQueryLawNumber) : false;
  if (leftExact !== rightExact) {
    return rightExact ? 1 : -1;
  }

  const leftStructured = isStructuredLawSource(left);
  const rightStructured = isStructuredLawSource(right);
  if (leftStructured !== rightStructured) {
    return rightStructured ? 1 : -1;
  }

  const leftLawNumber = getSourcePrimaryLawNumber(left);
  const rightLawNumber = getSourcePrimaryLawNumber(right);
  if (leftLawNumber && rightLawNumber && leftLawNumber === rightLawNumber) {
    const leftSubsectionOrder = extractLawSubsectionOrder(left);
    const rightSubsectionOrder = extractLawSubsectionOrder(right);
    if (leftSubsectionOrder !== rightSubsectionOrder) {
      return leftSubsectionOrder - rightSubsectionOrder;
    }
  }

  const scoreDiff = Number(right?.score || 0) - Number(left?.score || 0);
  if (scoreDiff !== 0) {
    return scoreDiff;
  }

  return getSourceStableOrderValue(left) - getSourceStableOrderValue(right);
}

function getScopedLawSectionSources(sources, options = {}) {
  if (options.questionIntent !== "law_section") {
    return Array.isArray(sources) ? sources.filter(Boolean) : [];
  }

  const queryLawNumber = extractQueryLawNumber(options.originalMessage || options.message || "");
  const deduped = dedupeSources(Array.isArray(sources) ? sources : [], Array.isArray(sources) ? sources.length : 0);
  const exactStructured = deduped
    .filter((source) => isStructuredLawSource(source) && sourceMatchesQueryLawNumber(source, queryLawNumber))
    .sort((left, right) => sortLawSectionSources(left, right, queryLawNumber));

  if (exactStructured.length > 0) {
    return exactStructured;
  }

  const structuredSources = deduped
    .filter((source) => isStructuredLawSource(source))
    .sort((left, right) => sortLawSectionSources(left, right, queryLawNumber));

  if (structuredSources.length > 0) {
    return structuredSources.slice(0, 2);
  }

  return deduped.sort((left, right) => sortLawSectionSources(left, right, queryLawNumber));
}

function extractClauseNumberFromLine(line) {
  const cleaned = cleanLine(line);
  const match = cleaned.match(/^(?:ข้อ\s*)?(?:\(?([0-9๐-๙]{1,3})\)|([0-9๐-๙]{1,3})[.)])\s*/);
  return normalizeClauseNumber(match?.[1] || match?.[2] || "");
}

function looksLikeBrokenClauseDetail(detail) {
  const text = cleanLine(detail);
  if (!text) return true;
  if (isNoisyLine(text)) return true;
  if (GARBLED_TEXT_PATTERN.test(text)) return true;

  // Prevent dangling markers like "หรือ", "และ", or very short tails from leaking into the answer body.
  if (/^(?:หรือ|และ)\s*$/u.test(text)) return true;
  if (/^(?:หรือ|และ)\b/u.test(text) && text.length < 18) return true;
  if (/(?:หรือ|และ)\s*$/u.test(text) && text.length < 24) return true;

  // If a clause detail is too short, it is usually an OCR split (e.g., "3. หรือ").
  if (text.length < 10) return true;

  // Pure punctuation or separators are not meaningful content.
  if (/^[;:,.()\[\]\-–—\s]+$/u.test(text)) return true;

  return false;
}

function extractClauseDetailFromLine(line) {
  const cleaned = cleanLine(line);
  const match = cleaned.match(/^(?:ข้อ\s*)?(?:\(?[0-9๐-๙]{1,3}\)|[0-9๐-๙]{1,3}[.)])\s*(.*)$/);
  return cleanLine(match?.[1] || "");
}

function shouldDisplayStructuredLawClauses(clauses = []) {
  if (!Array.isArray(clauses) || clauses.length < 2) {
    return false;
  }

  // Reject if any clause looks incomplete/broken.
  for (const line of clauses) {
    const detail = extractClauseDetailFromLine(line);
    if (looksLikeBrokenClauseDetail(detail)) {
      return false;
    }
  }

  // Basic sanity-check: most legal enumerations start at 1; if we only see a partial tail, avoid showing it.
  const numbers = clauses
    .map((line) => Number(extractClauseNumberFromLine(line)))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (numbers.length >= 2) {
    const sorted = [...numbers].sort((a, b) => a - b);
    if (sorted[0] !== 1 && sorted.length <= 4) {
      return false;
    }
  }

  return true;
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

    if (!number || !detail || looksLikeBrokenClauseDetail(detail) || seen.has(dedupeKey)) {
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

function extractLawSectionPreamble(text) {
  const raw = String(text || "");
  if (!raw.trim()) {
    return "";
  }

  const normalized = normalizeProtectedLineBreaks(raw);
  const match = normalized.match(/^[\s\S]*?(?=(?:ข้อ\s*)?(?:\(?[1-9๐-๙][0-9๐-๙]{0,2}\)|[1-9๐-๙][0-9๐-๙]{0,2}[.)]))/);
  const preamble = cleanLine(match?.[0] || "");
  if (!preamble) {
    return "";
  }

  if (isNoisyLine(preamble)) {
    return "";
  }

  return preamble.replace(/[;,.\-–—]+$/g, "").trim();
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

function buildStructuredLawSectionDisplayLines(source, options = {}) {
  const rawText = [source?.content, source?.comment].filter(Boolean).join("\n");
  const queryLawNumber = extractQueryLawNumber(options.originalMessage || options.message || "");
  const sourceHeadingCandidates = [source?.reference, source?.title]
    .map((item) => cleanLine(item))
    .filter(Boolean);
  const headingKeys = new Set(sourceHeadingCandidates.map((item) => normalizeComparisonText(item)).filter(Boolean));
  const segments = splitContentSegments(rawText)
    .filter((segment) => !isNoisyLine(segment))
    .filter((segment) => !lineLooksLikeSourceMetadata(segment, [source]))
    .filter((segment) => !looksLikeBareDocumentTitle(segment, [source]))
    .filter((segment) => {
      const headingNumber = extractPrimaryLawNumberFromText(
        cleanLine(segment).replace(/\s.*$/, ""),
      );
      return !headingNumber || !queryLawNumber || headingNumber === normalizeClauseNumber(queryLawNumber);
    });
  const preambleLine = extractLawSectionPreamble(rawText);
  const leadLines = uniqueCleanLines(
    [preambleLine, ...segments].filter((segment) => {
      if (extractClauseNumberFromLine(segment)) {
        return false;
      }

      const normalizedSegment = normalizeComparisonText(segment);
      if (normalizedSegment && headingKeys.has(normalizedSegment)) {
        return false;
      }

      return true;
    }),
    2,
  );
  const clauses = extractNumberedClauses(rawText)
    .map((item) => item.line)
    .filter((line) => !isNoisyLine(line));

  const safeClauses = clauses.filter((line) => !looksLikeBrokenClauseDetail(extractClauseDetailFromLine(line)));
  const canDisplayClauses = shouldDisplayStructuredLawClauses(safeClauses);

  // Always show a short, readable summary first for law-section questions.
  const summaryCandidates = [];
  if (leadLines[0]) summaryCandidates.push(leadLines[0]);
  summaryCandidates.push(
    ...segments
      .filter((segment) => !extractClauseNumberFromLine(segment))
      .filter((segment) => cleanLine(segment).length >= 18)
      .slice(0, 6),
  );

  // If the statute body is mostly a list, pull a few clause details as summary prose (without numbering).
  if (summaryCandidates.length < 2 && safeClauses.length > 0) {
    summaryCandidates.push(
      ...safeClauses
        .slice(0, 3)
        .map((line) =>
          cleanLine(
            extractClauseDetailFromLine(line)
              .replace(/\s*[;,.]\s*$/u, "")
              .replace(/\s*(?:หรือ|และ)\s*$/u, "")
              .trim(),
          ),
        )
        .filter(Boolean),
    );
  }

  const summaryLines = uniqueCleanLines(summaryCandidates, 5);
  const displayLines = [];
  if (summaryLines.length > 0) {
    displayLines.push("สรุปสาระสำคัญ:");
    displayLines.push(...summaryLines.slice(0, 5));
  }

  if (canDisplayClauses) {
    displayLines.push("รายละเอียดตามตัวบท:");
    displayLines.push(...safeClauses);
    return displayLines;
  }

  const completeSegments = uniqueCleanLines(
    [...leadLines, ...segments]
      .filter((segment) => !extractClauseNumberFromLine(segment))
      .filter((segment) => cleanLine(segment).length >= 18),
    Math.max(leadLines.length + segments.length, 12),
  );
  if (completeSegments.length > 0) {
    if (displayLines.length > 0) {
      // Avoid dumping raw statute when list parsing is incomplete; keep it as a clean summary.
      return displayLines;
    }
    return ["สรุปสาระสำคัญ:", ...completeSegments.slice(0, 5)];
  }

  const fallbackText = cleanLine(normalizeProtectedLineBreaks(rawText));
  if (fallbackText && !isNoisyLine(fallbackText)) {
    const trimmed = fallbackText.slice(0, 360);
    if (displayLines.length > 0) {
      return displayLines;
    }
    return ["สรุปสาระสำคัญ:", trimmed];
  }
  return displayLines.length > 0 ? displayLines : [];
}

function shouldUseDirectStructuredLawDatabaseAnswer(sources, options = {}) {
  if (options.questionIntent !== "law_section") {
    return false;
  }

  const lookupText = String(options.originalMessage || options.message || "").trim();
  if (!/((มาตรา|ข้อ|วรรค|อนุมาตรา)\s*\d+)/i.test(lookupText)) {
    return false;
  }

  return getScopedLawSectionSources(sources, options).some((source) => isStructuredLawSource(source));
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

  if (normalized === "managed_suggested_question") return 110;

  if (questionIntent === "law_section") {
    if (normalized === "tbl_laws") return 100;
    if (normalized === "tbl_glaws") return 95;
    if (normalized === "admin_knowledge") return 80;
    if (normalized === "knowledge_suggestion") return 75;
    if (normalized === "tbl_vinichai") return 70;
    if (normalized === "pdf_chunks") return 40;
    if (normalized === "documents") return 30;
    if (normalized === "knowledge_base") return 20;
    return 0;
  }

  if (normalized === "admin_knowledge") return 90;
  if (normalized === "knowledge_suggestion") return 85;
  if (normalized === "tbl_vinichai") return 80;
  if (normalized === "tbl_laws") return 75;
  if (normalized === "tbl_glaws") return 70;
  if (normalized === "pdf_chunks") return 50;
  if (normalized === "documents") return 45;
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
  const freePlan = isFreePlanDisplay(options);
  const vinichaiPriorityQuestion = isVinichaiPriorityQuestion(options.originalMessage || options.message || "");
  const quotaBySource = {
    admin_knowledge: vinichaiPriorityQuestion ? 2 : freePlan ? 4 : 3,
    knowledge_suggestion: options.questionIntent === "law_section" ? 1 : 1,
    tbl_laws: vinichaiPriorityQuestion ? 1 : options.questionIntent === "law_section" ? 4 : freePlan ? 2 : 3,
    tbl_glaws: vinichaiPriorityQuestion ? 1 : options.questionIntent === "law_section" ? 3 : freePlan ? 2 : 3,
    pdf_chunks: vinichaiPriorityQuestion ? 1 : freePlan ? 1 : options.explainMode ? 4 : 3,
    tbl_vinichai: vinichaiPriorityQuestion ? 4 : freePlan ? 3 : 2,
    documents: vinichaiPriorityQuestion ? 1 : freePlan ? 2 : 2,
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
  if (!sourceHasSubstantiveContent(source)) {
    return [];
  }
  const segments = splitContentSegments(rawText);
  const preserveMoreContent = options.preserveMoreContent === true;
  const focusTokens = getFocusQueryTokens(message);
  const unionFeeQuestion = options.amountMode === true && isUnionFeeQuestion(message);
  const scoredSegments = segments
    .map((segment, index) => ({
      index,
      text: segment,
      score: scoreSourceSegment(segment, message, source, options),
    }))
    .filter((item) => !isNoisyLine(item.text))
    .filter((item) => !lineLooksLikeSourceMetadata(item.text, [source]))
    .filter((item) => !unionFeeQuestion || lineMatchesUnionFeeFocus(item.text))
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
    normalizeProtectedLineBreaks(String(rawText || "")).slice(
      0,
      preserveMoreContent ? 720 : options.explainMode ? 420 : 280,
    ),
  );
  if (fallbackText && !isNoisyLine(fallbackText) && !lineLooksLikeSourceMetadata(fallbackText, [source])) {
    return [fallbackText];
  }

  return [];
}

function formatDatabaseOnlySourceBlock(source, message, options = {}) {
  const label = SOURCE_LABELS[source.source] || source.source || "ฐานข้อมูลภายในระบบ";
  const reference = cleanLine(source.reference || source.title || source.keyword || label);
  const title = cleanLine(source.title || "");
  const heading = reference && title && title !== reference ? `${reference} | ${title}` : reference || title || label;

  const segments =
    options.questionIntent === "law_section" && isStructuredLawSource(source)
      ? buildStructuredLawSectionDisplayLines(source, {
          ...options,
          originalMessage: options.originalMessage || message,
          message,
        })
      : extractRelevantSegmentsFromSource(source, message, options);
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
  const focusMessage = String(options.focusMessage || options.originalMessage || "").trim();
  const explainMode = Boolean(options.explainMode);
  const freePlan = isFreePlanDisplay(options);
  const vinichaiOverviewAnswer = buildVinichaiOverviewAnswer(sources, {
    ...options,
    focusMessage,
  });
  if (vinichaiOverviewAnswer) {
    return vinichaiOverviewAnswer;
  }
  const shortDecisionMode = options.questionIntent === "short_answer" && options.decisionMode;
  const baseSummaryLimit =
    shortDecisionMode
      ? 2
      : options.questionIntent === "short_answer"
        ? 3
      : options.questionIntent === "document"
        ? 5
        : explainMode
          ? 6
          : 5;
  const summaryLimit = baseSummaryLimit + (freePlan && !shortDecisionMode ? 1 : 0);
  const detailLimit = explainMode ? (freePlan ? 6 : 5) : 0;
  const substantiveLimit =
    shortDecisionMode
      ? 1
      : options.questionIntent === "short_answer"
        ? 2
        : explainMode
          ? 6
          : 4;
  const effectiveSubstantiveLimit = substantiveLimit + (freePlan && !shortDecisionMode ? 1 : 0);
  const fallbackLimit =
    shortDecisionMode
      ? 1
      : options.questionIntent === "short_answer"
        ? 2
        : explainMode
          ? 6
          : 4;
  const effectiveFallbackLimit = fallbackLimit + (freePlan && !shortDecisionMode ? 1 : 0);
  const visibleSourceLimit = freePlan ? (explainMode ? 10 : 8) : explainMode ? 8 : 6;
  const visibleSources = dedupeSources(
    orderSourcesForDatabaseOnly(sources, {
      questionIntent: options.questionIntent,
      explainMode,
      originalMessage: focusMessage,
      planCode: options.planCode,
      sourceLimit: visibleSourceLimit,
    }),
    visibleSourceLimit,
  );
  const qaPreparedSources =
    options.questionIntent === "qa"
      ? visibleSources.filter((source) => {
          const sourceName = String(source?.source || "").trim().toLowerCase();
          return sourceName === "admin_knowledge" || sourceName === "knowledge_suggestion";
        })
      : [];
  const summarySources = qaPreparedSources.length > 0 ? qaPreparedSources : visibleSources;

  const decisionLead = options.decisionMode ? inferDecisionLead(focusMessage, summarySources) : "";
  const substantiveSegments = extractSubstantiveSegments(summarySources, effectiveSubstantiveLimit, {
    message: focusMessage,
    requireFocus: true,
  });
  const numericEvidence = options.amountMode ? extractNumericEvidence(summarySources, explainMode ? 4 : 2, focusMessage) : [];
  const fallbackLines = buildSourceContentFallbackLines(summarySources, effectiveFallbackLimit, {
    ...options,
    amountMode: options.amountMode === true,
    explainMode,
  });
  const summaryLines = filterUnionFeeFocusedLines(
    [decisionLead, ...substantiveSegments, ...numericEvidence, ...fallbackLines],
    focusMessage,
    summaryLimit,
  );
  const orderedSummaryLines = prioritizeConclusionLines(summaryLines, {
    originalMessage: focusMessage,
    questionIntent: options.questionIntent,
  });
  const detailLines = explainMode
    ? buildSourceContentFallbackLines(summarySources, detailLimit, {
        ...options,
        amountMode: options.amountMode === true,
        explainMode: true,
        preserveMoreContent: true,
      })
    : [];

  if (orderedSummaryLines.length === 0) {
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
  const effectiveReferenceLimit = referenceLimit + (freePlan ? 1 : 0);
  const referenceSources = [...summarySources, ...visibleSources.filter((source) => !summarySources.includes(source))].sort((left, right) => {
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

  return cleanupAnswerText(
    [
      buildParagraphSummary(orderedSummaryLines, detailLines, explainMode, {
        summaryLimit,
        detailLimit: Math.max(detailLimit, 1),
      }),
      buildReferenceSection(referenceSources, Math.min(referenceSources.length, effectiveReferenceLimit)),
    ]
      .filter(Boolean)
      .join("\n\n"),
    summarySources,
    options,
  );
}

function buildDatabaseOnlyAnswer(sources, options = {}) {
  const focusMessage = String(options.focusMessage || options.originalMessage || "").trim();
  if (options.questionIntent !== "law_section") {
    const compactAnswer = buildCompactDatabaseOnlyAnswer(sources, options);
    if (compactAnswer) {
      return compactAnswer;
    }
  }

  const scopedLawSectionSources =
    options.questionIntent === "law_section"
      ? getScopedLawSectionSources(sources, {
          ...options,
          originalMessage: focusMessage,
          message: focusMessage,
        })
      : [];
  const orderedSources =
    options.questionIntent === "law_section" && scopedLawSectionSources.length > 0
      ? scopedLawSectionSources
      : orderSourcesForDatabaseOnly(sources, {
          questionIntent: options.questionIntent,
          explainMode: options.explainMode,
          originalMessage: focusMessage,
          planCode: options.planCode,
          sourceLimit:
            Math.max(
              Number(options.sourceLimit || 0),
              Array.isArray(sources) ? sources.length : 0,
              options.questionIntent === "law_section" ? 12 : options.explainMode ? 14 : 12,
            ),
        });
  const displaySources =
    options.questionIntent === "law_section"
      ? getScopedLawSectionSources(orderedSources, {
          ...options,
          originalMessage: focusMessage,
          message: focusMessage,
        })
      : orderedSources;
  const displayedSources = [];
  const sourceBlocks = displaySources
    .map((source) => {
      const block = formatDatabaseOnlySourceBlock(source, focusMessage, {
        explainMode: options.explainMode,
        amountMode: options.amountMode === true,
        questionIntent: options.questionIntent,
        preserveMoreContent: true,
        originalMessage: focusMessage,
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

function extractNumericEvidence(sources, limit = 5, message = "") {
  const scored = [];
  const unionFeeQuestion = isUnionFeeQuestion(message);

  for (const source of dedupeSources(sources, 10)) {
    const segments = splitContentSegments(
      [source.content, source.chunk_text, source.comment].filter(Boolean).join("\n"),
    );

    for (const segment of segments) {
      if (!/\d/.test(segment)) {
        continue;
      }

      if (unionFeeQuestion && !lineMatchesUnionFeeFocus(segment)) {
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
  const focusProfile = getQueryFocusProfile(message);
  const unionFeeQuestion = isUnionFeeQuestion(message);

  for (const source of dedupeSources(sources, 10)) {
    const joined = [source.content, source.chunk_text, source.comment].filter(Boolean).join("\n");
    const segments = splitContentSegments(joined);

    for (const segment of segments) {
      if (segment.length < 18 || isNoisyLine(segment)) {
        continue;
      }

      if (lineLooksLikeSourceMetadata(segment, [source])) {
        continue;
      }

      if (unionFeeQuestion && !lineMatchesUnionFeeFocus(segment)) {
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

      if (
        focusProfile.intent === "qualification" &&
        !/(คุณสมบัติ|ลักษณะต้องห้าม|วิธีการรับสมัคร|ขาดจากการเป็น|ขาดคุณสมบัติ|ไม่มีสิทธิ)/.test(segment) &&
        scoreQueryFocusAlignment(message, segment) < 30
      ) {
        continue;
      }

      if (
        focusProfile.intent === "duty" &&
        !/(อำนาจหน้าที่|มีหน้าที่|หน้าที่ของ|หน้าที่ในการ|รายงานเสนอต่อที่ประชุมใหญ่|ทำรายงานเสนอต่อที่ประชุมใหญ่|ตรวจสอบกิจการของสหกรณ์)/.test(
          segment,
        ) &&
        scoreQueryFocusAlignment(message, segment) < 30
      ) {
        continue;
      }

      if (
        focusProfile.intent === "rights" &&
        !/(สิทธิ|สิทธิออกเสียง|องค์ประชุม|เป็นกรรมการ|กู้ยืมเงิน|สิทธิและหน้าที่|ถือหุ้นได้|รับเลือกตั้ง)/.test(
          segment,
        ) &&
        scoreQueryFocusAlignment(message, segment) < 30
      ) {
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
    // Keep the heading on its own line so downstream shaping can split sections reliably.
    .replace(/\n\nรายละเอียดเพิ่มเติม:\s*/i, "\n\nรายละเอียดเพิ่มเติม:\n")
    .trim();
}

function extractAnswerBodyLines(answerText) {
  return mergeProtectedYearLines(
    normalizeParagraph(answerText)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  )
    .map((line) => cleanLine(line))
    .filter(Boolean)
    .filter((line) => !/^แหล่งอ้างอิง:?$/i.test(line))
    .filter((line) => !line.startsWith("- "));
}

function hasMeaningfulSummaryContent(answerText, sources, options = {}) {
  const promptProfile = options.promptProfile || {};
  const bodyLines = extractAnswerBodyLines(answerText)
    .filter((line) => !/^สรุปสาระสำคัญ:?$/i.test(line))
    .filter((line) => !/^รายละเอียดเพิ่มเติม:?$/i.test(line))
    .filter((line) => !isSectionHeading(line))
    .filter((line) => !lineLooksLikeSourceMetadata(line, sources))
    .filter((line) => !looksLikeBareDocumentTitle(line, sources));

  if (bodyLines.length === 0) {
    return false;
  }

  const message = String(options.originalMessage || options.focusMessage || "").trim();
  const substantiveLines = bodyLines.filter((line) => {
    if (hasSubstantiveAnswerSignal(line)) {
      return true;
    }

    const focusHits = countFocusTokenHits(line, message);
    if (focusHits >= 2 && line.length >= 24) {
      return true;
    }

    return false;
  });

  if (substantiveLines.length === 0) {
    return false;
  }

  if (
    promptProfile.code === "brief" &&
    !options.amountMode &&
    !options.decisionMode &&
    substantiveLines.length < 2
  ) {
    return false;
  }

  if (options.amountMode) {
    const hasAmountLine = substantiveLines.some((line) =>
      /\d[\d,]*(?:\.\d+)?\s*(?:บาท|ร้อยละ|เปอร์เซ็นต์|%)/.test(line) ||
      /(อัตรา|จัดสรร|กำไรสุทธิ|เรียกเก็บ|ค่าบำรุง|สันนิบาต)/.test(line),
    );

    if (!hasAmountLine) {
      return false;
    }
  }

  return true;
}

function normalizeModelSummary(text, explainMode, sources, options = {}) {
  const raw = normalizeParagraph(text);

  if (!raw) {
    return "";
  }

  const lines = mergeProtectedYearLines(
    raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  )
    .filter((line) => !shouldDropModelOutputLine(line, sources, options));
  const shape = getSummaryShapeOptions(options, explainMode);
  const structuredLawClauseLines = explainMode ? getPrimaryStructuredLawClauses(sources, options) : [];
  const minimumSummaryLimit = explainMode
    ? Math.max(
        shape.summaryContentLimit,
        structuredLawClauseLines.length ? structuredLawClauseLines.length + 2 : 0,
      )
    : shape.summaryContentLimit;

  if (explainMode) {
    const { summary, detail } = splitExplainSections(lines, {
      summaryLimit: minimumSummaryLimit,
      detailLimit: Math.max(6, Number(options.detailLimit || 6)),
    });
    const fallbackSummary = summary.length
      ? summary
      : buildSourceContentFallbackLines(sources, Math.max(4, minimumSummaryLimit), {
          ...options,
          amountMode: options.amountMode === true,
          explainMode,
        });
    const fallbackDetail = detail.length
      ? detail
      : buildSourceContentFallbackLines(sources, 3, {
          ...options,
          amountMode: options.amountMode === true,
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
        detailLimit: shape.detailLimit,
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
    const numericEvidence = extractNumericEvidence(sources, 3, options.originalMessage || options.focusMessage || "");
    const focusedLines = filterUnionFeeFocusedLines(
      conciseLines,
      options.originalMessage || options.focusMessage || "",
      minimumSummaryLimit,
    );
    const workingLines = focusedLines.length > 0 ? focusedLines : conciseLines;
    const hasNumericLine = workingLines.some((line) =>
      /\d[\d,]*(?:\.\d+)?\s*(?:บาท|ร้อยละ|เปอร์เซ็นต์|%)/.test(line),
    );
    const mergedLines = hasNumericLine
      ? workingLines
      : uniqueCleanLines([...numericEvidence, ...amountHighlights, ...workingLines], minimumSummaryLimit);
    const completedLines = ensureStructuredLawSummaryCompleteness(mergedLines, sources, {
      ...options,
      summaryLimit: minimumSummaryLimit,
    });

    return decorateConversationalAnswer(
      buildParagraphSummary(completedLines.lines, [], false, {
        summaryLimit: shape.summaryContentLimit,
        followUpPrompt: shape.followUpPrompt,
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
        summaryLimit: shape.summaryContentLimit,
        followUpPrompt: shape.followUpPrompt,
      }),
      options,
    );
  }

  const completedLines = {
    lines: conciseLines,
    summaryLimit: shape.summaryContentLimit,
  };

  return decorateConversationalAnswer(
    buildParagraphSummary(completedLines.lines, [], false, {
      summaryLimit: shape.summaryContentLimit,
      followUpPrompt: shape.followUpPrompt,
    }),
    options,
  );
}

function buildFallbackSummary(sources, explainMode, options = {}) {
  const focusMessage = String(options.focusMessage || options.originalMessage || "").trim();
  const promptProfile = options.promptProfile || {};
  const referenceLimit = Math.max(1, Number(promptProfile.referenceLimit || 5));
  const familyStyle = String(options.topicFamily?.answerStyle || "").trim().toLowerCase();
  const familyStepMode = familyStyle === "steps";
  const stepMode = options.stepMode === true || familyStepMode;
  if (options.databaseOnlyMode) {
    return buildDatabaseOnlyAnswer(sources, {
      ...options,
      explainMode,
      focusMessage,
    });
  }

  const topSources = narrowSourcesForFocusedGrounding(
    dedupeSources(
      (Array.isArray(sources) ? sources : []).filter((source) => sourceHasSubstantiveContent(source)),
      Math.max(referenceLimit + 1, 5),
    ),
    focusMessage,
    {
      limit: Math.min(3, Math.max(referenceLimit, 2)),
    },
  );
  const amountHighlights = options.amountMode ? extractAmountHighlights(topSources, explainMode ? 5 : 3) : [];
  const numericEvidence = options.amountMode ? extractNumericEvidence(topSources, explainMode ? 5 : 3, focusMessage) : [];
  const decisionLead = options.decisionMode ? inferDecisionLead(focusMessage, topSources) : "";
  const substantiveSegments = options.decisionMode
    ? extractSubstantiveSegments(topSources, explainMode ? 5 : 3, {
        message: focusMessage,
      })
    : [];
  const importantPoints = filterUnionFeeFocusedLines(
    [
      decisionLead,
      ...substantiveSegments,
      ...numericEvidence,
      ...amountHighlights,
      ...buildSourceContentFallbackLines(topSources, explainMode ? 8 : 5, {
        ...options,
        amountMode: options.amountMode === true,
        explainMode,
      }),
    ],
    focusMessage,
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
    return "พบหัวข้อหรือเอกสารที่เกี่ยวข้อง แต่ข้อความที่ดึงมาไม่เพียงพอสำหรับสรุปคำตอบอย่างถูกต้อง กรุณาระบุประเด็นให้เฉพาะเจาะจงขึ้น หรือสอบถามเป็นหัวข้อย่อยเพิ่มเติม";
  }

  const answerText = buildParagraphSummary(
    importantPoints,
    detailPoints.length
      ? detailPoints
      : ["หากต้องการรายละเอียดเพิ่ม สามารถพิมพ์คำว่า อธิบาย แล้วตามด้วยประเด็นที่ต้องการได้"],
    explainMode,
    {
      orderedSummary: stepMode,
      summaryHeading: stepMode ? "ขั้นตอนสำคัญ:" : "สรุปสาระสำคัญ:",
    },
  );

  return cleanupAnswerText(
    [decorateConversationalAnswer(answerText, options), buildReferenceSection(topSources, referenceLimit)]
      .filter(Boolean)
      .join("\n\n"),
    topSources,
    options,
  );
}

function filterHighQualitySources(sources, topScore, limit = 4, options = {}) {
  // Filter out sources with garbled OCR text or very low scores
  // Use stricter threshold: 70% of top score to focus on most relevant sources
  const queryText = String(options.message || options.originalMessage || "").trim();
  const amountMode = options.amountMode === true;
  const promptProfile = options.promptProfile || {};
  const strictSourceFiltering = promptProfile.strictSourceFiltering === true;
  const minScore = amountMode
    ? Math.max(topScore * (strictSourceFiltering ? 0.62 : 0.55), strictSourceFiltering ? 60 : 52)
    : Math.max(topScore * (strictSourceFiltering ? 0.8 : 0.7), strictSourceFiltering ? 88 : 80);
  const garbledPattern = /[็์ิีุู่้๊๋]{3,}|~็|็~|◊|Ë|‡|∫|≈|¡|¥|å|ì|î|ï|ñ|ó|ô|ö|ù|û|ü/g;
  
  const filtered = sources.filter((source) => {
    const rawContent = buildSourceRawContentText(source);
    const referenceText = cleanLine(source.reference || source.title || source.keyword || "");
    const hasAmountSubstance =
      amountMode &&
      sourceMatchesAmountFocus(source, queryText) &&
      (
        /\d[\d,]*(?:\.\d+)?\s*(?:บาท|ร้อยละ|เปอร์เซ็นต์|%)/.test(rawContent) ||
        /(อัตรา|ร้อยละ|เปอร์เซ็นต์|กำไรสุทธิ|จัดสรร|กฎกระทรวง|ค่าบำรุง|สันนิบาต)/.test(rawContent)
      );
    const looksLikeMetadataOnly =
      looksLikeAttachmentFilename(referenceText) ||
      looksLikeBareDocumentTitle(referenceText, [source]);

    if ((source.score || 0) < minScore && !hasAmountSubstance) {
      return false;
    }

    if (
      String(source?.source || "").trim().toLowerCase() === "internet_search" &&
      !sourceHasSubstantiveContent(source)
    ) {
      return false;
    }
    
    const content = String(rawContent || source.preview || "");
    const garbledHits = (content.match(garbledPattern) || []).length;
    if (garbledHits > 2) {
      return false;
    }

    if (amountMode && looksLikeMetadataOnly && !hasAmountSubstance) {
      return false;
    }
    
    return true;
  });
  
  // Limit effective sources by prompt profile to keep AI focused and cost-controlled.
  return filtered
    .sort((left, right) => {
      if (amountMode) {
        const leftAmountScore = sourceMatchesAmountFocus(left, queryText) ? 1 : 0;
        const rightAmountScore = sourceMatchesAmountFocus(right, queryText) ? 1 : 0;
        if (leftAmountScore !== rightAmountScore) {
          return rightAmountScore - leftAmountScore;
        }
      }

      return Number(right.score || 0) - Number(left.score || 0);
    })
    .slice(0, Math.max(1, Number(limit || 4)));
}

function isOverviewGroundingQuery(message = "") {
  const normalized = normalizeForSearch(String(message || "")).toLowerCase();
  if (!normalized) {
    return false;
  }

  return /(ความรู้ทั่วไป|ทั่วไปเกี่ยวกับ|เบื้องต้น|ภาพรวม|สรุป|นิยาม|ความหมาย|หมายถึง|สหกรณ์คืออะไร|คืออะไร|ประโยชน์|ข้อดี|ดีอย่างไร|ช่วยอะไร)/.test(
    normalized,
  );
}

function hasExplicitLegalGroundingIntent(message = "") {
  const normalized = normalizeForSearch(String(message || "")).toLowerCase();
  if (!normalized) {
    return false;
  }

  return /มาตรา\s*\d+|มาตรา|วรรค|อนุมาตรา|ข้อ\s*\d+|นายทะเบียน|อำนาจหน้าที่|พระราชบัญญัติ|กฎกระทรวง|ระเบียบ|ข้อบังคับ|พ\.ศ\./.test(
    normalized,
  );
}

function sourceLooksLikeLegalSection(source = {}) {
  const text = normalizeForSearch(
    [
      source?.title,
      source?.reference,
      source?.keyword,
      source?.content,
      source?.chunk_text,
      source?.comment,
    ]
      .filter(Boolean)
      .join(" "),
  ).toLowerCase();

  if (!text) {
    return false;
  }

  return /(มาตรา\s*\d+|มาตรา|วรรค|อนุมาตรา|พระราชบัญญัติ|กฎกระทรวง|ระเบียบ|ข้อบังคับ|นายทะเบียน|อำนาจหน้าที่)/.test(
    text,
  );
}

function sourceLooksOverviewFriendly(source = {}) {
  const text = normalizeForSearch(
    [
      source?.title,
      source?.reference,
      source?.keyword,
      source?.content,
      source?.chunk_text,
      source?.comment,
    ]
      .filter(Boolean)
      .join(" "),
  ).toLowerCase();

  if (!text) {
    return false;
  }

  return /(ความรู้ทั่วไป|ภาพรวม|เบื้องต้น|นิยาม|ความหมาย|หมายถึง|คือ|ประโยชน์|ข้อดี|วัตถุประสงค์|หลักการ)/.test(
    text,
  );
}

function narrowSourcesForFocusedGrounding(sources, message = "", options = {}) {
  const list = Array.isArray(sources) ? sources.filter(Boolean) : [];
  const limit = Math.max(1, Number(options.limit || 3));
  if (list.length <= limit) {
    return list.slice(0, limit);
  }

  const overviewQuery = isOverviewGroundingQuery(message);
  const legalIntent = hasExplicitLegalGroundingIntent(message);
  if (!overviewQuery || legalIntent) {
    return list.slice(0, limit);
  }

  const filtered = list.filter((source) => !sourceLooksLikeLegalSection(source));
  const overviewFriendly = filtered.filter((source) => sourceLooksOverviewFriendly(source));
  const candidatePool = overviewFriendly.length > 0 ? overviewFriendly : filtered;
  if (candidatePool.length === 0) {
    return list.slice(0, limit);
  }

  const anchor = candidatePool[0];
  const anchorDocumentId = Number(anchor?.documentId || anchor?.document_id || 0);
  const anchorTitle = normalizeForSearch(String(anchor?.title || anchor?.reference || "")).toLowerCase();
  const sameContext = candidatePool.filter((source) => {
    const sourceName = String(source?.source || "").trim().toLowerCase();
    if (sourceName !== "documents" && sourceName !== "pdf_chunks") {
      return false;
    }
    const documentId = Number(source?.documentId || source?.document_id || 0);
    if (anchorDocumentId && documentId) {
      return documentId === anchorDocumentId;
    }
    const title = normalizeForSearch(String(source?.title || source?.reference || "")).toLowerCase();
    return Boolean(anchorTitle) && title === anchorTitle;
  });

  const anchoredPool = sameContext.length > 0 ? sameContext : candidatePool;
  return anchoredPool.slice(0, limit);
}

async function generateChatSummary(message, sources, options = {}) {
  const explainMode = wantsExplanation(message);
  const amountMode = wantsAmountAnswer(message);
  const decisionMode = wantsDecisionAnswer(message);
  const stepMode = wantsStepAnswer(message);
  const focusMessage = String(options.focusMessage || message || "").trim() || String(message || "").trim();
  const topicFamily = detectTopicFamily(focusMessage);
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
  const finalizeSummary = (text) => finalizeGeneratedAnswer(text, explainMode, {
    ...options,
    promptProfile,
    sources: focusedAnswerSources,
  });
  const aiSourceLimit = Math.max(1, Number(promptProfile.aiSourceLimit || (explainMode ? 5 : 4)));
  const databaseOnlyMode = Boolean(options.databaseOnlyMode) || !aiEnabled || !openAiConfig;
  const answerInputSources = filterSourcesByAnswerFocus(sources, {
    ...options,
    amountMode,
    decisionMode,
    originalMessage: focusMessage,
  });

  // Filter out low-quality sources before sending to Gemini
  const topScore =
    answerInputSources.length > 0 ? Math.max(...answerInputSources.map((s) => s.score || 0)) : 0;
  const filteredSources = filterHighQualitySources(answerInputSources, topScore, aiSourceLimit, {
    ...options,
    amountMode,
    originalMessage: focusMessage,
    message,
  });
  const effectiveSources = narrowSourcesForFocusedGrounding(
    filteredSources.length > 0
      ? filteredSources
      : answerInputSources.slice(0, aiSourceLimit),
    focusMessage,
    {
      limit: Math.min(aiSourceLimit, explainMode ? 3 : 2),
    },
  );
  captureContinuationDiagnostics(options.answerDiagnostics, effectiveSources, promptProfile);
  const focusedAnswerSources =
    answerInputSources.length > 0
      ? narrowSourcesForFocusedGrounding(answerInputSources, focusMessage, {
          limit: Math.min(aiSourceLimit, explainMode ? 3 : 2),
        })
      : effectiveSources;

  const taxGuardAnswer = buildTaxCautiousAnswer(focusedAnswerSources, {
    ...options,
    originalMessage: focusMessage,
    message,
  });
  if (taxGuardAnswer) {
    return finalizeSummary(taxGuardAnswer);
  }

  const unionFeeFocusedAnswer = buildUnionFeeFocusedAnswer(
    focusedAnswerSources,
    {
      ...options,
      originalMessage: focusMessage,
      message,
    },
  );

  if (unionFeeFocusedAnswer) {
    return finalizeSummary(unionFeeFocusedAnswer);
  }

  const reserveFundFocusedAnswer = buildReserveFundFocusedAnswer(
    focusedAnswerSources,
    {
      ...options,
      originalMessage: focusMessage,
      message,
    },
  );

  if (reserveFundFocusedAnswer) {
    return finalizeSummary(reserveFundFocusedAnswer);
  }

  const dividendFocusedAnswer = buildDividendFocusedAnswer(
    focusedAnswerSources,
    {
      ...options,
      originalMessage: focusMessage,
      message,
    },
  );

  if (dividendFocusedAnswer) {
    return finalizeSummary(dividendFocusedAnswer);
  }

  const liquidationFocusedAnswer = buildLiquidationFocusedAnswer(
    focusedAnswerSources,
    {
      ...options,
      originalMessage: focusMessage,
      message,
      stepMode,
    },
  );

  if (liquidationFocusedAnswer) {
    return finalizeSummary(liquidationFocusedAnswer);
  }

  const groupFormationFocusedAnswer = buildGroupFormationFocusedAnswer(
    focusedAnswerSources,
    {
      ...options,
      originalMessage: focusMessage,
      message,
    },
  );

  if (groupFormationFocusedAnswer) {
    return finalizeSummary(groupFormationFocusedAnswer);
  }

  const coopFormationFocusedAnswer = buildCoopFormationFocusedAnswer(
    focusedAnswerSources,
    {
      ...options,
      originalMessage: focusMessage,
      message,
    },
  );

  if (coopFormationFocusedAnswer) {
    return finalizeSummary(coopFormationFocusedAnswer);
  }

  const coopDissolutionDeadlineAnswer = buildCoopDissolutionDeadlineFocusedAnswer(
    focusedAnswerSources,
    {
      ...options,
      originalMessage: focusMessage,
      message,
    },
  );

  if (coopDissolutionDeadlineAnswer) {
    return finalizeSummary(coopDissolutionDeadlineAnswer);
  }

  const coopDissolutionFocusedAnswer = buildCoopDissolutionFocusedAnswer(
    focusedAnswerSources,
    {
      ...options,
      originalMessage: focusMessage,
      message,
    },
  );

  if (coopDissolutionFocusedAnswer) {
    return finalizeSummary(coopDissolutionFocusedAnswer);
  }

  // Add more specialized handlers for common legal topics
  const meetingQuorumFocusedAnswer = buildMeetingQuorumFocusedAnswer(
    focusedAnswerSources,
    {
      ...options,
      originalMessage: focusMessage,
      message,
    },
  );

  if (meetingQuorumFocusedAnswer) {
    return finalizeSummary(meetingQuorumFocusedAnswer);
  }

  const boardElectionFocusedAnswer = buildBoardElectionFocusedAnswer(
    focusedAnswerSources,
    {
      ...options,
      originalMessage: focusMessage,
      message,
    },
  );

  if (boardElectionFocusedAnswer) {
    return finalizeSummary(boardElectionFocusedAnswer);
  }

  if (shouldUseDirectStructuredLawDatabaseAnswer(answerInputSources, {
    ...options,
    originalMessage: message,
    message: focusMessage,
  })) {
    if (options.answerDiagnostics && typeof options.answerDiagnostics === "object") {
      options.answerDiagnostics.answerMode = "db_only";
    }
    return buildFallbackSummary(answerInputSources, explainMode, {
      ...options,
      amountMode,
      decisionMode,
      stepMode: stepMode || String(topicFamily?.answerStyle || "").toLowerCase() === "steps",
      databaseOnlyMode: true,
      promptProfile,
      originalMessage: message,
      focusMessage,
      topicFamily,
    });
  }

  if (
    promptProfile.preferDatabaseOnlyForLawSections === true &&
    options.questionIntent === "law_section" &&
    focusedAnswerSources.some((item) => item && (item.source === "tbl_laws" || item.source === "tbl_glaws"))
  ) {
    return finalizeSummary(buildFallbackSummary(answerInputSources, explainMode, {
      ...options,
      amountMode,
      decisionMode,
      stepMode: stepMode || String(topicFamily?.answerStyle || "").toLowerCase() === "steps",
      databaseOnlyMode: true,
      promptProfile,
      originalMessage: message,
      focusMessage,
      topicFamily,
    }));
  }

  if (options.forceFallback || databaseOnlyMode || effectiveSources.length === 0) {
    return finalizeSummary(buildFallbackSummary(answerInputSources, explainMode, {
      ...options,
      amountMode,
      decisionMode,
      stepMode: stepMode || String(topicFamily?.answerStyle || "").toLowerCase() === "steps",
      databaseOnlyMode,
      promptProfile,
      originalMessage: message,
      focusMessage,
      topicFamily,
    }));
  }

  const conciseLineBudget = getSummaryShapeOptions({ ...options, promptProfile }, false).summaryContentLimit;
  const explainLineBudget = getSummaryShapeOptions({ ...options, promptProfile }, true);

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
  const deepAnalysisInstruction = promptProfile.allowDeepAnalysis
    ? "หากข้อมูลหลายแหล่งพูดถึงเงื่อนไข ข้อยกเว้น หรือผลทางกฎหมายต่างกัน ให้แยกอธิบายเป็นประเด็นและชี้ให้เห็นภาพรวมเชิงวิเคราะห์อย่างเป็นระบบ "
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
  const overviewGroundingInstruction =
    isOverviewGroundingQuery(focusMessage) && !hasExplicitLegalGroundingIntent(focusMessage)
      ? "คำถามนี้เป็นคำถามภาพรวม/นิยาม/ประโยชน์ ให้ตอบเฉพาะความหมาย ภาพรวม หรือประโยชน์ที่ตรงคำถามเท่านั้น หากแหล่งอ้างอิงบางส่วนเป็นบทกฎหมาย รายมาตรา หรืออำนาจหน้าที่ของนายทะเบียน แต่ผู้ใช้ไม่ได้ถามเชิงกฎหมาย ห้ามนำประเด็นนั้นมาปนในคำตอบ "
      : "";
  const instruction = explainMode
    ? `อ่านและพิจารณาข้อมูลจากทุกแหล่งที่ให้มาครบถ้วน แล้วอธิบายจากข้อมูลที่มีอยู่ให้มากที่สุดก่อน โดยไม่ตัดสาระสำคัญทิ้ง ${planToneInstruction}${depthInstruction}${compareInstruction}${deepAnalysisInstruction}${continuationInstruction}ใช้ภาษาไทยสุภาพแบบราชการ ห้ามเดาข้อมูลนอกแหล่งอ้างอิง ${amountInstruction} ${decisionInstruction} ${lawSectionInstruction}${overviewGroundingInstruction}${metadataExclusionInstruction}ให้ตอบเป็น plain text เท่านั้น โดยขึ้นต้นด้วย 'สรุปสาระสำคัญ:' แล้วตามด้วยข้อความสั้น ๆ แยกคนละบรรทัดไม่เกิน ${explainLineBudget.summaryContentLimit} บรรทัด และย่อหน้าถัดไปขึ้นต้นด้วย 'รายละเอียดเพิ่มเติม:' แล้วตามด้วยข้อความสั้น ๆ แยกคนละบรรทัดไม่เกิน ${explainLineBudget.detailLimit} บรรทัด ห้ามใช้ markdown heading หากเป็นคำถามต่อเนื่อง ให้ตอบเสมือนเป็นบทสนทนาในเรื่องเดิมต่อเนื่องกัน โดยยังคงถ้อยคำทางราชการ และหลีกเลี่ยงคำลงท้ายแบบภาษาพูด`
    : `อ่านและพิจารณาข้อมูลจากทุกแหล่งที่ให้มาครบถ้วน แล้วสรุปรวมกันเป็นคำตอบภาษาไทยที่ตรงประเด็น ${planToneInstruction}${depthInstruction}${compareInstruction}${deepAnalysisInstruction}พร้อมใช้ภาษาราชการที่สุภาพ ห้ามเดาข้อมูลนอกแหล่งอ้างอิง ${amountInstruction} ${decisionInstruction} ${lawSectionInstruction}${overviewGroundingInstruction}${metadataExclusionInstruction}ให้ตอบเป็น plain text เท่านั้น โดยขึ้นต้นด้วย 'สรุปสาระสำคัญ:' แล้วตามด้วยข้อความสั้น ๆ ไม่เกิน ${conciseLineBudget} บรรทัด โดยต้องเก็บใจความสำคัญทั้งหมดที่จำเป็นต่อการตัดสินใจ ห้ามเปิดหัวข้อ 'รายละเอียดเพิ่มเติม:' เองในรอบแรก ห้ามใช้ markdown heading หากเป็นคำถามต่อเนื่อง ให้ตอบเสมือนเป็นบทสนทนาในเรื่องเดิมต่อเนื่องกัน โดยยังคงถ้อยคำทางราชการ และหลีกเลี่ยงคำลงท้ายแบบภาษาพูด`;

  try {
    const conversationNote = options.conversationalFollowUp
      ? `\nบริบทก่อนหน้า: คำถามนี้เป็นคำถามต่อเนื่องเกี่ยวกับหัวข้อ "${options.topicLabel || "เรื่องเดิม"}"`
      : "";
    const responseText = await generateOpenAiCompletion({
      model: promptProfile.aiModel || undefined,
      systemInstruction: instruction,
      conversationHistory: Array.isArray(options.conversationHistory) ? options.conversationHistory : [],
      contents: `คำถามผู้ใช้: ${message}${conversationNote}\n\nข้อมูลอ้างอิง:\n${buildSourceContext(effectiveSources, { promptProfile })}`,
      timeoutMs: options.aiTimeoutMs,
      maxTokens: Number(explainMode ? promptProfile.aiMaxOutputTokens || 0 : promptProfile.conciseAiMaxOutputTokens || promptProfile.aiMaxOutputTokens || 0),
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
    if (!normalized || !hasMeaningfulSummaryContent(normalized, effectiveSources, {
      ...options,
      amountMode,
      decisionMode,
      originalMessage: message,
      focusMessage,
    })) {
      return finalizeSummary(buildFallbackSummary(answerInputSources, explainMode, {
        ...options,
        amountMode,
        decisionMode,
        stepMode: stepMode || String(topicFamily?.answerStyle || "").toLowerCase() === "steps",
        promptProfile,
        originalMessage: message,
        focusMessage,
        topicFamily,
      }));
    }
    return finalizeSummary([
      normalized,
      buildReferenceSection(
        effectiveSources.length > 0 ? effectiveSources : answerInputSources,
        Math.max(1, Number(promptProfile.referenceLimit || 5)),
      ),
    ].join("\n\n"));
  } catch (error) {
    return finalizeSummary(buildFallbackSummary(answerInputSources, explainMode, {
      ...options,
      amountMode,
      decisionMode,
      stepMode: stepMode || String(topicFamily?.answerStyle || "").toLowerCase() === "steps",
      promptProfile,
      originalMessage: message,
      focusMessage,
      topicFamily,
    }));
  }
}

function isMeetingQuorumQuestion(message) {
  const text = normalizeForSearch(String(message || "")).toLowerCase();
  if (!text) {
    return false;
  }

  return /(องค์ประชุม|ครบองค์ประชุม|ไม่ครบองค์ประชุม|กึ่งหนึ่ง|100 คน|หนึ่งร้อยคน|มาตรา 57|มาตรา 58)/.test(text);
}

function buildMeetingQuorumFocusedAnswer(sources, options = {}) {
  const message = String(options.originalMessage || options.message || "").trim();
  if (!isMeetingQuorumQuestion(message)) {
    return "";
  }

  const candidateSources = dedupeSources(sources, 10);
  let selectedEvidence = null;

  for (const source of candidateSources) {
    const segments = splitContentSegments(buildSourceRawContentText(source));
    
    for (let index = 0; index < segments.length; index += 1) {
      const first = cleanLine(segments[index]);
      const second = cleanLine(segments[index + 1] || "");
      
      if (first && second) {
        const combined = cleanLine(`${first} ${second}`);
        if (/(องค์ประชุม|ครบองค์ประชุม|ไม่ครบองค์ประชุม|กึ่งหนึ่ง|100 คน|หนึ่งร้อยคน|มาตรา 57|มาตรา 58)/.test(combined)) {
          selectedEvidence = {
            text: combined,
            source,
            score: Number(source.score || 0) + 20,
          };
          break;
        }
      }
    }
    
    if (selectedEvidence) break;
  }

  if (!selectedEvidence) {
    return "";
  }

  return [
    buildParagraphSummary(
      ["การประชุมใหญ่ต้องมีองค์ประชุมครบกึ่งหนึ่งของสมาชิกที่มีสิทธิลงคะแนนเสียง แต่ไม่น้อยกว่าหนึ่งร้อยคน"],
      [],
      false,
      { summaryLimit: 1 },
    ),
    buildReferenceSection([selectedEvidence.source], 1),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function isBoardElectionQuestion(message) {
  const text = normalizeForSearch(String(message || "")).toLowerCase();
  if (!text) {
    return false;
  }

  return /(เลือกตั้ง|สรรหา|คณะกรรมการ|กรรมการ|ลงคะแนน|เปิดหีบ|ปิดหีบ|มาตรา 56)/.test(text);
}

function buildBoardElectionFocusedAnswer(sources, options = {}) {
  const message = String(options.originalMessage || options.message || "").trim();
  if (!isBoardElectionQuestion(message)) {
    return "";
  }

  const candidateSources = dedupeSources(sources, 10);
  let selectedEvidence = null;

  for (const source of candidateSources) {
    const segments = splitContentSegments(buildSourceRawContentText(source));
    
    for (let index = 0; index < segments.length; index += 1) {
      const first = cleanLine(segments[index]);
      const second = cleanLine(segments[index + 1] || "");
      
      if (first && second) {
        const combined = cleanLine(`${first} ${second}`);
        if (/(เลือกตั้ง|สรรหา|คณะกรรมการ|กรรมการ|ลงคะแนน|เปิดหีบ|ปิดหีบ|มาตรา 56)/.test(combined)) {
          selectedEvidence = {
            text: combined,
            source,
            score: Number(source.score || 0) + 20,
          };
          break;
        }
      }
    }
    
    if (selectedEvidence) break;
  }

  if (!selectedEvidence) {
    return "";
  }

  return [
    buildParagraphSummary(
      ["คณะกรรมการดำเนินการของสหกรณ์มาจากการเลือกตั้งโดยที่ประชุมใหญ่ ตามหลักเกณฑ์และวิธีการที่กฎหมายกำหนด"],
      [],
      false,
      { summaryLimit: 1 },
    ),
    buildReferenceSection([selectedEvidence.source], 1),
  ]
    .filter(Boolean)
    .join("\n\n");
}

module.exports = {
  generateChatSummary,
  wantsExplanation,
  SOURCE_LABELS,
};
