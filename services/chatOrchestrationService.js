const LawChatbotSuggestedQuestionModel = require("../models/lawChatbotSuggestedQuestionModel");
const LawChatbotPdfChunkModel = require("../models/lawChatbotPdfChunkModel");
const UserSearchHistoryModel = require("../models/userSearchHistoryModel");
const { wantsExplanation } = require("./chatAnswerService");
const {
  isStandaloneLawLookup,
  looksLikeFollowUpQuestion,
  resolveMessageWithContext,
  startsWithFollowUpLead,
} = require("./contextService");
const {
  buildQueryRewriteCandidates,
  buildQueryRewriteTrace,
} = require("./queryRewriteService");
const {
  computeDbConfidence,
  isClearlyCurrentOrExternalQuestion,
  isLowConfidenceDatabaseResult,
  resolveSearchTarget,
  isSimpleQuestion,
  scoreMatchSet,
  searchDatabaseSources,
  sortByScore,
} = require("./sourceSelectionService");
const {
  canUseSearchHistory,
  getPlanConfig,
  normalizePlanCode,
  resolveUserPlanContext,
  shouldUseAIForPlan,
} = require("./planService");
const { extractExplicitTopicHints, normalizeForSearch } = require("./thaiTextUtils");

const CHAT_REQUEST_TIMEOUT_MS = Number(process.env.CHAT_REQUEST_TIMEOUT_MS || 25000);
const CHAT_BUDGET_BUFFER_MS = Number(process.env.CHAT_BUDGET_BUFFER_MS || 3000);
const CHAT_REPLY_BUDGET_MS = Math.max(2000, CHAT_REQUEST_TIMEOUT_MS - CHAT_BUDGET_BUFFER_MS);
const MIN_CONTEXT_RESEARCH_BUDGET_MS = Number(process.env.LAW_CHATBOT_CONTEXT_RESEARCH_MIN_BUDGET_MS || 7000);
const THREE_LAYER_FALLBACK_MESSAGE = "ขออภัย ขณะนี้ยังไม่พบข้อมูลที่ตรงกับคำถามนี้";

function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function getRemainingBudgetMs(startedAt, totalBudgetMs = CHAT_REPLY_BUDGET_MS) {
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.max(0, Math.round(totalBudgetMs - (nowMs() - startedAt)));
}

function resolveChatPlanContext(session, options = {}) {
  const aiAvailable = Boolean(options.aiAvailable);
  const baseUser =
    session?.adminUser
      ? { plan: "premium" }
      : session?.user || { plan: "free" };
  const configuredContext = resolveUserPlanContext(baseUser);
  const effectiveUseAI = aiAvailable && configuredContext.useAI;
  const effectiveUseInternet = effectiveUseAI && configuredContext.useInternet;
  const promptProfile = effectiveUseAI
    ? configuredContext.promptProfile
    : {
        ...configuredContext.promptProfile,
        code: configuredContext.code === "free" ? "template" : "dbonly",
        aiSourceLimit: 0,
      };

  return {
    ...configuredContext,
    useAI: effectiveUseAI,
    useInternet: effectiveUseInternet,
    promptProfile,
  };
}

function isTruthyFlag(value) {
  if (value === true) {
    return true;
  }

  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
}

function applyEconomyDatabaseOnlyMode(planContext, message, databaseMatches, questionIntent) {
  if (!planContext?.useAI) {
    return {
      ...planContext,
      answerMode: "db_only",
    };
  }

  if (questionIntent === "qa") {
    return {
      ...planContext,
      useAI: false,
      useInternet: false,
      promptProfile: {
        ...planContext.promptProfile,
        code: `prepared-qa-${planContext.promptProfile?.code || planContext.code || "plan"}`,
        aiSourceLimit: 0,
      },
      answerMode: "prepared_qa_db_only",
    };
  }

  const shouldUseAI = shouldUseAIForPlan(planContext.code, {
    dbConfidence: computeDbConfidence(databaseMatches, questionIntent),
    simpleQuestion: isSimpleQuestion(message, questionIntent),
    needsExplain: wantsExplanation(message),
    fewResults: (Array.isArray(databaseMatches) ? databaseMatches.length : 0) < 2,
    isCurrentOrExternalQuestion: isClearlyCurrentOrExternalQuestion(message),
  });

  if (shouldUseAI) {
    return {
      ...planContext,
      answerMode: "ai",
    };
  }

  return {
    ...planContext,
    useAI: false,
    useInternet: false,
    promptProfile: {
      ...planContext.promptProfile,
      code: `dbonly-${planContext.promptProfile?.code || planContext.code || "plan"}`,
      aiSourceLimit: 0,
    },
    answerMode: "economy_db_only",
  };
}

