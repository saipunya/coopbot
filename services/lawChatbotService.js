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
const { rewriteLegalText } = require("./aiRewriteService");
const { buildQuestionCacheIdentity } = require("./lawChatbotAnswerCacheUtils");
const {
  buildDbOnlyMainChatAnswerResult,
  generateChatSummary,
  selectDbOnlyMainChatAnswerEntries,
  wantsExplanation,
  SOURCE_LABELS,
} = require("./chatAnswerService");
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
  resolveThreeLayerChatResponse,
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
  saveKnowledgeSuggestionAsKnowledgeEntry,
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
  resetUserQuestionCount,
  rejectPaymentRequest,
  submitPaymentRequest,
  updatePaymentRequestPlan,
} = require("./userAdminPaymentService");
const { expandSearchConcepts, isTimeFollowUpQuestion, normalizeForSearch } = require("./thaiTextUtils");
const {
  classifyQuestionIntent,
  resolveSearchTarget,
  selectTieredSources,
} = require("./sourceSelectionService");
const { evaluateRetrievalResult } = require("./retrievalEvaluationService");
const { searchInternetSources } = require("./internetSearchService");
const { logSearchQuery } = require("./searchLogService");
const { canUseAiPreview } = require("./planService");
const { buildPaginationMeta, normalizePageNumber, normalizePageSize } = require("./paginationUtils");
const {
  MAIN_CHAT_CONTINUATION_MAX_CHARACTERS,
  MAIN_CHAT_CONTINUATION_SOURCE_LIMIT,
  createContinuationSessionState,
  getSessionContinuationState,
  paginateContinuationState,
  resolveContinuationState,
  setSessionContinuationState,
  signContinuationToken,
} = require("./lawChatbotMainChatContinuation");

const CHAT_REQUEST_TIMEOUT_MS = Number(process.env.CHAT_REQUEST_TIMEOUT_MS || 25000);
const CHAT_BUDGET_BUFFER_MS = Number(process.env.CHAT_BUDGET_BUFFER_MS || 3000);
const CHAT_REPLY_BUDGET_MS = Math.max(2000, CHAT_REQUEST_TIMEOUT_MS - CHAT_BUDGET_BUFFER_MS);
const MIN_INTERNET_SEARCH_BUDGET_MS = Number(process.env.LAW_CHATBOT_INTERNET_SEARCH_MIN_BUDGET_MS || 5000);
const MIN_AI_SUMMARY_BUDGET_MS = Number(process.env.LAW_CHATBOT_AI_SUMMARY_MIN_BUDGET_MS || 2500);
const DB_ONLY_MAIN_CHAT_MAX_SOURCE_CHUNKS = 1;
const DB_ONLY_LAW_SECTION_MAX_SOURCE_CHUNKS = 6;
const AI_SUMMARY_SOURCE_LIMIT = 3;
const AI_SUMMARY_SOURCE_TEXT_LIMIT = Math.max(
  280,
  Number(process.env.LAW_CHATBOT_AI_SOURCE_CONTEXT_CHAR_LIMIT || 700),
);
const PREPARED_QA_NOTICE = "คำตอบนี้มาจาก Q&A/ฐานข้อมูลในระบบ โดยไม่ได้เรียก AI";
const AI_SUMMARY_NOTICE = "คำตอบนี้สรุปโดย AI จากข้อมูลที่ระบบค้นพบ";
const DB_LOOKUP_NOTICE = "คำตอบนี้มาจากการค้นฐานข้อมูลโดยตรง";
const FAQ_HIGH_CONFIDENCE_THRESHOLD = Number(process.env.FAQ_HIGH_CONFIDENCE_THRESHOLD || 0.85);
const LAW_CHATBOT_ASSISTANT_SESSION_KEY = "lawChatbotAssistantProfile";
const LAW_CHATBOT_ASSISTANT_PROFILES = [
  {
    id: "male",
    label: "ผู้ช่วยกฤต",
    gender: "male",
    politeParticle: "ครับ",
  },
  {
    id: "female",
    label: "ผู้ช่วยดาว",
    gender: "female",
    politeParticle: "ค่ะ",
  },
];

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
function resolveSuggestedQuestionTargets(message = "", requestedTarget = "all") {
  const normalizedMessage = normalizeForSearch(String(message || "")).toLowerCase();
  const normalizedRequestedTarget = String(requestedTarget || "").trim().toLowerCase();

  const targets = [];

  if (normalizedRequestedTarget === "group" || /กลุ่มเกษตรกร|กลุ่มเกษต/.test(normalizedMessage)) {
    targets.push("group");
  }

  if (normalizedRequestedTarget === "coop" || /สหกรณ์/.test(normalizedMessage)) {
    targets.push("coop");
  }

  if (normalizedRequestedTarget && !targets.includes(normalizedRequestedTarget)) {
    targets.push(normalizedRequestedTarget);
  }

  if (!targets.includes("all")) {
    targets.push("all");
  }

  return Array.from(new Set(targets.filter(Boolean)));
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

function hasExplicitLawReferenceQuery(message = "") {
  const normalized = normalizeForSearch(String(message || "")).toLowerCase();
  if (!normalized) {
    return false;
  }

  return /(?:มาตรา|ข้อ|วรรค|อนุมาตรา)\s*[0-9๐-๙]{1,4}(?:\/[0-9๐-๙]{1,3})?/.test(normalized);
}

function shouldSkipFaqForQuestion(message = "") {
  return hasExplicitLawReferenceQuery(message) || classifyQuestionIntent(message) === "law_section";
}

function isHighConfidenceFaqMatch(match = null, message = "") {
  if (!match?.answerText) {
    return false;
  }

  const normalizedMessage = normalizeForSearch(String(message || "")).toLowerCase();
  const normalizedQuestion = normalizeForSearch(
    String(match.normalizedQuestion || match.questionText || ""),
  ).toLowerCase();

  if (normalizedMessage && normalizedQuestion && normalizedMessage === normalizedQuestion) {
    return true;
  }

  const similarity = Number(match.similarity);
  return Number.isFinite(similarity) && similarity >= FAQ_HIGH_CONFIDENCE_THRESHOLD;
}

function resolveDbOnlyMainChatMaxSourceChunks(message = "", questionIntent = "") {
  const normalizedIntent = String(questionIntent || "").trim().toLowerCase();
  if (normalizedIntent === "law_section") {
    return DB_ONLY_LAW_SECTION_MAX_SOURCE_CHUNKS;
  }

  return DB_ONLY_MAIN_CHAT_MAX_SOURCE_CHUNKS;
}

function shouldCollapseExactLawSectionPreview(message = "", questionIntent = "") {
  void message;
  void questionIntent;
  return false;
}

function resolveAnswerConfidenceLevel(retrievalEvaluation = null) {
  if (!retrievalEvaluation || typeof retrievalEvaluation !== "object") {
    return "";
  }

  return String(retrievalEvaluation.confidenceLevel || "").trim();
}

function applyAnswerConfidenceNotice(answer = "", retrievalEvaluation = null) {
  const text = String(answer || "").trim();
  if (!text || !retrievalEvaluation?.shouldAnswer) {
    return text;
  }

  const note = String(retrievalEvaluation.answerNote || "").trim();
  if (!note) {
    return text;
  }

  if (text.includes(note)) {
    return text;
  }

  return `${text}\n\n${note}`;
}

function buildResponseMeta(answerMode = "", sources = [], retrievalEvaluation = null, options = {}) {
  const sourceTables = getUniqueSourceTableNames(sources);
  const preparedQaModes = new Set(["prepared_qa_db_only", "managed_answer"]);
  const aiModes = new Set(["ai", "ai_preview", "ai_preview_compact", "mock_ai"]);
  const databaseModes = new Set(["db_only", "economy_db_only", "db_only_main_chat"]);
  const normalizedAnswerMode = String(answerMode || "").trim();
  const usesPreparedQa = preparedQaModes.has(String(answerMode || "").trim());
  const usesAiSummary = aiModes.has(normalizedAnswerMode);
  const usesDatabaseLookup = !usesPreparedQa && !usesAiSummary && databaseModes.has(normalizedAnswerMode);

  return {
    answerMode: normalizedAnswerMode,
    kind: usesPreparedQa ? "prepared_qa" : usesAiSummary ? "ai_summary" : usesDatabaseLookup ? "database_lookup" : "generic",
    usesPreparedQa,
    preparedQaTitle: usesPreparedQa
      ? String((Array.isArray(sources) && sources[0] && (sources[0].title || sources[0].reference)) || "").trim()
      : "",
    notice: usesPreparedQa
      ? PREPARED_QA_NOTICE
      : usesAiSummary
        ? AI_SUMMARY_NOTICE
        : usesDatabaseLookup
          ? DB_LOOKUP_NOTICE
          : "",
    answerConfidence: resolveAnswerConfidenceLevel(retrievalEvaluation),
    answerConfidenceScore: retrievalEvaluation?.confidence ?? null,
    usedAI: Boolean(options.usedAI),
    sourceTables,
  };
}

async function recordSearchQueryLog(query, effectiveQuery, retrievalEvaluation, usedAI) {
  await logSearchQuery({
    query,
    expandedQuery: expandSearchConcepts(effectiveQuery || query),
    confidence: retrievalEvaluation?.confidence ?? null,
    usedAI,
  });
}

function safeTruncateSourceText(text = "", limit = AI_SUMMARY_SOURCE_TEXT_LIMIT) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  const safeLimit = Math.max(0, Number(limit || 0));
  if (!normalized || safeLimit <= 0 || normalized.length <= safeLimit) {
    return normalized;
  }

  return `${Array.from(normalized).slice(0, safeLimit).join("").trim()}...`;
}

