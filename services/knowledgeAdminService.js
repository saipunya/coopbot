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
  const suggestedQuestionsPageSize = normalizePageSize(options.suggestedQuestionsPageSize || options.sqPerPage || 8, 8, 50);
  const knowledgePageSize = normalizePageSize(options.knowledgePageSize || options.knowledgePerPage || 8, 8, 50);
  const pendingSuggestionsPageSize = normalizePageSize(options.pendingSuggestionsPageSize || options.pendingPerPage || 8, 8, 50);

  const [
    knowledgeCount,
    pendingSuggestionCount,
    suggestedQuestionCount,
    activeSuggestedQuestionCount,
  ] = await Promise.all([
    LawChatbotKnowledgeModel.count(),
    LawChatbotKnowledgeSuggestionModel.countPending(),
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
  };
}

async function getKnowledgeAdminSummaryData() {
  const [knowledgeCount, pendingSuggestionCount, suggestedQuestionCount, activeSuggestedQuestionCount] = await Promise.all([
    LawChatbotKnowledgeModel.count(),
    LawChatbotKnowledgeSuggestionModel.countPending(),
    LawChatbotSuggestedQuestionModel.countAll(),
    LawChatbotSuggestedQuestionModel.countActive(),
  ]);

  return {
    knowledgeCount,
    pendingSuggestionCount,
    suggestedQuestionCount,
    activeSuggestedQuestionCount,
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

module.exports = {
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
};