function shouldUseAnswerCache(message) {
  const text = String(message || "").trim();
  return Boolean(text) && !looksLikeFollowUpQuestion(text) && !isStandaloneLawLookup(text);
}

function buildManagedSuggestedQuestionSource(match = {}) {
  return {
    id: match.id || null,
    target: match.target || "all",
    title: match.questionText || "",
    reference: match.sourceReference || match.questionText || "คำถามแนะนำ",
    content: match.answerText || "",
    source: "managed_suggested_question",
    comment: "คำตอบที่ผู้ดูแลกำหนดไว้ล่วงหน้า",
    score: 1000,
  };
}

function formatManagedSuggestedQuestionAnswer(match = {}) {
  const answerText = String(match.answerText || "").trim();
  const sourceReference = String(match.sourceReference || "").trim();

  if (!answerText || !sourceReference || /แหล่งอ้างอิง\s*:/i.test(answerText)) {
    return answerText;
  }

  const referenceLines = sourceReference
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!referenceLines.length) {
    return answerText;
  }

  return `${answerText}\n\nแหล่งอ้างอิง:\n${referenceLines.map((line) => `- ${line}`).join("\n")}`;
}

function buildSeededLegalAnswerSource(entry = {}) {
  return {
    id: entry.id || entry.key || null,
    target: "all",
    title: entry.questionText || "",
    reference: entry.sourceReference || entry.questionText || "คำตอบกฎหมายเฉพาะเรื่อง",
    content: entry.answerText || "",
    source: "managed_suggested_question",
    comment: "คำตอบกฎหมายเฉพาะเรื่องที่ระบบ seed ไว้เพื่อกันการตอบคลาดเคลื่อน",
    score: 1200,
  };
}

function findSeededLegalAnswer(message = "") {
  const normalizedMessage = normalizeForSearch(message).toLowerCase();
  if (!normalizedMessage) {
    return null;
  }

  const compactMessage = normalizedMessage.replace(/\s+/g, "");
  const mentionsCoopFormation =
    compactMessage.includes("จัดตั้งสหกรณ์") ||
    compactMessage.includes("การจัดตั้งสหกรณ์") ||
    compactMessage.includes("จดทะเบียนจัดตั้งสหกรณ์") ||
    compactMessage.includes("ผู้เริ่มก่อการสหกรณ์") ||
    compactMessage.includes("ผู้เริ่มก่อการ") ||
    compactMessage.includes("ผู้ซึ่งประสงค์จะเป็นสมาชิก") ||
    (compactMessage.includes("สหกรณ์") && compactMessage.includes("สมาชิก"));
  const asksMinimumMemberCount =
    compactMessage.includes("สมาชิกขั้นต่ำสหกรณ์") ||
    compactMessage.includes("อย่างน้อยกี่คน") ||
    compactMessage.includes("ต้องมีกี่คน") ||
    compactMessage.includes("ต้องมีสมาชิกกี่คน") ||
    compactMessage.includes("ไม่น้อยกว่า10คน") ||
    compactMessage.includes("ไม่น้อยกว่าสิบคน");
  const referencesSection33 =
    compactMessage.includes("มาตรา33") ||
    compactMessage.includes("มาตรา๓๓");

  if (!(referencesSection33 || (mentionsCoopFormation && asksMinimumMemberCount))) {
    return null;
  }

  const seededAnswer = {
    key: "coop_formation_minimum_members_section_33",
    questionText: "จำนวนสมาชิกขั้นต่ำในการจัดตั้งสหกรณ์",
    answerText:
      "การจัดตั้งสหกรณ์ต้องมีผู้ซึ่งประสงค์จะเป็นสมาชิกเข้าชื่อกันไม่น้อยกว่า 10 คน",
    sourceReference: "พระราชบัญญัติสหกรณ์ พ.ศ. 2542 มาตรา 33",
  };

  return {
    ...seededAnswer,
    answerText: formatManagedSuggestedQuestionAnswer(seededAnswer),
    topicHint: normalizeForSearch(seededAnswer.questionText).toLowerCase(),
    source: buildSeededLegalAnswerSource(seededAnswer),
  };
}