function prepareAiSummarySources(sources = [], options = {}) {
  const limit = Math.max(1, Number(options.limit || AI_SUMMARY_SOURCE_LIMIT));
  const textLimit = Math.max(280, Number(options.textLimit || AI_SUMMARY_SOURCE_TEXT_LIMIT));

  return (Array.isArray(sources) ? sources : [])
    .slice(0, limit)
    .map((source) => ({
      ...source,
      content: safeTruncateSourceText(source?.content || "", textLimit),
      chunk_text: safeTruncateSourceText(source?.chunk_text || "", textLimit),
      comment: safeTruncateSourceText(source?.comment || "", textLimit),
    }));
}

function isSummarizeModeEnabled(payload = {}) {
  return payload?.summarizeMode === true || payload?.summaryMode === true;
}

function resolveSummaryAiControl(retrievalEvaluation = null, planContext = {}, payload = {}) {
  const confidenceLevel = resolveAnswerConfidenceLevel(retrievalEvaluation);
  const summarizeModeEnabled = isSummarizeModeEnabled(payload);

  if (confidenceLevel === "high") {
    return {
      allowAI: false,
      reason: "high_confidence",
      summarizeModeEnabled,
    };
  }

  if (confidenceLevel === "low") {
    return {
      allowAI: false,
      reason: "low_confidence",
      summarizeModeEnabled,
    };
  }

  if (confidenceLevel === "medium" && summarizeModeEnabled && planContext?.useAI === true) {
    return {
      allowAI: true,
      reason: "medium_confidence_summary",
      summarizeModeEnabled,
    };
  }

  return {
    allowAI: false,
    reason: summarizeModeEnabled ? "ai_disabled_for_plan" : "summary_mode_disabled",
    summarizeModeEnabled,
  };
}

function logAiUsageGuardViolation(aiControl = {}, retrievalEvaluation = null, details = {}) {
  if (aiControl?.allowAI === true) {
    return;
  }

  console.warn("[law-chatbot] blocked AI usage rule violation", {
    confidenceLevel: resolveAnswerConfidenceLevel(retrievalEvaluation) || "unknown",
    reason: aiControl?.reason || "unknown",
    summarizeModeEnabled: aiControl?.summarizeModeEnabled === true,
    query: String(details.query || "").slice(0, 160),
  });
}

