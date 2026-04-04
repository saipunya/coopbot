const {
  computeDbConfidence,
  isClearlyCurrentOrExternalQuestion,
  isLowConfidenceDatabaseResult,
  scoreMatchSet,
  sortByScore,
} = require("./sourceSelectionService");
const { extractExplicitTopicHints, normalizeForSearch } = require("./thaiTextUtils");

const AUTHORITATIVE_SOURCES = new Set([
  "tbl_laws",
  "tbl_glaws",
  "tbl_vinichai",
  "admin_knowledge",
  "knowledge_suggestion",
]);
const PRIMARY_LAW_SOURCES = new Set(["tbl_laws", "tbl_glaws"]);
const DOCUMENT_SOURCES = new Set(["documents", "pdf_chunks"]);
const THRESHOLD_PROFILES = {
  general: {
    minAnswerability: 52,
    minClarifyAnswerability: 30,
    minTopScore: 84,
    minAggregateScore: 102,
    minSelectedConfidence: 9,
    minTopFocusScore: 14,
    strongSingleSourceTopScore: 112,
    requirePrimaryLawSource: false,
    preferDocumentSource: false,
  },
  law_section: {
    minAnswerability: 56,
    minClarifyAnswerability: 34,
    minTopScore: 88,
    minAggregateScore: 96,
    minSelectedConfidence: 10,
    minTopFocusScore: 12,
    strongSingleSourceTopScore: 110,
    requirePrimaryLawSource: true,
    preferDocumentSource: false,
  },
  document: {
    minAnswerability: 50,
    minClarifyAnswerability: 28,
    minTopScore: 82,
    minAggregateScore: 92,
    minSelectedConfidence: 8,
    minTopFocusScore: 14,
    strongSingleSourceTopScore: 108,
    requirePrimaryLawSource: false,
    preferDocumentSource: true,
  },
  qa: {
    minAnswerability: 54,
    minClarifyAnswerability: 30,
    minTopScore: 84,
    minAggregateScore: 100,
    minSelectedConfidence: 9,
    minTopFocusScore: 14,
    strongSingleSourceTopScore: 110,
    requirePrimaryLawSource: false,
    preferDocumentSource: false,
  },
  explain: {
    minAnswerability: 52,
    minClarifyAnswerability: 30,
    minTopScore: 82,
    minAggregateScore: 98,
    minSelectedConfidence: 8,
    minTopFocusScore: 12,
    strongSingleSourceTopScore: 108,
    requirePrimaryLawSource: false,
    preferDocumentSource: false,
  },
  short_answer: {
    minAnswerability: 54,
    minClarifyAnswerability: 32,
    minTopScore: 84,
    minAggregateScore: 96,
    minSelectedConfidence: 9,
    minTopFocusScore: 12,
    strongSingleSourceTopScore: 108,
    requirePrimaryLawSource: false,
    preferDocumentSource: false,
  },
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function scaleTo(value, minInput, maxInput, maxOutput) {
  if (!Number.isFinite(value) || maxInput <= minInput || maxOutput <= 0) {
    return 0;
  }

  if (value <= minInput) {
    return 0;
  }

  if (value >= maxInput) {
    return maxOutput;
  }

  return Math.round(((value - minInput) / (maxInput - minInput)) * maxOutput);
}

function normalizeSourceName(sourceName = "") {
  return String(sourceName || "").trim().toLowerCase();
}

function uniqueTerms(values = []) {
  const seen = new Set();
  const results = [];

  for (const value of Array.isArray(values) ? values : []) {
    const trimmed = String(value || "").trim();
    if (!trimmed) {
      continue;
    }

    const normalized = normalizeForSearch(trimmed).toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    results.push(trimmed);
  }

  return results;
}

function getMessageProfile(message = "") {
  const normalized = normalizeForSearch(String(message || "")).trim();
  const explicitTopics = extractExplicitTopicHints(normalized);
  const shortQuery = normalized.length > 0 && normalized.length <= 28;
  const lowContextQuery = normalized.length > 0 && normalized.length <= 48 && explicitTopics.length === 0;
  const clarifySignals =
    /^(ได้ไหม|ได้หรือไม่|มาตราไหน|ข้อไหน|วรรคไหน|กรณีนี้|เรื่องนี้|อันนี้|แล้ว|แล้วล่ะ|แล้วกรณีนี้|ยังไง|อย่างไร|อันไหน|แบบไหน)$/i.test(
      normalized,
    ) ||
    /^(แล้ว|แล้วก็|แล้วกรณีนี้|แล้วแบบนี้|กรณีนี้|ส่วนกรณีนี้|มาตราไหน|ข้อไหน|วรรคไหน)\b/i.test(
      normalized,
    );

  return {
    normalized,
    explicitTopics,
    shortQuery,
    lowContextQuery,
    clarifySignals,
    currentOrExternalQuestion: isClearlyCurrentOrExternalQuestion(normalized),
  };
}

function resolveRetrievalThresholdProfile(questionIntent = "general", options = {}) {
  const profile = THRESHOLD_PROFILES[questionIntent] || THRESHOLD_PROFILES.general;
  const messageProfile = getMessageProfile(options.effectiveMessage || options.message || "");

  return {
    intent: questionIntent || "general",
    ...profile,
    minAnswerability:
      profile.minAnswerability +
      (options.usedInternetFallback && options.usedInternetSearch ? 2 : 0) +
      (messageProfile.currentOrExternalQuestion ? 2 : 0),
    minClarifyAnswerability: profile.minClarifyAnswerability,
    minTopScore: profile.minTopScore,
    minAggregateScore: profile.minAggregateScore,
    minSelectedConfidence: profile.minSelectedConfidence,
    minTopFocusScore: profile.minTopFocusScore,
    strongSingleSourceTopScore: profile.strongSingleSourceTopScore,
    requirePrimaryLawSource: Boolean(profile.requirePrimaryLawSource),
    preferDocumentSource: Boolean(profile.preferDocumentSource),
  };
}

function collectRetrievalMetrics(payload = {}, profile = resolveRetrievalThresholdProfile()) {
  const questionIntent = payload.questionIntent || profile.intent || "general";
  const selectedSources = sortByScore(payload.selectedSources || payload.sources || []);
  const databaseMatches = sortByScore(payload.databaseMatches || []);
  const messageProfile = getMessageProfile(payload.effectiveMessage || payload.message || "");
  const rankedForConfidence = selectedSources.length > 0 ? selectedSources : databaseMatches;

  const topScore = toNumber(selectedSources[0]?.score);
  const aggregateScore = scoreMatchSet(selectedSources);
  const selectedConfidence = computeDbConfidence(selectedSources, questionIntent);
  const dbConfidence = computeDbConfidence(rankedForConfidence, questionIntent);
  const lowConfidence = isLowConfidenceDatabaseResult(rankedForConfidence, questionIntent);

  const authoritativeCount = selectedSources.filter((item) =>
    AUTHORITATIVE_SOURCES.has(normalizeSourceName(item?.source)),
  ).length;
  const primaryLawCount = selectedSources.filter((item) =>
    PRIMARY_LAW_SOURCES.has(normalizeSourceName(item?.source)),
  ).length;
  const documentCount = selectedSources.filter((item) =>
    DOCUMENT_SOURCES.has(normalizeSourceName(item?.source)),
  ).length;
  const internetCount = selectedSources.filter(
    (item) => normalizeSourceName(item?.source) === "internet_search",
  ).length;
  const contextCarryCount = selectedSources.filter((item) => item?.contextCarry).length;
  const matchedReferences = uniqueTerms(
    selectedSources.map((item) => item?.rankingTrace?.matchedReference || ""),
  );
  const focusScores = selectedSources
    .map((item) => toNumber(item?.rankingTrace?.focusAlignmentRaw, NaN))
    .filter((value) => Number.isFinite(value));
  const topFocusScore = focusScores.length > 0 ? Math.max(...focusScores) : 0;
  const avgFocusScore =
    focusScores.length > 0
      ? Math.round(focusScores.reduce((sum, value) => sum + value, 0) / focusScores.length)
      : 0;
  const strongFocusCount = focusScores.filter((value) => value >= 24).length;
  const weakFocusCount = focusScores.filter((value) => value > 0 && value < profile.minTopFocusScore).length;
  const freshnessScores = selectedSources
    .map((item) => toNumber(item?.rankingTrace?.freshnessScore, NaN))
    .filter((value) => Number.isFinite(value));
  const freshCount = freshnessScores.filter((value) => value >= 3).length;
  const staleCount = freshnessScores.filter((value) => value < 0).length;
  const internetOnly =
    selectedSources.length > 0 &&
    internetCount === selectedSources.length &&
    authoritativeCount === 0 &&
    primaryLawCount === 0 &&
    documentCount === 0;
  const strongSingleSource =
    selectedSources.length === 1 && topScore >= toNumber(profile.strongSingleSourceTopScore, 110);

  return {
    selectedCount: selectedSources.length,
    databaseMatchCount: databaseMatches.length,
    topScore,
    secondScore: toNumber(selectedSources[1]?.score),
    aggregateScore,
    selectedConfidence,
    dbConfidence,
    lowConfidence,
    authoritativeCount,
    primaryLawCount,
    documentCount,
    internetCount,
    internetOnly,
    contextCarryCount,
    matchedReferences,
    topMatchedReference: matchedReferences[0] || "",
    matchedReferenceCount: matchedReferences.length,
    focusScores,
    topFocusScore,
    avgFocusScore,
    strongFocusCount,
    weakFocusCount,
    freshCount,
    staleCount,
    ambiguousFollowUp: Boolean(payload.queryRewriteTrace?.ambiguousFollowUp),
    shortQuery: messageProfile.shortQuery,
    lowContextQuery: messageProfile.lowContextQuery,
    clarifySignals: messageProfile.clarifySignals,
    explicitTopicCount: messageProfile.explicitTopics.length,
    explicitTopics: messageProfile.explicitTopics,
    currentOrExternalQuestion: messageProfile.currentOrExternalQuestion,
    strongSingleSource,
    usedInternetFallback: Boolean(payload.usedInternetFallback),
    usedInternetSearch: Boolean(payload.usedInternetSearch),
  };
}

function computeAnswerability(payload = {}, profile = resolveRetrievalThresholdProfile()) {
  const metrics = collectRetrievalMetrics(payload, profile);
  const components = {
    topScore: scaleTo(metrics.topScore, 60, 125, 28),
    aggregateScore: scaleTo(metrics.aggregateScore, 70, 150, 18),
    selectedConfidence: scaleTo(metrics.selectedConfidence, 0, 20, 18),
    focus: scaleTo(metrics.topFocusScore, 0, 48, 14),
    authority: clamp(metrics.authoritativeCount * 4, 0, 12),
    sectionMatch: metrics.matchedReferenceCount > 0 ? 10 : 0,
    corroboration:
      metrics.selectedCount >= 2
        ? clamp(4 + (metrics.selectedCount - 2) * 2, 4, 8)
        : metrics.strongSingleSource
          ? 4
          : 0,
    freshness:
      metrics.currentOrExternalQuestion
        ? clamp(metrics.freshCount * 2 - metrics.staleCount * 2, -4, 6)
        : clamp(metrics.freshCount - metrics.staleCount, -2, 4),
  };
  const penalties = {
    noSources: metrics.selectedCount === 0 ? -60 : 0,
    lowConfidence: metrics.lowConfidence ? -12 : 0,
    internetOnly: metrics.internetOnly ? -10 : 0,
    ambiguousFollowUp:
      metrics.ambiguousFollowUp && metrics.matchedReferenceCount === 0 && metrics.topFocusScore < 24
        ? -8
        : 0,
    weakFocus:
      metrics.topFocusScore > 0 && metrics.topFocusScore < profile.minTopFocusScore
        ? -6
        : 0,
    missingPrimaryLaw:
      profile.requirePrimaryLawSource && metrics.primaryLawCount === 0 && metrics.matchedReferenceCount === 0
        ? -10
        : 0,
    missingDocumentSource:
      profile.preferDocumentSource && metrics.documentCount === 0 && metrics.topFocusScore < 24
        ? -6
        : 0,
    staleCurrent:
      metrics.currentOrExternalQuestion && metrics.staleCount > 0 && metrics.freshCount === 0
        ? -4
        : 0,
  };

  const positiveScore = Object.values(components).reduce((sum, value) => sum + toNumber(value), 0);
  const negativeScore = Object.values(penalties).reduce((sum, value) => sum + toNumber(value), 0);
  const answerabilityScore = clamp(Math.round(positiveScore + negativeScore), 0, 100);
  const confidence = clamp(
    Math.round(answerabilityScore * 0.82 + metrics.selectedConfidence * 1.6),
    0,
    100,
  );

  return {
    profile,
    metrics,
    components,
    penalties,
    positiveScore,
    negativeScore,
    answerabilityScore,
    confidence,
  };
}

function buildPositiveReasonParts(metrics = {}, payload = {}) {
  const reasons = [];

  if (metrics.matchedReferenceCount > 0) {
    reasons.push("ตรงมาตราที่ถาม");
  }

  if (metrics.primaryLawCount > 0) {
    reasons.push("มีแหล่งกฎหมายหลักรองรับ");
  } else if (metrics.authoritativeCount > 0) {
    reasons.push("มีแหล่งข้อมูลที่น่าเชื่อถือรองรับ");
  }

  if (metrics.topFocusScore >= 24) {
    reasons.push("focus ตรงประเด็นคำถาม");
  }

  if (metrics.selectedCount >= 2) {
    reasons.push("มี source สนับสนุนมากกว่าหนึ่งรายการ");
  }

  if (metrics.currentOrExternalQuestion && metrics.freshCount > 0) {
    reasons.push("มีข้อมูลค่อนข้างใหม่");
  }

  if (payload.queryRewriteTrace?.summary) {
    reasons.push("query rewrite ช่วยขยายคำค้น");
  }

  return reasons.slice(0, 4);
}

function buildNegativeReasonParts(metrics = {}, payload = {}, profile = {}) {
  const reasons = [];

  if (metrics.selectedCount === 0) {
    reasons.push("ยังไม่พบ source ที่พอใช้ตอบ");
  }

  if (metrics.ambiguousFollowUp) {
    reasons.push("คำถามยังกำกวมหรือเป็นคำถามต่อ");
  }

  if (metrics.shortQuery) {
    reasons.push("คำถามสั้นเกินไป");
  }

  if (metrics.lowContextQuery) {
    reasons.push("คำค้นยังไม่พอให้จับประเด็น");
  }

  if (profile.requirePrimaryLawSource && metrics.matchedReferenceCount === 0) {
    reasons.push("ยังไม่เห็นมาตราที่ตรงชัด");
  }

  if (profile.preferDocumentSource && metrics.documentCount === 0) {
    reasons.push("ยังไม่พบเอกสารที่ตรงคำถาม");
  }

  if (metrics.topFocusScore > 0 && metrics.topFocusScore < profile.minTopFocusScore) {
    reasons.push("focus score ยังต่ำ");
  }

  if (metrics.internetOnly) {
    reasons.push("อาศัยแหล่งสาธารณะเป็นหลัก");
  }

  if (metrics.lowConfidence) {
    reasons.push("คะแนน retrieval ยังไม่พอ");
  }

  return uniqueTerms(reasons).slice(0, 4);
}

function buildReasonCodes(metrics = {}, profile = {}, policy = "no_answer") {
  const reasonCodes = [];

  if (metrics.selectedCount === 0) {
    reasonCodes.push("no_sources");
  }
  if (metrics.ambiguousFollowUp) {
    reasonCodes.push("ambiguous_follow_up");
  }
  if (metrics.shortQuery) {
    reasonCodes.push("short_query");
  }
  if (metrics.lowContextQuery) {
    reasonCodes.push("low_context_query");
  }
  if (metrics.matchedReferenceCount > 0) {
    reasonCodes.push("matched_reference");
  }
  if (metrics.primaryLawCount > 0) {
    reasonCodes.push("primary_law_support");
  } else if (metrics.authoritativeCount > 0) {
    reasonCodes.push("authoritative_support");
  }
  if (metrics.documentCount > 0) {
    reasonCodes.push("document_support");
  }
  if (metrics.internetOnly) {
    reasonCodes.push("internet_only");
  }
  if (metrics.lowConfidence) {
    reasonCodes.push("low_confidence_retrieval");
  }
  if (metrics.topFocusScore >= profile.minTopFocusScore) {
    reasonCodes.push("focus_aligned");
  } else if (metrics.topFocusScore > 0) {
    reasonCodes.push("weak_focus_alignment");
  }
  if (metrics.freshCount > 0) {
    reasonCodes.push("fresh_support");
  }
  if (metrics.staleCount > 0) {
    reasonCodes.push("stale_support");
  }
  if (policy === "clarify") {
    reasonCodes.push("needs_clarification");
  }
  if (policy === "no_answer") {
    reasonCodes.push("insufficient_retrieval_support");
  }

  return uniqueTerms(reasonCodes);
}

function buildHintExamples(payload = {}, metrics = {}) {
  const suggestions = uniqueTerms([
    ...(payload.resolvedContext?.topicHints || []),
    ...(payload.queryRewriteTrace?.expandedKeywords || []),
    ...(payload.queryRewriteTrace?.legalAliases || []),
    ...(metrics.explicitTopics || []),
  ]).slice(0, 3);

  return suggestions.length > 0 ? suggestions.join(", ") : "";
}

function buildClarifyingQuestion(payload = {}, metrics = {}, profile = {}) {
  const hintExamples = buildHintExamples(payload, metrics);
  const suffix = hintExamples ? ` เช่น คำเต็มของ${hintExamples} หรือคำที่เกี่ยวข้อง` : "";

  if (profile.intent === "law_section") {
    return `เพื่อหามาตราที่ตรงขึ้น รบกวนระบุชื่อเรื่องหรือมาตราที่ต้องการเพิ่มเติมอีกนิด${suffix}`;
  }

  if (profile.intent === "document") {
    return `เพื่อค้นเอกสารให้ตรงขึ้น รบกวนระบุชื่อเอกสาร เลขที่หนังสือ หน่วยงาน หรือวันที่เพิ่มเติม${hintExamples}`;
  }

  return `เพื่อหาคำตอบให้ตรงขึ้น รบกวนเพิ่มคำสำคัญหรือรายละเอียดที่ต้องการสอบถามอีกนิด${suffix}`;
}

function buildNoAnswerMessage(payload = {}, metrics = {}, profile = {}) {
  const baseMessage = payload.usedInternetSearch
    ? "ไม่ปรากฏข้อมูลที่ตรงกับประเด็นคำถามอย่างชัดเจนทั้งในฐานข้อมูลและแหล่งข้อมูลสาธารณะ"
    : "ไม่ปรากฏข้อมูลที่ตรงกับประเด็นคำถามอย่างชัดเจนในฐานข้อมูลและเอกสารภายในระบบ";

  const hintExamples = buildHintExamples(payload, metrics);

  if (profile.intent === "law_section") {
    return `${baseMessage}\n\nกรุณาระบุชื่อเรื่องกฎหมายหรือมาตราที่เกี่ยวข้องเพิ่มเติม${hintExamples ? ` เช่น ${hintExamples}` : ""}`;
  }

  if (profile.intent === "document") {
    return `${baseMessage}\n\nกรุณาระบุชื่อเอกสาร เลขที่หนังสือ หน่วยงาน หรือวันที่เพิ่มเติม${hintExamples ? ` เช่น ${hintExamples}` : ""}`;
  }

  return `${baseMessage}\n\nกรุณาระบุคำสำคัญเพิ่มเติม${hintExamples ? ` เช่น ${hintExamples}` : " เช่น การประชุมใหญ่ สมาชิก คณะกรรมการ หรือการจัดตั้งกลุ่มเกษตรกร"}`;
}

function buildHumanReadableDecision(policy = "no_answer", metrics = {}, payload = {}, profile = {}) {
  const positive = buildPositiveReasonParts(metrics, payload);
  const negative = buildNegativeReasonParts(metrics, payload, profile);

  if (policy === "answer") {
    return `answer because: "${positive.slice(0, 3).join(" + ") || "คะแนนรวมพอสำหรับตอบ"}"`;
  }

  if (policy === "clarify") {
    return `clarify because: "${negative.slice(0, 3).join(" + ") || "ต้องการข้อมูลเพิ่มก่อนตอบ"}"`;
  }

  return `no-answer because: "${negative.slice(0, 3).join(" + ") || "retrieval ยังไม่พอ"}"`;
}

function decideNoAnswerPolicy(payload = {}, answerability = computeAnswerability(payload)) {
  const profile = answerability.profile || resolveRetrievalThresholdProfile(payload.questionIntent, payload);
  const metrics = answerability.metrics || collectRetrievalMetrics(payload, profile);

  const meetsTopScore = metrics.topScore >= profile.minTopScore;
  const meetsAggregateScore =
    metrics.aggregateScore >= profile.minAggregateScore || metrics.strongSingleSource;
  const meetsFocus =
    metrics.topFocusScore >= profile.minTopFocusScore ||
    metrics.matchedReferenceCount > 0 ||
    metrics.authoritativeCount > 0;
  const meetsPrimaryLawRequirement =
    !profile.requirePrimaryLawSource ||
    metrics.primaryLawCount > 0 ||
    metrics.matchedReferenceCount > 0;
  const meetsDocumentPreference =
    !profile.preferDocumentSource ||
    metrics.documentCount > 0 ||
    metrics.strongSingleSource ||
    metrics.topFocusScore >= 24;
  const meetsAnswerThresholds =
    metrics.selectedCount > 0 &&
    answerability.answerabilityScore >= profile.minAnswerability &&
    metrics.selectedConfidence >= profile.minSelectedConfidence &&
    meetsTopScore &&
    meetsAggregateScore &&
    meetsFocus &&
    meetsPrimaryLawRequirement &&
    meetsDocumentPreference;

  let policy = "no_answer";

  if (meetsAnswerThresholds) {
    policy = "answer";
  } else {
    const shouldClarify =
      metrics.ambiguousFollowUp ||
      metrics.shortQuery ||
      metrics.lowContextQuery ||
      metrics.clarifySignals ||
      (profile.intent === "law_section" && metrics.matchedReferenceCount === 0 && metrics.selectedCount <= 1) ||
      (profile.intent === "document" && metrics.documentCount === 0 && metrics.selectedCount <= 1);

    if (
      shouldClarify &&
      (
        answerability.answerabilityScore >= profile.minClarifyAnswerability ||
        metrics.selectedCount === 0 ||
        metrics.selectedConfidence >= Math.max(4, profile.minSelectedConfidence - 4)
      )
    ) {
      policy = "clarify";
    }
  }

  const reasonCodes = buildReasonCodes(metrics, profile, policy);
  const humanReadableDecision = buildHumanReadableDecision(policy, metrics, payload, profile);
  const userFacingMessage =
    policy === "answer"
      ? ""
      : policy === "clarify"
        ? buildClarifyingQuestion(payload, metrics, profile)
        : buildNoAnswerMessage(payload, metrics, profile);

  return {
    policy,
    shouldAnswer: policy === "answer",
    shouldAskClarifyingQuestion: policy === "clarify",
    shouldReturnNoAnswer: policy === "no_answer",
    reasonCodes,
    humanReadableDecision,
    userFacingMessage,
  };
}

function buildRetrievalDecisionTrace(payload = {}, answerability = computeAnswerability(payload), decision = null) {
  const resolvedDecision = decision || decideNoAnswerPolicy(payload, answerability);
  const profile = answerability.profile || resolveRetrievalThresholdProfile(payload.questionIntent, payload);
  const metrics = answerability.metrics || collectRetrievalMetrics(payload, profile);

  return {
    policy: resolvedDecision.policy,
    shouldAnswer: resolvedDecision.shouldAnswer,
    shouldAskClarifyingQuestion: resolvedDecision.shouldAskClarifyingQuestion,
    shouldReturnNoAnswer: resolvedDecision.shouldReturnNoAnswer,
    confidence: answerability.confidence,
    answerabilityScore: answerability.answerabilityScore,
    reasonCodes: resolvedDecision.reasonCodes,
    humanReadableDecision: resolvedDecision.humanReadableDecision,
    thresholdProfile: {
      intent: profile.intent,
      minAnswerability: profile.minAnswerability,
      minClarifyAnswerability: profile.minClarifyAnswerability,
      minTopScore: profile.minTopScore,
      minAggregateScore: profile.minAggregateScore,
      minSelectedConfidence: profile.minSelectedConfidence,
      minTopFocusScore: profile.minTopFocusScore,
      strongSingleSourceTopScore: profile.strongSingleSourceTopScore,
      requirePrimaryLawSource: profile.requirePrimaryLawSource,
      preferDocumentSource: profile.preferDocumentSource,
    },
    metrics: {
      selectedCount: metrics.selectedCount,
      databaseMatchCount: metrics.databaseMatchCount,
      topScore: metrics.topScore,
      secondScore: metrics.secondScore,
      aggregateScore: metrics.aggregateScore,
      selectedConfidence: metrics.selectedConfidence,
      dbConfidence: metrics.dbConfidence,
      lowConfidence: metrics.lowConfidence,
      authoritativeCount: metrics.authoritativeCount,
      primaryLawCount: metrics.primaryLawCount,
      documentCount: metrics.documentCount,
      internetCount: metrics.internetCount,
      internetOnly: metrics.internetOnly,
      contextCarryCount: metrics.contextCarryCount,
      matchedReferenceCount: metrics.matchedReferenceCount,
      topMatchedReference: metrics.topMatchedReference,
      topFocusScore: metrics.topFocusScore,
      avgFocusScore: metrics.avgFocusScore,
      strongFocusCount: metrics.strongFocusCount,
      weakFocusCount: metrics.weakFocusCount,
      freshCount: metrics.freshCount,
      staleCount: metrics.staleCount,
      ambiguousFollowUp: metrics.ambiguousFollowUp,
      shortQuery: metrics.shortQuery,
      lowContextQuery: metrics.lowContextQuery,
      explicitTopicCount: metrics.explicitTopicCount,
      explicitTopics: metrics.explicitTopics,
      currentOrExternalQuestion: metrics.currentOrExternalQuestion,
      strongSingleSource: metrics.strongSingleSource,
      usedInternetFallback: metrics.usedInternetFallback,
      usedInternetSearch: metrics.usedInternetSearch,
    },
    components: answerability.components,
    penalties: answerability.penalties,
    queryRewrite: payload.queryRewriteTrace
      ? {
          method: payload.queryRewriteTrace.method || "",
          selectedType: payload.queryRewriteTrace.selectedType || "",
          selectedQuery: payload.queryRewriteTrace.selectedQuery || "",
          effectiveQuery: payload.queryRewriteTrace.effectiveQuery || "",
          summary: payload.queryRewriteTrace.summary || "",
          ambiguousFollowUp: Boolean(payload.queryRewriteTrace.ambiguousFollowUp),
        }
      : null,
  };
}

function evaluateRetrievalResult(payload = {}) {
  const profile = resolveRetrievalThresholdProfile(payload.questionIntent, payload);
  const answerability = computeAnswerability(payload, profile);
  const decision = decideNoAnswerPolicy(payload, answerability);

  return {
    policy: decision.policy,
    shouldAnswer: decision.shouldAnswer,
    shouldAskClarifyingQuestion: decision.shouldAskClarifyingQuestion,
    shouldReturnNoAnswer: decision.shouldReturnNoAnswer,
    confidence: answerability.confidence,
    answerabilityScore: answerability.answerabilityScore,
    reasonCodes: decision.reasonCodes,
    humanReadableDecision: decision.humanReadableDecision,
    userFacingMessage: decision.userFacingMessage,
    profile,
    metrics: answerability.metrics,
    trace: buildRetrievalDecisionTrace(payload, answerability, decision),
  };
}

module.exports = {
  buildRetrievalDecisionTrace,
  computeAnswerability,
  decideNoAnswerPolicy,
  evaluateRetrievalResult,
  resolveRetrievalThresholdProfile,
};
