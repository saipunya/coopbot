const LawChatbotModel = require("../models/lawChatbotModel");
const LawChatbotFeedbackModel = require("../models/lawChatbotFeedbackModel");
const LawChatbotKnowledgeModel = require("../models/lawChatbotKnowledgeModel");
const LawChatbotKnowledgeSuggestionModel = require("../models/lawChatbotKnowledgeSuggestionModel");
const LawChatbotPdfChunkModel = require("../models/lawChatbotPdfChunkModel");
const LawSearchModel = require("../models/lawSearchModel");
const { wantsExplanation } = require("./chatAnswerService");
const { isStandaloneLawLookup } = require("./contextService");
const { parseThaiDateToIso } = require("./documentMetadataService");
const { normalizePlanCode } = require("./planService");
const {
  getQueryFocusProfile,
  normalizeForSearch,
  scoreQueryFocusAlignment,
  uniqueTokens,
} = require("./thaiTextUtils");

const HYBRID_SEARCH_TIMEOUT_MS = Number(process.env.LAW_CHATBOT_HYBRID_SEARCH_TIMEOUT_MS || 4000);

async function withTimeout(task, timeoutMs, fallbackValue, label = "task") {
  const normalizedTimeoutMs = Number(timeoutMs || 0);
  if (!Number.isFinite(normalizedTimeoutMs) || normalizedTimeoutMs <= 0) {
    return typeof task === "function" ? task() : task;
  }

  let timeoutId = null;
  let timedOut = false;

  try {
    return await Promise.race([
      Promise.resolve().then(() => (typeof task === "function" ? task() : task)),
      new Promise((resolve) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          resolve(fallbackValue);
        }, normalizedTimeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    if (timedOut && process.env.CHATBOT_DEBUG === "1") {
      console.warn(`[law-chatbot] ${label} reached timeout budget ${normalizedTimeoutMs}ms`);
    }
  }
}

function prioritizeMatches(matches, options = {}) {
  const retrievalPriority = Number(options.retrievalPriority || 0);
  const scoreBoost = Number(options.scoreBoost || 0);
  const sourceOverride = options.sourceOverride || "";

  return (Array.isArray(matches) ? matches : []).map((item) => ({
    ...item,
    source: sourceOverride || item.source,
    retrievalPriority,
    rawScore: Number(item.rawScore ?? item.baseScore ?? item.score ?? 0) + scoreBoost,
    score: Number(item.rawScore ?? item.baseScore ?? item.score ?? 0) + scoreBoost,
  }));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getMatchBaseScore(item = {}) {
  return Number(item.rawScore ?? item.baseScore ?? item.score ?? 0);
}

function parseSourceTimestamp(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  const text = String(value).trim();
  if (!text) {
    return null;
  }

  const directTimestamp = Date.parse(text);
  if (Number.isFinite(directTimestamp)) {
    return directTimestamp;
  }

  const thaiIsoDate = parseThaiDateToIso(text);
  if (thaiIsoDate) {
    const thaiTimestamp = Date.parse(thaiIsoDate);
    if (Number.isFinite(thaiTimestamp)) {
      return thaiTimestamp;
    }
  }

  const normalizedDigits = normalizeLawFocusDigits(text);
  const yearMatch = normalizedDigits.match(/\b(25\d{2}|20\d{2}|19\d{2})\b/);
  if (!yearMatch?.[1]) {
    return null;
  }

  let year = Number(yearMatch[1]);
  if (year > 2400) {
    year -= 543;
  }

  return Number.isFinite(year) ? Date.UTC(year, 0, 1) : null;
}

function resolveSourceTimestamp(item = {}) {
  const candidates = [
    item.documentDate,
    item.document_date,
    item.updatedAt,
    item.updated_at,
    item.createdAt,
    item.created_at,
    item.reviewedAt,
    item.reviewed_at,
    item.documentDateText,
    item.document_date_text,
  ];

  for (const candidate of candidates) {
    const timestamp = parseSourceTimestamp(candidate);
    if (Number.isFinite(timestamp)) {
      return timestamp;
    }
  }

  return null;
}

function extractRequestedLawReferences(message = "") {
  const normalizedMessage = normalizeLawFocusDigits(normalizeForSearch(String(message || ""))).toLowerCase();
  if (!normalizedMessage) {
    return [];
  }

  const references = [];
  const matcher = /(?:มาตรา|ข้อ|วรรค|อนุมาตรา)\s*([0-9]+(?:\/[0-9]+)?)/g;
  let match = matcher.exec(normalizedMessage);
  while (match) {
    if (match[1]) {
      references.push(match[1]);
    }
    match = matcher.exec(normalizedMessage);
  }

  return uniqueTokens(references.filter(Boolean));
}

function getSourceAuthorityTrace(item = {}, intent = "general", message = "") {
  const sourceName = String(item.source || "").trim().toLowerCase();
  let score = 0;
  let reason = "";

  const baseWeights = {
    admin_knowledge: 12,
    knowledge_suggestion: 11,
    tbl_vinichai: 10,
    tbl_laws: 9,
    tbl_glaws: 8,
    documents: 5,
    pdf_chunks: 4,
    knowledge_base: 1,
  };

  score += Number(baseWeights[sourceName] || 0);

  if (intent === "law_section") {
    if (sourceName === "tbl_laws" || sourceName === "tbl_glaws") {
      score += 8;
      reason = "structured law source";
    } else if (sourceName === "tbl_vinichai") {
      score += 2;
    } else if (sourceName === "documents" || sourceName === "pdf_chunks") {
      score -= 1;
    }
  } else if (intent === "qa") {
    if (sourceName === "admin_knowledge") {
      score += 9;
      reason = "prepared knowledge source";
    } else if (sourceName === "knowledge_suggestion") {
      score += 7;
      reason = "approved suggested knowledge source";
    } else if (sourceName === "tbl_vinichai") {
      score += 4;
      reason = "vinichai support source";
    }
  } else if (intent === "document") {
    if (sourceName === "documents" || sourceName === "pdf_chunks") {
      score += 7;
      reason = "document source";
    } else if (sourceName === "tbl_laws" || sourceName === "tbl_glaws") {
      score += 1;
    }
  } else if (intent === "explain") {
    if (sourceName === "tbl_laws" || sourceName === "tbl_glaws") {
      score += 5;
      reason = "authoritative source";
    } else if (sourceName === "admin_knowledge") {
      score += 4;
    } else if (sourceName === "documents" || sourceName === "pdf_chunks") {
      score += 3;
    }
  }

  if (!reason && (sourceName === "tbl_laws" || sourceName === "tbl_glaws")) {
    reason = "authoritative source";
  }

  if (!reason && isClearlyCurrentOrExternalQuestion(message) && (sourceName === "documents" || sourceName === "pdf_chunks")) {
    reason = "supports current reference";
  }

  return {
    score,
    reason,
  };
}

function getSectionMatchTrace(item = {}, message = "", intent = "general") {
  const requestedReferences = extractRequestedLawReferences(message);
  const sourceText = normalizeLawFocusDigits(buildSourceFocusSearchText(item));
  const sourceLawNumber = normalizeLawFocusDigits(extractPrimaryLawFocusNumber(item));
  let score = 0;
  let matchedReference = "";

  if (requestedReferences.length > 0) {
    const exactNumberMatch =
      sourceLawNumber &&
      requestedReferences.some((reference) => reference === sourceLawNumber);

    if (exactNumberMatch) {
      score += 18;
      matchedReference = sourceLawNumber;
    } else {
      const textMatch = requestedReferences.find((reference) =>
        sourceText.includes(`มาตรา ${reference}`) ||
        sourceText.includes(`ข้อ ${reference}`) ||
        sourceText.includes(`วรรค ${reference}`) ||
        sourceText.includes(`อนุมาตรา ${reference}`),
      );

      if (textMatch) {
        score += 12;
        matchedReference = textMatch;
      } else if (intent === "law_section" && sourceLawNumber) {
        score -= 6;
      }
    }
  } else if (intent === "law_section" && sourceLawNumber) {
    score += 4;
  }

  return {
    score,
    matchedReference,
    requestedReferences: requestedReferences.slice(0, 4),
  };
}

function getGroupBylawStructuredLawFocusBoost(message = "", item = {}) {
  const sourceName = String(item.source || "").trim().toLowerCase();
  if (sourceName !== "tbl_glaws") {
    return 0;
  }

  const normalizedMessage = normalizeForSearch(String(message || "")).toLowerCase();
  if (!normalizedMessage || !/ข้อบังคับ/.test(normalizedMessage) || !/กลุ่มเกษตรกร/.test(normalizedMessage)) {
    return 0;
  }

  const sourceText = buildSourceFocusSearchText(item);
  if (!sourceText || !/ข้อบังคับ/.test(sourceText)) {
    return 0;
  }

  let boost = 26;

  if (
    /(อย่างน้อยต้องมีรายการ|ต้องมีรายการ|ต้องระบุ|ชื่อ|วัตถุประสงค์|ที่ตั้งสำนักงาน|ทุนซึ่งแบ่งเป็นหุ้น|การประชุมใหญ่|ผู้ตรวจสอบกิจการ|ผู้จัดการ|สมาชิกภาพ)/.test(
      sourceText,
    )
  ) {
    boost += 14;
  }

  if (/(มาตรา 8|มาตรา8|ข้อ 8|ข้อ8)/.test(sourceText)) {
    boost += 6;
  }

  return boost;
}

function getSourceAwareFocusScore(message = "", item = {}) {
  const baseFocusScore = Number(scoreQueryFocusAlignment(message, buildSourceFocusSearchText(item)) || 0);
  return baseFocusScore + getGroupBylawStructuredLawFocusBoost(message, item);
}

function getFocusAlignmentTrace(item = {}, message = "") {
  const rawFocusScore = Number(getSourceAwareFocusScore(message, item) || 0);
  return {
    rawFocusScore,
    score: Math.round(clamp(rawFocusScore, -20, 60) * 0.18),
  };
}

function getFreshnessNormalizationProfile(sourceName = "", currentBias = false) {
  switch (sourceName) {
    case "documents":
    case "pdf_chunks":
      return {
        label: currentBias ? "document_recency_high" : "document_recency_medium",
        positiveScores: currentBias ? [10, 8, 6, 3] : [5, 4, 3, 1],
        stalePenalty: currentBias ? -4 : -1,
        missingDatePenalty: currentBias ? -1 : 0,
      };
    case "internet_search":
      return {
        label: currentBias ? "public_recency_medium" : "public_recency_light",
        positiveScores: currentBias ? [8, 6, 4, 2] : [4, 3, 2, 1],
        stalePenalty: currentBias ? -3 : -1,
        missingDatePenalty: currentBias ? -1 : 0,
      };
    case "admin_knowledge":
    case "knowledge_suggestion":
      return {
        label: currentBias ? "managed_content_medium" : "managed_content_light",
        positiveScores: currentBias ? [6, 5, 3, 1] : [3, 2, 1, 0],
        stalePenalty: currentBias ? -1 : 0,
        missingDatePenalty: 0,
      };
    case "tbl_laws":
    case "tbl_glaws":
    case "tbl_vinichai":
      return {
        label: "authoritative_static",
        positiveScores: [0, 0, 0, 0],
        stalePenalty: 0,
        missingDatePenalty: 0,
      };
    default:
      return {
        label: "generic_light",
        positiveScores: currentBias ? [4, 3, 2, 1] : [2, 1, 1, 0],
        stalePenalty: currentBias ? -1 : 0,
        missingDatePenalty: 0,
      };
  }
}

function getFreshnessTrace(item = {}, message = "", intent = "general") {
  const sourceName = String(item.source || "").trim().toLowerCase();
  const timestamp = resolveSourceTimestamp(item);
  const currentBias =
    intent === "document" ||
    intent === "short_answer" ||
    isClearlyCurrentOrExternalQuestion(message);
  const profile = getFreshnessNormalizationProfile(sourceName, currentBias);

  if (!Number.isFinite(timestamp)) {
    return {
      score: Number(profile.missingDatePenalty || 0),
      sourceDate: "",
      ageDays: null,
      normalization: profile.label,
    };
  }

  const ageDays = Math.max(0, Math.round((Date.now() - timestamp) / (24 * 60 * 60 * 1000)));
  let score = Number(profile.stalePenalty || 0);

  if (ageDays <= 30) {
    score = Number(profile.positiveScores[0] || 0);
  } else if (ageDays <= 180) {
    score = Number(profile.positiveScores[1] || 0);
  } else if (ageDays <= 365) {
    score = Number(profile.positiveScores[2] || 0);
  } else if (ageDays <= 1095) {
    score = Number(profile.positiveScores[3] || 0);
  }

  return {
    score,
    sourceDate: new Date(timestamp).toISOString().slice(0, 10),
    ageDays,
    normalization: profile.label,
  };
}

function buildRerankReasons({
  retrievalWeight,
  authorityTrace,
  sectionTrace,
  focusTrace,
  freshnessTrace,
  helpfulBoost,
  item,
}) {
  const reasons = [];

  if (Number(retrievalWeight || 0) >= 8) {
    reasons.push("high-priority retrieval bucket");
  } else if (Number(retrievalWeight || 0) >= 4) {
    reasons.push("preferred source bucket");
  }

  if (authorityTrace?.reason) {
    reasons.push(authorityTrace.reason);
  }

  if (sectionTrace?.matchedReference) {
    reasons.push(`matched section ${sectionTrace.matchedReference}`);
  }

  if (Number(focusTrace?.rawFocusScore || 0) >= 44) {
    reasons.push("strong topic alignment");
  } else if (Number(focusTrace?.rawFocusScore || 0) >= 24) {
    reasons.push("good topic alignment");
  }

  if (Number(freshnessTrace?.score || 0) > 0 && freshnessTrace?.sourceDate) {
    reasons.push(`fresh source (${freshnessTrace.sourceDate})`);
  }

  if (Number(helpfulBoost || 0) > 0) {
    reasons.push("boosted by prior helpful feedback");
  }

  if (item?.contextCarry) {
    reasons.push("conversation context carry-over");
  }

  return reasons.slice(0, 5);
}

function getReadableQuestionContext(message = "", intent = "general") {
  const focusProfile = getQueryFocusProfile(message);
  const primaryTopic = focusProfile.topics[0]?.primary || "";
  if (primaryTopic) {
    return `คำถามเกี่ยวกับ${primaryTopic}`;
  }

  switch (intent) {
    case "law_section":
      return "คำถามหามาตรากฎหมาย";
    case "qa":
      return "คำถามเชิงแนววินิจฉัย";
    case "document":
      return "คำถามเชิงเอกสาร";
    case "explain":
      return "คำถามเชิงอธิบาย";
    default:
      return "คำถามเกี่ยวกับสหกรณ์";
  }
}

function getReadableAuthorityPhrase(item = {}, intent = "general") {
  const sourceName = String(item.source || "").trim().toLowerCase();
  switch (sourceName) {
    case "tbl_laws":
    case "tbl_glaws":
      return intent === "law_section" ? "แหล่งกฎหมายหลัก" : "แหล่งกฎหมายที่น่าเชื่อถือ";
    case "tbl_vinichai":
      return "แหล่งแนววินิจฉัยที่ตรงประเด็น";
    case "admin_knowledge":
      return "ฐานความรู้ที่ผู้ดูแลคัดไว้";
    case "knowledge_suggestion":
      return "คำตอบที่ผ่านการอนุมัติแล้ว";
    case "documents":
    case "pdf_chunks":
      return "เอกสารอ้างอิงที่เกี่ยวข้อง";
    case "internet_search":
      return "แหล่งข้อมูลสาธารณะที่ช่วยเสริม";
    default:
      return "คะแนนรวมเหมาะกับคำถาม";
  }
}

function buildSourceCandidateKey(item = {}) {
  return [
    normalizeSourceIdentityText(item.source || ""),
    normalizeSourceIdentityText(item.id || ""),
    normalizeSourceIdentityText(item.reference || ""),
    normalizeSourceIdentityText(item.title || ""),
    normalizeSourceIdentityText(item.url || ""),
  ].join("::");
}

function isSameCandidate(left, right) {
  if (!left || !right) {
    return false;
  }

  const leftKey = buildSourceCandidateKey(left);
  const rightKey = buildSourceCandidateKey(right);
  if (leftKey && rightKey && leftKey === rightKey) {
    return true;
  }

  return areNearDuplicateSources(left, right);
}

function buildSelectedBecauseText(item = {}, message = "", intent = "general") {
  const rankingTrace = item.rankingTrace || {};
  const reasons = [];

  if (rankingTrace.matchedReference) {
    reasons.push("ตรงมาตรา");
  }

  if (Number(rankingTrace.authorityScore || 0) > 0) {
    reasons.push(getReadableAuthorityPhrase(item, intent));
  }

  if (Number(rankingTrace.focusAlignmentRaw || 0) >= 24) {
    reasons.push(getReadableQuestionContext(message, intent));
  }

  if (Number(rankingTrace.freshnessScore || 0) >= 6) {
    reasons.push("ข้อมูลค่อนข้างใหม่");
  }

  if (item.contextCarry) {
    reasons.push("ต่อเนื่องจากคำถามก่อนหน้า");
  }

  if (reasons.length === 0) {
    reasons.push("คะแนนรวมชนะ source อื่น");
  }

  return `selected because: "${reasons.slice(0, 3).join(" + ")}"`;
}

function buildRejectedBecauseText(item = {}, selectedSources = [], message = "", intent = "general") {
  const rankingTrace = item.rankingTrace || {};
  const reasons = [];
  const strongerDuplicate = selectedSources.find((selected) => isSameCandidate(selected, item));
  const strongerSameSource = selectedSources
    .filter((selected) => String(selected?.source || "").trim().toLowerCase() === String(item.source || "").trim().toLowerCase())
    .sort((left, right) => Number(right?.score || 0) - Number(left?.score || 0))[0];
  const hasMoreAuthoritativeWinner = selectedSources.some((selected) =>
    ["tbl_laws", "tbl_glaws", "tbl_vinichai", "admin_knowledge"].includes(String(selected?.source || "").trim().toLowerCase()),
  );

  if (strongerDuplicate) {
    reasons.push("ซ้ำกับ source ที่ดีกว่า");
  }

  if (Number(rankingTrace.focusAlignmentRaw || 0) > 0 && Number(rankingTrace.focusAlignmentRaw || 0) < 18) {
    reasons.push("focus score ต่ำ");
  }

  if (Number(rankingTrace.freshnessScore || 0) < 0) {
    reasons.push("document เก่าเมื่อเทียบกับคำถาม");
  }

  if (
    strongerSameSource &&
    Number(strongerSameSource.score || 0) >= Number(item.score || 0) + 8 &&
    !isSameCandidate(strongerSameSource, item)
  ) {
    reasons.push("คะแนนรวมสู้ source ที่ชนะในกลุ่มเดียวกันไม่ได้");
  }

  if (
    reasons.length === 0 &&
    hasMoreAuthoritativeWinner &&
    ["documents", "pdf_chunks", "knowledge_base", "knowledge_suggestion"].includes(String(item.source || "").trim().toLowerCase())
  ) {
    reasons.push("มี source ที่น่าเชื่อถือกว่าชนะอยู่แล้ว");
  }

  if (reasons.length === 0) {
    reasons.push("คะแนนรวมต่ำกว่า source ที่ถูกเลือก");
  }

  return `rejected because: "${reasons.slice(0, 3).join(" / ")}"`;
}

function buildSelectionDiagnostics(groups, selectedSources, intent = "general", options = {}) {
  const focusMessage = String(options.originalMessage || options.message || "").trim();
  const allCandidates = sortByScore(
    dedupeSourcesConservatively([
      ...(groups.structured_laws || []),
      ...(groups.admin_knowledge || []),
      ...(groups.knowledge_suggestion || []),
      ...(groups.vinichai || []),
      ...(groups.documents || []),
      ...(groups.pdf_chunks || []),
      ...(groups.internet || []),
      ...(groups.knowledge_base || []),
    ]),
  );
  const selected = (Array.isArray(selectedSources) ? selectedSources : []).map((item) => ({
    source: item.source || "",
    reference: item.reference || item.title || "",
    score: Number(item.score || 0),
    selectedBecause: buildSelectedBecauseText(item, focusMessage, intent),
  }));
  const rejected = allCandidates
    .filter((item) => !selectedSources.some((selectedItem) => isSameCandidate(selectedItem, item)))
    .slice(0, 8)
    .map((item) => ({
      source: item.source || "",
      reference: item.reference || item.title || "",
      score: Number(item.score || 0),
      rejectedBecause: buildRejectedBecauseText(item, selectedSources, focusMessage, intent),
    }));

  return {
    selected,
    rejected,
  };
}

function rerankRetrievedMatches(matches, message, options = {}) {
  const intent = options.intent || "general";
  const feedbackTarget = options.target || "all";

  return (Array.isArray(matches) ? matches : [])
    .filter(Boolean)
    .map((item) => {
      const baseScore = getMatchBaseScore(item);
      const retrievalWeight = Math.round(Number(item.retrievalPriority || 0) * 1.2);
      const authorityTrace = getSourceAuthorityTrace(item, intent, message);
      const sectionTrace = getSectionMatchTrace(item, message, intent);
      
      const focusTrace = getFocusAlignmentTrace(item, message);
      const freshnessTrace = getFreshnessTrace(item, message, intent);
      const contextWeight = item.contextCarry ? 6 : 0;
      const helpfulFeedbackProfile = LawChatbotFeedbackModel.getHelpfulBoostProfile(
        message,
        feedbackTarget,
        item.source || "",
      );
      const helpfulBoost = Number(helpfulFeedbackProfile?.boost || 0);
      const offTopicPenalty =
  ["documents", "pdf_chunks", "knowledge_base"].includes(String(item.source || "").trim().toLowerCase()) &&
  Number(focusTrace.rawFocusScore || 0) < 18
    ? -18
    : 0;
      const finalScore = Math.round(
  baseScore +
  retrievalWeight +
  Number(authorityTrace.score || 0) +
  Number(sectionTrace.score || 0) +
  Number(focusTrace.score || 0) +
  Number(freshnessTrace.score || 0) +
  helpfulBoost +
  contextWeight +
  offTopicPenalty,
);

      return {
        ...item,
        rawScore: baseScore,
        score: finalScore,
        rankingTrace: {
          baseScore,
          finalScore,
          offTopicPenalty,
          retrievalPriority: Number(item.retrievalPriority || 0),
          retrievalWeight,
          authorityScore: Number(authorityTrace.score || 0),
          sectionScore: Number(sectionTrace.score || 0),
          focusScore: Number(focusTrace.score || 0),
          focusAlignmentRaw: Number(focusTrace.rawFocusScore || 0),
          freshnessScore: Number(freshnessTrace.score || 0),
          helpfulBoost,
          helpfulFeedbackHelpfulMatches: Number(helpfulFeedbackProfile?.helpfulMatches || 0),
          helpfulFeedbackHarmfulMatches: Number(helpfulFeedbackProfile?.harmfulMatches || 0),
          contextWeight,
          matchedReference: sectionTrace.matchedReference || "",
          sourceDate: freshnessTrace.sourceDate || "",
          ageDays: freshnessTrace.ageDays,
          freshnessNormalization: freshnessTrace.normalization || "",
          reasons: buildRerankReasons({
            retrievalWeight,
            authorityTrace,
            sectionTrace,
            focusTrace,
            freshnessTrace,
            helpfulBoost,
            item,
          }),
        },
      };
    })
    .sort((left, right) => {
      const scoreDiff = Number(right.score || 0) - Number(left.score || 0);
      if (scoreDiff !== 0) {
        return scoreDiff;
      }

      return Number(getMatchBaseScore(right) || 0) - Number(getMatchBaseScore(left) || 0);
    });
}

function isCompensationGovernanceQuestion(message) {
  const normalized = normalizeForSearch(String(message || "")).toLowerCase();
  if (!normalized) {
    return false;
  }

  const asksBonus = /โบนัส|เงินโบนัส/.test(normalized) && /(กรรมการ|เจ้าหน้าที่)/.test(normalized);
  const asksCompensation =
    /ค่าตอบแทน/.test(normalized) &&
    /(กรรมการ|เจ้าหน้าที่|งบประมาณ|แผนงาน|มติที่ประชุมใหญ่|ส่วนได้ส่วนเสีย)/.test(normalized);
  const asksMeetingAllowance =
    /(เบี้ยประชุม|ค่าใช้จ่ายประชุม|ค่าใช้จ่ายในการประชุม|ประชุมสัมมนา|ค่าใช้จ่ายสัมมนา|ค่าตอบแทน)/.test(normalized) &&
    /(ผู้จัดการ|เจ้าหน้าที่|ฝ่ายจัดการ|ประชุมใหญ่|ประชุมคณะกรรมการ|ประชุมกรรมการ)/.test(normalized);

  return asksBonus || asksCompensation || asksMeetingAllowance;
}

function getCompensationGovernanceProfile(message) {
  const normalized = normalizeForSearch(String(message || "")).toLowerCase();
  return {
    asksBonus: /โบนัส|เงินโบนัส/.test(normalized) && /(กรรมการ|เจ้าหน้าที่)/.test(normalized),
    asksCompensation:
      /ค่าตอบแทน/.test(normalized) &&
      /(กรรมการ|เจ้าหน้าที่|งบประมาณ|แผนงาน|มติที่ประชุมใหญ่|ส่วนได้ส่วนเสีย)/.test(normalized),
    asksMeetingAllowance:
      /(เบี้ยประชุม|ค่าใช้จ่ายประชุม|ค่าใช้จ่ายในการประชุม|ประชุมสัมมนา|ค่าใช้จ่ายสัมมนา|ค่าตอบแทน)/.test(
        normalized,
      ) && /(ผู้จัดการ|เจ้าหน้าที่|ฝ่ายจัดการ|ประชุมใหญ่|ประชุมคณะกรรมการ|ประชุมกรรมการ)/.test(normalized),
  };
}

function classifyQuestionIntent(message) {
  const text = normalizeForSearch(String(message || "")).toLowerCase();
  const asksExplanation = wantsExplanation(text);

  const asksLawSection =
    /มาตรา\s*\d+|มาตรา|วรรค|อนุมาตรา|ข้อ\s*\d+/.test(text);
  const asksDocumentStyle =
    /กฎกระทรวง|ประกาศ|หนังสือเวียน|ข้อหารือ|หนังสือสั่งการ|หนังสือกรม|เอกสาร|ฉบับ/.test(text);
  const asksFeeOrAmountStyle =
    /ค่าบำรุง|สันนิบาต|อัตรา|ร้อยละ|เปอร์เซ็นต์|%|จำนวนเงิน|ต้องจ่าย|ชำระ|จ่าย/.test(text);
  const asksQaStyle =
    /แนววินิจฉัย|วินิจฉัย|ตีความ|ข้อหารือ|ถามตอบ|คำถามคำตอบ/.test(text);
  const asksShortAnswer =
    text.length <= 60 &&
    /คืออะไร|หมายถึง|เท่าไร|เท่าไหร่|กี่บาท|กี่เปอร์เซ็นต์|กี่ร้อยละ|เมื่อไร|เมื่อไหร่|ต้อง|ควร|ได้ไหม|ได้หรือไม่/.test(
      text,
    );
  const asksAbbreviationDefinition =
    text.length <= 40 &&
    /[ก-๙]{2,8}\.?\s*(คืออะไร|หมายถึง|คือ|หมายความว่าอะไร)/.test(text);

  if (asksLawSection) {
    return "law_section";
  }

  if (asksExplanation) {
    return "explain";
  }

  if (isDissolutionPrioritySearch(text) || isLiquidationPrioritySearch(text)) {
    return "law_section";
  }

  if (isCompensationGovernanceQuestion(text) || asksQaStyle) {
    return "qa";
  }

  if (asksDocumentStyle || asksFeeOrAmountStyle) {
    return "document";
  }

  if (asksAbbreviationDefinition || asksShortAnswer) {
    return "short_answer";
  }

  return "general";
}

function isLawPrioritySearch(message) {
  return /(มาตรา|ข้อ|วรรค|อนุมาตรา)/.test(normalizeForSearch(message).toLowerCase());
}

function isLiquidationPrioritySearch(message) {
  return /ชำระบัญชี|ผู้ชำระบัญชี/.test(normalizeForSearch(message).toLowerCase());
}

function isDissolutionPrioritySearch(message) {
  const normalized = normalizeForSearch(message).toLowerCase();
  if (!normalized) {
    return false;
  }

  return /(?:การเลิกสหกรณ์|เลิกสหกรณ์|สั่งเลิกสหกรณ์|สหกรณ์(?:ย่อม)?(?:ต้อง)?เลิก|การเลิกกลุ่มเกษตรกร|เลิกกลุ่มเกษตรกร|สั่งเลิกกลุ่มเกษตรกร|กลุ่มเกษตรกร(?:ย่อม)?(?:ต้อง)?เลิก|ยุบเลิกกลุ่มเกษตรกร)/.test(
    normalized,
  );
}

function isGroupStructuredLawSearch(message) {
  const normalized = normalizeForSearch(message).toLowerCase();
  if (!normalized) {
    return false;
  }

  return /กลุ่มเกษตรกร|พรฎ\.?\s*กลุ่มเกษตรกร|พระราชกฤษฎีกากลุ่มเกษตรกร|กฎหมายกลุ่มเกษตรกร/.test(
    normalized,
  );
}

function isCoopStructuredLawSearch(message) {
  const normalized = normalizeForSearch(message).toLowerCase();
  if (!normalized) {
    return false;
  }

  return /สหกรณ์|พรบ\.?\s*สหกรณ์|พระราชบัญญัติสหกรณ์|กฎหมายสหกรณ์/.test(normalized);
}

function getPreferredDissolutionLawNumberBonuses(message = "") {
  const mentionsGroupLaw = isGroupStructuredLawSearch(message);
  const mentionsCoopLaw = isCoopStructuredLawSearch(message);

  if (mentionsGroupLaw && !mentionsCoopLaw) {
    return {
      "32": 150,
      "33": 142,
      "34": 126,
    };
  }

  if (mentionsCoopLaw && !mentionsGroupLaw) {
    return {
      "70": 140,
      "71": 132,
      "89/3": 116,
    };
  }

  return {
    "70": 140,
    "71": 132,
    "89/3": 116,
    "32": 138,
    "33": 130,
    "34": 114,
  };
}

function hasExclusiveStructuredLawDomain(message = "", target = "all") {
  const normalizedTarget = String(target || "all").trim().toLowerCase();
  if (normalizedTarget === "group" || normalizedTarget === "coop") {
    return true;
  }

  const mentionsGroupLaw = isGroupStructuredLawSearch(message);
  const mentionsCoopLaw = isCoopStructuredLawSearch(message);
  return mentionsGroupLaw !== mentionsCoopLaw;
}

function isVinichaiPrioritySearch(message) {
  const normalized = normalizeForSearch(message).toLowerCase();
  if (!normalized) {
    return false;
  }

  return /แนววินิจฉัย|วินิจฉัย|ตีความ|ข้อหารือ|ถามตอบ|คำถามคำตอบ/.test(normalized) || isCompensationGovernanceQuestion(normalized);
}

function isFreePlanSearch(planCode = "") {
  return normalizePlanCode(planCode || "free") === "free";
}

function resolvePreferredStructuredLawSources(message, target = "all") {
  const normalizedMessage = normalizeForSearch(message).toLowerCase();
  const normalizedTarget = String(target || "all").trim().toLowerCase();
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

function getFreeSourcePriorityPlan(message, target = "all") {
  const { primaryLawSource, secondaryLawSource } = resolvePreferredStructuredLawSources(message, target);
  if (isVinichaiPrioritySearch(message)) {
    return {
      admin_knowledge: 12,
      knowledge_suggestion: 11,
      vinichai: 10,
      tbl_laws: 9,
      tbl_glaws: 8,
      documents: 2,
      pdf_chunks: 1,
      knowledge_base: 1,
    };
  }

  if (isLawPrioritySearch(message)) {
    return {
      tbl_laws: 12,
      tbl_glaws: 11,
      admin_knowledge: 10,
      knowledge_suggestion: 9,
      vinichai: 8,
      documents: 2,
      pdf_chunks: 1,
      knowledge_base: 1,
    };
  }

  if (isLiquidationPrioritySearch(message)) {
    return {
      admin_knowledge: 12,
      [primaryLawSource]: 10,
      knowledge_suggestion: 8,
      vinichai: 7,
      documents: 3,
      [secondaryLawSource]: 2,
      pdf_chunks: 1,
      knowledge_base: 1,
    };
  }

  if (isDissolutionPrioritySearch(message)) {
    return {
      [primaryLawSource]: 12,
      admin_knowledge: 6,
      vinichai: 0,
      knowledge_suggestion: 2,
      documents: 1,
      [secondaryLawSource]: 0,
      pdf_chunks: 0,
      knowledge_base: 0,
    };
  }

  return {
    admin_knowledge: 10,
    knowledge_suggestion: 9,
    vinichai: 8,
    tbl_laws: 7,
    tbl_glaws: 6,
    documents: 3,
    pdf_chunks: 1,
    knowledge_base: 1,
  };
}

function getSourceRoutingPlan(intent) {
  switch (intent) {
    case "explain":
      return {
        priorities: {
          admin_knowledge: 7,
          knowledge_suggestion: 6,
          vinichai: 5,
          structured_laws: 4,
          documents: 2,
          pdf_chunks: 1,
          knowledge_base: 1,
        },
        limits: {
          admin_knowledge: 2,
          knowledge_suggestion: 2,
          vinichai: 2,
          structured_laws: 4,
          documents: 1,
          pdf_chunks: 1,
          knowledge_base: 1,
        },
      };
    case "law_section":
      return {
        priorities: {
          structured_laws: 12,
          admin_knowledge: 10,
          knowledge_suggestion: 9,
          vinichai: 8,
          documents: 1,
          pdf_chunks: 0,
          knowledge_base: 1,
        },
        limits: {
          structured_laws: 4,
          admin_knowledge: 1,
          knowledge_suggestion: 1,
          vinichai: 1,
          documents: 0,
          pdf_chunks: 0,
          knowledge_base: 1,
        },
      };
    case "document":
      return {
        priorities: {
          admin_knowledge: 7,
          knowledge_suggestion: 6,
          vinichai: 5,
          structured_laws: 4,
          documents: 3,
          pdf_chunks: 2,
          knowledge_base: 1,
        },
        limits: {
          admin_knowledge: 2,
          knowledge_suggestion: 1,
          vinichai: 1,
          structured_laws: 2,
          documents: 2,
          pdf_chunks: 2,
          knowledge_base: 1,
        },
      };
    case "qa":
      return {
        priorities: {
          admin_knowledge: 10,
          knowledge_suggestion: 9,
          vinichai: 8,
          structured_laws: 7,
          documents: 0,
          pdf_chunks: 0,
          knowledge_base: 1,
        },
        limits: {
          admin_knowledge: 3,
          knowledge_suggestion: 2,
          vinichai: 2,
          structured_laws: 1,
          documents: 0,
          pdf_chunks: 0,
          knowledge_base: 1,
        },
      };
    case "short_answer":
      return {
        priorities: {
          admin_knowledge: 8,
          knowledge_suggestion: 7,
          structured_laws: 6,
          vinichai: 0,
          documents: 0,
          pdf_chunks: 0,
          knowledge_base: 1,
        },
        limits: {
          admin_knowledge: 3,
          knowledge_suggestion: 1,
          structured_laws: 2,
          vinichai: 0,
          documents: 0,
          pdf_chunks: 0,
          knowledge_base: 1,
        },
      };
    default:
      return {
        priorities: {
          admin_knowledge: 8,
          knowledge_suggestion: 7,
          vinichai: 6,
          structured_laws: 5,
          documents: 1,
          pdf_chunks: 1,
          knowledge_base: 1,
        },
        limits: {
          admin_knowledge: 2,
          knowledge_suggestion: 1,
          structured_laws: 3,
          vinichai: 2,
          documents: 1,
          pdf_chunks: 1,
          knowledge_base: 1,
        },
      };
  }
}

async function searchDatabaseSources(message, target, options = {}) {
  const retrievalMessage = String(message || "").trim();
  const focusMessage = String(options.originalMessage || retrievalMessage).trim();
  const intent = classifyQuestionIntent(retrievalMessage || focusMessage);
  const routingPlan = getSourceRoutingPlan(intent);
  const freePlanSearch = isFreePlanSearch(options.planCode);
  const freeSourcePriorityPlan = freePlanSearch ? getFreeSourcePriorityPlan(retrievalMessage || focusMessage, target) : null;
  const hybridTimeoutMs = Math.max(1000, Number(options.hybridTimeoutMs || HYBRID_SEARCH_TIMEOUT_MS));
  const lawPrioritySearch = isLawPrioritySearch(retrievalMessage || focusMessage);
  const prioritizeStructuredLawSearch =
    lawPrioritySearch ||
    isLiquidationPrioritySearch(retrievalMessage || focusMessage) ||
    isDissolutionPrioritySearch(retrievalMessage || focusMessage);

  const [
    rawKnowledgeMatches,
    rawSuggestionMatches,
    rawDocumentMatches,
    rawPdfMatches,
    rawFallbackKnowledge,
    rawStructuredMatches,
    rawVinichaiMatches,
  ] = await Promise.all([
    LawChatbotKnowledgeModel.searchKnowledge(retrievalMessage, target, 5),
    LawChatbotKnowledgeSuggestionModel.searchApproved(retrievalMessage, target, 5),
    LawChatbotPdfChunkModel.searchDocuments(retrievalMessage, 5),
    withTimeout(() => LawChatbotPdfChunkModel.hybridSearch(retrievalMessage, 6), hybridTimeoutMs, [], "hybrid-search"),
    Promise.resolve(LawChatbotModel.searchKnowledge(retrievalMessage, target)),
    LawSearchModel.searchStructuredLaws(retrievalMessage, target, 6),
    LawSearchModel.searchVinichai(retrievalMessage, 5),
  ]);

  const knowledgeMatches = prioritizeMatches(rawKnowledgeMatches, {
    retrievalPriority:
      freeSourcePriorityPlan?.admin_knowledge || routingPlan.priorities.admin_knowledge || 4,
    sourceOverride: "admin_knowledge",
  });
  const suggestionMatches = prioritizeMatches(rawSuggestionMatches, {
    retrievalPriority:
      freeSourcePriorityPlan?.knowledge_suggestion || routingPlan.priorities.knowledge_suggestion || 0,
    sourceOverride: "knowledge_suggestion",
  });
  const documentMatches = prioritizeMatches(rawDocumentMatches, {
    retrievalPriority: freeSourcePriorityPlan?.documents || routingPlan.priorities.documents || 3,
  });
  const pdfMatches = prioritizeMatches(rawPdfMatches, {
    retrievalPriority: freeSourcePriorityPlan?.pdf_chunks || routingPlan.priorities.pdf_chunks || 2,
  });
  const fallbackKnowledge = prioritizeMatches(rawFallbackKnowledge, {
    retrievalPriority: routingPlan.priorities.knowledge_base || 2,
    sourceOverride: "knowledge_base",
  });
  const vinichaiMatches = prioritizeMatches(rawVinichaiMatches, {
    retrievalPriority: freeSourcePriorityPlan?.vinichai || routingPlan.priorities.vinichai || 4,
  });
  const structuredLawBasePriority = routingPlan.priorities.structured_laws || 5;
  const tblLawsPriority =
    freeSourcePriorityPlan?.tbl_laws || structuredLawBasePriority + (lawPrioritySearch ? 2 : 0);
  const tblGlawsPriority =
    freeSourcePriorityPlan?.tbl_glaws || Math.max(0, structuredLawBasePriority + (lawPrioritySearch ? 1 : -1));
  const structuredMatches = [
    ...prioritizeMatches(
      rawStructuredMatches.filter((item) => item && item.source === "tbl_laws"),
      {
        retrievalPriority: tblLawsPriority,
        sourceOverride: "tbl_laws",
      },
    ),
    ...prioritizeMatches(
      rawStructuredMatches.filter((item) => item && item.source === "tbl_glaws"),
      {
        retrievalPriority: tblGlawsPriority,
        sourceOverride: "tbl_glaws",
      },
    ),
  ];

  const combinedMatches = [
    ...knowledgeMatches,
    ...suggestionMatches,
    ...vinichaiMatches,
    ...structuredMatches,
    ...documentMatches,
    ...pdfMatches,
    ...fallbackKnowledge,
  ]
    .filter(Boolean)
    .sort((a, b) => {
      const priorityDiff = (b.retrievalPriority || 0) - (a.retrievalPriority || 0);
      if (priorityDiff !== 0) {
        return priorityDiff;
      }

      return (b.score || 0) - (a.score || 0);
    })
    .slice(0, 120);

  return rerankRetrievedMatches(pruneFocusedQueryMatches(combinedMatches, focusMessage), focusMessage, {
    intent,
    target,
  });
}

function scoreMatchSet(matches) {
  if (!matches.length) {
    return 0;
  }

  const top = Number(matches[0]?.score || 0);
  const second = Number(matches[1]?.score || 0);
  return top + second * 0.35;
}

function sortByScore(matches) {
  return (Array.isArray(matches) ? matches : [])
    .filter(Boolean)
    .sort((a, b) => (b.score || 0) - (a.score || 0));
}

function computeDbConfidence(matches, questionIntent = "general") {
  const ranked = sortByScore(matches);
  if (!ranked.length) {
    return 0;
  }

  const topScore = Number(ranked[0]?.score || 0);
  const aggregateScore = scoreMatchSet(ranked);
  let confidence = Math.round(Math.max(topScore / 10, aggregateScore / 8));

  if (questionIntent === "law_section" && topScore >= 90) {
    confidence += 2;
  }

  if (ranked.length >= 3 && aggregateScore >= 120) {
    confidence += 1;
  }

  return Math.max(0, Math.min(20, confidence));
}

function isSimpleQuestion(message, questionIntent = "general") {
  const text = normalizeForSearch(String(message || "")).toLowerCase();
  if (!text) {
    return false;
  }

  if (questionIntent === "short_answer") {
    return true;
  }

  if (questionIntent === "law_section" && isStandaloneLawLookup(text)) {
    return true;
  }

  return text.length <= 60 && /คืออะไร|หมายถึง|เท่าไร|เท่าไหร่|กี่|เมื่อไร|เมื่อไหร่|ได้ไหม|ได้หรือไม่|ต้องไหม|ต้องหรือไม่/.test(text);
}

function isBroadFollowUpExplainMessage(message) {
  const text = normalizeForSearch(String(message || "")).toLowerCase().replace(/\s+/g, " ").trim();
  if (!text || !wantsExplanation(text)) {
    return false;
  }

  return /^(อธิบายเพิ่ม|อธิบายเพิ่มเติม|ช่วยอธิบายเพิ่ม|ช่วยอธิบายเพิ่มเติม|อธิบายอีกที|ขยายความ|ขยายความเพิ่ม|เพิ่มเติม|รายละเอียด|ขอรายละเอียด|ขอรายละเอียดเพิ่มเติม)$/.test(
    text,
  );
}

function isClearlyCurrentOrExternalQuestion(message) {
  const text = normalizeForSearch(String(message || "")).toLowerCase();
  if (!text) {
    return false;
  }

  return /(วันนี้|ตอนนี้|ล่าสุด|ปัจจุบัน|ข่าว|new|update|ประกาศใหม่|เว็บไซต์|ลิงก์|link|ออนไลน์|internet|web|google|facebook|line|โทร|เบอร์|ที่อยู่|map|แผนที่|ภายนอก|external)/.test(
    text,
  );
}

function isLowConfidenceDatabaseResult(matches, questionIntent = "general") {
  const ranked = sortByScore(matches);
  if (!ranked.length) {
    return true;
  }

  const topScore = Number(ranked[0]?.score || 0);
  const secondScore = Number(ranked[1]?.score || 0);
  const aggregateScore = scoreMatchSet(ranked);

  if (questionIntent === "law_section") {
    return topScore < 90;
  }

  if (questionIntent === "short_answer") {
    return topScore < 80 && aggregateScore < 110;
  }

  return topScore < 85 || (ranked.length < 2 && topScore < 105) || aggregateScore < 120 || secondScore < 35;
}

function buildSourceFocusSearchText(item = {}) {
  return normalizeForSearch(
    [
      item.reference,
      item.title,
      item.keyword,
      item.content,
      item.chunk_text,
      item.comment,
      item.documentNumber,
      item.documentDateText,
      item.documentSource,
      item.sourceNote,
    ]
      .filter(Boolean)
      .join(" "),
  ).toLowerCase();
}

function isUnionFeeQuestion(message) {
  const normalized = normalizeForSearch(String(message || "")).toLowerCase();
  if (!normalized) {
    return false;
  }

  return /(ค่าบำรุง|บำรุง)/.test(normalized) && /สันนิบาต/.test(normalized);
}

function scoreUnionFeeSourceFocus(item = {}) {
  const sourceName = String(item.source || "").trim().toLowerCase();
  const sourceText = buildSourceFocusSearchText(item);
  if (!sourceText) {
    return Number.NEGATIVE_INFINITY;
  }

  let score = 0;

  if (/ค่าบำรุง\s*สันนิบาต|บำรุง\s*สันนิบาต/.test(sourceText)) {
    score += 60;
  } else if (/สันนิบาต/.test(sourceText) && /(?:ค่าบำรุง|บำรุง|อัตรา|ร้อยละ|เปอร์เซ็นต์|กำไรสุทธิ|กฎกระทรวง)/.test(sourceText)) {
    score += 32;
  } else {
    score -= 80;
  }

  if (/(อัตรา|ร้อยละ|เปอร์เซ็นต์|กำไรสุทธิ|สามหมื่นบาท|กฎกระทรวง|จัดสรร)/.test(sourceText)) {
    score += 24;
  }

  if (/(ชำระ|จ่าย|คำนวณ|เรียกเก็บ)/.test(sourceText)) {
    score += 14;
  }

  if (sourceName === "pdf_chunks" || sourceName === "documents") {
    score += 12;
  }

  if (sourceName === "tbl_laws" || sourceName === "tbl_glaws") {
    score += 6;
  }

  if (sourceName === "knowledge_base") {
    score -= 28;
  }

  if (/(ประชุมใหญ่|คณะกรรมการ|สมาชิก|เลือกตั้ง|รับสมาชิก)/.test(sourceText)) {
    score -= 48;
  }

  score += getMatchBaseScore(item) * 0.15;
  return score;
}

function scoreCompensationGovernanceSourceFocus(item = {}, message = "") {
  const sourceName = String(item.source || "").trim().toLowerCase();
  const sourceText = buildSourceFocusSearchText(item);
  if (!sourceText) {
    return Number.NEGATIVE_INFINITY;
  }

  const { asksBonus, asksCompensation, asksMeetingAllowance } = getCompensationGovernanceProfile(message);
  const normalizedMessage = normalizeForSearch(String(message || "")).toLowerCase();
  const asksManagerStaff = /(ผู้จัดการ|เจ้าหน้าที่|ฝ่ายจัดการ)/.test(normalizedMessage);
  const asksBoard = /(กรรมการ|คณะกรรมการดำเนินการ)/.test(normalizedMessage);
  let score = 0;

  if (asksMeetingAllowance) {
    if (/(เบี้ยประชุม|ประชุมสัมมนา|ค่าใช้จ่ายประชุม|ค่าใช้จ่ายในการประชุม|ค่าใช้จ่ายสัมมนา|ค่าตอบแทน)/.test(sourceText) && /(ผู้จัดการ|เจ้าหน้าที่|ฝ่ายจัดการ)/.test(sourceText)) {
      score += 72;
    } else if (/(เบี้ยประชุม|ค่าตอบแทน)/.test(sourceText) && /ประชุมใหญ่/.test(sourceText)) {
      score += 40;
    } else {
      score -= 90;
    }
  }

  if (asksCompensation) {
    if (/(ค่าตอบแทน)/.test(sourceText) && /(กรรมการ|เจ้าหน้าที่)/.test(sourceText)) {
      score += 58;
    } else {
      score -= 48;
    }
    if (/(แผนงาน|งบประมาณ|มติที่ประชุมใหญ่|ส่วนได้ส่วนเสีย|ให้ตนเอง)/.test(sourceText)) {
      score += 34;
    }
    if (/(ผิดนัดชำระหนี้|เงินเฉลี่ยคืน|สมาชิกที่ผิดนัดชำระหนี้|ชดเชยให้กับสมาชิก)/.test(sourceText)) {
      score -= 84;
    }
  }

  if (asksBonus) {
    if (/(โบนัส|เงินโบนัส)/.test(sourceText) && /(กรรมการ|เจ้าหน้าที่)/.test(sourceText)) {
      score += 64;
    } else {
      score -= 72;
    }
    if (/(ข้อบังคับ|กำไรสุทธิ|การจัดสรรกำไรสุทธิ|ร้อยละ|ไม่ต่ำกว่า)/.test(sourceText)) {
      score += 30;
    }
  }

  if (asksManagerStaff && /(ผู้จัดการ|เจ้าหน้าที่|ฝ่ายจัดการ)/.test(sourceText)) {
    score += 18;
  }

  if (asksBoard && /(กรรมการ|คณะกรรมการดำเนินการ)/.test(sourceText)) {
    score += 14;
  }

  if (/(ได้หรือไม่|จ่าย|เบิกจ่าย|เข้าร่วมประชุม|ชี้แจง)/.test(sourceText)) {
    score += 18;
  }

  if (sourceName === "tbl_vinichai") {
    score += 16;
  } else if (sourceName === "admin_knowledge" || sourceName === "knowledge_suggestion") {
    score += 10;
  } else if (sourceName === "pdf_chunks" || sourceName === "documents") {
    score -= 18;
  }

  if (/(150 วัน|ผู้แทนสมาชิก|องค์ประชุม|หน่วยเลือกตั้ง|วิสามัญ|นับเวลา|วันสิ้นปีทางบัญชี)/.test(sourceText)) {
    score -= 64;
  }

  score += getMatchBaseScore(item) * 0.12;
  return score;
}

function scoreDissolutionSourceFocus(item = {}) {
  const sourceName = String(item.source || "").trim().toLowerCase();
  const sourceText = buildSourceFocusSearchText(item);
  if (!sourceText) {
    return Number.NEGATIVE_INFINITY;
  }

  let score = 0;

  if (/(มาตรา 70|มาตรา70)/.test(sourceText)) {
    score += 56;
  }
  if (/(มาตรา 71|มาตรา71)/.test(sourceText)) {
    score += 52;
  }
  if (/(มาตรา 89 3|มาตรา89 3|89 3)/.test(sourceText)) {
    score += 34;
  }

  if (/(เลิกสหกรณ์|สหกรณ์ย่อมเลิก|สั่งเลิกสหกรณ์|การเลิกสหกรณ์)/.test(sourceText)) {
    score += 42;
  }

  if (/(มาตรา 32|มาตรา32)/.test(sourceText)) {
    score += 62;
  }
  if (/(มาตรา 33|มาตรา33)/.test(sourceText)) {
    score += 58;
  }
  if (/(มาตรา 34|มาตรา34)/.test(sourceText)) {
    score += 38;
  }

  if (/(เลิกกลุ่มเกษตรกร|กลุ่มเกษตรกรย่อมเลิก|สั่งเลิกกลุ่มเกษตรกร|การเลิกกลุ่มเกษตรกร)/.test(sourceText)) {
    score += 48;
  }

  if (/(มีเหตุตามที่กำหนดในข้อบังคับ|สมาชิกน้อยกว่าสิบคน|ที่ประชุมใหญ่ลงมติให้เลิก|ล้มละลาย)/.test(sourceText)) {
    score += 24;
  }

  if (/(สมาชิกน้อยกว่าสามสิบคน|นายทะเบียนสหกรณ์มีอำนาจสั่งเลิกกลุ่มเกษตรกร|กลุ่มเกษตรกรที่เลิก|ปิดประกาศการเลิกกลุ่มเกษตรกร)/.test(sourceText)) {
    score += 26;
  }

  if (/(ไม่เริ่มดำเนินกิจการภายในหนึ่งปี|หยุดดำเนินกิจการติดต่อกันเป็นเวลาสองปี|ไม่ส่งสำเนารายงานประจำปี|งบการเงินประจำปี|สามปีติดต่อกัน|ก่อให้เกิดความเสียหาย|ดำเนินกิจการไม่เป็นผลดี)/.test(sourceText)) {
    score += 28;
  }

  if (sourceName === "admin_knowledge" || sourceName === "knowledge_suggestion") {
    score += 12;
  }

  if (sourceName === "tbl_laws") {
    score += 8;
  }

  if (sourceName === "tbl_glaws") {
    score += 12;
  }

  if (sourceName === "tbl_vinichai") {
    score -= 18;
  }

  if (sourceName === "documents" || sourceName === "pdf_chunks") {
    score -= 22;
  }

  if (sourceName === "knowledge_base") {
    score -= 30;
  }

  if (/(องค์ประชุม|การประชุมใหญ่|ผู้ตรวจการสหกรณ์|กำหนดระบบบัญชี|อำนาจหน้าที่)/.test(sourceText) && !/(เลิก|สั่งเลิก)/.test(sourceText)) {
    score -= 44;
  }

  if (sourceName === "tbl_laws" && /นายทะเบียนสหกรณ์มีอำนาจหน้าที่/.test(sourceText) && !/สั่งเลิกสหกรณ์/.test(sourceText)) {
    score -= 36;
  }

  score += getMatchBaseScore(item) * 0.12;
  return score;
}

function normalizeLawFocusDigits(text) {
  const digitMap = {
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
  return String(text || "").replace(/[๐-๙]/g, (character) => digitMap[character] || character);
}

function extractPrimaryLawFocusNumber(item = {}) {
  const candidates = [item.reference, item.title, item.keyword];
  for (const candidate of candidates) {
    const raw = normalizeLawFocusDigits(String(candidate || "").trim());
    if (!raw) {
      continue;
    }

    const explicitMatch = raw.match(/(?:มาตรา|ข้อ|วรรค|อนุมาตรา)\s*([0-9]+(?:\/[0-9]+)?)/i);
    if (explicitMatch?.[1]) {
      return explicitMatch[1];
    }

    const bareMatch = raw.match(/^([0-9]+(?:\/[0-9]+)?)$/);
    if (bareMatch?.[1]) {
      return bareMatch[1];
    }
  }

  return "";
}

function normalizeSourceIdentityText(value) {
  return normalizeForSearch(String(value || ""))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildDedupReferenceKey(item) {
  return normalizeSourceIdentityText(item.reference || item.title || item.keyword || "");
}

function buildDedupContentKey(item) {
  return normalizeSourceIdentityText(item.content || item.chunk_text || item.snippet || "");
}

function areNearDuplicateSources(left, right) {
  const leftSource = normalizeSourceIdentityText(left?.source || "");
  const rightSource = normalizeSourceIdentityText(right?.source || "");
  if (!leftSource || !rightSource || leftSource !== rightSource) {
    return false;
  }

  const leftReference = buildDedupReferenceKey(left);
  const rightReference = buildDedupReferenceKey(right);
  if (!leftReference || !rightReference || leftReference !== rightReference) {
    return false;
  }

  const leftContent = buildDedupContentKey(left);
  const rightContent = buildDedupContentKey(right);
  if (!leftContent || !rightContent) {
    return false;
  }

  if (leftContent === rightContent) {
    return true;
  }

  const shorterLength = Math.min(leftContent.length, rightContent.length);
  if (shorterLength < 80) {
    return false;
  }

  if (leftContent.startsWith(rightContent) || rightContent.startsWith(leftContent)) {
    const longerLength = Math.max(leftContent.length, rightContent.length);
    return shorterLength / longerLength >= 0.92;
  }

  return false;
}

function dedupeSourcesConservatively(matches) {
  const ranked = sortByScore(matches);
  const deduped = [];

  ranked.forEach((item) => {
    if (!item) {
      return;
    }

    const duplicateIndex = deduped.findIndex((existing) => areNearDuplicateSources(existing, item));
    if (duplicateIndex === -1) {
      deduped.push(item);
      return;
    }

    if (Number(item.score || 0) > Number(deduped[duplicateIndex].score || 0)) {
      deduped[duplicateIndex] = item;
    }
  });

  return deduped;
}

function rankSourcesForMessageFocus(items, message = "") {
  const ranked = dedupeSourcesConservatively(items);
  if (isCompensationGovernanceQuestion(message)) {
    return ranked
      .map((item) => ({
        ...item,
        __messageFocusRank: scoreCompensationGovernanceSourceFocus(item, message),
      }))
      .sort((left, right) => {
        const focusDiff = Number(right.__messageFocusRank || 0) - Number(left.__messageFocusRank || 0);
        if (focusDiff !== 0) {
          return focusDiff;
        }
        return Number(right.score || 0) - Number(left.score || 0);
      })
      .map((item) => {
        const normalized = { ...item };
        delete normalized.__messageFocusRank;
        return normalized;
      });
  }

  if (!isDissolutionPrioritySearch(message)) {
    return ranked;
  }

  const preferredLawNumbers = getPreferredDissolutionLawNumberBonuses(message);

  return ranked
    .map((item) => {
      const lawNumber = extractPrimaryLawFocusNumber(item);
      const bonus = preferredLawNumbers[lawNumber] || 0;
      return {
        ...item,
        __messageFocusRank: scoreDissolutionSourceFocus(item) + bonus,
      };
    })
    .sort((left, right) => {
      const focusDiff = Number(right.__messageFocusRank || 0) - Number(left.__messageFocusRank || 0);
      if (focusDiff !== 0) {
        return focusDiff;
      }
      return Number(right.score || 0) - Number(left.score || 0);
    })
    .map((item) => {
      const normalized = { ...item };
      delete normalized.__messageFocusRank;
      return normalized;
    });
}

function pruneFocusedQueryMatches(matches, message) {
  const ranked = sortByScore(matches);
    const abbreviationDefinitionMatch =
    normalizeForSearch(String(message || ""))
      .toLowerCase()
      .match(/([ก-๙]{2,8})\s*(?:คืออะไร|หมายถึง|คือ|หมายความว่าอะไร)/);

    if (abbreviationDefinitionMatch?.[1]) {
    const abbreviation = abbreviationDefinitionMatch[1];

    const strictAbbreviationMatches = ranked.filter((item) => {
      const sourceText = buildSourceFocusSearchText(item);
      if (!sourceText) {
        return false;
      }

      const normalizedSource = normalizeForSearch(sourceText).toLowerCase();
      return (
        normalizedSource.includes(abbreviation) &&
        (
          /คือ|หมายถึง|หมายความว่า|ย่อมาจาก|คณะกรรมการ|ประกอบด้วย/.test(normalizedSource)
        )
      );
    });

    if (strictAbbreviationMatches.length > 0) {
      return strictAbbreviationMatches;
    }
  }
  if (isCompensationGovernanceQuestion(message)) {
    const focusedMeetingCompensationMatches = ranked
      .map((item) => ({
        ...item,
        __meetingCompensationScore: scoreCompensationGovernanceSourceFocus(item, message),
      }))
      .filter((item) => Number(item.__meetingCompensationScore || 0) >= 24)
      .sort((left, right) => {
        const focusDiff =
          Number(right.__meetingCompensationScore || 0) - Number(left.__meetingCompensationScore || 0);
        if (focusDiff !== 0) {
          return focusDiff;
        }

        return Number(right.score || 0) - Number(left.score || 0);
      });

    if (focusedMeetingCompensationMatches.length > 0) {
      return focusedMeetingCompensationMatches.map((item) => {
        const normalized = { ...item };
        delete normalized.__meetingCompensationScore;
        return normalized;
      });
    }
  }

  if (isUnionFeeQuestion(message)) {
    const focusedUnionMatches = ranked
      .map((item) => ({
        ...item,
        __unionFeeScore: scoreUnionFeeSourceFocus(item),
      }))
      .filter((item) => Number(item.__unionFeeScore || 0) >= 20)
      .sort((left, right) => {
        const focusDiff = Number(right.__unionFeeScore || 0) - Number(left.__unionFeeScore || 0);
        if (focusDiff !== 0) {
          return focusDiff;
        }

        return Number(right.score || 0) - Number(left.score || 0);
      });

    if (focusedUnionMatches.length > 0) {
      return focusedUnionMatches.map((item) => {
        const normalized = { ...item };
        delete normalized.__unionFeeScore;
        return normalized;
      });
    }
  }

  if (isDissolutionPrioritySearch(message)) {
    const focusedDissolutionMatches = ranked
      .map((item) => ({
        ...item,
        __dissolutionScore: scoreDissolutionSourceFocus(item),
      }))
      .filter((item) => Number(item.__dissolutionScore || 0) >= 18)
      .sort((left, right) => {
        const focusDiff = Number(right.__dissolutionScore || 0) - Number(left.__dissolutionScore || 0);
        if (focusDiff !== 0) {
          return focusDiff;
        }

        return Number(right.score || 0) - Number(left.score || 0);
      });

    if (focusedDissolutionMatches.length > 0) {
      return focusedDissolutionMatches.map((item) => {
        const normalized = { ...item };
        delete normalized.__dissolutionScore;
        return normalized;
      });
    }
  }

  const focusProfile = getQueryFocusProfile(message);
  if (!focusProfile.topics.length) {
    return ranked;
  }

  const structuredSources = new Set(["tbl_laws", "tbl_glaws"]);
  const secondaryFocusedSources = new Set(["admin_knowledge", "knowledge_suggestion", "tbl_vinichai"]);
  const documentLikeSources = new Set(["documents", "pdf_chunks", "knowledge_base"]);
  const generalMinimumFocusScore = focusProfile.intent === "general" ? 18 : 24;
  const documentMinimumFocusScore = focusProfile.intent === "general" ? 26 : 32;

  const scoredMatches = ranked.map((item) => ({
    ...item,
    __focusScore: getSourceAwareFocusScore(message, item),
  }));

  let filtered = scoredMatches.filter((item) => {
    const sourceName = String(item.source || "").trim().toLowerCase();
    const focusScore = Number(item.__focusScore || 0);

    if (structuredSources.has(sourceName)) {
      return focusScore >= generalMinimumFocusScore;
    }

    if (secondaryFocusedSources.has(sourceName)) {
      return focusScore >= generalMinimumFocusScore;
    }

    if (documentLikeSources.has(sourceName)) {
      return focusScore >= documentMinimumFocusScore;
    }

    return focusScore >= generalMinimumFocusScore;
  });

  if (focusProfile.intent !== "general") {
    const strongStructured = filtered.filter((item) => {
      const sourceName = String(item.source || "").trim().toLowerCase();
      return structuredSources.has(sourceName) && Number(item.__focusScore || 0) >= generalMinimumFocusScore;
    });

    if (strongStructured.length > 0) {
      filtered = filtered.filter((item) => {
        const sourceName = String(item.source || "").trim().toLowerCase();
        if (structuredSources.has(sourceName)) {
          return true;
        }

        if (secondaryFocusedSources.has(sourceName)) {
          const extraThreshold = sourceName === "admin_knowledge" ? 18 : 10;
          return Number(item.__focusScore || 0) >= generalMinimumFocusScore + extraThreshold;
        }

        return false;
      });
    }
  }

  if (filtered.length === 0) {
    return ranked;
  }

  return filtered.map((item) => {
    const normalized = { ...item };
    delete normalized.__focusScore;
    return normalized;
  });
}

function getFinalSourceCompactionPlan(intent = "general", options = {}) {
  const focusMessage = options.originalMessage || options.message || "";
  const compensationGovernanceQuestion = isCompensationGovernanceQuestion(focusMessage);
  const compensationProfile = getCompensationGovernanceProfile(focusMessage);

  if (isDissolutionPrioritySearch(focusMessage) || isLiquidationPrioritySearch(focusMessage)) {
    return {
      totalLimit: 4,
      quotas: {
        vinichai: 0,
        structured_laws: 4,
        admin_knowledge: 1,
        knowledge_suggestion: 0,
        document_like: 0,
        internet: 0,
      },
    };
  }

  switch (intent) {
    case "qa":
      if (compensationGovernanceQuestion) {
        return {
          totalLimit: compensationProfile.asksBonus ? 2 : 1,
          quotas: {
            vinichai: 1,
            structured_laws: compensationProfile.asksBonus ? 1 : 0,
            admin_knowledge: 0,
            knowledge_suggestion: 0,
            document_like: 0,
            internet: 0,
          },
        };
      }
      return {
        totalLimit: 5,
        quotas: {
          admin_knowledge: 2,
          knowledge_suggestion: 1,
          vinichai: 1,
          structured_laws: 1,
          document_like: 1,
          internet: 0,
        },
      };
    case "law_section":
      return {
        totalLimit: 4,
        quotas: {
          vinichai: 0,
          structured_laws: 3,
          admin_knowledge: 1,
          knowledge_suggestion: 1,
          document_like: 1,
          internet: 1,
        },
      };
    case "short_answer":
      return {
        totalLimit: 4,
        quotas: {
          vinichai: 0,
          structured_laws: 2,
          admin_knowledge: 1,
          knowledge_suggestion: 1,
          document_like: 1,
          internet: 1,
        },
      };
    case "document":
      return {
        totalLimit: 5,
        quotas: {
          vinichai: 0,
          structured_laws: 2,
          admin_knowledge: 1,
          knowledge_suggestion: 1,
          document_like: 2,
          internet: 1,
        },
      };
    case "explain":
      return {
        totalLimit: 6,
        quotas: {
          vinichai: 0,
          structured_laws: 3,
          admin_knowledge: 1,
          knowledge_suggestion: 1,
          document_like: 2,
          internet: 1,
        },
      };
    default:
      return {
        totalLimit: 5,
        quotas: {
          vinichai: 0,
          structured_laws: 2,
          admin_knowledge: 1,
          knowledge_suggestion: 1,
          document_like: 2,
          internet: 1,
        },
      };
  }
}

function compactSourcesForSummarization(groups, intent = "general", options = {}) {
  const plan = getFinalSourceCompactionPlan(intent, options);
  const compacted = [];
  const focusMessage = String(options.originalMessage || options.message || "").trim();
  const strictStructuredLawFocus =
    isDissolutionPrioritySearch(focusMessage) || isLiquidationPrioritySearch(focusMessage);
  const targetLimit = strictStructuredLawFocus
    ? plan.totalLimit
    : Math.max(plan.totalLimit, Number(options.sourceLimit || 0) || 0);
  const compensationGovernanceQuestion = isCompensationGovernanceQuestion(focusMessage);
  const pushUnique = (items, limit) => {
    rankSourcesForMessageFocus(items, focusMessage)
      .slice(0, limit)
      .forEach((item) => {
        if (compacted.find((existing) => areNearDuplicateSources(existing, item))) {
          return;
        }
        compacted.push(item);
      });
  };

  pushUnique(groups.admin_knowledge, plan.quotas.admin_knowledge || 0);
  pushUnique(groups.knowledge_suggestion, plan.quotas.knowledge_suggestion || 0);
  pushUnique(groups.vinichai, plan.quotas.vinichai || 0);
  pushUnique(groups.structured_laws, plan.quotas.structured_laws || 0);
  pushUnique([...(groups.documents || []), ...(groups.pdf_chunks || [])], plan.quotas.document_like || 0);
  pushUnique(groups.internet, plan.quotas.internet || 0);

  if (compacted.length < targetLimit && !compensationGovernanceQuestion && !strictStructuredLawFocus) {
    const fallbackPool = [
      ...(groups.admin_knowledge || []),
      ...(groups.knowledge_suggestion || []),
      ...(groups.vinichai || []),
      ...(groups.structured_laws || []),
      ...(groups.documents || []),
      ...(groups.pdf_chunks || []),
      ...(groups.knowledge_base || []),
      ...(groups.internet || []),
    ];

    pushUnique(fallbackPool, targetLimit - compacted.length);
  }

  return rankSourcesForMessageFocus(compacted, focusMessage).slice(0, targetLimit || plan.totalLimit);
}

function getDatabaseOnlySelectionPlan(intent = "general", options = {}) {
  const focusMessage = options.originalMessage || options.message || "";
  const { primaryLawSource, secondaryLawSource } = resolvePreferredStructuredLawSources(
    focusMessage,
    options.target || "all",
  );
  const exclusiveStructuredLawDomain = hasExclusiveStructuredLawDomain(
    focusMessage,
    options.target || "all",
  );
  const freePlan = isFreePlanSearch(options.planCode);
  const vinichaiPrioritySearch = isVinichaiPrioritySearch(focusMessage);
  const compensationGovernanceQuestion = isCompensationGovernanceQuestion(focusMessage);
  const compensationProfile = getCompensationGovernanceProfile(focusMessage);

  if (isDissolutionPrioritySearch(focusMessage) || isLiquidationPrioritySearch(focusMessage)) {
    return {
      totalLimit: 5,
      quotas: {
        admin_knowledge: 1,
        knowledge_suggestion: 0,
        tbl_laws:
          primaryLawSource === "tbl_laws"
            ? 4
            : secondaryLawSource === "tbl_laws" && !exclusiveStructuredLawDomain
              ? 1
              : 0,
        tbl_glaws:
          primaryLawSource === "tbl_glaws"
            ? 4
            : secondaryLawSource === "tbl_glaws" && !exclusiveStructuredLawDomain
              ? 1
              : 0,
        pdf_chunks: 0,
        tbl_vinichai: 0,
        documents: 0,
        knowledge_base: 0,
      },
    };
  }

  switch (intent) {
  case "law_section":
    return {
      totalLimit: 8,
      quotas: {
        admin_knowledge: 2,
        knowledge_suggestion: 1,
        tbl_laws: 4,
        tbl_glaws: 3,
        pdf_chunks: 0,
        tbl_vinichai: 1,
        documents: 0,
        knowledge_base: 1,
      },
    };
  case "short_answer":
    return {
      totalLimit: 5,
      quotas: {
        admin_knowledge: 3,
        knowledge_suggestion: 1,
        tbl_laws: 2,
        tbl_glaws: 1,
        pdf_chunks: 0,
        tbl_vinichai: 0,  // ตัด tbl_vinichai ออกจาก short_answer
        documents: 0,
        knowledge_base: 1,
      },
    };
  case "document":
    return {
      totalLimit: 7,
      quotas: {
        admin_knowledge: freePlan ? 3 : 2,
        knowledge_suggestion: 1,
        tbl_laws: 2,
        tbl_glaws: 1,
        pdf_chunks: 1,
        tbl_vinichai: 1,
        documents: freePlan ? 1 : 2,
        knowledge_base: 1,
      },
    };
  case "qa":
    if (compensationGovernanceQuestion) {
      return {
        totalLimit: compensationProfile.asksBonus ? 2 : 1,
        quotas: {
          admin_knowledge: 0,
          knowledge_suggestion: 0,
          tbl_laws: compensationProfile.asksBonus ? 1 : 0,
          tbl_glaws: 0,
          pdf_chunks: 0,
          tbl_vinichai: 1,
          documents: 0,
          knowledge_base: 0,
        },
      };
    }
    return {
      totalLimit: 6,
      quotas: {
        admin_knowledge: 3,
        knowledge_suggestion: 2,
        tbl_laws: vinichaiPrioritySearch ? 1 : 1,
        tbl_glaws: 0,
        pdf_chunks: 0,
        tbl_vinichai: vinichaiPrioritySearch ? 2 : 1,
        documents: 0,
        knowledge_base: 1,
      },
    };
  case "explain":
    return {
      totalLimit: freePlan ? 12 : 10,
      quotas: {
        admin_knowledge: freePlan ? 3 : 3,
        knowledge_suggestion: freePlan ? 2 : 2,
        tbl_laws: freePlan ? 3 : 3,
        tbl_glaws: freePlan ? 2 : 2,
        pdf_chunks: freePlan ? 1 : 1,
        tbl_vinichai: freePlan ? 2 : 1,
        documents: freePlan ? 2 : 1,
        knowledge_base: freePlan ? 2 : 1,
      },
    };
  default:
    return {
      totalLimit: 8,
      quotas: {
        admin_knowledge: 3,
        knowledge_suggestion: 1,
        tbl_laws: freePlan ? 2 : 3,
        tbl_glaws: 1,
        pdf_chunks: 0,
        tbl_vinichai: freePlan ? 2 : 1,
        documents: 0,
        knowledge_base: 1,
      },
    };
  }
}




function getDatabaseOnlySourceOrder(intent = "general", options = {}) {
  const { primaryLawSource, secondaryLawSource } = resolvePreferredStructuredLawSources(
    options.originalMessage || options.message || "",
    options.target || "all",
  );

  const focusMessage = options.originalMessage || options.message || "";

  if (
    isDissolutionPrioritySearch(focusMessage) ||
    isLiquidationPrioritySearch(focusMessage)
  ) {
    return [
      primaryLawSource,
      "admin_knowledge",
      "knowledge_suggestion",
      secondaryLawSource,
      "tbl_vinichai",
      "documents",
      "pdf_chunks",
      "knowledge_base",
    ];
  }

  if (intent === "law_section") {
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

  if (intent === "qa" || isVinichaiPrioritySearch(focusMessage)) {
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

  if (intent === "short_answer") {
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

  if (intent === "document") {
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

  if (intent === "explain") {
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

function selectDatabaseOnlySources(groups, intent = "general", options = {}) {
  const plan = getDatabaseOnlySelectionPlan(intent, options);
  const selected = [];
  const usedTiers = [];
  const focusMessage = String(options.originalMessage || options.message || "").trim();
  const broadFollowUpExplainMessage = isBroadFollowUpExplainMessage(focusMessage);
  const strictStructuredLawFocus =
    isDissolutionPrioritySearch(focusMessage) || isLiquidationPrioritySearch(focusMessage);
  const hasContextCarryCandidates = [
    ...(groups.admin_knowledge || []),
    ...(groups.knowledge_suggestion || []),
    ...(groups.structured_laws || []),
    ...(groups.vinichai || []),
    ...(groups.documents || []),
    ...(groups.pdf_chunks || []),
    ...(groups.knowledge_base || []),
  ].some((item) => item && item.contextCarry);
  const strictFollowUpExplainMode = intent === "explain" && hasContextCarryCandidates;
  const targetLimit = strictStructuredLawFocus
    ? plan.totalLimit
    : Math.max(plan.totalLimit, Number(options.sourceLimit || 0) || 0);
  const compensationGovernanceQuestion = isCompensationGovernanceQuestion(focusMessage);
  const selectionTrace = {
    mode: "database_only",
    tiers: [],
    fallbackUsed: false,
  };

  const pushUnique = (items, limit, tierName) => {
    const normalizedItems = strictFollowUpExplainMode
      ? (Array.isArray(items) ? items : []).filter((item) => {
          if (!item) {
            return false;
          }

          if (item.contextCarry) {
            return true;
          }

          if (broadFollowUpExplainMessage) {
            return false;
          }

          const sourceName = String(item.source || "").trim().toLowerCase();
          const itemScore = Number(item.score || 0);
          if (["documents", "pdf_chunks", "knowledge_base"].includes(sourceName)) {
            return false;
          }

          return itemScore >= 84;
        })
      : items;
    const ranked = rankSourcesForMessageFocus(normalizedItems, focusMessage).slice(0, limit);
    const tierTrace = {
      tier: tierName,
      requestedLimit: limit,
      candidateCount: Array.isArray(normalizedItems) ? normalizedItems.length : 0,
      topScore: Number(ranked[0]?.score || 0),
      selectedCount: 0,
    };
    selectionTrace.tiers.push(tierTrace);

    if (ranked.length === 0) {
      return;
    }

    usedTiers.push(tierName);
    ranked.forEach((item) => {
      if (selected.find((existing) => areNearDuplicateSources(existing, item))) {
        return;
      }
      selected.push({
        ...item,
        selectionTier: item.selectionTier || tierName,
      });
      tierTrace.selectedCount += 1;
    });
  };

  const structuredLaws = Array.isArray(groups.structured_laws) ? groups.structured_laws : [];
  const sourceBuckets = {
    admin_knowledge: groups.admin_knowledge || [],
    knowledge_suggestion: groups.knowledge_suggestion || [],
    tbl_laws: structuredLaws.filter((item) => item && item.source === "tbl_laws"),
    tbl_glaws: structuredLaws.filter((item) => item && item.source === "tbl_glaws"),
    pdf_chunks: groups.pdf_chunks || [],
    tbl_vinichai: groups.vinichai || [],
    documents: groups.documents || [],
    knowledge_base: groups.knowledge_base || [],
  };
  const sourceOrder = getDatabaseOnlySourceOrder(intent, options);

  sourceOrder.forEach((sourceName) => {
    pushUnique(
      sourceBuckets[sourceName] || [],
      plan.quotas[sourceName] || 0,
      sourceName,
    );
  });

  if (
    selected.length < targetLimit &&
    !compensationGovernanceQuestion &&
    !strictStructuredLawFocus &&
    !strictFollowUpExplainMode
  ) {
    selectionTrace.fallbackUsed = true;
    const fallbackOrder = new Map(sourceOrder.map((sourceName, index) => [sourceName, index]));
    const fallbackPool = rankSourcesForMessageFocus([
      ...(groups.admin_knowledge || []),
      ...(groups.knowledge_suggestion || []),
      ...structuredLaws.filter((item) => item && item.source === "tbl_laws"),
      ...structuredLaws.filter((item) => item && item.source === "tbl_glaws"),
      ...(groups.vinichai || []),
      ...(groups.documents || []),
      ...(groups.pdf_chunks || []),
      ...(groups.knowledge_base || []),
    ], focusMessage).sort((left, right) => {
      const leftOrder = fallbackOrder.get(String(left?.source || "").trim().toLowerCase());
      const rightOrder = fallbackOrder.get(String(right?.source || "").trim().toLowerCase());
      if (leftOrder !== rightOrder) {
        return (leftOrder ?? Number.MAX_SAFE_INTEGER) - (rightOrder ?? Number.MAX_SAFE_INTEGER);
      }

      return Number(right?.score || 0) - Number(left?.score || 0);
    });

    fallbackPool.forEach((item) => {
      if (selected.length >= targetLimit) {
        return;
      }

      if (selected.find((existing) => areNearDuplicateSources(existing, item))) {
        return;
      }

      selected.push(item);
    });
  }

  return {
    selectedSourceTier: usedTiers.join(" > ") || "none",
    selectedSources: selected.slice(0, targetLimit || plan.totalLimit),
    selectionTrace: {
      ...selectionTrace,
      selectedCount: Math.min(selected.length, targetLimit || plan.totalLimit),
    },
    selectionDiagnostics: buildSelectionDiagnostics(
      groups,
      selected.slice(0, targetLimit || plan.totalLimit),
      intent,
      options,
    ),
  };
}

function selectTieredSources(groups, intent = "general", options = {}) {
  if (options.databaseOnlyMode) {
    return selectDatabaseOnlySources(groups, intent, options);
  }

  const routingPlan = getSourceRoutingPlan(intent);

  const planItems = [
    { key: "structured_laws", limit: routingPlan.limits.structured_laws || 3, priority: routingPlan.priorities.structured_laws || 0 },
    { key: "admin_knowledge", limit: routingPlan.limits.admin_knowledge || 2, priority: routingPlan.priorities.admin_knowledge || 0 },
    { key: "knowledge_suggestion", limit: routingPlan.limits.knowledge_suggestion || 0, priority: routingPlan.priorities.knowledge_suggestion || 0 },
    { key: "vinichai", limit: routingPlan.limits.vinichai || 2, priority: routingPlan.priorities.vinichai || 0 },
    { key: "documents", limit: routingPlan.limits.documents || 2, priority: routingPlan.priorities.documents || 0 },
    { key: "pdf_chunks", limit: routingPlan.limits.pdf_chunks || 3, priority: routingPlan.priorities.pdf_chunks || 0 },
    { key: "internet", limit: 2, priority: 0 },
    { key: "knowledge_base", limit: routingPlan.limits.knowledge_base || 1, priority: routingPlan.priorities.knowledge_base || 0 },
  ];

  const plan = planItems.sort((a, b) => b.priority - a.priority);

  const selected = [];
  const usedTiers = [];
  const focusMessage = String(options.originalMessage || options.message || "").trim();
  const selectionTrace = {
    mode: "tiered",
    tiers: [],
  };

  plan.forEach(({ key, limit }) => {
    const ranked = rankSourcesForMessageFocus(groups[key], focusMessage).slice(0, limit);
    const tierTrace = {
      tier: key,
      requestedLimit: limit,
      candidateCount: Array.isArray(groups[key]) ? groups[key].length : 0,
      topScore: Number(ranked[0]?.score || 0),
      selectedCount: ranked.length,
    };
    selectionTrace.tiers.push(tierTrace);

    if (ranked.length > 0) {
      usedTiers.push(key);
      selected.push(
        ...ranked.map((item) => ({
          ...item,
          selectionTier: item.selectionTier || key,
        })),
      );
    }
  });

  const compactedSelected = compactSourcesForSummarization(
    {
      ...groups,
      structured_laws: selected.filter((item) => item && (item.source === "tbl_laws" || item.source === "tbl_glaws")),
      admin_knowledge: selected.filter((item) => item && item.source === "admin_knowledge"),
      knowledge_suggestion: selected.filter((item) => item && item.source === "knowledge_suggestion"),
      vinichai: selected.filter((item) => item && item.source === "tbl_vinichai"),
      documents: selected.filter((item) => item && item.source === "documents"),
      pdf_chunks: selected.filter((item) => item && item.source === "pdf_chunks"),
      knowledge_base: selected.filter((item) => item && item.source === "knowledge_base"),
      internet: selected.filter((item) => item && item.source === "internet_search"),
    },
    intent,
    options,
  );

  return {
    selectedSourceTier: usedTiers.join(" > ") || "none",
    selectedSources: compactedSelected,
    selectionTrace: {
      ...selectionTrace,
      selectedCount: compactedSelected.length,
    },
    selectionDiagnostics: buildSelectionDiagnostics(groups, compactedSelected, intent, options),
  };
}

module.exports = {
  classifyQuestionIntent,
  compactSourcesForSummarization,
  computeDbConfidence,
  getSourceRoutingPlan,
  isClearlyCurrentOrExternalQuestion,
  isLowConfidenceDatabaseResult,
  isSimpleQuestion,
  pruneFocusedQueryMatches,
  scoreMatchSet,
  searchDatabaseSources,
  selectDatabaseOnlySources,
  selectTieredSources,
  sortByScore,
};
