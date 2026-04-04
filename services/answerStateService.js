const UserMonthlyUsageModel = require("../models/userMonthlyUsageModel");
const {
  canUseAiPreview,
  getAiPreviewMonthlyLimit,
  normalizePlanCode,
  resolveUserPlanContext,
} = require("./planService");
const { normalizeForSearch } = require("./thaiTextUtils");

const ANSWER_CACHE_TTL_MS = Number(process.env.LAW_CHATBOT_ANSWER_CACHE_TTL_MS || 5 * 60 * 1000); // 5 minutes base TTL

// TTL based on question intent
const CACHE_TTL_BY_INTENT = {
  law_section: 30 * 60 * 1000, // 30 นาที - กฎหมายไม่เปลี่ยนบ่อย
  short_answer: 15 * 60 * 1000, // 15 นาที - คำตอบสั้นค่อนข้างคงที่
  qa: 10 * 60 * 1000,           // 10 นาที - คำถามทั่วไป
  document: 5 * 60 * 1000,      // 5 นาที - เอกสารอาจอัปเดต
  explain: 7 * 60 * 1000,       // 7 นาที - คำอธิบาย
  general: 10 * 60 * 1000,      // 10 นาที - ค่าเริ่มต้น
};

const ANSWER_CACHE_SCOPE_VERSION = "v13";
const answerCache = new Map();

function buildAnswerCacheScope(planContext = {}) {
  const planCode = normalizePlanCode(planContext.code || planContext.plan || "free");
  const promptProfileCode =
    String(planContext.promptProfile?.code || "").trim().toLowerCase() || "template";
  const internetMode = planContext.useInternet
    ? String(planContext.internetMode || "full").trim().toLowerCase()
    : "none";

  return [ANSWER_CACHE_SCOPE_VERSION, planCode, promptProfileCode, internetMode].join("::");
}

function buildAnswerCacheKey(message, target, planContext = {}) {
  return `${target}::${buildAnswerCacheScope(planContext)}::${normalizeForSearch(message).toLowerCase()}`;
}

function getCachedAnswer(cacheKey, questionIntent = "general") {
  const cached = answerCache.get(cacheKey);
  if (!cached) {
    return null;
  }

  // Use intent-specific TTL
  const ttlMs = CACHE_TTL_BY_INTENT[questionIntent] || ANSWER_CACHE_TTL_MS;
  if (Date.now() - cached.createdAt > ttlMs) {
    answerCache.delete(cacheKey);
    return null;
  }

  return cached.value;
}

function setCachedAnswer(cacheKey, value) {
  answerCache.set(cacheKey, {
    createdAt: Date.now(),
    value,
  });

  if (answerCache.size > 200) {
    const oldestKey = answerCache.keys().next().value;
    if (oldestKey) {
      answerCache.delete(oldestKey);
    }
  }
}

function clearAnswerCache() {
  answerCache.clear();
}

function buildAiPreviewMeta(planContext = {}, usage = null) {
  const planCode = normalizePlanCode(planContext.code || planContext.plan || "free");
  const enabled = canUseAiPreview(planCode);
  const limit = getAiPreviewMonthlyLimit(planCode);
  const usedCount = Math.max(0, Number(usage?.ai_preview_count || 0));
  const remainingCount = enabled ? Math.max(0, limit - usedCount) : 0;

  return {
    enabled,
    limit,
    usedCount,
    remainingCount,
    canTryPreview: enabled && remainingCount > 0,
    exhausted: enabled && remainingCount <= 0,
  };
}

function buildFreeAiPreviewPlanContext(basePlanContext = {}) {
  const professionalPlanContext = resolveUserPlanContext({ plan: "pro" });
  const professionalPromptProfile = professionalPlanContext.promptProfile || {};

  return {
    ...basePlanContext,
    detailLevel: professionalPlanContext.detailLevel,
    useAI: true,
    useInternet: false,
    maxInternetSources: 0,
    sourceLimit: Math.max(1, Number(professionalPlanContext.sourceLimit || 5)),
    strictSourceFiltering: Boolean(professionalPlanContext.strictSourceFiltering),
    preferDatabaseOnlyForLawSections: Boolean(professionalPlanContext.preferDatabaseOnlyForLawSections),
    followUpStrength: professionalPlanContext.followUpStrength || "enhanced",
    promptProfile: {
      ...professionalPromptProfile,
      code: "preview-professional",
    },
    answerMode: "ai_preview",
  };
}

async function attachAiPreviewState(result = {}, options = {}) {
  const previewMeta = options.previewMeta || { enabled: false };
  if (!previewMeta.enabled) {
    return {
      ...result,
      freeAiPreview: {
        enabled: false,
        limit: 0,
        usedCount: 0,
        remainingCount: 0,
        canTryPreview: false,
        exhausted: false,
        usedThisAnswer: false,
      },
    };
  }

  let effectiveMeta = previewMeta;
  let usedThisAnswer = false;

  if (options.consumePreview === true && Number(options.userId || 0) > 0 && options.usageMonth) {
    const updatedUsage = await UserMonthlyUsageModel.incrementAiPreviewCount(options.userId, options.usageMonth);
    effectiveMeta = buildAiPreviewMeta({ code: "free" }, updatedUsage);
    usedThisAnswer = true;
  }

  return {
    ...result,
    freeAiPreview: {
      enabled: true,
      limit: effectiveMeta.limit,
      usedCount: effectiveMeta.usedCount,
      remainingCount: effectiveMeta.remainingCount,
      canTryPreview: effectiveMeta.canTryPreview,
      exhausted: effectiveMeta.exhausted,
      usedThisAnswer,
    },
  };
}

module.exports = {
  attachAiPreviewState,
  buildAiPreviewMeta,
  buildAnswerCacheKey,
  buildAnswerCacheScope,
  buildFreeAiPreviewPlanContext,
  clearAnswerCache,
  getCachedAnswer,
  setCachedAnswer,
};
