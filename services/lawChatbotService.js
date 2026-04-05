const LawChatbotModel = require("../models/lawChatbotModel");
const LawChatbotFeedbackModel = require("../models/lawChatbotFeedbackModel");
const LawChatbotKnowledgeModel = require("../models/lawChatbotKnowledgeModel");
const LawChatbotKnowledgeSuggestionModel = require("../models/lawChatbotKnowledgeSuggestionModel");
const LawChatbotPdfChunkModel = require("../models/lawChatbotPdfChunkModel");
const LawChatbotAnswerCacheModel = require("../models/lawChatbotAnswerCacheModel");
const LawSearchModel = require("../models/lawSearchModel");
const UserMonthlyUsageModel = require("../models/userMonthlyUsageModel");
const runtimeFlags = require("../config/runtimeFlags");
const { isAiEnabled } = require("./runtimeSettingsService");
const { getOpenAiConfig } = require("./openAiService");
const { buildQuestionCacheIdentity } = require("./lawChatbotAnswerCacheUtils");
const { generateChatSummary, wantsExplanation, SOURCE_LABELS } = require("./chatAnswerService");
const {
  getConversationHistory,
  getFollowUpCarrySources,
  mergeUniqueSources,
  storeConversationContext,
} = require("./contextService");
const {
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
} = require("./chatOrchestrationService");
const {
  attachAiPreviewState,
  buildAiPreviewMeta,
  buildAnswerCacheKey,
  buildAnswerCacheScope,
  buildFreeAiPreviewPlanContext,
  getCachedAnswer,
  setCachedAnswer,
} = require("./answerStateService");
const {
  approveKnowledgeSuggestion,
  deleteKnowledgeEntry,
  deleteSuggestedQuestionEntry,
  getKnowledgeAdminData,
  getKnowledgeAdminSummaryData,
  rejectKnowledgeSuggestion,
  saveKnowledgeEntry,
  saveSuggestedQuestionEntry,
  submitKnowledgeSuggestion,
  updateKnowledgeEntry,
  updateKnowledgeSuggestion,
  updateSuggestedQuestionEntry,
} = require("./knowledgeAdminService");
const { recordUpload } = require("./uploadIngestionService");
const {
  adminUpdateUserPlan,
  approvePaymentRequest,
  clearAdminGuestUsage,
  getAdminGuestUsageData,
  getAdminPaymentRequestDetail,
  getAdminPaymentRequestsData,
  getAdminUsersData,
  getDashboardData,
  getPaymentRequestPageData,
  getUserDashboardData,
  getUserSearchHistoryData,
  rejectPaymentRequest,
  submitPaymentRequest,
  updatePaymentRequestPlan,
} = require("./userAdminPaymentService");
const {
  classifyQuestionIntent,
  selectTieredSources,
} = require("./sourceSelectionService");
const { evaluateRetrievalResult } = require("./retrievalEvaluationService");
const { searchInternetSources } = require("./internetSearchService");
const { canUseAiPreview } = require("./planService");
const { buildPaginationMeta, normalizePageNumber, normalizePageSize } = require("./paginationUtils");

const CHAT_REQUEST_TIMEOUT_MS = Number(process.env.CHAT_REQUEST_TIMEOUT_MS || 25000);
const CHAT_BUDGET_BUFFER_MS = Number(process.env.CHAT_BUDGET_BUFFER_MS || 3000);
const CHAT_REPLY_BUDGET_MS = Math.max(2000, CHAT_REQUEST_TIMEOUT_MS - CHAT_BUDGET_BUFFER_MS);
const MIN_INTERNET_SEARCH_BUDGET_MS = Number(process.env.LAW_CHATBOT_INTERNET_SEARCH_MIN_BUDGET_MS || 5000);
const MIN_AI_SUMMARY_BUDGET_MS = Number(process.env.LAW_CHATBOT_AI_SUMMARY_MIN_BUDGET_MS || 2500);
const PREPARED_QA_NOTICE = "คำตอบนี้มาจาก Q&A/ฐานข้อมูลในระบบ โดยไม่ได้เรียก AI";
const AI_SUMMARY_NOTICE = "คำตอบนี้สรุปโดย AI จากข้อมูลที่ระบบค้นพบ";
const DB_LOOKUP_NOTICE = "คำตอบนี้มาจากการค้นฐานข้อมูลโดยตรง";

