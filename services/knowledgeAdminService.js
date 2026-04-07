const LawChatbotKnowledgeModel = require("../models/lawChatbotKnowledgeModel");
const LawChatbotKnowledgeSuggestionModel = require("../models/lawChatbotKnowledgeSuggestionModel");
const LawChatbotSuggestedQuestionModel = require("../models/lawChatbotSuggestedQuestionModel");
const { clearAnswerCache } = require("./answerStateService");
const { buildPaginationMeta, normalizePageNumber, normalizePageSize } = require("./paginationUtils");
const { normalizeForSearch } = require("./thaiTextUtils");

const suggestionThrottleMap = new Map();

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

async function getKnowledgeAdminData(options = {}) {
  const suggestedQuestionsPage = normalizePageNumber(options.suggestedQuestionsPage || options.sqPage || 1);
  const knowledgePage = normalizePageNumber(options.knowledgePage || 1);
  const pendingSuggestionsPage = normalizePageNumber(options.pendingSuggestionsPage || options.pendingPage || 1);
  const pendingSuggestionSourceTypeFilter = ["text", "voice", "auto_feedback", "auto_no_answer"].includes(String(options.pendingSourceType || options.sourceType || "").trim())
    ? String(options.pendingSourceType || options.sourceType || "").trim()
    : "all";
  const suggestedQuestionsPageSize = normalizePageSize(options.suggestedQuestionsPageSize || options.sqPerPage || 8, 8, 50);
  const knowledgePageSize = normalizePageSize(options.knowledgePageSize || options.knowledgePerPage || 8, 8, 50);
  const pendingSuggestionsPageSize = normalizePageSize(options.pendingSuggestionsPageSize || options.pendingPerPage || 8, 8, 50);

  const [
    knowledgeCount,
    pendingSuggestionCount,
    pendingSuggestionSourceTypeCounts,
    createdTodaySuggestionSourceTypeCounts,
    suggestedQuestionCount,
    activeSuggestedQuestionCount,
  ] = await Promise.all([
    LawChatbotKnowledgeModel.count(),
    LawChatbotKnowledgeSuggestionModel.countPending(pendingSuggestionSourceTypeFilter),
    LawChatbotKnowledgeSuggestionModel.countPendingBySourceType(),
    LawChatbotKnowledgeSuggestionModel.countCreatedTodayBySourceType(),
    LawChatbotSuggestedQuestionModel.countAll(),
    LawChatbotSuggestedQuestionModel.countActive(),
  ]);

  const suggestedQuestionsPagination = buildPaginationMeta({
    page: suggestedQuestionsPage,
    pageSize: suggestedQuestionsPageSize,
    totalItems: suggestedQuestionCount,
  });
  const knowledgePagination = buildPaginationMeta({
    page: knowledgePage,
    pageSize: knowledgePageSize,
    totalItems: knowledgeCount,
  });
  const pendingSuggestionsPagination = buildPaginationMeta({
    page: pendingSuggestionsPage,
    pageSize: pendingSuggestionsPageSize,
    totalItems: pendingSuggestionCount,
  });

  const [recentKnowledge, pendingSuggestions, suggestedQuestions] = await Promise.all([
    LawChatbotKnowledgeModel.listRecent(knowledgePagination.pageSize, knowledgePagination.offset),
    LawChatbotKnowledgeSuggestionModel.listPending(
      pendingSuggestionsPagination.pageSize,
      pendingSuggestionsPagination.offset,
      pendingSuggestionSourceTypeFilter,
    ),
    LawChatbotSuggestedQuestionModel.listRecent(
      suggestedQuestionsPagination.pageSize,
      suggestedQuestionsPagination.offset,
    ),
  ]);

  return {
    appName: "Coopbot Law Chatbot",
    knowledgeCount,
    recentKnowledge,
    pendingSuggestionCount,
    pendingSuggestionSourceTypeCounts,
    createdTodaySuggestionSourceTypeCounts,
    pendingSuggestionSourceTypeFilter,
    pendingSuggestions,
    suggestedQuestionCount,
    activeSuggestedQuestionCount,
    suggestedQuestions,
    suggestedQuestionsPagination,
    knowledgePagination,
    pendingSuggestionsPagination,
    targets: [
      { value: "coop", label: "สหกรณ์" },
      { value: "group", label: "กลุ่มเกษตรกร" },
    ],
    suggestedQuestionTargets: [
      { value: "all", label: "ทุกประเภท" },
      { value: "coop", label: "สหกรณ์" },
      { value: "group", label: "กลุ่มเกษตรกร" },
    ],
    pendingSuggestionSourceTypeOptions: [
      { value: "all", label: "ทุกช่องทาง" },
      { value: "text", label: "ข้อความ" },
      { value: "voice", label: "เสียง" },
      { value: "auto_feedback", label: "feedback อัตโนมัติ" },
      { value: "auto_no_answer", label: "คำถามที่ระบบตอบไม่ได้" },
    ],
  };
}

