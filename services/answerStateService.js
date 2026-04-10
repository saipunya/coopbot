const UserMonthlyUsageModel = require("../models/userMonthlyUsageModel");
const {
  canUseAiPreview,
  getAiPreviewMonthlyLimit,
  getAiPreviewPremiumLimit,
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
  general: 10 * 60 * 1000,      // ค่าเริ่มต้น
};

const ANSWER_CACHE_SCOPE_VERSION = "v16";
const answerCache = new Map();

function buildAnswerCacheScope(planContext = {}) {
  const planCode = normalizePlanCode(planContext.code || planContext.plan || "free");
  const promptProfileCode =
    String(planContext.promptProfile?.code || "").trim().toLowerCase() || "template";
  const aiModel = String(planContext.promptProfile?.aiModel || planContext.aiModel || "").trim().toLowerCase() || "none";
  const internetMode = planContext.useInternet
    ? String(planContext.internetMode || "full").trim().toLowerCase()
    : "none";

  return [ANSWER_CACHE_SCOPE_VERSION, planCode, promptProfileCode, aiModel, internetMode].join("::");
}

function buildAnswerCacheKey(message, target, planContext = {}) {
  const cacheContextKey = String(planContext.cacheContextKey || "").trim().toLowerCase();
  const contextPart = cacheContextKey ? `::ctx=${cacheContextKey}` : "";
  return `${target}::${buildAnswerCacheScope(planContext)}${contextPart}::${normalizeForSearch(message).toLowerCase()}`;
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
  const premiumLimit = getAiPreviewPremiumLimit(planCode);
  const usedCount = Math.max(0, Number(usage?.ai_preview_count || 0));
  const premiumUsedCount = Math.max(0, Number(usage?.ai_preview_premium_count || 0));
  const remainingCount = enabled ? Math.max(0, limit - usedCount) : 0;
  const premiumRemainingCount = enabled ? Math.max(0, premiumLimit - premiumUsedCount) : 0;

  return {
    enabled,
    limit,
    premiumLimit,
    usedCount,
    premiumUsedCount,
    remainingCount,
    premiumRemainingCount,
    canTryPreview: enabled && (remainingCount > 0 || premiumRemainingCount > 0),
    canTryPremiumPreview: enabled && premiumRemainingCount > 0,
    exhausted: enabled && remainingCount <= 0 && premiumRemainingCount <= 0,
  };
}