const SOURCE_TABLE_NAMES = {
  managed_suggested_question: "chatbot_suggested_questions",
  admin_knowledge: "chatbot_knowledge",
  knowledge_suggestion: "chatbot_knowledge_suggestions",
  knowledge_base: "law_chatbot",
  documents: "law_chatbot_pdf_chunks",
  pdf_chunks: "law_chatbot_pdf_chunks",
  tbl_laws: "tbl_laws",
  tbl_glaws: "tbl_glaws",
  tbl_vinichai: "tbl_vinichai",
  internet_search: "internet_search",
};

function getSourceDisplayLabel(sourceName = "") {
  return SOURCE_LABELS[String(sourceName || "").trim()] || String(sourceName || "").trim();
}

function getSourceTableName(sourceName = "") {
  const normalized = String(sourceName || "").trim();
  return SOURCE_TABLE_NAMES[normalized] || normalized;
}

function getUniqueSourceTableNames(sources = []) {
  return Array.from(
    new Set(
      (Array.isArray(sources) ? sources : [])
        .map((item) => getSourceTableName(item?.source || ""))
        .filter(Boolean),
    ),
  );
}

function buildResponseMeta(answerMode = "", sources = []) {
  const sourceTables = getUniqueSourceTableNames(sources);
  const preparedQaModes = new Set(["prepared_qa_db_only", "managed_answer"]);
  const aiModes = new Set(["ai", "ai_preview", "ai_preview_compact", "mock_ai"]);
  const databaseModes = new Set(["db_only", "economy_db_only"]);
  const normalizedAnswerMode = String(answerMode || "").trim();
  const usesPreparedQa = preparedQaModes.has(String(answerMode || "").trim());
  const usesAiSummary = aiModes.has(normalizedAnswerMode);
  const usesDatabaseLookup = !usesPreparedQa && !usesAiSummary && databaseModes.has(normalizedAnswerMode);

  return {
    answerMode: normalizedAnswerMode,
    kind: usesPreparedQa ? "prepared_qa" : usesAiSummary ? "ai_summary" : usesDatabaseLookup ? "database_lookup" : "generic",
    usesPreparedQa,
    notice: usesPreparedQa
      ? PREPARED_QA_NOTICE
      : usesAiSummary
        ? AI_SUMMARY_NOTICE
        : usesDatabaseLookup
          ? DB_LOOKUP_NOTICE
          : "",
    sourceTables,
  };
}

function resolveRuntimeAiPlanContext(planContext = {}, usage = null) {
  if (!planContext || typeof planContext !== "object") {
    return planContext;
  }

  const planCode = String(planContext.code || planContext.plan || "").trim().toLowerCase();
  if (planCode !== "premium" || planContext.useAI !== true) {
    return planContext;
  }

  const promptProfile = planContext.promptProfile || {};
  const primaryModel = String(planContext.aiModel || promptProfile.aiModel || "").trim();
  const secondaryModel = String(planContext.secondaryAiModel || "").trim();
  const primaryLimit = Math.max(0, Number(planContext.primaryAiModelQuestionLimit || 0));
  if (!primaryModel || !secondaryModel || primaryLimit <= 0) {
    return planContext;
  }

  const questionCount = Math.max(0, Number(usage?.question_count || 0));
  const activeAiModel = questionCount <= primaryLimit ? primaryModel : secondaryModel;

  return {
    ...planContext,
    activeAiModel,
    promptProfile: {
      ...promptProfile,
      aiModel: activeAiModel,
    },
  };
}