async function findManagedSuggestedQuestionMatch(message, target = "all") {
  const match = await LawChatbotSuggestedQuestionModel.findAnswerMatch(message, target);
  if (!match?.answerText) {
    return null;
  }

  return {
    ...match,
    answerText: formatManagedSuggestedQuestionAnswer(match),
    topicHint: normalizeForSearch(match.questionText || message).toLowerCase(),
    source: buildManagedSuggestedQuestionSource(match),
  };
}

function isThreeLayerChatFlowEnabled() {
  return String(process.env.DISABLE_AI || "").trim().toLowerCase() === "true" &&
    String(process.env.DISABLE_INTERNET || "").trim().toLowerCase() === "true";
}

function buildThreeLayerPdfSource(topResult = {}) {
  const keyword = String(topResult.keyword || "").trim();
  const chunkText = String(topResult.chunk_text || topResult.clean_text || "").trim();

  return {
    id: topResult.id || null,
    title: keyword || "pdf chunk",
    reference: keyword || chunkText || "pdf chunk",
    content: chunkText,
    source: "pdf_chunks",
    comment: "ผลลัพธ์จากการค้นหา pdf_chunks แบบ keyword-based",
    score: Number(topResult.score || 0),
    document_id: topResult.document_id || null,
    keyword,
    chunk_text: chunkText,
  };
}

function buildThreeLayerHighlightTerms(message = "", source = null) {
  const terms = [];
  const keyword = String(source?.keyword || "").trim();
  if (keyword) {
    terms.push(keyword);
  }

  const messageTerms = String(message || "")
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean)
    .slice(0, 6);

  return Array.from(new Set([...terms, ...messageTerms])).slice(0, 8);
}

async function resolveThreeLayerChatResponse(message, target = "all", options = {}) {
  if (!isThreeLayerChatFlowEnabled()) {
    return null;
  }

  const normalizedMessage = String(message || "").trim();
  if (!normalizedMessage) {
    return {
      answerMode: "generic",
      selectedSourceTier: "fallback",
      hasContext: false,
      answer: THREE_LAYER_FALLBACK_MESSAGE,
      highlightTerms: [],
      usedFollowUpContext: false,
      usedInternetFallback: false,
      fromCache: false,
      sources: [],
    };
  }
  const effectiveTarget = resolveSearchTarget(normalizedMessage, target);

  const seededLegalAnswer = findSeededLegalAnswer(normalizedMessage);
  if (seededLegalAnswer) {
    return {
      answerMode: "managed_answer",
      selectedSourceTier: "managed_suggested_question",
      hasContext: true,
      answer: seededLegalAnswer.answerText,
      highlightTerms: buildThreeLayerHighlightTerms(normalizedMessage, seededLegalAnswer.source),
      usedFollowUpContext: false,
      usedInternetFallback: false,
      fromCache: false,
      sources: [seededLegalAnswer.source],
    };
  }

  const managedSuggestedQuestionMatch = await findManagedSuggestedQuestionMatch(normalizedMessage, effectiveTarget);
  if (managedSuggestedQuestionMatch) {
    return {
      answerMode: "managed_answer",
      selectedSourceTier: "managed_suggested_question",
      hasContext: true,
      answer: managedSuggestedQuestionMatch.answerText,
      highlightTerms: buildThreeLayerHighlightTerms(normalizedMessage, managedSuggestedQuestionMatch.source),
      usedFollowUpContext: false,
      usedInternetFallback: false,
      fromCache: false,
      sources: [managedSuggestedQuestionMatch.source],
    };
  }

  const searchLimit = Math.max(1, Number(options.searchLimit || 5));
  const pdfMatches = await LawChatbotPdfChunkModel.searchChunksSmart(normalizedMessage, searchLimit);
  const topResult = Array.isArray(pdfMatches) && pdfMatches.length > 0 ? pdfMatches[0] : null;
  if (topResult) {
    const source = buildThreeLayerPdfSource(topResult);
    const answer = String(topResult.chunk_text || topResult.clean_text || topResult.keyword || "").trim();
    if (!answer) {
      return {
        answerMode: "generic",
        selectedSourceTier: "fallback",
        hasContext: false,
        answer: THREE_LAYER_FALLBACK_MESSAGE,
        highlightTerms: buildThreeLayerHighlightTerms(normalizedMessage),
        usedFollowUpContext: false,
        usedInternetFallback: false,
        fromCache: false,
        sources: [],
      };
    }

    return {
      answerMode: "db_only",
      selectedSourceTier: "pdf_chunks",
      hasContext: Boolean(answer),
      answer,
      highlightTerms: buildThreeLayerHighlightTerms(normalizedMessage, source),
      usedFollowUpContext: false,
      usedInternetFallback: false,
      fromCache: false,
      sources: [source],
    };
  }

  return {
    answerMode: "generic",
    selectedSourceTier: "fallback",
    hasContext: false,
    answer: THREE_LAYER_FALLBACK_MESSAGE,
    highlightTerms: buildThreeLayerHighlightTerms(normalizedMessage),
    usedFollowUpContext: false,
    usedInternetFallback: false,
    fromCache: false,
    sources: [],
  };
}

