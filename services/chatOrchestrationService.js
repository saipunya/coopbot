const LawChatbotSuggestedQuestionModel = require("../models/lawChatbotSuggestedQuestionModel");
const UserSearchHistoryModel = require("../models/userSearchHistoryModel");
const { wantsExplanation } = require("./chatAnswerService");
const {
  getSessionContext,
  isStandaloneLawLookup,
  looksLikeFollowUpQuestion,
  resolveMessageWithContext,
  startsWithFollowUpLead,
} = require("./contextService");
const {
  computeDbConfidence,
  isClearlyCurrentOrExternalQuestion,
  isLowConfidenceDatabaseResult,
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
const {
  extractExplicitTopicHints,
  normalizeForSearch,
} = require("./thaiTextUtils");

const CHAT_REQUEST_TIMEOUT_MS = Number(process.env.CHAT_REQUEST_TIMEOUT_MS || 25000);
const CHAT_BUDGET_BUFFER_MS = Number(process.env.CHAT_BUDGET_BUFFER_MS || 3000);
const CHAT_REPLY_BUDGET_MS = Math.max(2000, CHAT_REQUEST_TIMEOUT_MS - CHAT_BUDGET_BUFFER_MS);
const MIN_CONTEXT_RESEARCH_BUDGET_MS = Number(process.env.LAW_CHATBOT_CONTEXT_RESEARCH_MIN_BUDGET_MS || 7000);

function normalizeRewriteQuery(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function stripFollowUpLeadText(message) {
  return normalizeRewriteQuery(
    String(message || "").replace(
      /^(ตกลง|แล้ว|แล้วถ้า|ส่วน|ประเด็นนี้|กรณีนี้|สรุปแล้ว|ท้ายที่สุด|เรื่องนี้|หัวข้อนี้)\s*/i,
      "",
    ),
  );
}

function getRecentRewriteAnchors(session, target) {
  const recent = getSessionContext(session).find((item) => item && item.target === target);
  const recentTopic = Array.isArray(recent?.topicHints) ? String(recent.topicHints[0] || "").trim() : "";
  const sourceAnchors = (Array.isArray(recent?.focusSources) ? recent.focusSources : [])
    .map((source) => String(source.reference || source.title || source.lawNumber || source.keyword || "").trim())
    .filter((value) => value && value.length >= 4)
    .slice(0, 2);

  return {
    recentTopic,
    sourceAnchors,
  };
}

function isAmbiguousFollowUpQuestion(message, contextualCandidate = {}) {
  const text = normalizeRewriteQuery(message);
  if (!text) {
    return false;
  }

  if (contextualCandidate?.usedContext) {
    return true;
  }

  if (text.length <= 18) {
    return true;
  }

  if (startsWithFollowUpLead(text)) {
    return true;
  }

  return (
    extractExplicitTopicHints(text).length === 0 &&
    /(มาตราไหน|ข้อไหน|วรรคไหน|อันไหน|แบบไหน|เรื่องนี้|กรณีนี้|อย่างไร|ยังไง|ได้ไหม|ได้หรือไม่|มีหน้าที่|คุณสมบัติ|ลักษณะต้องห้าม)/.test(
      text,
    )
  );
}

function buildQueryRewriteCandidates(message, target, session, contextualCandidate = {}) {
  const baseMessage = normalizeRewriteQuery(message);
  const strippedMessage = stripFollowUpLeadText(baseMessage) || baseMessage;
  const { recentTopic, sourceAnchors } = getRecentRewriteAnchors(session, target);
  const topicAnchor = String(contextualCandidate?.topicHints?.[0] || recentTopic || "").trim();
  const ambiguousFollowUp = isAmbiguousFollowUpQuestion(baseMessage, contextualCandidate);
  const asksLawSection = /(มาตรา|ข้อ|วรรค|อนุมาตรา|มาตราไหน|ข้อไหน)/.test(baseMessage);
  const seen = new Set();
  const candidates = [];

  const pushCandidate = (query, metadata = {}) => {
    const normalizedQuery = normalizeRewriteQuery(query);
    const normalizedKey = normalizedQuery.toLowerCase();
    if (!normalizedQuery || seen.has(normalizedKey)) {
      return;
    }

    seen.add(normalizedKey);
    candidates.push({
      query: normalizedQuery,
      type: metadata.type || "original",
      reason: metadata.reason || "",
    });
  };

  pushCandidate(baseMessage, {
    type: "original",
    reason: "original user query",
  });

  if (contextualCandidate?.usedContext && contextualCandidate.effectiveMessage && contextualCandidate.effectiveMessage !== baseMessage) {
    pushCandidate(contextualCandidate.effectiveMessage, {
      type: "contextual",
      reason: "session follow-up context",
    });
  }

  if (ambiguousFollowUp && topicAnchor) {
    pushCandidate(`${topicAnchor} ${strippedMessage}`, {
      type: "topic_anchor",
      reason: "recent topic anchor",
    });
  }

  if (ambiguousFollowUp && sourceAnchors.length > 0 && (asksLawSection || strippedMessage.length <= 40)) {
    pushCandidate(`${sourceAnchors[0]} ${strippedMessage}`, {
      type: "source_anchor",
      reason: "recent source anchor",
    });
  }

  return {
    ambiguousFollowUp,
    candidates: candidates.slice(0, 4),
  };
}

function buildQueryRewriteTrace(baseMessage, candidateResults, selectedCandidate, options = {}) {
  return {
    originalQuery: baseMessage,
    selectedQuery: selectedCandidate?.query || baseMessage,
    selectedType: selectedCandidate?.type || "original",
    decision: options.decision || "",
    usedContext: Boolean(options.usedContext),
    ambiguousFollowUp: Boolean(options.ambiguousFollowUp),
    implicitFollowUpQuestion: Boolean(options.implicitFollowUpQuestion),
    shortFollowUpBias: Boolean(options.shortFollowUpBias),
    candidates: (Array.isArray(candidateResults) ? candidateResults : []).map((candidate) => ({
      type: candidate.type || "original",
      query: candidate.query || "",
      reason: candidate.reason || "",
      matchCount: Number(candidate.matchCount || 0),
      topScore: Number(candidate.topScore || 0),
      aggregateScore: Number(candidate.score || 0),
      selected:
        candidate.type === selectedCandidate?.type &&
        candidate.query === selectedCandidate?.query,
    })),
  };
}

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
    reference: match.questionText || "คำถามแนะนำ",
    content: match.answerText || "",
    source: "managed_suggested_question",
    comment: "คำตอบที่ผู้ดูแลกำหนดไว้ล่วงหน้า",
    score: 1000,
  };
}