function buildFreeAiPreviewPlanContext(basePlanContext = {}, usePremiumModel = false) {
  const professionalPlanContext = resolveUserPlanContext({ plan: "pro" });
  const professionalPromptProfile = professionalPlanContext.promptProfile || {};
  const freePlanConfig = require("../config/planConfig").PLAN_DEFINITIONS.free;
  const compactSourceLimit = Math.max(2, Math.min(5, Number(professionalPlanContext.sourceLimit || 5)));
  const previewInternetSourceLimit = professionalPlanContext.useInternet
    ? Math.max(1, Math.min(usePremiumModel ? 2 : 1, Number(professionalPlanContext.maxInternetSources || 1)))
    : 0;
  const previewModel = usePremiumModel
    ? String(freePlanConfig.aiPreviewPremiumModel || "gpt-4o")
    : String(freePlanConfig.aiModel || "gpt-4o-mini");

  return {
    ...basePlanContext,
    detailLevel: professionalPlanContext.detailLevel,
    useAI: true,
    useInternet: previewInternetSourceLimit > 0,
    internetMode: String(professionalPlanContext.internetMode || "limited"),
    maxInternetSources: previewInternetSourceLimit,
    sourceLimit: compactSourceLimit,
    strictSourceFiltering: Boolean(professionalPlanContext.strictSourceFiltering),
    preferDatabaseOnlyForLawSections: Boolean(professionalPlanContext.preferDatabaseOnlyForLawSections),
    followUpStrength: professionalPlanContext.followUpStrength || "enhanced",
    promptProfile: {
      ...professionalPromptProfile,
      code: usePremiumModel ? "preview-premium-compact" : "preview-professional-compact",
      aiModel: previewModel,
      instructionTone: usePremiumModel
        ? "ตอบแบบละเอียดพอสมควร พร้อมเหตุผลหรือเงื่อนไขที่เกี่ยวข้อง"
        : "ตอบแบบสั้น กระชับ และคุ้มต้นทุน แต่ยังเก็บใจความสำคัญให้ครบก่อน",
      summaryRange: usePremiumModel ? "ไม่เกิน 7 บรรทัด" : "ไม่เกิน 4 บรรทัด",
      summaryLineLimit: usePremiumModel ? 8 : 4,
      explainSummaryLineLimit: usePremiumModel ? 8 : 5,
      detailLineLimit: usePremiumModel ? 5 : 4,
      aiSourceLimit: Math.max(2, Math.min(usePremiumModel ? 4 : 3, Number(professionalPromptProfile.aiSourceLimit || 3))),
      aiTimeoutMs: usePremiumModel ? 10000 : Math.max(2500, Math.min(4200, Number(professionalPromptProfile.aiTimeoutMs || 4200))),
      aiMaxOutputTokens: usePremiumModel ? 450 : Math.max(180, Math.min(260, Number(professionalPromptProfile.aiMaxOutputTokens || 260))),
      conciseAiMaxOutputTokens: usePremiumModel ? 320 : 140,
      aiSourceContextCharLimit: usePremiumModel ? 700 : Math.max(320, Math.min(420, Number(professionalPromptProfile.aiSourceContextCharLimit || 420))),
      referenceLimit: Math.max(2, Math.min(usePremiumModel ? 4 : 3, Number(professionalPromptProfile.referenceLimit || 3))),
      followUpPrompt:
        "หากต้องการเพิ่มเติม พิมพ์: อธิบาย, แสดงรายละเอียด, รายละเอียด, ใจความทั้งหมด, ฉันไม่เข้าใจ หรือ แจ้งเพิ่มเติม",
    },
    answerMode: usePremiumModel ? "ai_preview_premium" : "ai_preview_compact",
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
        premiumLimit: 0,
        usedCount: 0,
        premiumUsedCount: 0,
        remainingCount: 0,
        premiumRemainingCount: 0,
        canTryPreview: false,
        canTryPremiumPreview: false,
        exhausted: false,
        usedThisAnswer: false,
        usedPremiumThisAnswer: false,
      },
    };
  }

  let effectiveMeta = previewMeta;
  let usedThisAnswer = false;
  let usedPremiumThisAnswer = false;

  if (options.consumePreview === true && Number(options.userId || 0) > 0 && options.usageMonth) {
    try {
      const incrementFn = options.consumePremiumPreview
        ? UserMonthlyUsageModel.incrementAiPreviewPremiumCount.bind(UserMonthlyUsageModel)
        : UserMonthlyUsageModel.incrementAiPreviewCount.bind(UserMonthlyUsageModel);
      const updatedUsage = await incrementFn(options.userId, options.usageMonth);
      effectiveMeta = buildAiPreviewMeta({ code: "free" }, updatedUsage);
      usedThisAnswer = true;
      usedPremiumThisAnswer = Boolean(options.consumePremiumPreview);
    } catch (error) {
      console.error("[answer-state] Failed to persist AI preview usage:", error.message || error);
    }
  }

  return {
    ...result,
    freeAiPreview: {
      enabled: true,
      limit: effectiveMeta.limit,
      premiumLimit: effectiveMeta.premiumLimit,
      usedCount: effectiveMeta.usedCount,
      premiumUsedCount: effectiveMeta.premiumUsedCount,
      remainingCount: effectiveMeta.remainingCount,
      premiumRemainingCount: effectiveMeta.premiumRemainingCount,
      canTryPreview: effectiveMeta.canTryPreview,
      canTryPremiumPreview: effectiveMeta.canTryPremiumPreview,
      exhausted: effectiveMeta.exhausted,
      usedThisAnswer,
      usedPremiumThisAnswer,
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