function shouldPersistDbAnswerCache(answer, options = {}) {
  const text = String(answer || "").trim();
  if (!text || options.debugMode) {
    return false;
  }

  return !/(เข้าสู่ระบบด้วย google|guest ครบ|ใช้สิทธิ์ถามคำถามครบ|อัปเกรดแพ็กเกจ|อัปเกรดแพลน|mock ai|โหมดทดสอบ)/i.test(
    text,
  );
}

function buildDbCachedChatResult(cacheEntry, message) {
  const metadata = cacheEntry?.metadata || {};
  const highlightTerms = Array.isArray(metadata.highlightTerms)
    ? metadata.highlightTerms
    : String(message || "")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 8);

  return {
    hasContext: metadata.hasContext !== false,
    answer: String(cacheEntry?.answer_text || "").trim(),
    highlightTerms,
    usedFollowUpContext: false,
    usedInternetFallback: Boolean(metadata.usedInternetFallback),
    responseMeta: metadata.responseMeta || null,
    fromCache: true,
  };
}

function getFollowUpResolutionProfile(planCode = "free") {
  const normalizedPlanCode = normalizePlanCode(planCode);

  if (normalizedPlanCode === "free") {
    return {
      contextScoreBuffer: 5,
      contextScoreMultiplier: 1.1,
      shortFollowUpContextScoreBuffer: 1,
      shortFollowUpContextScoreMultiplier: 1.02,
      minimumContextTopScore: 44,
      allowStrongerContextCarry: true,
    };
  }

  if (normalizedPlanCode === "premium") {
    return {
      contextScoreBuffer: 0,
      contextScoreMultiplier: 1.0,
      shortFollowUpContextScoreBuffer: 0,
      shortFollowUpContextScoreMultiplier: 1.0,
      minimumContextTopScore: 44,
      allowStrongerContextCarry: true,
    };
  }

  if (normalizedPlanCode === "pro") {
    return {
      contextScoreBuffer: 4,
      contextScoreMultiplier: 1.08,
      shortFollowUpContextScoreBuffer: 1,
      shortFollowUpContextScoreMultiplier: 1.02,
      minimumContextTopScore: 46,
      allowStrongerContextCarry: true,
    };
  }

  return {
    contextScoreBuffer: 8,
    contextScoreMultiplier: 1.2,
    shortFollowUpContextScoreBuffer: 2,
    shortFollowUpContextScoreMultiplier: 1.05,
    minimumContextTopScore: 48,
    allowStrongerContextCarry: false,
  };
}

function shouldSearchInternetForPlan(planCode, message, matches, questionIntent = "general") {
  const config = getPlanConfig(planCode);
  if (!config.useInternet) {
    return false;
  }

  const normalizedMessage = String(message || "").trim();
  const currentOrExternal = isClearlyCurrentOrExternalQuestion(normalizedMessage);
  const lowConfidence = isLowConfidenceDatabaseResult(matches, questionIntent);
  const topScore = Number(sortByScore(matches)[0]?.score || 0);
  const mostlyInternalQuestion =
    !currentOrExternal &&
    (questionIntent === "law_section" || questionIntent === "document" || questionIntent === "short_answer");

  if (mostlyInternalQuestion) {
    return false;
  }

  if (config.internetMode === "full") {
    return currentOrExternal || lowConfidence || (questionIntent === "general" && topScore < 78);
  }

  return currentOrExternal || lowConfidence;
}

