const LawChatbotModel = require("../models/lawChatbotModel");
const LawChatbotFeedbackModel = require("../models/lawChatbotFeedbackModel");
const LawChatbotPdfChunkModel = require("../models/lawChatbotPdfChunkModel");
const LawChatbotAnswerCacheModel = require("../models/lawChatbotAnswerCacheModel");
const UserMonthlyUsageModel = require("../models/userMonthlyUsageModel");
const runtimeFlags = require("../config/runtimeFlags");
const { isAiEnabled } = require("./runtimeSettingsService");
const { getOpenAiConfig } = require("./openAiService");
const { buildQuestionCacheIdentity } = require("./lawChatbotAnswerCacheUtils");
const { generateChatSummary, wantsExplanation } = require("./chatAnswerService");
const {
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
const { searchInternetSources } = require("./internetSearchService");
const { canUseAiPreview } = require("./planService");

const CHAT_REQUEST_TIMEOUT_MS = Number(process.env.CHAT_REQUEST_TIMEOUT_MS || 25000);
const CHAT_BUDGET_BUFFER_MS = Number(process.env.CHAT_BUDGET_BUFFER_MS || 3000);
const CHAT_REPLY_BUDGET_MS = Math.max(2000, CHAT_REQUEST_TIMEOUT_MS - CHAT_BUDGET_BUFFER_MS);
const MIN_INTERNET_SEARCH_BUDGET_MS = Number(process.env.LAW_CHATBOT_INTERNET_SEARCH_MIN_BUDGET_MS || 5000);
const MIN_AI_SUMMARY_BUDGET_MS = Number(process.env.LAW_CHATBOT_AI_SUMMARY_MIN_BUDGET_MS || 2500);

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
        topicHints: managedSuggestedQuestionMatch.topicHint ? [managedSuggestedQuestionMatch.topicHint] : [],
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
      queryRewrite: evidence.queryRewriteTrace || null,
      selectionTrace: evidence.selectionTrace || null,
      diagnostics: evidence.selectionDiagnostics || null,
      timing: {
        ...(evidence.timing || {}),
        answerGenerationMs: Math.round(afterAnswerGenerationAt - afterCollectSourcesAt),
        totalReplyMs: Math.round(afterAnswerGenerationAt - startedAt),
      },
      sources: sources.map((item) => ({
        source: item.source || "",
        selectionTier: item.selectionTier || "",
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
