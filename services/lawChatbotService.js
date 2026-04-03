const LawChatbotModel = require("../models/lawChatbotModel");
const LawChatbotKnowledgeModel = require("../models/lawChatbotKnowledgeModel");
const LawChatbotKnowledgeSuggestionModel = require("../models/lawChatbotKnowledgeSuggestionModel");
const LawChatbotSuggestedQuestionModel = require("../models/lawChatbotSuggestedQuestionModel");
const LawChatbotFeedbackModel = require("../models/lawChatbotFeedbackModel");
const LawChatbotPdfChunkModel = require("../models/lawChatbotPdfChunkModel");
const LawChatbotAnswerCacheModel = require("../models/lawChatbotAnswerCacheModel");
const PaymentRequestModel = require("../models/paymentRequestModel");
const UserModel = require("../models/userModel");
const UserMonthlyUsageModel = require("../models/userMonthlyUsageModel");
const UserSearchHistoryModel = require("../models/userSearchHistoryModel");
const runtimeFlags = require("../config/runtimeFlags");
const { isAiEnabled } = require("./runtimeSettingsService");
const { getOpenAiConfig } = require("./openAiService");
const { buildQuestionCacheIdentity } = require("./lawChatbotAnswerCacheUtils");
const { sendPaymentRequestNotification } = require("./telegramService");
const { generateChatSummary, wantsExplanation } = require("./chatAnswerService");
const {
  getFollowUpCarrySources,
  isStandaloneLawLookup,
  looksLikeFollowUpQuestion,
  mergeUniqueSources,
  resolveMessageWithContext,
  startsWithFollowUpLead,
  storeConversationContext,
} = require("./contextService");
const {
  attachAiPreviewState,
  buildAiPreviewMeta,
  buildAnswerCacheKey,
  buildAnswerCacheScope,
  buildFreeAiPreviewPlanContext,
  clearAnswerCache,
  getCachedAnswer,
  setCachedAnswer,
} = require("./answerStateService");
const { recordUpload } = require("./uploadIngestionService");
const {
  classifyQuestionIntent,
  computeDbConfidence,
  isClearlyCurrentOrExternalQuestion,
  isLowConfidenceDatabaseResult,
  isSimpleQuestion,
  scoreMatchSet,
  searchDatabaseSources,
  selectTieredSources,
  sortByScore,
} = require("./sourceSelectionService");
const { searchInternetSources } = require("./internetSearchService");

const {
  canUseAiPreview,
  getPlanDurationDays,
  getPlanConfig,
  getPlanLabel,
  getPlanPriceBaht,
  getSearchHistoryRetentionLabel,
  isPaidPlan,
  listPurchasablePlans,
  listPlanComparisons,
  normalizePlanCode,
  resolveUserPlanContext,
  canUseSearchHistory,
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
const MIN_INTERNET_SEARCH_BUDGET_MS = Number(process.env.LAW_CHATBOT_INTERNET_SEARCH_MIN_BUDGET_MS || 5000);
const MIN_AI_SUMMARY_BUDGET_MS = Number(process.env.LAW_CHATBOT_AI_SUMMARY_MIN_BUDGET_MS || 2500);
const suggestionThrottleMap = new Map();

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

function cleanupSuggestionThrottle() {
  if (suggestionThrottleMap.size <= 200) {
    return;
  }

  for (const [key, value] of suggestionThrottleMap.entries()) {
    if (Date.now() - value.createdAt > 10 * 60 * 1000) {
      suggestionThrottleMap.delete(key);
    }
  }
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

  const standaloneMatches = await searchDatabaseSources(baseMessage, target, options);
  const standaloneScore = scoreMatchSet(standaloneMatches);

  if (!contextualCandidate.usedContext) {
    return {
      effectiveMessage: baseMessage,
      matches: standaloneMatches,
      resolvedContext: contextualCandidate,
    };
  }

  const remainingBudgetMs = getRemainingBudgetMs(options.requestStartedAt, options.totalBudgetMs);
  if (remainingBudgetMs < MIN_CONTEXT_RESEARCH_BUDGET_MS) {
    return {
      effectiveMessage: baseMessage,
      matches: standaloneMatches,
      resolvedContext: {
        ...contextualCandidate,
        effectiveMessage: baseMessage,
        usedContext: false,
      },
    };
  }

  const contextualMatches = await searchDatabaseSources(contextualCandidate.effectiveMessage, target, options);
  const contextualScore = scoreMatchSet(contextualMatches);
  const standaloneTopScore = Number(standaloneMatches[0]?.score || 0);
  const contextualTopScore = Number(contextualMatches[0]?.score || 0);
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
    return {
      effectiveMessage: baseMessage,
      matches: standaloneMatches,
      resolvedContext: {
        ...contextualCandidate,
        effectiveMessage: baseMessage,
        usedContext: false,
      },
    };
  }

  return {
    effectiveMessage: contextualCandidate.effectiveMessage,
    matches: contextualMatches,
    resolvedContext: contextualCandidate,
  };
}