function getLawChatbotAssistantProfile(session) {
  if (!session || typeof session !== "object") {
    return LAW_CHATBOT_ASSISTANT_PROFILES[0];
  }

  const existingProfileId = String(session[LAW_CHATBOT_ASSISTANT_SESSION_KEY]?.id || "").trim();
  const existingProfile = LAW_CHATBOT_ASSISTANT_PROFILES.find((profile) => profile.id === existingProfileId);
  if (existingProfile) {
    return existingProfile;
  }

  const selectedProfile = LAW_CHATBOT_ASSISTANT_PROFILES[
    Math.floor(Math.random() * LAW_CHATBOT_ASSISTANT_PROFILES.length)
  ] || LAW_CHATBOT_ASSISTANT_PROFILES[0];

  session[LAW_CHATBOT_ASSISTANT_SESSION_KEY] = {
    id: selectedProfile.id,
  };

  return selectedProfile;
}

function applyThaiPoliteParticle(text = "", politeParticle = "ครับ") {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return trimmed;
  }

  const trailingPunctuationMatch = trimmed.match(/([\s"'”’)\]\u0E2F\u0E46.!?…]+)$/u);
  const trailingPunctuation = trailingPunctuationMatch ? trailingPunctuationMatch[0] : "";
  const baseText = trailingPunctuation ? trimmed.slice(0, -trailingPunctuation.length).trimEnd() : trimmed;

  const normalizedBaseText = baseText.replace(/(ครับ|ค่ะ|คะ)$/u, "").trimEnd();
  const separator = normalizedBaseText ? " " : "";

  return `${normalizedBaseText}${separator}${politeParticle}${trailingPunctuation}`.trim();
}

function personalizeAnswerWithAssistantProfile(answer = "", assistantProfile = LAW_CHATBOT_ASSISTANT_PROFILES[0]) {
  const rawAnswer = String(answer || "");
  if (!rawAnswer.trim()) {
    return rawAnswer;
  }

  const referenceSectionMatch = rawAnswer.match(/(\n(?:\s*\n)?(?:แหล่งอ้างอิง|อ้างอิง):\s*\n[\s\S]*)$/u);
  const referenceSection = referenceSectionMatch ? referenceSectionMatch[1] : "";
  const mainAnswer = referenceSectionMatch
    ? rawAnswer.slice(0, rawAnswer.length - referenceSection.length)
    : rawAnswer;

  return `${applyThaiPoliteParticle(mainAnswer, assistantProfile.politeParticle)}${referenceSection}`;
}

function personalizeChatResult(session, result = {}) {
  if (!result || typeof result !== "object") {
    return result;
  }

  const assistantProfile = getLawChatbotAssistantProfile(session);

  return {
    ...result,
    answer: personalizeAnswerWithAssistantProfile(result.answer, assistantProfile),
    assistantProfile: {
      id: assistantProfile.id,
      label: assistantProfile.label,
      gender: assistantProfile.gender,
    },
  };
}

async function applyAiRewriteLayer(result = {}, options = {}) {
  const rawAnswer = String(result?.answer || "").trim();
  if (!rawAnswer) {
    return result;
  }

  try {
    const simplifiedAnswer = await rewriteLegalText(rawAnswer, {
      explicitLawSectionQuery: hasExplicitLawReferenceQuery(options.message || ""),
    });

    if (!simplifiedAnswer) {
      return result;
    }

    return {
      ...result,
      answer: simplifiedAnswer,
      simplifiedAnswer,
      rawAnswer,
    };
  } catch (error) {
    console.error("[law-chatbot] AI rewrite failed:", error.message || error);
    return result;
  }
}

function getInitialAssistantProfile(session) {
  const assistantProfile = getLawChatbotAssistantProfile(session);

  return {
    id: assistantProfile.id,
    label: assistantProfile.label,
    gender: assistantProfile.gender,
  };
}

function buildAutoSuggestionQueueMeta(meta = {}, tag = "auto-feedback") {
  const submittedBy = String(meta.submittedBy || "").trim();

  return {
    submittedBy: submittedBy
      ? `${submittedBy} [${tag}]`
      : `ระบบบันทึกอัตโนมัติ [${tag}]`,
    submittedByUserId: Number(meta.submittedByUserId || 0) > 0 ? Number(meta.submittedByUserId) : null,
    sessionId: String(meta.sessionId || "").trim(),
    ip: String(meta.ip || "").trim(),
  };
}

async function queueAutomaticKnowledgeSuggestion(payload = {}, meta = {}, tag = "auto-feedback") {
  try {
    await submitKnowledgeSuggestion(payload, buildAutoSuggestionQueueMeta(meta, tag));
    return {
      queued: true,
      duplicate: false,
    };
  } catch (error) {
    const errorMessage = String(error?.message || "").trim();
    if (errorMessage.includes("มีการส่งข้อเสนอแนะเดิมเข้ามาแล้ว")) {
      return {
        queued: false,
        duplicate: true,
      };
    }

    console.error("[law-chatbot] failed to queue automatic knowledge suggestion:", error);

    return {
      queued: false,
      duplicate: false,
    };
  }
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

function cleanAssistantAnswer(rawAnswer = "", originalMessage = "") {
  let text = String(rawAnswer || "");
  if (!text) return "";

  // Normalize line endings and whitespace
  text = text.replace(/\r\n/g, "\n").replace(/\t/g, " ");

  // Remove lines starting with forbidden prefixes
  const lines = text.split(/\n/).filter((ln) => {
    const t = String(ln || "").trim();
    if (!t) return false;
    if (/^\s*(คำถาม:)/.test(t)) return false;
    if (/^\s*(KR\b)/.test(t)) return false;
    if (/^\s*(ผู้ช่วย\b)/.test(t)) return false;
    return true;
  });

  text = lines.join("\n").trim();

  // If content contains explicit Q/A markers, extract the answer part
  try {
    const qaMatch = text.match(/(?:คำถาม[:\s].*?\n+)?(?:คำตอบ[:\s]*)?(.*)/s);
    if (qaMatch && qaMatch[1]) {
      const candidate = String(qaMatch[1] || "").trim();
      if (candidate) text = candidate;
    }
  } catch (e) {
    // ignore
  }

  // If originalMessage is present and appears at the start of the answer, remove it
  const orig = String(originalMessage || "").replace(/\s+/g, " ").trim();
  if (orig) {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.startsWith(orig)) {
      text = normalized.slice(orig.length).trim();
    }
  }

  // Remove any leading labels like "คำตอบ:" or "Answer:" after trimming
  text = text.replace(/^\s*(คำตอบ[:\s]*)+/i, "").trim();

  return text;
}

function isShortExplainFollowUpMessage(message = "") {
  const text = String(message || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!text) {
    return false;
  }

  // Keep this strict: only for short follow-ups that should expand prior context.
  if (text.length > 22) {
    return false;
  }

  return /^(?:อธิบาย|ช่วยอธิบาย|รายละเอียด|แสดงรายละเอียด|รายละเอียดหน่อย|ฉันไม่เข้าใจ|ไม่เข้าใจ|แจ้งเพิ่มเติม)$/.test(text);
}

async function getMonthlyUsageSafe(userId, usageMonth) {
  if (!Number(userId || 0) || !String(usageMonth || "").trim()) {
    return null;
  }

  try {
    return await UserMonthlyUsageModel.findByUserAndMonth(userId, usageMonth);
  } catch (error) {
    console.error("[law-chatbot] Failed to load monthly usage:", error.message || error);
    return null;
  }
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
  const shouldNarrowToCarrySources =
    carrySources.length > 0 &&
    searchPlan.resolvedContext?.usedContext === true &&
    wantsExplanation(message) &&
    isShortExplainFollowUpMessage(message);
  const databaseMatches = shouldNarrowToCarrySources
    ? mergeUniqueSources(carrySources)
    : mergeUniqueSources(
        carrySources,
        Array.isArray(searchPlan.matches) ? searchPlan.matches : [],
      );
  const topicFamilyId = String(searchPlan?.resolvedContext?.topicFamilyId || "").trim().toLowerCase();
  const timeFollowUpBound = searchPlan?.resolvedContext?.usedContext === true && isTimeFollowUpQuestion(message);
  const guardedDatabaseMatches =
    timeFollowUpBound && topicFamilyId === "coop_dissolution"
      ? databaseMatches.filter((source) => {
          const text = normalizeForSearch(
            [source?.reference, source?.title, source?.keyword, source?.content, source?.chunk_text, source?.comment]
              .filter(Boolean)
              .join(" "),
          ).toLowerCase();
          if (!text) {
            return false;
          }

          const looksLikeMeetingTimeline =
            /(150 วัน|วันสิ้นปีทางบัญชี|ประชุมใหญ่|มาตรา 54|มาตรา 56|มาตรา 57|มาตรา 58)/.test(text);
          const hasDissolutionSignal =
            /(เลิกสหกรณ์|สหกรณ์(?:ย่อม)?เลิก|สั่งเลิกสหกรณ์|มาตรา 70|มาตรา 71|ชำระบัญชี|ผู้ชำระบัญชี|แจ้ง)/.test(text);

          if (looksLikeMeetingTimeline && !hasDissolutionSignal) {
            return false;
          }

          return true;
        })
      : databaseMatches;
  const suppressInternetForFollowUpExplanation =
    carrySources.length > 0 &&
    searchPlan.resolvedContext?.usedContext === true &&
    wantsExplanation(message);
  const shouldSearchInternet =
    allowInternetFallback &&
    !shouldNarrowToCarrySources &&
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
    structured_laws: guardedDatabaseMatches.filter(
      (item) => item && (item.source === "tbl_laws" || item.source === "tbl_glaws"),
    ),
    admin_knowledge: guardedDatabaseMatches.filter((item) => item && item.source === "admin_knowledge"),
    knowledge_suggestion: guardedDatabaseMatches.filter((item) => item && item.source === "knowledge_suggestion"),
    vinichai: guardedDatabaseMatches.filter((item) => item && item.source === "tbl_vinichai"),
    documents: guardedDatabaseMatches.filter((item) => item && item.source === "documents"),
    pdf_chunks: guardedDatabaseMatches.filter((item) => item && item.source === "pdf_chunks"),
    knowledge_base: guardedDatabaseMatches.filter((item) => item && item.source === "knowledge_base"),
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

function buildDbOnlyMainChatContinuation(message = "", nextState = null, options = {}) {
  const label = String(options.label || "ดูคำตอบต่อ").trim() || "ดูคำตอบต่อ";
  if (!nextState || !Array.isArray(nextState.sources) || nextState.sources.length === 0) {
    return {
      available: false,
      label,
    };
  }

  return {
    available: true,
    label,
    token: signContinuationToken(nextState),
  };
}

function buildDbOnlyMainChatErrorResult(answer) {
  return {
    hasContext: false,
    answer: String(answer || "").trim(),
    highlightTerms: [],
    usedFollowUpContext: false,
    usedInternetFallback: false,
    responseMeta: buildResponseMeta("db_only_main_chat", []),
    fromCache: false,
    continuation: {
      available: false,
      label: "ดูคำตอบต่อ",
    },
  };
}

async function buildDbOnlyMainChatAnswer(message, target, sources, options = {}) {
  return buildDbOnlyMainChatAnswerResult(sources, {
    message: options.effectiveMessage || message,
    originalMessage: message,
    questionIntent: options.questionIntent || "",
    collapseExactLawSectionPreview: options.collapseExactLawSectionPreview === true,
    maxPrimarySections: 3,
  });
}

async function replyToDbOnlyMainChat(payload, session) {
  const startedAt = nowMs();
  const requestedMessage = String(payload.message || "").trim();
  const requestedTarget =
    payload.target === "group" ? "group" : payload.target === "coop" ? "coop" : "all";
  const continueFromPrevious =
    payload.continueFromPrevious === true || payload.continueFromPrevious === "true";
  const continuationToken = String(payload.continuationToken || "").trim();
  const debugMode =
    payload && (payload.debug === true || payload.debug === "true" || process.env.CHATBOT_DEBUG === "1");
  const planContext = resolveChatPlanContext(session, {
    aiAvailable: false,
  });

  let continuationState = null;
  let continuationSource = "";
  let invalidContinuationMessage = "";

  if (continueFromPrevious) {
    try {
      const resolvedContinuation = resolveContinuationState({
        continuationToken,
        target: requestedTarget,
        sessionState: getSessionContinuationState(session),
      });
      continuationState = resolvedContinuation.state;
      continuationSource = resolvedContinuation.source;
    } catch (_error) {
      invalidContinuationMessage = "ลิงก์คำตอบต่อหมดอายุหรือไม่ถูกต้อง กรุณาถามใหม่อีกครั้ง";
    }

    if (!continuationState && !invalidContinuationMessage) {
      invalidContinuationMessage = "ไม่พบข้อมูลคำตอบต่อ กรุณาถามใหม่อีกครั้ง";
    }

    if (!continuationState) {
      return buildDbOnlyMainChatErrorResult(invalidContinuationMessage);
    }
  }

  // Prefer explicit request message; if absent, use continuation state's originalMessage
  // Note: token-based continuation should also provide the original message from the token
  const message =
    requestedMessage ||
    (continuationState?.originalMessage ? String(continuationState.originalMessage || "").trim() : "");
  if (!message) {
    return buildDbOnlyMainChatErrorResult("กรุณาระบุคำถามหรือประเด็นที่ต้องการสอบถามก่อนส่งข้อความ");
  }
  let target = resolveSearchTarget(message, requestedTarget);

 if (!continueFromPrevious && !shouldSkipFaqForQuestion(message)) {
  const suggestedQuestionTargets = resolveSuggestedQuestionTargets(message, target);

  let managedSuggestedQuestionMatch = null;
  let managedSuggestedQuestionTarget = target;

  for (const candidateTarget of suggestedQuestionTargets) {
    managedSuggestedQuestionMatch = await findManagedSuggestedQuestionMatch(message, candidateTarget);

    if (isHighConfidenceFaqMatch(managedSuggestedQuestionMatch, message)) {
      managedSuggestedQuestionTarget = candidateTarget;
      break;
    }
  }

  if (isHighConfidenceFaqMatch(managedSuggestedQuestionMatch, message)) {
    // Override target with DB value if present
   if (managedSuggestedQuestionMatch.target) {
  target = managedSuggestedQuestionMatch.target;
} else if (managedSuggestedQuestionTarget) {
  target = managedSuggestedQuestionTarget;
}
    const selectedSources = managedSuggestedQuestionMatch.source ? [managedSuggestedQuestionMatch.source] : [];
    const effectiveMessage = String(
      managedSuggestedQuestionMatch.questionText ||
        managedSuggestedQuestionMatch.topicHint ||
        message,
    ).trim() || message;
    const answer = cleanAssistantAnswer(managedSuggestedQuestionMatch.answerText, "");

    setSessionContinuationState(session, null);

    if (answer && selectedSources.length > 0) {
      storeConversationContext(
        session,
        target,
        message,
        effectiveMessage,
        selectedSources,
        { usedContext: false, topicHints: [] },
        {
          answerText: answer,
          usedSourcesForContinuation: selectedSources.slice(0, MAIN_CHAT_CONTINUATION_SOURCE_LIMIT),
          continuationSourceLimit: MAIN_CHAT_CONTINUATION_SOURCE_LIMIT,
        },
      );
    }

    LawChatbotModel.create({
      message,
      effectiveMessage,
      target,
      answer,
      matchedSources: selectedSources.map((item) => ({
        id: item.id || item.url || item.reference || item.title,
        title: item.title || item.keyword || item.reference,
        lawNumber: item.lawNumber || item.reference || item.keyword,
        source: item.source || "",
        url: item.url || "",
        score: Number(item.score || 0),
      })),
    });

    await recordUserSearchHistory(session, planContext, {
      questionText: message,
      target,
      answerText: answer,
    });

    const result = {
      hasContext: Boolean(answer),
      answer,
      highlightTerms: effectiveMessage.split(/\s+/).filter(Boolean).slice(0, 8),
      usedFollowUpContext: false,
      usedInternetFallback: false,
      responseMeta: buildResponseMeta("managed_answer", selectedSources),
      fromCache: false,
      continuation: {
        available: false,
        label: "ดูคำตอบต่อ",
      },
    };

    if (debugMode) {
      result.debug = {
        selectedSourceTier: "managed_suggested_question",
        selectedSourceTierLabel: "managed_suggested_question",
        sourceTables: result.responseMeta?.sourceTables || [],
        consideredSourceTables: ["chatbot_suggested_questions"],
        sourceCount: selectedSources.length,
        databaseMatches: selectedSources.length,
        internetMatches: 0,
        answerMode: "managed_answer",
        promptProfile: planContext.promptProfile?.code || "template",
        timing: {
          totalReplyMs: Math.round(nowMs() - startedAt),
        },
        suggestedQuestionTargets,
        matchedSuggestedQuestionTarget: managedSuggestedQuestionTarget,
        sources: selectedSources.map((item) => ({
          source: item.source || "",
          sourceLabel: getSourceDisplayLabel(item.source || ""),
          sourceTable: getSourceTableName(item.source || ""),
          reference: item.reference || item.title || "",
          score: Number(item.score || 0),
          preview: String(item.content || item.chunk_text || "").replace(/\s+/g, " ").slice(0, 180),
        })),
      };
    }

    return personalizeChatResult(session, result);
  }
}

  let effectiveMessage = message;
  let resolvedContext = { usedContext: false, topicHints: [] };
  let selectedSources = [];
  let questionIntent = classifyQuestionIntent(message);
  let retrievalEvaluation = null;
  let paginated = null;
  let continuationSessionState = continuationState;
  let answer = "";
  let contextCarrySources = [];
  let answerSourcePool = [];
  let continuationLabel = "ดูคำตอบต่อ";

  if (continueFromPrevious) {
    paginated = await paginateContinuationState(continuationSessionState, {
      maxCharacters: MAIN_CHAT_CONTINUATION_MAX_CHARACTERS,
      maxSourceChunks: resolveDbOnlyMainChatMaxSourceChunks(message, questionIntent),
    });

    if (!Array.isArray(paginated.renderSources) || paginated.renderSources.length === 0) {
      setSessionContinuationState(session, null);
      return buildDbOnlyMainChatErrorResult("ไม่พบข้อมูลคำตอบต่อ กรุณาถามใหม่อีกครั้ง");
    }

    selectedSources = paginated.renderSources;
    if (Array.isArray(selectedSources) && selectedSources.length > 0) {
      const answerResult = await buildDbOnlyMainChatAnswer(message, target, selectedSources, {
        effectiveMessage: continuationSessionState?.effectiveMessage || effectiveMessage,
        usedFollowUpContext: true,
        questionIntent,
        promptProfile: planContext.promptProfile,
        planCode: planContext.code,
      });
      answer = answerResult.answer;
      selectedSources = answerResult.selectedSources;
    } else {
      const answerResult = await buildDbOnlyMainChatAnswer(message, target, selectedSources, {
        effectiveMessage,
        usedFollowUpContext: true,
        questionIntent,
        promptProfile: planContext.promptProfile,
        planCode: planContext.code,
      });
      answer = answerResult.answer;
      selectedSources = answerResult.selectedSources;
    }
  } else {
    const searchPlan = await resolveSearchPlan(message, target, session, {
      requestStartedAt: startedAt,
      totalBudgetMs: CHAT_REPLY_BUDGET_MS,
      planCode: planContext.code,
    });
    const evidence = await collectAnswerSources(message, target, session, {
      searchPlan,
      requestStartedAt: startedAt,
      totalBudgetMs: CHAT_REPLY_BUDGET_MS,
      allowInternetFallback: false,
      databaseOnlyMode: true,
      sourceLimit: planContext.sourceLimit,
      internetLimit: 0,
      promptProfile: planContext.promptProfile,
      planCode: planContext.code,
    });

    effectiveMessage = evidence.effectiveMessage || message;
    resolvedContext = evidence.resolvedContext || resolvedContext;
    selectedSources = evidence.sources || [];
    questionIntent = evidence.questionIntent || questionIntent;
    retrievalEvaluation = evaluateRetrievalResult({
      message,
      effectiveMessage,
      questionIntent,
      queryRewriteTrace: evidence.queryRewriteTrace,
      databaseMatches: evidence.databaseMatches,
      internetMatches: [],
      selectedSources,
      usedInternetFallback: false,
      usedInternetSearch: false,
      resolvedContext,
    });

    if (!retrievalEvaluation.shouldAnswer) {
      setSessionContinuationState(session, null);
      answer = retrievalEvaluation.userFacingMessage;
    } else {
      answerSourcePool = selectDbOnlyMainChatAnswerEntries(selectedSources, {
        message: effectiveMessage,
        originalMessage: message,
        maxPrimarySections: 3,
      }).map((entry) => entry.source).filter(Boolean);
      contextCarrySources = answerSourcePool.slice(0, MAIN_CHAT_CONTINUATION_SOURCE_LIMIT);
      const collapseExactLawSectionPreview = shouldCollapseExactLawSectionPreview(message, questionIntent);
      if (collapseExactLawSectionPreview && answerSourcePool.length > 1) {
        continuationLabel = "ดูเพิ่มเติม";
      }

      if (answerSourcePool.length === 0) {
        setSessionContinuationState(session, null);
        answer = retrievalEvaluation.userFacingMessage || "ขออภัย ขณะนี้ยังไม่พบข้อมูลที่ตรงกับคำถามนี้";
      } else {
        continuationSessionState = createContinuationSessionState({
          target,
          originalMessage: message,
          effectiveMessage,
          sources: answerSourcePool,
        });
        paginated = await paginateContinuationState(continuationSessionState, {
          maxCharacters: MAIN_CHAT_CONTINUATION_MAX_CHARACTERS,
          maxSourceChunks: collapseExactLawSectionPreview
            ? 1
            : resolveDbOnlyMainChatMaxSourceChunks(message, questionIntent),
        });
        selectedSources = paginated.renderSources || [];

        if (selectedSources.length === 0) {
          setSessionContinuationState(session, null);
          answer = retrievalEvaluation.userFacingMessage || "ขออภัย ขณะนี้ยังไม่พบข้อมูลที่ตรงกับคำถามนี้";
        } else {
          const answerResult = await buildDbOnlyMainChatAnswer(message, target, selectedSources, {
            effectiveMessage,
            usedFollowUpContext: resolvedContext.usedContext,
            topicLabel:
              resolvedContext.topicHints && resolvedContext.topicHints[0]
                ? resolvedContext.topicHints[0]
                : "",
            questionIntent,
            collapseExactLawSectionPreview,
            promptProfile: planContext.promptProfile,
            planCode: planContext.code,
          });
          answer = answerResult.answer;
          selectedSources = answerResult.selectedSources;
        }
      }
    }
  }

  const nextContinuationState =
    paginated && Array.isArray(paginated.renderSources) && paginated.renderSources.length > 0
      ? {
          ...continuationSessionState,
          originalMessage:
            continuationSessionState?.originalMessage || message,
          effectiveMessage:
            continuationSessionState?.effectiveMessage || effectiveMessage,
          activeSourceIndex: paginated.nextState.activeSourceIndex,
          sources: paginated.nextState.sources,
        }
      : null;
  const hasContinuation =
    Boolean(nextContinuationState) &&
    paginated?.hasMore === true &&
    nextContinuationState.activeSourceIndex < nextContinuationState.sources.length;

  setSessionContinuationState(session, hasContinuation ? nextContinuationState : null);

  if (answer && (continueFromPrevious || retrievalEvaluation?.shouldAnswer)) {
    storeConversationContext(session, target, message, effectiveMessage, selectedSources, resolvedContext, {
      answerText: answer,
      usedSourcesForContinuation: continueFromPrevious
        ? selectedSources
        : contextCarrySources,
      continuationSourceLimit: MAIN_CHAT_CONTINUATION_SOURCE_LIMIT,
    });
  }
  // Clean answer content before storing and returning
  const cleanedAnswer = cleanAssistantAnswer(answer, message);
  answer = applyAnswerConfidenceNotice(cleanedAnswer, retrievalEvaluation);

  if (!continueFromPrevious) {
    await recordSearchQueryLog(message, effectiveMessage, retrievalEvaluation, false);
  }

  LawChatbotModel.create({
    message,
    effectiveMessage,
    target,
    answer,
    matchedSources: (selectedSources || []).map((item) => ({
      id: item.id || item.url || item.reference || item.title,
      title: item.title || item.keyword || item.reference,
      lawNumber: item.lawNumber || item.reference || item.keyword,
      source: item.source || "",
      url: item.url || "",
      score: Number(item.score || 0),
    })),
  });

  await recordUserSearchHistory(session, planContext, {
    questionText: message,
    target,
    answerText: answer,
  });

  const result = {
    hasContext: Boolean(answer && selectedSources.length > 0),
    answer,
    highlightTerms: effectiveMessage.split(/\s+/).filter(Boolean).slice(0, 8),
    usedFollowUpContext: Boolean(resolvedContext.usedContext),
    usedInternetFallback: false,
    responseMeta: buildResponseMeta("db_only_main_chat", selectedSources, retrievalEvaluation),
    fromCache: false,
    continuation: hasContinuation
      ? buildDbOnlyMainChatContinuation(message, nextContinuationState, {
          label: continuationLabel,
        })
      : {
          available: false,
          label: continuationLabel,
        },
  };

  const rewrittenResult = await applyAiRewriteLayer(result, { message });

  if (retrievalEvaluation?.shouldReturnNoAnswer) {
    rewrittenResult.reviewQueue = await queueNoAnswerKnowledgeSuggestion(
      message,
      target,
      retrievalEvaluation,
      {
        resolvedContext,
        selectionDiagnostics: { selected: [] },
      },
      payload?.requestMeta || {},
    );
  }

  if (debugMode) {
    rewrittenResult.debug = {
      selectedSourceTier: continueFromPrevious ? `continuation_${continuationSource}` : "db_only_main_chat",
      selectedSourceTierLabel: continueFromPrevious ? `continuation_${continuationSource}` : "db_only_main_chat",
      sourceTables: rewrittenResult.responseMeta?.sourceTables || [],
      consideredSourceTables: [],
      sourceCount: selectedSources.length,
      databaseMatches: selectedSources.length,
      internetMatches: 0,
      answerMode: "db_only_main_chat",
      usedAI: false,
      promptProfile: planContext.promptProfile?.code || "template",
      timing: {
        totalReplyMs: Math.round(nowMs() - startedAt),
      },
      sources: selectedSources.map((item) => ({
        source: item.source || "",
        sourceLabel: getSourceDisplayLabel(item.source || ""),
        sourceTable: getSourceTableName(item.source || ""),
        reference: item.reference || item.title || "",
        score: Number(item.score || 0),
        preview: String(item.content || item.chunk_text || "").replace(/\s+/g, " ").slice(0, 180),
      })),
    };
  }

  return personalizeChatResult(session, rewrittenResult);
}

async function replyToChat(payload, session) {
  return replyToDbOnlyMainChat(payload, session);
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
  const monthlyUsage = await getMonthlyUsageSafe(userId, usageMonth);

  const target =
    resolveSearchTarget(
      message,
      payload.target === "group" ? "group" : payload.target === "coop" ? "coop" : "all",
    );
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
    await recordSearchQueryLog(message, evidence.effectiveMessage || message, retrievalEvaluation, false);

    return {
      summary: retrievalEvaluation.userFacingMessage,
      usedAI: false,
      responseMeta: buildResponseMeta("db_only", sources, retrievalEvaluation, { usedAI: false }),
    };
  }

  const assistantProfile = getLawChatbotAssistantProfile(session);
  const aiControl = resolveSummaryAiControl(retrievalEvaluation, planContext, payload);
  const answerDiagnostics = {};
  const summarySources = aiControl.allowAI
    ? prepareAiSummarySources(sources)
    : sources;
  const summaryPromptProfile = aiControl.allowAI
    ? {
        ...planContext.promptProfile,
        aiSourceLimit: AI_SUMMARY_SOURCE_LIMIT,
        aiSourceContextCharLimit: AI_SUMMARY_SOURCE_TEXT_LIMIT,
      }
    : planContext.promptProfile;
  const summary = personalizeAnswerWithAssistantProfile(await generateChatSummary(message, summarySources, {
    conversationalFollowUp: resolvedContext.usedContext,
    conversationHistory: getConversationHistory(session, target),
    topicLabel: resolvedContext.topicHints && resolvedContext.topicHints[0] ? resolvedContext.topicHints[0] : "",
    questionIntent: evidence.questionIntent,
    databaseOnlyMode: !aiControl.allowAI,
    promptProfile: summaryPromptProfile,
    planCode: planContext.code,
    target,
    answerDiagnostics,
  }), assistantProfile);
  const usedAI = answerDiagnostics.usedAI === true;
  if (usedAI && !aiControl.allowAI) {
    logAiUsageGuardViolation(aiControl, retrievalEvaluation, { query: message });
  }
  const responseMeta = buildResponseMeta(usedAI ? "ai" : "db_only", sources, retrievalEvaluation, { usedAI });
  await recordSearchQueryLog(message, evidence.effectiveMessage || message, retrievalEvaluation, usedAI);
  const result = {
    summary: applyAnswerConfidenceNotice(summary, retrievalEvaluation),
    usedAI,
    responseMeta,
    assistantProfile: {
      id: assistantProfile.id,
      label: assistantProfile.label,
      gender: assistantProfile.gender,
    },
  };

  if (payload?.debug === true || payload?.debug === "true") {
    result.debug = {
      usedAI,
      aiControl,
      aiSourceCount: usedAI ? Number(answerDiagnostics.aiSourceCount || 0) : 0,
      confidenceLevel: retrievalEvaluation.confidenceLevel,
      confidence: retrievalEvaluation.confidence,
      sourceCount: sources.length,
    };
  }

  return result;
}

function buildAutoSuggestionSourceReference(payload = {}) {
  const parts = [];
  const suggestedLawNumber = String(payload.suggestedLawNumber || "").trim();
  const sourceLabel = String(payload.sourceLabel || payload.source || "").trim();

  if (suggestedLawNumber) {
    parts.push(suggestedLawNumber);
  }

  if (sourceLabel) {
    parts.push(`อ้างอิงคำตอบเดิมจาก ${sourceLabel}`);
  }

  return parts.join("\n");
}

function buildAutoNoAnswerSuggestionContent(message = "", retrievalEvaluation = null) {
  const reasonText = String(retrievalEvaluation?.trace?.humanReadableDecision || "").trim();

  return [
    `ระบบยังไม่พบคำตอบที่มั่นใจเพียงพอสำหรับคำถามนี้: ${String(message || "").trim()}`,
    reasonText ? `เหตุผล: ${reasonText}` : "",
    "กรุณาแก้ไขข้อความนี้ให้เป็นคำตอบที่ถูกต้องก่อนอนุมัติ",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildAutoNoAnswerSourceReference(message = "", retrievalEvaluation = null, evidence = {}) {
  const parts = [];
  const reasonCodes = Array.isArray(retrievalEvaluation?.trace?.reasonCodes)
    ? retrievalEvaluation.trace.reasonCodes.filter(Boolean)
    : [];
  const sourceTables = Array.from(
    new Set(
      (Array.isArray(evidence?.selectionDiagnostics?.selected) ? evidence.selectionDiagnostics.selected : [])
        .map((item) => getSourceTableName(item?.source || ""))
        .filter(Boolean),
    ),
  );

  parts.push(`คำถามต้นฉบับ: ${String(message || "").trim()}`);

  if (reasonCodes.length > 0) {
    parts.push(`รหัสเหตุผล: ${reasonCodes.join(", ")}`);
  }

  if (sourceTables.length > 0) {
    parts.push(`แหล่งที่ระบบพิจารณา: ${sourceTables.join(", ")}`);
  }

  return parts.join("\n");
}

async function queueNoAnswerKnowledgeSuggestion(message, target, retrievalEvaluation, evidence = {}, meta = {}) {
  const question = String(message || "").trim();
  if (!question || !retrievalEvaluation?.shouldReturnNoAnswer) {
    return {
      queued: false,
      duplicate: false,
    };
  }

  const hasDuplicatePending = await LawChatbotKnowledgeSuggestionModel.hasPendingDuplicate({
    target: target || "all",
    title: question,
    sourceType: "auto_no_answer",
  });

  if (hasDuplicatePending) {
    return {
      queued: false,
      duplicate: true,
    };
  }

  return queueAutomaticKnowledgeSuggestion(
    {
      target: target || "all",
      title: question,
      content: buildAutoNoAnswerSuggestionContent(question, retrievalEvaluation),
      sourceReference: buildAutoNoAnswerSourceReference(question, retrievalEvaluation, evidence),
      sourceType: "auto_no_answer",
    },
    meta,
    "auto-no-answer",
  );
}

async function saveChatFeedback(payload, meta = {}) {
  const feedbackEntry = LawChatbotFeedbackModel.create({
    name: "Chat Feedback",
    email: "",
    message: payload.message || "",
    answerShown: payload.answerShown || "",
    isHelpful: Boolean(payload.isHelpful),
    target: payload.target || "all",
    source: payload.source || payload.sourceName || "",
    sourceLabel: payload.sourceLabel || "",
    expectedAnswer: payload.expectedAnswer || "",
    suggestedLawNumber: payload.suggestedLawNumber || "",
  });

  const isHelpful = Boolean(payload.isHelpful);
  const question = String(payload.message || "").trim();
  const expectedAnswer = String(payload.expectedAnswer || "").trim();

  if (isHelpful || !question || expectedAnswer.length < 10) {
    return {
      feedbackEntry,
      autoSuggestionQueued: false,
      autoSuggestionDuplicate: false,
    };
  }

  const queueResult = await queueAutomaticKnowledgeSuggestion(
    {
      target: payload.target || "all",
      title: question,
      content: expectedAnswer,
      sourceReference: buildAutoSuggestionSourceReference(payload),
      sourceType: "auto_feedback",
    },
    meta,
    "auto-feedback",
  );

  return {
    feedbackEntry,
    autoSuggestionQueued: Boolean(queueResult.queued),
    autoSuggestionDuplicate: Boolean(queueResult.duplicate),
  };
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
  getInitialAssistantProfile,
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
  resetUserQuestionCount,
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
  saveKnowledgeSuggestionAsKnowledgeEntry,
  updateKnowledgeEntry,
  deleteKnowledgeEntry,
  saveFeedback,
  submitPaymentRequest,
  approvePaymentRequest,
  rejectPaymentRequest,
  __private: {
    prepareAiSummarySources,
    logAiUsageGuardViolation,
    resolveSummaryAiControl,
    safeTruncateSourceText,
    shouldSkipFaqForQuestion,
  },
};