async function findManagedSuggestedQuestionMatch(message, target = "all") {
  const match = await LawChatbotSuggestedQuestionModel.findAnswerMatch(message, target);
  if (!match?.answerText) {
    return null;
  }

  return {
    ...match,
    topicHint: normalizeForSearch(match.questionText || message).toLowerCase(),
    source: buildManagedSuggestedQuestionSource(match),
  };
}

function shouldPersistDbAnswerCache(answer, options = {}) {
  const text = String(answer || "").trim();
  if (!text || options.debugMode) {
    return false;
  }

  return !/(เข้าสู่ระบบด้วย google|guest ครบ|ใช้สิทธิ์ถามคำถามครบ|อัปเกรดแพลน|mock ai|โหมดทดสอบ)/i.test(
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
  const followUpProfile = getFollowUpResolutionProfile(options.planCode || "free");
  const contextualCandidate = resolveMessageWithContext(baseMessage, target, session);
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
  const { ambiguousFollowUp, candidates } = buildQueryRewriteCandidates(
    baseMessage,
    target,
    session,
    contextualCandidate,
  );
  const candidateResults = await Promise.all(
    candidates.map(async (candidate) => {
      const matches = await searchDatabaseSources(candidate.query, target, {
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
      type: "original",
      reason: "original user query",
      matches: [],
      matchCount: 0,
      topScore: 0,
      score: 0,
    };
  const buildSearchPlanResult = (candidate, resolvedContext, decision) => ({
    effectiveMessage: candidate.query || baseMessage,
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
          effectiveMessage: bestRewriteResult.query || baseMessage,
          usedContext: (bestRewriteResult.query || baseMessage) !== baseMessage,
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
      effectiveMessage: bestContextualResult.query || contextualCandidate.effectiveMessage,
      usedContext: (bestContextualResult.query || baseMessage) !== baseMessage,
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
  resolveSearchPlan,
  shouldPersistDbAnswerCache,
  shouldSearchInternetForPlan,
  shouldUseAnswerCache,
};