async function resolveSearchPlan(message, target, session, options = {}) {
  const baseMessage = String(message || "").trim();
  const effectiveTarget = resolveSearchTarget(baseMessage, target);
  const followUpProfile = getFollowUpResolutionProfile(options.planCode || "free");
  const contextualCandidate = resolveMessageWithContext(baseMessage, effectiveTarget, session);
  const baseTopicHints = extractExplicitTopicHints(baseMessage);
  const implicitFollowUpQuestion =
    contextualCandidate.usedContext &&
    baseTopicHints.length === 0 &&
    (
      baseMessage.length <= 18 ||
      startsWithFollowUpLead(baseMessage) ||
      /(อำนาจหน้าที่|มีหน้าที่|หน้าที่|คุณสมบัติ|ลักษณะต้องห้าม|ขาดจากการเป็น|ต้องทำอย่างไร|ทำอย่างไร|อย่างไร|ยังไง)/.test(
        baseMessage,
      )
    );
  const shortFollowUpBias =
    contextualCandidate.usedContext &&
    (
      baseMessage.length <= 18 ||
      startsWithFollowUpLead(baseMessage) ||
      (
        /(อำนาจหน้าที่|มีหน้าที่|หน้าที่|คุณสมบัติ|ลักษณะต้องห้าม|ขาดจากการเป็น)/.test(baseMessage) &&
        baseTopicHints.length === 0
      )
    );
  const { ambiguousFollowUp, candidates } = await buildQueryRewriteCandidates(
    baseMessage,
    effectiveTarget,
    session,
    contextualCandidate,
  );
  const candidateResults = await Promise.all(
    candidates.map(async (candidate) => {
      const matches = await searchDatabaseSources(candidate.retrievalQuery || candidate.query, effectiveTarget, {
        ...options,
        originalMessage: baseMessage,
      });

      return {
        ...candidate,
        matches,
        matchCount: matches.length,
        topScore: Number(matches[0]?.score || 0),
        score: scoreMatchSet(matches),
      };
    }),
  );
  const standaloneResult =
    candidateResults.find((candidate) => candidate.type === "original") || {
      query: baseMessage,
      effectiveQuery: baseMessage,
      retrievalQuery: baseMessage,
      expandedKeywords: [],
      legalAliases: [],
      type: "original",
      reason: "original user query",
      matches: [],
      matchCount: 0,
      topScore: 0,
      score: 0,
    };
  const buildSearchPlanResult = (candidate, resolvedContext, decision) => ({
    effectiveMessage: candidate.effectiveQuery || candidate.query || baseMessage,
    matches: Array.isArray(candidate.matches) ? candidate.matches : [],
    resolvedContext,
    queryRewriteTrace: buildQueryRewriteTrace(baseMessage, candidateResults, candidate, {
      decision,
      usedContext: Boolean(resolvedContext?.usedContext),
      ambiguousFollowUp,
      implicitFollowUpQuestion,
      shortFollowUpBias,
    }),
  });
  const rewrittenResults = candidateResults
    .filter((candidate) => candidate.type !== "original")
    .sort((left, right) => {
      const scoreDiff = Number(right.score || 0) - Number(left.score || 0);
      if (scoreDiff !== 0) {
        return scoreDiff;
      }

      return Number(right.topScore || 0) - Number(left.topScore || 0);
    });
  const bestRewriteResult = rewrittenResults[0];
  const standaloneMatches = standaloneResult.matches;
  const standaloneScore = Number(standaloneResult.score || 0);
  const standaloneTopScore = Number(standaloneResult.topScore || 0);

  if (!contextualCandidate.usedContext) {
    if (
      bestRewriteResult &&
      bestRewriteResult.matches.length > 0 &&
      (
        standaloneMatches.length === 0 ||
        Number(bestRewriteResult.topScore || 0) >= standaloneTopScore + 8 ||
        Number(bestRewriteResult.score || 0) >= standaloneScore * 1.12
      )
    ) {
      return buildSearchPlanResult(
        bestRewriteResult,
        {
          ...contextualCandidate,
          effectiveMessage: bestRewriteResult.effectiveQuery || bestRewriteResult.query || baseMessage,
          usedContext: (bestRewriteResult.effectiveQuery || bestRewriteResult.query || baseMessage) !== baseMessage,
        },
        `selected_${bestRewriteResult.type || "rewrite"}`,
      );
    }

    return buildSearchPlanResult(
      standaloneResult,
      contextualCandidate,
      candidateResults.length > 1 ? "original_outperformed_rewrites" : "original_only",
    );
  }
  const bestContextualResult = bestRewriteResult;

  const remainingBudgetMs = getRemainingBudgetMs(options.requestStartedAt, options.totalBudgetMs);
  if (remainingBudgetMs < MIN_CONTEXT_RESEARCH_BUDGET_MS) {
    return buildSearchPlanResult(
      standaloneResult,
      {
        ...contextualCandidate,
        effectiveMessage: baseMessage,
        usedContext: false,
      },
      "budget_preserved_original",
    );
  }

  if (!bestContextualResult) {
    return buildSearchPlanResult(
      standaloneResult,
      {
        ...contextualCandidate,
        effectiveMessage: baseMessage,
        usedContext: false,
      },
      "no_contextual_candidate",
    );
  }

  const contextualMatches = bestContextualResult.matches;
  const contextualScore = Number(bestContextualResult.score || 0);
  const contextualTopScore = Number(bestContextualResult.topScore || 0);
  const contextScoreBuffer = shortFollowUpBias
    ? followUpProfile.shortFollowUpContextScoreBuffer
    : followUpProfile.contextScoreBuffer;
  const contextScoreMultiplier = shortFollowUpBias
    ? followUpProfile.shortFollowUpContextScoreMultiplier
    : followUpProfile.contextScoreMultiplier;
  const shouldPreferShortFollowUpContext =
    shortFollowUpBias &&
    contextualMatches.length > 0 &&
    (
      standaloneMatches.length === 0 ||
      contextualTopScore >= Math.max(followUpProfile.minimumContextTopScore, standaloneTopScore * 0.75) ||
      contextualScore >= Math.max(60, standaloneScore - 18)
    );
  const shouldUseContext =
    contextualMatches.length > 0 &&
    (implicitFollowUpQuestion ||
      shouldPreferShortFollowUpContext ||
      (
        followUpProfile.allowStrongerContextCarry &&
        contextualCandidate.usedContext &&
        contextualTopScore >= Math.max(followUpProfile.minimumContextTopScore, standaloneTopScore * 0.7)
      ) ||
      standaloneMatches.length === 0 ||
      contextualScore >= standaloneScore + contextScoreBuffer ||
      contextualScore >= standaloneScore * contextScoreMultiplier);

  if (!shouldUseContext) {
    return buildSearchPlanResult(
      standaloneResult,
      {
        ...contextualCandidate,
        effectiveMessage: baseMessage,
        usedContext: false,
      },
      "original_outperformed_context",
    );
  }

  return buildSearchPlanResult(
    bestContextualResult,
    {
      ...contextualCandidate,
      effectiveMessage: bestContextualResult.effectiveQuery || bestContextualResult.query || contextualCandidate.effectiveMessage,
      usedContext: (bestContextualResult.effectiveQuery || bestContextualResult.query || baseMessage) !== baseMessage,
    },
    `selected_${bestContextualResult.type || "contextual"}`,
  );
}