async function collectAnswerSources(message, target, session, options = {}) {
  const startedAt = nowMs();
  const questionIntent = classifyQuestionIntent(message);
  const effectiveMessage = String(message || "").trim();
  const allowInternetFallback =
    typeof options.allowInternetFallback === "boolean"
      ? options.allowInternetFallback
      : await isAiEnabled();

  const searchPlan =
    options.searchPlan ||
    (await resolveSearchPlan(message, target, session, options));
  const afterDbSearchAt = nowMs();

  const resolvedEffectiveMessage = searchPlan.effectiveMessage || effectiveMessage;
  const carrySources = getFollowUpCarrySources(
    session,
    target,
    message,
    searchPlan.resolvedContext || {},
  );
  const databaseMatches = mergeUniqueSources(
    carrySources,
    Array.isArray(searchPlan.matches) ? searchPlan.matches : [],
  );
  const suppressInternetForFollowUpExplanation =
    carrySources.length > 0 &&
    searchPlan.resolvedContext?.usedContext === true &&
    wantsExplanation(message);
  const shouldSearchInternet =
    allowInternetFallback &&
    !suppressInternetForFollowUpExplanation &&
    shouldSearchInternetForPlan(options.planCode || "free", resolvedEffectiveMessage, databaseMatches, questionIntent);
  let internetMatches = [];
  const remainingBudgetBeforeInternetMs = getRemainingBudgetMs(
    options.requestStartedAt,
    options.totalBudgetMs,
  );
  const shouldSkipInternetForBudget =
    shouldSearchInternet && remainingBudgetBeforeInternetMs < MIN_INTERNET_SEARCH_BUDGET_MS;

  if (shouldSearchInternet && !shouldSkipInternetForBudget) {
    const internetTimeoutMs = Math.max(
  1000,
  remainingBudgetBeforeInternetMs - MIN_AI_SUMMARY_BUDGET_MS,
);
    internetMatches = await searchInternetSources(resolvedEffectiveMessage, target, {
      timeoutMs: internetTimeoutMs,
      limit: options.internetLimit,
    });
  }
  const afterInternetSearchAt = nowMs();

  const grouped = {
    structured_laws: databaseMatches.filter(
      (item) => item && (item.source === "tbl_laws" || item.source === "tbl_glaws"),
    ),
    admin_knowledge: databaseMatches.filter((item) => item && item.source === "admin_knowledge"),
    knowledge_suggestion: databaseMatches.filter((item) => item && item.source === "knowledge_suggestion"),
    vinichai: databaseMatches.filter((item) => item && item.source === "tbl_vinichai"),
    documents: databaseMatches.filter((item) => item && item.source === "documents"),
    pdf_chunks: databaseMatches.filter((item) => item && item.source === "pdf_chunks"),
    knowledge_base: databaseMatches.filter((item) => item && item.source === "knowledge_base"),
    internet: internetMatches,
  };

  const { selectedSourceTier, selectedSources } = selectTieredSources(grouped, questionIntent, {
    databaseOnlyMode: options.databaseOnlyMode === true,
    sourceLimit: options.sourceLimit,
    planCode: options.planCode,
    message,
    originalMessage: message,
  });
  const afterSourceSelectionAt = nowMs();
  const usedInternetFallback = selectedSources.some((item) => item && item.source === "internet_search");

  return {
    ...searchPlan,
    questionIntent,
    effectiveMessage: resolvedEffectiveMessage,
    databaseMatches,
    internetMatches,
    sources: selectedSources,
    selectedSourceTier,
    usedInternetFallback,
    usedInternetSearch: shouldSearchInternet && !shouldSkipInternetForBudget,
    skippedInternetSearch: shouldSkipInternetForBudget,
    allowInternetFallback,
    timing: {
      dbSearchMs: Math.round(afterDbSearchAt - startedAt),
      internetSearchMs: Math.round(afterInternetSearchAt - afterDbSearchAt),
      sourceSelectionMs: Math.round(afterSourceSelectionAt - afterInternetSearchAt),
      totalSourceCollectionMs: Math.round(afterSourceSelectionAt - startedAt),
      remainingBudgetBeforeInternetMs:
        remainingBudgetBeforeInternetMs === Number.POSITIVE_INFINITY ? null : remainingBudgetBeforeInternetMs,
      carrySourceCount: carrySources.length,
    },
  };
}

async function getDashboardData() {
  const [uploadedChunkCount, suggestedQuestions] = await Promise.all([
    LawChatbotPdfChunkModel.countChunks(),
    LawChatbotSuggestedQuestionModel.listActive(18, "all"),
  ]);

  return {
    appName: "Coopbot Law Chatbot",
    description: "ระบบต้นแบบสำหรับค้นหากฎหมายสหกรณ์และกลุ่มเกษตรกร พร้อมเก็บคำถามและข้อเสนอแนะ",
    status: "Knowledge base ready",
    conversationCount: LawChatbotModel.count(),
    uploadedPdfCount: LawChatbotPdfChunkModel.countDocuments(),
    uploadedChunkCount,
    recentConversations: LawChatbotModel.listRecent(6),
    suggestedQuestions,
  };
}

function enrichPaymentRequestRecord(record = {}) {
  const planCode = normalizePlanCode(record.plan_name || record.planName || "free");
  const currentPlanCode = normalizePlanCode(record.user_plan || "free");

  return {
    ...record,
    planCode,
    planLabel: getPlanLabel(planCode),
    userPlanCode: currentPlanCode,
    userPlanLabel: getPlanLabel(currentPlanCode),
    planPriceBaht: Number(record.amount || getPlanPriceBaht(planCode) || 0),
    userPlanExpiresAt: record.plan_expires_at || record.premium_expires_at || null,
  };
}

function listAdminManageablePlans() {
  const purchasable = listPurchasablePlans();
  return [
    {
      value: "free",
      code: "free",
      label: getPlanLabel("free"),
      priceBaht: 0,
      monthlyLimit: resolveUserPlanContext({ plan: "free" }).monthlyLimit,
      description: "ค้นฐานข้อมูลอย่างเดียว ไม่มี AI และไม่มี internet search",
    },
    ...purchasable,
  ];
}