function normalizeContinuationText(text = "") {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function getContinuationCharBudget(promptProfile = {}) {
  return Math.max(280, Number(promptProfile.aiSourceContextCharLimit || 700));
}

async function hydrateContinuationRecord(source = {}) {
  const sourceName = String(source.source || "").trim().toLowerCase();
  const normalizedId = Number(source.id || 0);

  if (sourceName === "admin_knowledge" && normalizedId) {
    return LawChatbotKnowledgeModel.findById(normalizedId);
  }

  if (sourceName === "knowledge_suggestion" && normalizedId) {
    return LawChatbotKnowledgeSuggestionModel.findById(normalizedId);
  }

  if (sourceName === "knowledge_base" && normalizedId) {
    return LawChatbotModel.findKnowledgeById(normalizedId);
  }

  if (["tbl_laws", "tbl_glaws", "tbl_vinichai"].includes(sourceName) && normalizedId) {
    return LawSearchModel.findBySourceId(sourceName, normalizedId);
  }

  if (sourceName === "pdf_chunks" && normalizedId) {
    return LawChatbotPdfChunkModel.findChunkById(normalizedId);
  }

  return null;
}

function buildTextContinuationSource(source = {}, record = {}, promptProfile = {}) {
  const charBudget = getContinuationCharBudget(promptProfile);
  const mergedRecord = record && typeof record === "object" ? record : {};
  const fullText = normalizeContinuationText(
    [mergedRecord.content, mergedRecord.chunk_text, mergedRecord.comment]
      .filter(Boolean)
      .join(" ") || [source.content, source.chunk_text, source.comment].filter(Boolean).join(" "),
  );
  const currentOffset = Math.max(0, Number(source.continuationNextOffset || source.continuationCursor || 0));
  if (!fullText || currentOffset >= fullText.length) {
    return null;
  }

  const rawSlice = fullText.slice(currentOffset, currentOffset + charBudget);
  const continuationText = normalizeContinuationText(rawSlice);
  if (!continuationText) {
    return null;
  }

  const nextOffset = Math.min(fullText.length, currentOffset + rawSlice.length);
  return {
    ...source,
    ...mergedRecord,
    id: mergedRecord.id || source.id || null,
    source: source.source || mergedRecord.source || "",
    title: mergedRecord.title || source.title || "",
    reference: mergedRecord.reference || source.reference || source.title || "",
    lawNumber: mergedRecord.lawNumber || source.lawNumber || "",
    url: mergedRecord.url || source.url || "",
    keyword: mergedRecord.keyword || source.keyword || "",
    documentId: mergedRecord.documentId || mergedRecord.document_id || source.documentId || null,
    content: continuationText,
    comment: "",
    score: Math.max(Number(source.score || 0), Number(mergedRecord.score || 0)),
    contextCarry: true,
    continuationMode: source.continuationMode || "text",
    continuationCursor: currentOffset,
    continuationNextOffset: nextOffset,
    continuationTotalLength: fullText.length,
    continuationHasMore: nextOffset < fullText.length,
  };
}

async function buildDocumentContinuationSource(source = {}, promptProfile = {}) {
  const charBudget = getContinuationCharBudget(promptProfile);
  const documentId = Number(source.documentId || source.document_id || (source.source === "documents" ? source.id || 0 : 0));
  let remainingBudget = charBudget;
  let currentChunkId = Number(source.continuationChunkId || (source.source === "pdf_chunks" ? source.id || 0 : 0));
  let currentChunkOffset = Math.max(0, Number(source.continuationChunkOffset || 0));
  let currentChunkLength = Math.max(0, Number(source.continuationTotalLength || 0));
  let activeRecord = null;
  const pieces = [];
  let additionalChunksFetched = 0;

  const appendChunkText = (chunk, startOffset = 0) => {
    const chunkText = normalizeContinuationText(chunk?.content || chunk?.chunk_text || "");
    if (!chunkText || startOffset >= chunkText.length || remainingBudget <= 0) {
      return false;
    }

    const rawSlice = chunkText.slice(startOffset, startOffset + remainingBudget);
    const normalizedSlice = normalizeContinuationText(rawSlice);
    if (!normalizedSlice) {
      return false;
    }

    pieces.push(normalizedSlice);
    remainingBudget = Math.max(0, remainingBudget - rawSlice.length);
    currentChunkId = Number(chunk.id || currentChunkId || 0);
    currentChunkOffset = Math.min(chunkText.length, startOffset + rawSlice.length);
    currentChunkLength = chunkText.length;
    activeRecord = chunk;
    return true;
  };

  if (currentChunkId) {
    const currentChunk = await LawChatbotPdfChunkModel.findChunkById(currentChunkId);
    if (currentChunk) {
      appendChunkText(currentChunk, currentChunkOffset);
    }
  }

  if (remainingBudget > 0 && documentId > 0) {
    const nextChunks = await LawChatbotPdfChunkModel.listChunksByDocumentId(documentId, {
      afterChunkId: currentChunkId,
      limit: 4,
    });

    for (const chunk of nextChunks) {
      if (remainingBudget <= 0) {
        break;
      }

      if (appendChunkText(chunk, 0)) {
        additionalChunksFetched += 1;
      }
    }

    if (!activeRecord && nextChunks[0]) {
      activeRecord = nextChunks[0];
    }
  }

  if (pieces.length === 0) {
    return null;
  }

  const mergedRecord = activeRecord || source;
  const hasMore =
    remainingBudget <= 0 ||
    currentChunkOffset < currentChunkLength ||
    (documentId > 0 && additionalChunksFetched >= 4);

  return {
    ...source,
    ...mergedRecord,
    id: source.id || mergedRecord.id || null,
    source: source.source || mergedRecord.source || "documents",
    title: mergedRecord.title || source.title || "",
    reference: mergedRecord.reference || source.reference || source.title || "",
    lawNumber: mergedRecord.lawNumber || source.lawNumber || "",
    url: mergedRecord.url || source.url || "",
    keyword: mergedRecord.keyword || source.keyword || "",
    documentId: documentId || mergedRecord.documentId || mergedRecord.document_id || null,
    content: normalizeContinuationText(pieces.join(" ")),
    comment: "",
    score: Math.max(Number(source.score || 0), Number(mergedRecord.score || 0)),
    contextCarry: true,
    continuationMode: "document_chunks",
    continuationChunkId: currentChunkId || null,
    continuationChunkOffset: currentChunkOffset,
    continuationTotalLength: currentChunkLength,
    continuationHasMore: hasMore,
  };
}

async function expandCarrySourcesForContinuation(carrySources = [], promptProfile = {}) {
  const expanded = await Promise.all(
    (Array.isArray(carrySources) ? carrySources : []).map(async (source) => {
      const sourceName = String(source?.source || "").trim().toLowerCase();
      if (!source || typeof source !== "object") {
        return null;
      }

      if (sourceName === "documents" || sourceName === "pdf_chunks" || source.continuationMode === "document_chunks") {
        const continuedDocumentSource = await buildDocumentContinuationSource(source, promptProfile);
        return continuedDocumentSource || source;
      }

      const hydratedRecord = await hydrateContinuationRecord(source);
      const continuedTextSource = buildTextContinuationSource(source, hydratedRecord || source, promptProfile);
      return continuedTextSource || source;
    }),
  );

  return mergeUniqueSources(expanded.filter(Boolean));
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
  const initialCarrySources = getFollowUpCarrySources(
    session,
    target,
    message,
    searchPlan.resolvedContext || {},
  );
  const carrySources =
    initialCarrySources.length > 0
      ? await expandCarrySourcesForContinuation(initialCarrySources, options.promptProfile || {})
      : [];
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

  const {
    selectedSourceTier,
    selectedSources,
    selectionTrace,
    selectionDiagnostics,
  } = selectTieredSources(grouped, questionIntent, {
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
    selectionTrace,
    selectionDiagnostics,
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
  const monthlyUsage = userId
    ? await UserMonthlyUsageModel.findByUserAndMonth(userId, usageMonth)
    : null;
  const freeAiPreviewUsage =
    userId && canUseAiPreview(basePlanContext.code)
      ? monthlyUsage
      : null;
  const freeAiPreviewMeta = buildAiPreviewMeta(basePlanContext, freeAiPreviewUsage);
  const aiPreviewRequested = isTruthyFlag(payload.aiPreview);
  const aiPreviewApproved = aiPreviewRequested && freeAiPreviewMeta.canTryPreview && aiFeatureAvailable;
  const usePremiumPreview = aiPreviewApproved && freeAiPreviewMeta.canTryPremiumPreview &&
    (wantsExplanation(message) || classifyQuestionIntent(message) === "explain");
  const runtimeSearchPlanCode = aiPreviewApproved ? "pro" : basePlanContext.code;

  if (aiPreviewRequested && freeAiPreviewMeta.enabled && !aiPreviewApproved) {
    const unavailableMessage = freeAiPreviewMeta.exhausted
      ? `คุณใช้สิทธิ์ลองคำตอบแบบ AI ฟรีครบแล้วของเดือนนี้ (AI ขั้นสูง ${freeAiPreviewMeta.premiumLimit} ครั้ง + AI มาตรฐาน ${freeAiPreviewMeta.limit} ครั้ง) หากต้องการใช้ AI ต่อเนื่อง แนะนำอัปเกรดเป็นแพ็กเกจ Professional`
      : "ขณะนี้ยังไม่สามารถใช้สิทธิ์ลอง AI ได้ กรุณาลองใหม่อีกครั้งในภายหลัง";
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
        topicHints: managedSuggestedQuestionMatch.topicHint ? [managedSuggestedQuestionMatch.topicHint] : [],
      },
      { answerText: answer },
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
      responseMeta: buildResponseMeta("managed_answer", [matchedSource]),
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
        sourceTables: getUniqueSourceTableNames([matchedSource]),
        timing: {
          totalReplyMs: Math.round(nowMs() - startedAt),
        },
        sources: [
          {
            source: matchedSource.source,
            sourceLabel: getSourceDisplayLabel(matchedSource.source),
            sourceTable: getSourceTableName(matchedSource.source),
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
      consumePremiumPreview: usePremiumPreview,
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
      responseMeta: buildResponseMeta("mock_ai", []),
      fromCache: false,
    }, {
      previewMeta: freeAiPreviewMeta,
      consumePreview: aiPreviewApproved && Boolean(answer),
      consumePremiumPreview: usePremiumPreview,
      userId,
      usageMonth,
    });
  }

  const searchPlan = await resolveSearchPlan(message, target, session, {
    requestStartedAt: startedAt,
    totalBudgetMs: CHAT_REPLY_BUDGET_MS,
    planCode: runtimeSearchPlanCode,
  });
  const planContext = resolveRuntimeAiPlanContext(
    aiPreviewApproved
      ? buildFreeAiPreviewPlanContext(basePlanContext, usePremiumPreview)
      : applyEconomyDatabaseOnlyMode(
          basePlanContext,
          searchPlan.effectiveMessage || message,
          searchPlan.matches,
          classifyQuestionIntent(message),
        ),
    monthlyUsage,
  );
  const cacheScope = buildAnswerCacheScope(planContext);
  const { normalizedQuestion, questionHash } = buildQuestionCacheIdentity(message, target, cacheScope);
  const cacheKey = buildAnswerCacheKey(message, target, planContext);
  const canUseCache = shouldUseAnswerCache(message) && !debugMode;
  const cachedAnswer = canUseCache ? getCachedAnswer(cacheKey, classifyQuestionIntent(message)) : null;
  if (cachedAnswer) {
    storeConversationContext(
      session,
      target,
      message,
      cachedAnswer.effectiveMessage || message,
      cachedAnswer.sources || [],
      cachedAnswer.resolvedContext || { usedContext: false, topicHints: [] },
      { answerText: cachedAnswer.answer },
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
      answerMode: cachedAnswer.answerMode || cachedAnswer.responseMeta?.answerMode || "cache",
      responseMeta: cachedAnswer.responseMeta || null,
      fromCache: true,
    };

    if (debugMode) {
      cachedResult.debug = {
        selectedSourceTier: cachedAnswer.selectedSourceTier || "cache",
        sourceCount: Array.isArray(cachedAnswer.sources) ? cachedAnswer.sources.length : 0,
        answerMode: cachedAnswer.answerMode || "cache",
        sourceTables: Array.isArray(cachedAnswer.responseMeta?.sourceTables) ? cachedAnswer.responseMeta.sourceTables : [],
        timing: {
          cacheHit: true,
          totalReplyMs: Math.round(nowMs() - startedAt),
        },
        sources: (cachedAnswer.sources || []).map((item) => ({
          source: item.source || "",
          sourceLabel: getSourceDisplayLabel(item.source || ""),
          sourceTable: getSourceTableName(item.source || ""),
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
      consumePreview: aiPreviewApproved && cachedResult.answerMode !== "db_only" && Boolean(cachedResult.answer),
      consumePremiumPreview: usePremiumPreview && cachedResult.answerMode !== "db_only",
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
        cachedResult.answerMode = dbCachedAnswer?.metadata?.answerMode || cachedResult.responseMeta?.answerMode || "db_cache";
        if (debugMode) {
          cachedResult.debug = {
            selectedSourceTier: dbCachedAnswer?.metadata?.selectedSourceTier || "db_cache",
            sourceCount: Number(dbCachedAnswer?.metadata?.sourceCount || 0),
            answerMode: dbCachedAnswer?.metadata?.answerMode || "db_cache",
            sourceTables: Array.isArray(dbCachedAnswer?.metadata?.responseMeta?.sourceTables)
              ? dbCachedAnswer.metadata.responseMeta.sourceTables
              : Array.isArray(dbCachedAnswer?.metadata?.sourceTables)
                ? dbCachedAnswer.metadata.sourceTables
                : [],
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
          { answerText: cachedResult.answer },
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
          responseMeta: cachedResult.responseMeta || null,
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
          consumePreview: aiPreviewApproved && cachedResult.answerMode !== "db_only" && Boolean(cachedResult.answer),
          consumePremiumPreview: usePremiumPreview && cachedResult.answerMode !== "db_only",
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
    promptProfile: planContext.promptProfile,
    planCode: runtimeSearchPlanCode,
  });
  const afterCollectSourcesAt = nowMs();
  const resolvedContext = evidence.resolvedContext;
  const effectiveMessage = evidence.effectiveMessage || message;
  const sources = evidence.sources;
  const highlightTerms = effectiveMessage.split(/\s+/).filter(Boolean).slice(0, 8);
  const retrievalEvaluation = evaluateRetrievalResult({
    message,
    effectiveMessage,
    questionIntent: evidence.questionIntent,
    queryRewriteTrace: evidence.queryRewriteTrace,
    databaseMatches: evidence.databaseMatches,
    internetMatches: evidence.internetMatches,
    selectedSources: sources,
    usedInternetFallback: evidence.usedInternetFallback,
    usedInternetSearch: evidence.usedInternetSearch,
    resolvedContext,
  });

  let answer = "";

  if (!retrievalEvaluation.shouldAnswer) {
    answer = retrievalEvaluation.userFacingMessage;
  } else {
    const remainingBudgetBeforeAnswerMs = getRemainingBudgetMs(
      startedAt,
      CHAT_REPLY_BUDGET_MS,
    );
    const answerSources = sources;
    const answerDiagnostics = {};
    answer = await generateChatSummary(message, answerSources, {
      conversationalFollowUp: resolvedContext.usedContext,
      conversationHistory: getConversationHistory(session, target),
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
      answerDiagnostics,
    });
    evidence.answerDiagnostics = answerDiagnostics;
  }
  const afterAnswerGenerationAt = nowMs();
  const effectiveAnswerMode = retrievalEvaluation.shouldAnswer
    ? evidence.answerDiagnostics?.answerMode || planContext.answerMode || (planContext.useAI ? "ai" : "db_only")
    : retrievalEvaluation.policy;

  if (retrievalEvaluation.shouldAnswer) {
    storeConversationContext(session, target, message, effectiveMessage, sources, resolvedContext, {
      answerText: answer,
      usedSourcesForContinuation: evidence.answerDiagnostics?.usedSources,
    });
  }

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
    hasContext: retrievalEvaluation.shouldAnswer && sources.length > 0,
    answer,
    highlightTerms,
    usedFollowUpContext: resolvedContext.usedContext,
    usedInternetFallback: evidence.usedInternetFallback,
    responseMeta: buildResponseMeta(
      effectiveAnswerMode,
      sources,
    ),
    fromCache: false,
  };

  if (retrievalEvaluation.shouldAnswer && canUseCache && !resolvedContext.usedContext) {
    setCachedAnswer(cacheKey, {
      hasContext: retrievalEvaluation.shouldAnswer && sources.length > 0,
      answer,
      highlightTerms,
      usedInternetFallback: evidence.usedInternetFallback,
      responseMeta: result.responseMeta,
      selectedSourceTier: evidence.selectedSourceTier || "none",
      planCode: planContext.code,
      promptProfile: planContext.promptProfile?.code || "template",
      answerMode: effectiveAnswerMode,
      effectiveMessage,
      resolvedContext,
      sources,
    });
  }

  if (
    retrievalEvaluation.shouldAnswer &&
    canUseCache &&
    !resolvedContext.usedContext &&
    questionHash &&
    shouldPersistDbAnswerCache(answer, { debugMode })
  ) {
    try {
      await LawChatbotAnswerCacheModel.upsert({
        questionHash,
        normalizedQuestion: normalizedQuestion || effectiveMessage || message,
        originalQuestion: message,
        target,
        answerText: answer,
        metadata: {
          hasContext: retrievalEvaluation.shouldAnswer && sources.length > 0,
          highlightTerms,
          usedInternetFallback: evidence.usedInternetFallback,
          selectedSourceTier: evidence.selectedSourceTier || "none",
          effectiveMessage,
          sourceCount: sources.length,
          sourceTables: result.responseMeta?.sourceTables || [],
          responseMeta: result.responseMeta || null,
          planCode: planContext.code,
          promptProfile: planContext.promptProfile?.code || "template",
          answerMode: effectiveAnswerMode,
        },
      });
    } catch (error) {
      console.error("[replyToChat] Answer cache write failed:", error.message || error);
    }
  }

  if (debugMode) {
    const consideredSourceTables = Array.from(
      new Set(
        (evidence.selectionDiagnostics?.rejected || [])
          .map((item) => getSourceTableName(item?.source || ""))
          .filter(Boolean),
      ),
    );
    result.debug = {
      selectedSourceTier: evidence.selectedSourceTier || "none",
      selectedSourceTierLabel: getSourceDisplayLabel(evidence.selectedSourceTier || "none"),
      sourceTables: result.responseMeta?.sourceTables || [],
      consideredSourceTables,
      sourceCount: sources.length,
      databaseMatches: evidence.databaseMatches?.length || 0,
      internetMatches: evidence.internetMatches?.length || 0,
      answerMode:
        evidence.answerDiagnostics?.answerMode || effectiveAnswerMode,
      promptProfile: planContext.promptProfile?.code || "template",
      queryRewrite: evidence.queryRewriteTrace || null,
      queryRewriteCount: Array.isArray(evidence.queryRewriteTrace?.rewrites) ? evidence.queryRewriteTrace.rewrites.length : 0,
      selectionDiagnostics: evidence.selectionDiagnostics || null,
      evaluation: retrievalEvaluation.trace,
      timing: {
        ...(evidence.timing || {}),
        answerGenerationMs: Math.round(afterAnswerGenerationAt - afterCollectSourcesAt),
        totalReplyMs: Math.round(afterAnswerGenerationAt - startedAt),
      },
      sources: sources.map((item) => ({
        source: item.source || "",
        sourceLabel: getSourceDisplayLabel(item.source || ""),
        sourceTable: getSourceTableName(item.source || ""),
        selectionTier: item.selectionTier || "",
        selectionTierLabel: getSourceDisplayLabel(item.selectionTier || ""),
        reference: item.reference || item.title || "",
        score: Number(item.score || 0),
        rawScore: Number(item.rawScore ?? item.score ?? 0),
        rankingTrace: item.rankingTrace || null,
        selectedBecause: evidence.selectionDiagnostics?.selected?.find((candidate) =>
          candidate.source === (item.source || "") &&
          candidate.reference === (item.reference || item.title || ""),
        )?.selectedBecause || "",
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
    consumePreview: aiPreviewApproved && effectiveAnswerMode !== "db_only" && retrievalEvaluation.shouldAnswer && Boolean(answer),
    consumePremiumPreview: usePremiumPreview && effectiveAnswerMode !== "db_only" && retrievalEvaluation.shouldAnswer && Boolean(answer),
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
  const sessionUser = session?.user || null;
  const userId = Number(sessionUser?.userId || sessionUser?.id || 0);
  const usageMonth = UserMonthlyUsageModel.getYearMonth();
  const monthlyUsage = userId
    ? await UserMonthlyUsageModel.findByUserAndMonth(userId, usageMonth)
    : null;

  const target =
    payload.target === "group" ? "group" : payload.target === "coop" ? "coop" : "all";
  const searchPlan = await resolveSearchPlan(message, target, session, {
    planCode: basePlanContext.code,
  });
  const planContext = resolveRuntimeAiPlanContext(
    applyEconomyDatabaseOnlyMode(
      basePlanContext,
      searchPlan.effectiveMessage || message,
      searchPlan.matches,
      classifyQuestionIntent(message),
    ),
    monthlyUsage,
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
  const retrievalEvaluation = evaluateRetrievalResult({
    message,
    effectiveMessage: evidence.effectiveMessage || message,
    questionIntent: evidence.questionIntent,
    queryRewriteTrace: evidence.queryRewriteTrace,
    databaseMatches: evidence.databaseMatches,
    internetMatches: evidence.internetMatches,
    selectedSources: sources,
    usedInternetFallback: evidence.usedInternetFallback,
    usedInternetSearch: evidence.usedInternetSearch,
    resolvedContext,
  });

  if (!retrievalEvaluation.shouldAnswer) {
    return {
      summary: retrievalEvaluation.userFacingMessage,
    };
  }

  return {
    summary: await generateChatSummary(message, sources, {
      conversationalFollowUp: resolvedContext.usedContext,
      conversationHistory: getConversationHistory(session, target),
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

async function getUploadPageData(options = {}) {
  const uploadedChunkCount = await LawChatbotPdfChunkModel.countChunks();
  const maxUploadBytes = Number(process.env.MAX_UPLOAD_BYTES || 20 * 1024 * 1024);
  const uploadedPdfCount = LawChatbotPdfChunkModel.countDocuments();
  const page = normalizePageNumber(options.page || 1);
  const pageSize = normalizePageSize(options.pageSize || 10, 10, 100);
  const pagination = buildPaginationMeta({
    page,
    pageSize,
    totalItems: uploadedPdfCount,
  });

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
    uploadedPdfCount,
    uploadedChunkCount,
    pagination,
    uploadedFiles: LawChatbotPdfChunkModel.list(pagination.pageSize, pagination.offset),
  };
}

async function getFeedbackPageData(options = {}) {
  const stats = LawChatbotFeedbackModel.stats();
  const feedbackCount = LawChatbotFeedbackModel.count();
  const page = normalizePageNumber(options.page || 1);
  const pageSize = normalizePageSize(options.pageSize || 10, 10, 100);
  const pagination = buildPaginationMeta({
    page,
    pageSize,
    totalItems: feedbackCount,
  });

  return {
    appName: "Coopbot Law Chatbot",
    feedbackCount,
    helpfulCount: stats.helpful,
    needsImprovementCount: stats.needsImprovement,
    pagination,
    recentFeedback: LawChatbotFeedbackModel.list(pagination.pageSize, pagination.offset),
  };
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
  getAdminGuestUsageData,
  clearAdminGuestUsage,
  getAdminUsersData,
  adminUpdateUserPlan,
  getAdminPaymentRequestsData,
  getAdminPaymentRequestDetail,
  updatePaymentRequestPlan,
  getKnowledgeAdminData,
  getKnowledgeAdminSummaryData,
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