function buildSearchHistoryPreview(answer) {
  const text = String(answer || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }

  if (text.length <= 500) {
    return text;
  }

  return `${text.slice(0, 500).trim()}...`;
}

async function recordUserSearchHistory(session, planContext, payload = {}) {
  const sessionUser = session?.user || null;
  const userId = Number(sessionUser?.userId || sessionUser?.id || 0);
  const questionText = String(payload.questionText || "").trim();
  if (!userId || !questionText) {
    return;
  }

  const userPlanCode = normalizePlanCode(sessionUser?.plan || planContext?.code || "free");
  if (!canUseSearchHistory(userPlanCode)) {
    return;
  }

  const userPlanContext = resolveUserPlanContext({ plan: userPlanCode });
  const retentionDays = Math.max(0, Number(userPlanContext.searchHistoryRetentionDays || 0));
  if (retentionDays <= 0) {
    return;
  }

  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + retentionDays * 24 * 60 * 60 * 1000);

  try {
    await UserSearchHistoryModel.create({
      userId,
      planCode: userPlanCode,
      target: payload.target || "all",
      questionText,
      answerPreview: buildSearchHistoryPreview(payload.answerText || ""),
      createdAt,
      expiresAt,
    });
  } catch (error) {
    console.error("[recordUserSearchHistory] Failed to save search history:", error.message || error);
  }
}

module.exports = {
  applyEconomyDatabaseOnlyMode,
  buildDbCachedChatResult,
  findManagedSuggestedQuestionMatch,
  getRemainingBudgetMs,
  isTruthyFlag,
  nowMs,
  recordUserSearchHistory,
  resolveChatPlanContext,
  resolveThreeLayerChatResponse,
  resolveSearchPlan,
  shouldPersistDbAnswerCache,
  shouldSearchInternetForPlan,
  shouldUseAnswerCache,
};