function enrichAdminUserRecord(record = {}) {
  const planCode = normalizePlanCode(record.plan || "free");
  const planLabel = getPlanLabel(planCode);
  const expiresAt = record.plan_expires_at || record.premium_expires_at || null;
  const expiresDate = expiresAt ? new Date(expiresAt) : null;
  const now = new Date();
  const remainingDays =
    expiresDate instanceof Date && !Number.isNaN(expiresDate.getTime())
      ? Math.ceil((expiresDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
      : null;

  return {
    ...record,
    planCode,
    planLabel,
    planPriceBaht: getPlanPriceBaht(planCode),
    searchHistoryRetentionLabel: getSearchHistoryRetentionLabel(planCode),
    monthlyLimit: resolveUserPlanContext({ plan: planCode }).monthlyLimit,
    planExpiresAt: expiresAt,
    remainingDays,
    isExpired:
      remainingDays !== null &&
      Number.isFinite(remainingDays) &&
      remainingDays < 0,
  };
}

function buildSignedInProfile(signedInUser = {}, persistedUser = null) {
  if (!persistedUser) {
    return signedInUser;
  }

  return {
    ...signedInUser,
    id: persistedUser.id,
    userId: persistedUser.id,
    username: persistedUser.email,
    email: persistedUser.email,
    name: persistedUser.name || signedInUser.name || persistedUser.email,
    picture: persistedUser.avatar_url || signedInUser.picture || signedInUser.avatarUrl || "",
    avatarUrl: persistedUser.avatar_url || signedInUser.avatarUrl || signedInUser.picture || "",
    googleId: persistedUser.google_id || signedInUser.googleId || "",
    plan: persistedUser.plan || signedInUser.plan || "free",
    planStartedAt: persistedUser.plan_started_at || signedInUser.planStartedAt || null,
    planExpiresAt: persistedUser.plan_expires_at || signedInUser.planExpiresAt || null,
    status: persistedUser.status || signedInUser.status || "active",
    premiumExpiresAt: persistedUser.premium_expires_at || signedInUser.premiumExpiresAt || null,
  };
}

function buildSearchHistoryMeta(planContext = {}) {
  return {
    enabled: canUseSearchHistory(planContext.code),
    retentionDays: Math.max(0, Number(planContext.searchHistoryRetentionDays || 0)),
    retentionLabel: getSearchHistoryRetentionLabel(planContext.code),
  };
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

async function replyToChat(payload, session) {
  const startedAt = nowMs();
  const message = String(payload.message || "").trim();
  const target =
    payload.target === "group" ? "group" : payload.target === "coop" ? "coop" : "all";
  const debugMode =
    payload && (payload.debug === true || payload.debug === "true" || process.env.CHATBOT_DEBUG === "1");

  if (!message) {
    return {
      hasContext: false,
      answer: "กรุณาระบุคำถามหรือประเด็นที่ต้องการสอบถามก่อนส่งข้อความ",
      highlightTerms: [],
    };
  }

  const aiRuntimeEnabled = await isAiEnabled();
  const openAiConfig = getOpenAiConfig();
  const aiFeatureAvailable = aiRuntimeEnabled && Boolean(openAiConfig);
  const basePlanContext = resolveChatPlanContext(session, {
    aiAvailable: aiFeatureAvailable,
  });
  const sessionUser = session?.user || null;
  const userId = Number(sessionUser?.userId || sessionUser?.id || 0);
  const usageMonth = UserMonthlyUsageModel.getYearMonth();
  const freeAiPreviewUsage =
    userId && canUseAiPreview(basePlanContext.code)
      ? await UserMonthlyUsageModel.findByUserAndMonth(userId, usageMonth)
      : null;
  const freeAiPreviewMeta = buildAiPreviewMeta(basePlanContext, freeAiPreviewUsage);
  const aiPreviewRequested = isTruthyFlag(payload.aiPreview);
  const aiPreviewApproved = aiPreviewRequested && freeAiPreviewMeta.canTryPreview && aiFeatureAvailable;
  const runtimeSearchPlanCode = aiPreviewApproved ? "standard" : basePlanContext.code;

  if (aiPreviewRequested && freeAiPreviewMeta.enabled && !aiPreviewApproved) {
    const unavailableMessage = freeAiPreviewMeta.exhausted
      ? `คุณใช้สิทธิ์ลองคำตอบแบบ AI ฟรีครบ ${freeAiPreviewMeta.limit} ครั้งของเดือนนี้แล้ว หากต้องการใช้ AI ต่อเนื่อง แนะนำอัปเกรดเป็นแพ็กเกจ Standard`
      : "ขณะนี้ยังไม่สามารถใช้ AI preview ได้ กรุณาลองใหม่อีกครั้งในภายหลัง";
    return attachAiPreviewState(
      {
        hasContext: false,
        answer: unavailableMessage,
        highlightTerms: [],
        usedFollowUpContext: false,
        usedInternetFallback: false,
        fromCache: false,
      },
      {
        previewMeta: freeAiPreviewMeta,
      },
    );
  }

  const managedSuggestedQuestionMatch = aiPreviewApproved
    ? null
    : await findManagedSuggestedQuestionMatch(message, target);
  if (managedSuggestedQuestionMatch) {
    const highlightTerms = message.split(/\s+/).filter(Boolean).slice(0, 8);
    const matchedSource = managedSuggestedQuestionMatch.source;
    const answer = managedSuggestedQuestionMatch.answerText;

    storeConversationContext(
      session,
      target,
      message,
      message,
      [matchedSource],
      {
        usedContext: false,
        topicHints: [normalizeForSearch(managedSuggestedQuestionMatch.questionText || message).toLowerCase()],
      },
    );

    LawChatbotModel.create({
      message,
      effectiveMessage: message,
      target,
      answer,
      matchedSources: [
        {
          id: matchedSource.id || managedSuggestedQuestionMatch.id || managedSuggestedQuestionMatch.questionText,
          title: managedSuggestedQuestionMatch.questionText,
          lawNumber: "",
          source: matchedSource.source,
          url: "",
          score: Number(matchedSource.score || 0),
        },
      ],
    });

    const result = {
      hasContext: true,
      answer,
      highlightTerms,
      usedFollowUpContext: false,
      usedInternetFallback: false,
      fromCache: false,
    };

    if (debugMode) {
      result.debug = {
        selectedSourceTier: "managed_suggested_question",
        sourceCount: 1,
        databaseMatches: 0,
        internetMatches: 0,
        answerMode: "managed_answer",
        promptProfile: "managed",
        timing: {
          totalReplyMs: Math.round(nowMs() - startedAt),
        },
        sources: [
          {
            source: matchedSource.source,
            reference: matchedSource.reference,
            score: Number(matchedSource.score || 0),
            preview: String(answer || "").replace(/\s+/g, " ").slice(0, 180),
          },
        ],
      };
    }

    await recordUserSearchHistory(session, basePlanContext, {
      questionText: message,
      target,
      answerText: answer,
    });

    return attachAiPreviewState(result, {
      previewMeta: freeAiPreviewMeta,
      consumePreview: aiPreviewApproved && Boolean(answer),
      userId,
      usageMonth,
    });
  }

  if (runtimeFlags.useMockAI) {
    const highlightTerms = message.split(/\s+/).filter(Boolean).slice(0, 8);
    const answer = `Mock AI\n\nคำถาม: "${message}"\n\nสรุปจำลอง: ระบบกำลังอยู่ในโหมดทดสอบและยังไม่ได้เรียก AI จริง`;

    await recordUserSearchHistory(session, basePlanContext, {
      questionText: message,
      target,
      answerText: answer,
    });

    return attachAiPreviewState({
      hasContext: true,
      answer,
      highlightTerms,
      usedFollowUpContext: false,
      usedInternetFallback: false,
      fromCache: false,
    }, {
      previewMeta: freeAiPreviewMeta,
      consumePreview: aiPreviewApproved && Boolean(answer),
      userId,
      usageMonth,
    });
  }

  const searchPlan = await resolveSearchPlan(message, target, session, {
    requestStartedAt: startedAt,
    totalBudgetMs: CHAT_REPLY_BUDGET_MS,
    planCode: runtimeSearchPlanCode,
  });
  const planContext = aiPreviewApproved
    ? buildFreeAiPreviewPlanContext(basePlanContext)
    : applyEconomyDatabaseOnlyMode(
        basePlanContext,
        searchPlan.effectiveMessage || message,
        searchPlan.matches,
        classifyQuestionIntent(message),
      );
  const cacheScope = buildAnswerCacheScope(planContext);
  const { normalizedQuestion, questionHash } = buildQuestionCacheIdentity(message, target, cacheScope);
  const cacheKey = buildAnswerCacheKey(message, target, planContext);
  const canUseCache = shouldUseAnswerCache(message) && !debugMode;
  const cachedAnswer = canUseCache ? getCachedAnswer(cacheKey) : null;
  if (cachedAnswer) {
    storeConversationContext(
      session,
      target,
      message,
      cachedAnswer.effectiveMessage || message,
      cachedAnswer.sources || [],
      cachedAnswer.resolvedContext || { usedContext: false, topicHints: [] },
    );

    LawChatbotModel.create({
      message,
      effectiveMessage: cachedAnswer.effectiveMessage || message,
      target,
      answer: cachedAnswer.answer,
      matchedSources: (cachedAnswer.sources || []).map((item) => ({
        id: item.id || item.url || item.reference || item.title,
        title: item.title || item.keyword || item.reference,
        lawNumber: item.lawNumber || item.reference || item.keyword,
        source: item.source || "",
        url: item.url || "",
        score: Number(item.score || 0),
      })),
    });

    const cachedResult = {
      hasContext: cachedAnswer.hasContext,
      answer: cachedAnswer.answer,
      highlightTerms: cachedAnswer.highlightTerms,
      usedFollowUpContext: false,
      usedInternetFallback: cachedAnswer.usedInternetFallback,
      fromCache: true,
    };

    if (debugMode) {
      cachedResult.debug = {
        selectedSourceTier: cachedAnswer.selectedSourceTier || "cache",
        sourceCount: Array.isArray(cachedAnswer.sources) ? cachedAnswer.sources.length : 0,
        answerMode: cachedAnswer.answerMode || "cache",
        timing: {
          cacheHit: true,
          totalReplyMs: Math.round(nowMs() - startedAt),
        },
        sources: (cachedAnswer.sources || []).map((item) => ({
          source: item.source || "",
          reference: item.reference || item.title || "",
          score: Number(item.score || 0),
          preview: String(item.content || item.chunk_text || "").replace(/\s+/g, " ").slice(0, 180),
        })),
      };
    }

    await recordUserSearchHistory(session, planContext, {
      questionText: message,
      target,
      answerText: cachedResult.answer,
    });

    return attachAiPreviewState(cachedResult, {
      previewMeta: freeAiPreviewMeta,
      consumePreview: aiPreviewApproved && Boolean(cachedResult.answer),
      userId,
      usageMonth,
    });
  }

  if (canUseCache && questionHash) {
    try {
      const dbCachedAnswer = await LawChatbotAnswerCacheModel.findByQuestionHash(questionHash);
      if (dbCachedAnswer?.answer_text) {
        await LawChatbotAnswerCacheModel.incrementHitCount(dbCachedAnswer.id);

        const cachedResult = buildDbCachedChatResult(dbCachedAnswer, message);
        if (debugMode) {
          cachedResult.debug = {
            selectedSourceTier: dbCachedAnswer?.metadata?.selectedSourceTier || "db_cache",
            sourceCount: Number(dbCachedAnswer?.metadata?.sourceCount || 0),
            answerMode: dbCachedAnswer?.metadata?.answerMode || "db_cache",
            timing: {
              cacheHit: true,
              totalReplyMs: Math.round(nowMs() - startedAt),
            },
            sources: [],
          };
        }

        storeConversationContext(
          session,
          target,
          message,
          dbCachedAnswer.normalized_question || message,
          [],
          { usedContext: false, topicHints: [] },
        );

        LawChatbotModel.create({
          message,
          effectiveMessage: dbCachedAnswer.normalized_question || message,
          target,
          answer: cachedResult.answer,
          matchedSources: [],
        });

        setCachedAnswer(cacheKey, {
          hasContext: cachedResult.hasContext,
          answer: cachedResult.answer,
          highlightTerms: cachedResult.highlightTerms,
          usedInternetFallback: cachedResult.usedInternetFallback,
          selectedSourceTier: dbCachedAnswer?.metadata?.selectedSourceTier || "db_cache",
          answerMode: dbCachedAnswer?.metadata?.answerMode || "db_cache",
          effectiveMessage: dbCachedAnswer.normalized_question || message,
          resolvedContext: { usedContext: false, topicHints: [] },
          sources: [],
        });

        await recordUserSearchHistory(session, planContext, {
          questionText: message,
          target,
          answerText: cachedResult.answer,
        });

        return attachAiPreviewState(cachedResult, {
          previewMeta: freeAiPreviewMeta,
          consumePreview: aiPreviewApproved && Boolean(cachedResult.answer),
          userId,
          usageMonth,
        });
      }
    } catch (error) {
      console.error("[replyToChat] Answer cache lookup failed:", error.message || error);
    }
  }

  const evidence = await collectAnswerSources(message, target, session, {
    searchPlan,
    requestStartedAt: startedAt,
    totalBudgetMs: CHAT_REPLY_BUDGET_MS,
    allowInternetFallback: planContext.useInternet,
    databaseOnlyMode: !planContext.useAI,
    sourceLimit: planContext.sourceLimit,
    internetLimit: planContext.maxInternetSources,
    planCode: runtimeSearchPlanCode,
  });
  const afterCollectSourcesAt = nowMs();
  const resolvedContext = evidence.resolvedContext;
  const effectiveMessage = evidence.effectiveMessage || message;
  const sources = evidence.sources;
  const highlightTerms = effectiveMessage.split(/\s+/).filter(Boolean).slice(0, 8);

  let answer = "";

  if (sources.length === 0) {
    answer =
      evidence.usedInternetSearch
        ? "ไม่ปรากฏข้อมูลที่ตรงกับประเด็นคำถามอย่างชัดเจนทั้งในฐานข้อมูลและแหล่งข้อมูลสาธารณะ\n\nกรุณาระบุคำสำคัญเพิ่มเติม เช่น การประชุมใหญ่ สมาชิก คณะกรรมการ หรือการจัดตั้งกลุ่มเกษตรกร"
        : "ไม่ปรากฏข้อมูลที่ตรงกับประเด็นคำถามอย่างชัดเจนในฐานข้อมูลและเอกสารภายในระบบ\n\nกรุณาระบุคำสำคัญเพิ่มเติม เช่น การประชุมใหญ่ สมาชิก คณะกรรมการ หรือการจัดตั้งกลุ่มเกษตรกร";
  } else {
    const remainingBudgetBeforeAnswerMs = getRemainingBudgetMs(startedAt, CHAT_REPLY_BUDGET_MS);
    const answerSources = sources;
    answer = await generateChatSummary(message, answerSources, {
      conversationalFollowUp: resolvedContext.usedContext,
      focusMessage: effectiveMessage,
      topicLabel: resolvedContext.topicHints && resolvedContext.topicHints[0] ? resolvedContext.topicHints[0] : "",
      forceFallback: !planContext.useAI || remainingBudgetBeforeAnswerMs < MIN_AI_SUMMARY_BUDGET_MS,
      aiTimeoutMs: Math.max(
        1000,
        Math.min(
          Number(planContext.promptProfile?.aiTimeoutMs || remainingBudgetBeforeAnswerMs - 500),
          remainingBudgetBeforeAnswerMs - 500,
        ),
      ),
      questionIntent: evidence.questionIntent,
      databaseOnlyMode: !planContext.useAI,
      promptProfile: planContext.promptProfile,
      planCode: runtimeSearchPlanCode,
      target,
    });
  }
  const afterAnswerGenerationAt = nowMs();

  storeConversationContext(session, target, message, effectiveMessage, sources, resolvedContext);

  LawChatbotModel.create({
    message,
    effectiveMessage,
    target,
    answer,
    matchedSources: sources.map((item) => ({
      id: item.id || item.url || item.reference || item.title,
      title: item.title || item.keyword || item.reference,
      lawNumber: item.lawNumber || item.reference || item.keyword,
      source: item.source || "",
      url: item.url || "",
      score: Number(item.score || 0),
    })),
  });

  const result = {
    hasContext: sources.length > 0,
    answer,
    highlightTerms,
    usedFollowUpContext: resolvedContext.usedContext,
    usedInternetFallback: evidence.usedInternetFallback,
    fromCache: false,
  };

  if (canUseCache && !resolvedContext.usedContext) {
    setCachedAnswer(cacheKey, {
      hasContext: sources.length > 0,
      answer,
      highlightTerms,
      usedInternetFallback: evidence.usedInternetFallback,
      selectedSourceTier: evidence.selectedSourceTier || "none",
      planCode: planContext.code,
      promptProfile: planContext.promptProfile?.code || "template",
      answerMode: planContext.answerMode || (planContext.useAI ? "ai" : "db_only"),
      effectiveMessage,
      resolvedContext,
      sources,
    });
  }

  if (canUseCache && !resolvedContext.usedContext && questionHash && shouldPersistDbAnswerCache(answer, { debugMode })) {
    try {
      await LawChatbotAnswerCacheModel.upsert({
        questionHash,
        normalizedQuestion: normalizedQuestion || effectiveMessage || message,
        originalQuestion: message,
        target,
        answerText: answer,
        metadata: {
          hasContext: sources.length > 0,
          highlightTerms,
          usedInternetFallback: evidence.usedInternetFallback,
          selectedSourceTier: evidence.selectedSourceTier || "none",
          effectiveMessage,
          sourceCount: sources.length,
          planCode: planContext.code,
          promptProfile: planContext.promptProfile?.code || "template",
          answerMode: planContext.answerMode || (planContext.useAI ? "ai" : "db_only"),
        },
      });
    } catch (error) {
      console.error("[replyToChat] Answer cache write failed:", error.message || error);
    }
  }

  if (debugMode) {
    result.debug = {
      selectedSourceTier: evidence.selectedSourceTier || "none",
      sourceCount: sources.length,
      databaseMatches: evidence.databaseMatches?.length || 0,
      internetMatches: evidence.internetMatches?.length || 0,
      answerMode: planContext.answerMode || (planContext.useAI ? "ai" : "db_only"),
      promptProfile: planContext.promptProfile?.code || "template",
      timing: {
        ...(evidence.timing || {}),
        answerGenerationMs: Math.round(afterAnswerGenerationAt - afterCollectSourcesAt),
        totalReplyMs: Math.round(afterAnswerGenerationAt - startedAt),
      },
      sources: sources.map((item) => ({
        source: item.source || "",
        reference: item.reference || item.title || "",
        score: Number(item.score || 0),
        preview: String(item.content || item.chunk_text || "").replace(/\s+/g, " ").slice(0, 180),
      })),
    };
  }

  await recordUserSearchHistory(session, planContext, {
    questionText: message,
    target,
    answerText: answer,
  });

  return attachAiPreviewState(result, {
    previewMeta: freeAiPreviewMeta,
    consumePreview: aiPreviewApproved && Boolean(answer),
    userId,
    usageMonth,
  });
}

async function summarizeChat(payload, session) {
  const message = String(payload.message || "").trim();
  if (!message) {
    return { summary: "" };
  }
  const aiRuntimeEnabled = await isAiEnabled();
  const openAiConfig = getOpenAiConfig();
  const basePlanContext = resolveChatPlanContext(session, {
    aiAvailable: aiRuntimeEnabled && Boolean(openAiConfig),
  });

  const target =
    payload.target === "group" ? "group" : payload.target === "coop" ? "coop" : "all";
  const searchPlan = await resolveSearchPlan(message, target, session, {
    planCode: basePlanContext.code,
  });
  const planContext = applyEconomyDatabaseOnlyMode(
    basePlanContext,
    searchPlan.effectiveMessage || message,
    searchPlan.matches,
    classifyQuestionIntent(message),
  );
  const evidence = await collectAnswerSources(message, target, session, {
    searchPlan,
    allowInternetFallback: planContext.useInternet,
    databaseOnlyMode: !planContext.useAI,
    sourceLimit: planContext.sourceLimit,
    internetLimit: planContext.maxInternetSources,
    planCode: planContext.code,
  });
  const resolvedContext = evidence.resolvedContext;
  const sources = evidence.sources;

  return {
    summary: await generateChatSummary(message, sources, {
      conversationalFollowUp: resolvedContext.usedContext,
      topicLabel: resolvedContext.topicHints && resolvedContext.topicHints[0] ? resolvedContext.topicHints[0] : "",
      questionIntent: evidence.questionIntent,
      databaseOnlyMode: !planContext.useAI,
      promptProfile: planContext.promptProfile,
      planCode: planContext.code,
      target,
    }),
  };
}

async function saveChatFeedback(payload) {
  return LawChatbotFeedbackModel.create({
    name: "Chat Feedback",
    email: "",
    message: payload.message || "",
    answerShown: payload.answerShown || "",
    isHelpful: Boolean(payload.isHelpful),
    target: payload.target || "all",
    expectedAnswer: payload.expectedAnswer || "",
    suggestedLawNumber: payload.suggestedLawNumber || "",
  });
}

async function getUploadPageData() {
  const uploadedChunkCount = await LawChatbotPdfChunkModel.countChunks();
  const maxUploadBytes = Number(process.env.MAX_UPLOAD_BYTES || 20 * 1024 * 1024);

  return {
    appName: "Coopbot Law Chatbot",
    uploadPath: "/law-chatbot/upload",
    acceptedTypes: [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    maxUploadBytes,
    maxUploadMb: Math.floor(maxUploadBytes / (1024 * 1024)),
    uploadedPdfCount: LawChatbotPdfChunkModel.countDocuments(),
    uploadedChunkCount,
    uploadedFiles: LawChatbotPdfChunkModel.list(10),
  };
}

async function getFeedbackPageData() {
  const stats = LawChatbotFeedbackModel.stats();

  return {
    appName: "Coopbot Law Chatbot",
    feedbackCount: LawChatbotFeedbackModel.count(),
    helpfulCount: stats.helpful,
    needsImprovementCount: stats.needsImprovement,
    recentFeedback: LawChatbotFeedbackModel.list(),
  };
}

async function getUserDashboardData(user) {
  const signedInUser = user || {};
  const userId = Number(signedInUser.userId || signedInUser.id || 0);
  if (!userId) {
    throw new Error("Please sign in before opening the user dashboard.");
  }

  const usageMonth = UserMonthlyUsageModel.getYearMonth();
  const [persistedUser, usage, recentRequests] = await Promise.all([
    UserModel.findById(userId),
    UserMonthlyUsageModel.findByUserAndMonth(userId, usageMonth),
    PaymentRequestModel.listByUserId(userId, 10),
  ]);

  const profile = buildSignedInProfile(signedInUser, persistedUser);
  const planContext = resolveUserPlanContext(profile);
  const questionCount = Number(usage?.question_count || 0);
  const aiPreview = buildAiPreviewMeta(planContext, usage);
  const questionLimit = Number.isFinite(planContext.monthlyLimit) ? planContext.monthlyLimit : null;
  const remainingQuestions =
    Number.isFinite(questionLimit) ? Math.max(0, questionLimit - questionCount) : null;

  return {
    appName: "Coopbot Law Chatbot",
    user: profile,
    planContext,
    usage: {
      usageMonth,
      questionCount,
      questionLimit,
      remainingQuestions,
      isUnlimited: planContext.isUnlimited,
    },
    aiPreview,
    searchHistory: buildSearchHistoryMeta(planContext),
    recentRequests: recentRequests.map((item) => enrichPaymentRequestRecord(item)),
  };
}

async function getUserSearchHistoryData(user) {
  const signedInUser = user || {};
  const userId = Number(signedInUser.userId || signedInUser.id || 0);
  if (!userId) {
    throw new Error("Please sign in before opening search history.");
  }

  const persistedUser = await UserModel.findById(userId);
  const profile = buildSignedInProfile(signedInUser, persistedUser);
  const planContext = resolveUserPlanContext(profile);
  const searchHistory = buildSearchHistoryMeta(planContext);
  await UserSearchHistoryModel.deleteExpired();
  const entries = await UserSearchHistoryModel.listActiveByUserId(userId, 100);

  return {
    appName: "Coopbot Law Chatbot",
    user: profile,
    planContext,
    searchHistory,
    entries,
  };
}

async function getPaymentRequestPageData(user) {
  const signedInUser = user || {};
  const userId = Number(signedInUser.userId || signedInUser.id || 0);
  const currentPlanContext = resolveUserPlanContext(signedInUser);
  const usageMonth = UserMonthlyUsageModel.getYearMonth();
  const usage = userId ? await UserMonthlyUsageModel.findByUserAndMonth(userId, usageMonth) : null;
  const aiPreview = buildAiPreviewMeta(currentPlanContext, usage);

  return {
    appName: "Coopbot Law Chatbot",
    plans: listPurchasablePlans(),
    planComparison: listPlanComparisons(),
    currentPlanContext,
    aiPreview,
    user: signedInUser,
    recentRequests: userId
      ? (await PaymentRequestModel.listByUserId(userId, 10)).map((item) => enrichPaymentRequestRecord(item))
      : [],
  };
}

async function submitPaymentRequest(payload, file, user) {
  const signedInUser = user || {};
  const userId = Number(signedInUser.userId || signedInUser.id || 0);
  const planCode = normalizePlanCode(payload.planName || "");
  const note = String(payload.note || "").trim();

  if (!userId) {
    throw new Error("Please sign in before submitting a payment request.");
  }

  if (!isPaidPlan(planCode)) {
    throw new Error("Please select a valid paid plan.");
  }

  const amount = getPlanPriceBaht(planCode);

  const paymentRequest = await PaymentRequestModel.create({
    userId,
    planName: planCode,
    amount,
    slipImage: file ? `/uploads/paymentRequests/${file.filename}` : "",
    note,
    status: "pending",
  });

  try {
    await sendPaymentRequestNotification(paymentRequest, signedInUser);
  } catch (error) {
    console.error("[submitPaymentRequest] Telegram notification failed:", error.message || error);
  }

  return paymentRequest;
}

async function getAdminUsersData(query = "") {
  const trimmedQuery = String(query || "").trim();
  const [stats, users] = await Promise.all([
    UserModel.getAdminStats(),
    UserModel.listForAdmin({ query: trimmedQuery, limit: 100 }),
  ]);

  return {
    query: trimmedQuery,
    totalCount: Number(stats.total_count || 0),
    freeCount: Number(stats.free_count || 0),
    paidCount: Number(stats.paid_count || 0),
    activeCount: Number(stats.active_count || 0),
    defaultPlanDurationDays: getPlanDurationDays(),
    plans: listAdminManageablePlans(),
    users: users.map((item) => enrichAdminUserRecord(item)),
  };
}

async function adminUpdateUserPlan(userId, planCode, options = {}) {
  const normalizedUserId = Number(userId || 0);
  const normalizedPlanCode = normalizePlanCode(planCode || "free");
  const allowedPlans = new Set(listAdminManageablePlans().map((plan) => plan.code));
  const durationDays = Math.max(
    1,
    Number(options.durationDays || getPlanDurationDays()),
  );

  if (!normalizedUserId) {
    return { ok: false, reason: "invalid_user" };
  }

  if (!allowedPlans.has(normalizedPlanCode)) {
    return { ok: false, reason: "invalid_plan" };
  }

  const currentUser = await UserModel.findById(normalizedUserId);
  if (!currentUser) {
    return { ok: false, reason: "not_found" };
  }

  const updated = await UserModel.setPlanByAdmin(normalizedUserId, normalizedPlanCode, {
    durationDays,
  });

  if (!updated) {
    return { ok: false, reason: "not_updated" };
  }

  const refreshedUser = await UserModel.findById(normalizedUserId);
  const enrichedUser = enrichAdminUserRecord(refreshedUser || currentUser);

  return {
    ok: true,
    user: enrichedUser,
    planCode: normalizedPlanCode,
    planLabel: getPlanLabel(normalizedPlanCode),
    durationDays,
  };
}

async function getAdminPaymentRequestsData() {
  const requests = (await PaymentRequestModel.listAll(100)).map((item) => enrichPaymentRequestRecord(item));

  return {
    plans: listPurchasablePlans(),
    totalCount: requests.length,
    pendingCount: requests.filter((item) => item.status === "pending").length,
    approvedCount: requests.filter((item) => item.status === "approved").length,
    rejectedCount: requests.filter((item) => item.status === "rejected").length,
    requests,
  };
}

async function getAdminPaymentRequestDetail(id) {
  const request = await PaymentRequestModel.findById(id);
  if (!request) {
    return null;
  }

  return {
    request: enrichPaymentRequestRecord(request),
    plans: listPurchasablePlans(),
  };
}

async function updatePaymentRequestPlan(id, nextPlanCode) {
  const request = await PaymentRequestModel.findById(id);
  if (!request || request.status !== "pending") {
    return { ok: false, reason: "not_found" };
  }

  const currentPlanCode = normalizePlanCode(request.plan_name || "free");
  const planCode = normalizePlanCode(nextPlanCode || currentPlanCode);
  if (!isPaidPlan(planCode)) {
    return { ok: false, reason: "invalid_plan" };
  }

  const amount = getPlanPriceBaht(planCode);
  if (currentPlanCode === planCode && Number(request.amount || 0) === amount) {
    return {
      ok: true,
      requestId: Number(request.id || id || 0),
      planCode,
      planLabel: getPlanLabel(planCode),
      amount,
      unchanged: true,
    };
  }

  const updated = await PaymentRequestModel.updateRequestedPlan(id, planCode, amount);
  if (!updated) {
    return { ok: false, reason: "not_updated" };
  }

  return {
    ok: true,
    requestId: Number(request.id || id || 0),
    planCode,
    planLabel: getPlanLabel(planCode),
    amount,
    previousPlanCode: currentPlanCode,
    previousPlanLabel: getPlanLabel(currentPlanCode),
  };
}

async function approvePaymentRequest(id, reviewMeta = {}) {
  const request = await PaymentRequestModel.findById(id);
  if (!request || request.status !== "pending") {
    return { ok: false, reason: "not_found" };
  }

  const planCode = normalizePlanCode(request.plan_name || "free");
  if (!isPaidPlan(planCode)) {
    return { ok: false, reason: "invalid_plan" };
  }

  const activated = await UserModel.activatePlan(request.user_id, planCode, {
    durationDays: getPlanDurationDays(),
  });
  if (!activated) {
    return { ok: false, reason: "user_not_updated" };
  }

  const reviewed = await PaymentRequestModel.updateReviewStatus(
    id,
    "approved",
    reviewMeta.reviewedBy || "",
  );

  if (!reviewed) {
    return { ok: false, reason: "review_not_updated" };
  }

  return {
    ok: true,
    requestId: id,
    planCode,
    planLabel: getPlanLabel(planCode),
  };
}

async function rejectPaymentRequest(id, reviewMeta = {}) {
  const request = await PaymentRequestModel.findById(id);
  if (!request || request.status !== "pending") {
    return { ok: false, reason: "not_found" };
  }
  const planCode = normalizePlanCode(request.plan_name || "free");

  const reviewed = await PaymentRequestModel.updateReviewStatus(
    id,
    "rejected",
    reviewMeta.reviewedBy || "",
  );

  if (!reviewed) {
    return { ok: false, reason: "review_not_updated" };
  }

  return {
    ok: true,
    requestId: id,
    planCode,
    planLabel: getPlanLabel(planCode),
  };
}

async function getKnowledgeAdminData() {
  const [
    knowledgeCount,
    recentKnowledge,
    pendingSuggestionCount,
    pendingSuggestions,
    suggestedQuestionCount,
    activeSuggestedQuestionCount,
    suggestedQuestions,
  ] = await Promise.all([
    LawChatbotKnowledgeModel.count(),
    LawChatbotKnowledgeModel.listRecent(10),
    LawChatbotKnowledgeSuggestionModel.countPending(),
    LawChatbotKnowledgeSuggestionModel.listPending(12),
    LawChatbotSuggestedQuestionModel.countAll(),
    LawChatbotSuggestedQuestionModel.countActive(),
    LawChatbotSuggestedQuestionModel.listRecent(20),
  ]);

  return {
    appName: "Coopbot Law Chatbot",
    knowledgeCount,
    recentKnowledge,
    pendingSuggestionCount,
    pendingSuggestions,
    suggestedQuestionCount,
    activeSuggestedQuestionCount,
    suggestedQuestions,
    targets: [
      { value: "coop", label: "สหกรณ์" },
      { value: "group", label: "กลุ่มเกษตรกร" },
    ],
    suggestedQuestionTargets: [
      { value: "all", label: "ทุกประเภท" },
      { value: "coop", label: "สหกรณ์" },
      { value: "group", label: "กลุ่มเกษตรกร" },
    ],
  };
}

async function saveSuggestedQuestionEntry(payload = {}) {
  const entry = await LawChatbotSuggestedQuestionModel.create({
    target: payload.target,
    questionText: payload.questionText || payload.question,
    answerText: payload.answerText || payload.answer,
    displayOrder: payload.displayOrder,
    isActive: payload.isActive,
  });

  if (!entry) {
    return { ok: false, reason: "invalid_payload" };
  }

  clearAnswerCache();

  return {
    ok: true,
    entry,
  };
}

async function updateSuggestedQuestionEntry(id, payload = {}) {
  const existing = await LawChatbotSuggestedQuestionModel.findById(id);
  if (!existing) {
    return { ok: false, reason: "not_found" };
  }

  const updated = await LawChatbotSuggestedQuestionModel.updateById(id, {
    target: payload.target,
    questionText: payload.questionText || payload.question,
    answerText: payload.answerText || payload.answer,
    displayOrder: payload.displayOrder,
    isActive: payload.isActive,
  });

  if (!updated) {
    return { ok: false, reason: "not_updated" };
  }

  clearAnswerCache();
  const refreshed = await LawChatbotSuggestedQuestionModel.findById(id);

  return {
    ok: true,
    entry: refreshed,
  };
}

async function deleteSuggestedQuestionEntry(id) {
  const removed = await LawChatbotSuggestedQuestionModel.removeById(id);
  if (removed) {
    clearAnswerCache();
  }
  return removed;
}

async function submitKnowledgeSuggestion(payload, meta = {}) {
  const title = String(payload.title || payload.question || "").trim();
  const content = String(payload.content || "").trim();
  const target = payload.target === "group" ? "group" : "coop";
  const sourceType = payload.sourceType === "voice" ? "voice" : "text";

  if (!title || !content) {
    throw new Error("กรุณาระบุคำถามและคำตอบที่ต้องการเสนอ");
  }

  if (content.length < 10) {
    throw new Error("กรุณาอธิบายคำตอบที่ต้องการเสนอให้ชัดเจนมากขึ้น");
  }

  const sessionKey = String(meta.sessionId || meta.ip || "anonymous").trim() || "anonymous";
  const normalizedFingerprint = normalizeForSearch(`${target} ${title} ${content}`).toLowerCase();
  const throttleKey = `${sessionKey}::${normalizedFingerprint}`;
  const now = Date.now();
  const previous = suggestionThrottleMap.get(throttleKey);

  if (previous && now - previous.createdAt < 3 * 60 * 1000) {
    throw new Error("มีการส่งข้อเสนอแนะเดิมเข้ามาแล้ว กรุณารอสักครู่ก่อนส่งซ้ำ");
  }

  cleanupSuggestionThrottle();
  suggestionThrottleMap.set(throttleKey, { createdAt: now });

  return LawChatbotKnowledgeSuggestionModel.create({
    target,
    title,
    content,
    sourceType,
    submittedBy: meta.submittedBy || "",
    submitterSession: meta.sessionId || "",
    submitterIp: meta.ip || "",
    status: "pending",
  });
}

async function approveKnowledgeSuggestion(id, reviewMeta = {}) {
  const suggestion = await LawChatbotKnowledgeSuggestionModel.findById(id);
  if (!suggestion || suggestion.status !== "pending") {
    return { ok: false, reason: "not_found" };
  }

  const sourceNoteParts = [
    suggestion.sourceType === "voice" ? "ข้อเสนอจากผู้ใช้งาน (เสียง)" : "ข้อเสนอจากผู้ใช้งาน",
    suggestion.submittedBy ? `โดย ${suggestion.submittedBy}` : "",
  ].filter(Boolean);

  const entry = await saveKnowledgeEntry({
    target: suggestion.target,
    title: suggestion.title,
    content: suggestion.content,
    sourceNote: sourceNoteParts.join(" | "),
  });

  const updated = await LawChatbotKnowledgeSuggestionModel.updateStatus(id, "approved", {
    reviewedBy: reviewMeta.reviewedBy || "",
    reviewNote: reviewMeta.reviewNote || "",
  });

  return {
    ok: updated,
    entry,
    suggestion,
  };
}

async function updateKnowledgeSuggestion(id, patch = {}) {
  const suggestion = await LawChatbotKnowledgeSuggestionModel.findById(id);
  if (!suggestion || suggestion.status !== "pending") {
    return { ok: false, reason: "not_found" };
  }

  const updated = await LawChatbotKnowledgeSuggestionModel.updatePendingSuggestion(id, {
    target: patch.target,
    title: patch.title,
    content: patch.content,
    reviewNote: patch.reviewNote || "",
  });

  if (!updated) {
    return { ok: false, reason: "not_updated" };
  }

  const refreshed = await LawChatbotKnowledgeSuggestionModel.findById(id);

  return {
    ok: true,
    suggestion: refreshed,
  };
}

async function rejectKnowledgeSuggestion(id, reviewMeta = {}) {
  return LawChatbotKnowledgeSuggestionModel.updateStatus(id, "rejected", {
    reviewedBy: reviewMeta.reviewedBy || "",
    reviewNote: reviewMeta.reviewNote || "",
  });
}

async function saveKnowledgeEntry(payload) {
  const target = payload.target === "group" ? "group" : "coop";

  clearAnswerCache();

  return LawChatbotKnowledgeModel.create({
    target,
    title: payload.title || "",
    lawNumber: payload.lawNumber || "",
    content: payload.content || "",
    sourceNote: payload.sourceNote || payload.note || "",
  });
}

async function updateKnowledgeEntry(id, payload = {}) {
  const existing = await LawChatbotKnowledgeModel.findById(id);
  if (!existing) {
    return { ok: false, reason: "not_found" };
  }

  const target = payload.target === "group" ? "group" : "coop";

  clearAnswerCache();

  const updated = await LawChatbotKnowledgeModel.updateById(id, {
    target,
    title: payload.title || "",
    lawNumber: payload.lawNumber || "",
    content: payload.content || "",
    sourceNote: payload.sourceNote || payload.note || "",
  });

  if (!updated) {
    return { ok: false, reason: "not_updated" };
  }

  const refreshed = await LawChatbotKnowledgeModel.findById(id);

  return {
    ok: true,
    entry: refreshed,
  };
}

async function deleteKnowledgeEntry(id) {
  clearAnswerCache();
  return LawChatbotKnowledgeModel.removeById(id);
}

async function saveFeedback(payload) {
  return LawChatbotFeedbackModel.create({
    name: payload.name || "Anonymous",
    email: payload.email || "",
    message: payload.message || "",
  });
}

module.exports = {
  getDashboardData,
  collectAnswerSources,
  replyToChat,
  summarizeChat,
  saveChatFeedback,
  getUploadPageData,
  recordUpload,
  getFeedbackPageData,
  getUserDashboardData,
  getUserSearchHistoryData,
  getPaymentRequestPageData,
  getAdminUsersData,
  adminUpdateUserPlan,
  getAdminPaymentRequestsData,
  getAdminPaymentRequestDetail,
  updatePaymentRequestPlan,
  getKnowledgeAdminData,
  saveSuggestedQuestionEntry,
  updateSuggestedQuestionEntry,
  deleteSuggestedQuestionEntry,
  submitKnowledgeSuggestion,
  approveKnowledgeSuggestion,
  updateKnowledgeSuggestion,
  rejectKnowledgeSuggestion,
  saveKnowledgeEntry,
  updateKnowledgeEntry,
  deleteKnowledgeEntry,
  saveFeedback,
  submitPaymentRequest,
  approvePaymentRequest,
  rejectPaymentRequest,
};