async function getKnowledgeAdminSummaryData() {
  const [knowledgeCount, pendingSuggestionCount, pendingSuggestionSourceTypeCounts, createdTodaySuggestionSourceTypeCounts, suggestedQuestionCount, activeSuggestedQuestionCount] = await Promise.all([
    LawChatbotKnowledgeModel.count(),
    LawChatbotKnowledgeSuggestionModel.countPending(),
    LawChatbotKnowledgeSuggestionModel.countPendingBySourceType(),
    LawChatbotKnowledgeSuggestionModel.countCreatedTodayBySourceType(),
    LawChatbotSuggestedQuestionModel.countAll(),
    LawChatbotSuggestedQuestionModel.countActive(),
  ]);

  return {
    knowledgeCount,
    pendingSuggestionCount,
    pendingSuggestionSourceTypeCounts,
    createdTodaySuggestionSourceTypeCounts,
    suggestedQuestionCount,
    activeSuggestedQuestionCount,
  };
}

async function saveSuggestedQuestionEntry(payload = {}) {
  const entry = await LawChatbotSuggestedQuestionModel.create({
    target: payload.target,
    questionText: payload.questionText || payload.question,
    answerText: payload.answerText || payload.answer,
    sourceReference: payload.sourceReference || payload.reference,
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
    sourceReference: payload.sourceReference || payload.reference,
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
  const sourceReference = String(payload.sourceReference || payload.reference || "").trim();
  const target = payload.target === "group" ? "group" : "coop";
  const allowedSourceTypes = new Set(["text", "voice", "auto_feedback", "auto_no_answer"]);
  const requestedSourceType = String(payload.sourceType || "text").trim();
  const sourceType = allowedSourceTypes.has(requestedSourceType) ? requestedSourceType : "text";

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
    sourceReference,
    sourceType,
    submittedBy: meta.submittedBy || "",
    submittedByUserId: meta.submittedByUserId || null,
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

  const entryResult = await saveSuggestedQuestionEntry({
    target: suggestion.target,
    questionText: suggestion.title,
    answerText: suggestion.content,
    sourceReference: suggestion.sourceReference,
    displayOrder: 0,
    isActive: 1,
  });

  if (!entryResult.ok) {
    return { ok: false, reason: "not_saved" };
  }

  const updated = await LawChatbotKnowledgeSuggestionModel.updateStatus(id, "approved", {
    reviewedBy: reviewMeta.reviewedBy || "",
    reviewNote: reviewMeta.reviewNote || "",
  });

  return {
    ok: updated,
    entry: entryResult.entry,
    suggestion,
    rewardSummary: {
      grantedBonusQuestions: Number(suggestion.submittedByUserId || 0) > 0 ? 1 : 0,
      contributorLabel: suggestion.submittedBy || "",
    },
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
    sourceReference: patch.sourceReference || patch.reference || "",
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

async function saveKnowledgeSuggestionAsKnowledgeEntry(id, reviewMeta = {}) {
  const suggestion = await LawChatbotKnowledgeSuggestionModel.findById(id);
  if (!suggestion || suggestion.status !== "pending") {
    return { ok: false, reason: "not_found" };
  }

  const reviewedBy = String(reviewMeta.reviewedBy || "").trim() || "admin";
  const reviewedAt = new Date().toISOString();
  const conversionNote = `แปลงจากข้อเสนอเป็นฐานความรู้โดย ${reviewedBy} เมื่อ ${reviewedAt}`;
  const mergedSourceNote = [suggestion.sourceReference || "", conversionNote]
    .filter(Boolean)
    .join(" | ");

  const entry = await saveKnowledgeEntry({
    target: suggestion.target,
    title: suggestion.title,
    content: suggestion.content,
    sourceNote: mergedSourceNote,
  });

  if (!entry) {
    return { ok: false, reason: "not_saved" };
  }

  const rejected = await LawChatbotKnowledgeSuggestionModel.updateStatus(id, "rejected", {
    reviewedBy,
    reviewNote: reviewMeta.reviewNote || conversionNote,
  });

  if (!rejected) {
    return { ok: false, reason: "not_updated" };
  }

  return {
    ok: true,
    entry,
    suggestion,
  };
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

module.exports = {
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
};
