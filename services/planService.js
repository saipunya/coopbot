const {
  DEFAULT_PLAN_CODE,
  DEFAULT_PLAN_DURATION_DAYS,
  PLAN_ALIASES,
  PLAN_DEFINITIONS,
  PLAN_ORDER,
  PAID_PLAN_CODES,
} = require("../config/planConfig");

function normalizePlanCode(value, fallback = DEFAULT_PLAN_CODE) {
  const normalized = String(value || "").trim().toLowerCase();
  if (PLAN_DEFINITIONS[normalized]) {
    return normalized;
  }

  if (PLAN_ALIASES[normalized]) {
    return PLAN_ALIASES[normalized];
  }

  return fallback;
}

function getPlanConfig(planCode = DEFAULT_PLAN_CODE) {
  const normalizedPlanCode = normalizePlanCode(planCode);
  return PLAN_DEFINITIONS[normalizedPlanCode] || PLAN_DEFINITIONS[DEFAULT_PLAN_CODE];
}

function getPlanLabel(planCode = DEFAULT_PLAN_CODE) {
  return getPlanConfig(planCode).label;
}

function getMonthlyLimit(planCode = DEFAULT_PLAN_CODE) {
  return getPlanConfig(planCode).monthlyLimit;
}

function getPlanPriceBaht(planCode = DEFAULT_PLAN_CODE) {
  return Number(getPlanConfig(planCode).priceBaht || 0);
}

function getSearchHistoryRetentionDays(planCode = DEFAULT_PLAN_CODE) {
  return Math.max(0, Number(getPlanConfig(planCode).searchHistoryRetentionDays || 0));
}

function getAiPreviewMonthlyLimit(planCode = DEFAULT_PLAN_CODE) {
  return Math.max(0, Number(getPlanConfig(planCode).aiPreviewMonthlyLimit || 0));
}

function canUseAiPreview(planCode = DEFAULT_PLAN_CODE) {
  const config = getPlanConfig(planCode);
  return Boolean(config.allowAiPreview) && getAiPreviewMonthlyLimit(planCode) > 0;
}

function canUseSearchHistory(planCode = DEFAULT_PLAN_CODE) {
  const config = getPlanConfig(planCode);
  return Boolean(config.allowSearchHistory) && getSearchHistoryRetentionDays(planCode) > 0;
}

function getSearchHistoryRetentionLabel(planCode = DEFAULT_PLAN_CODE) {
  const days = getSearchHistoryRetentionDays(planCode);
  if (!canUseSearchHistory(planCode) || days <= 0) {
    return "ไม่รองรับ";
  }

  if (days >= 30 && days % 30 === 0) {
    const months = days / 30;
    return months === 1 ? "1 เดือน" : `${months} เดือน`;
  }

  return `${days} วัน`;
}

function shouldUseAIForPlan(planCode = DEFAULT_PLAN_CODE, context = {}) {
  const config = getPlanConfig(planCode);
  const economyMode = config.economyMode || {};
  if (!config.useAI) {
    return false;
  }

  if (context.forceAI === true) {
    return true;
  }

  if (economyMode.enabled !== true) {
    return true;
  }

  if (economyMode.alwaysUseAI === true) {
    return true;
  }

  if (economyMode.skipCurrentOrExternal !== false && context.isCurrentOrExternalQuestion === true) {
    return true;
  }

  const dbConfidence = Number(context.dbConfidence || 0);
  const needsExplain = context.needsExplain === true;
  const simpleQuestion = context.simpleQuestion === true;
  const fewResults = context.fewResults === true;
  const strongDbThreshold = Number(economyMode.strongDbThreshold || 18);
  const simpleQuestionThreshold = Number(economyMode.simpleQuestionThreshold || 12);
  const defaultAiThreshold = Number(economyMode.defaultAiThreshold || 12);

  if (dbConfidence >= strongDbThreshold && !needsExplain) {
    return false;
  }

  if (simpleQuestion && dbConfidence >= simpleQuestionThreshold) {
    return false;
  }

  if (fewResults) {
    return true;
  }

  if (needsExplain) {
    return true;
  }

  return dbConfidence < defaultAiThreshold;
}

function isPlanAllowedToUseAI(planCode = DEFAULT_PLAN_CODE) {
  return Boolean(getPlanConfig(planCode).useAI);
}

function isPlanAllowedToUseInternet(planCode = DEFAULT_PLAN_CODE) {
  return Boolean(getPlanConfig(planCode).useInternet);
}

function isPaidPlan(planCode = DEFAULT_PLAN_CODE) {
  return PAID_PLAN_CODES.includes(normalizePlanCode(planCode));
}

function isUnlimitedPlan(planCode = DEFAULT_PLAN_CODE) {
  const monthlyLimit = getMonthlyLimit(planCode);
  return monthlyLimit === null || monthlyLimit === undefined;
}

function getPromptProfile(planCode = DEFAULT_PLAN_CODE) {
  const config = getPlanConfig(planCode);

  switch (config.detailLevel) {
    case "brief":
      return {
        code: "brief",
        instructionTone: "ตอบแบบสั้น ชัด และตรงประเด็น",
        summaryRange: config.summaryRange || "3 ถึง 5 ข้อ",
        detailRange: config.detailRange || "2 ถึง 4 ข้อ",
        aiSourceLimit: config.aiSourceLimit || 3,
        aiTimeoutMs: Number(config.aiTimeoutMs || 4500),
        aiMaxOutputTokens: Number(config.aiMaxOutputTokens || 220),
        aiSourceContextCharLimit: Number(config.aiSourceContextCharLimit || 550),
        compareSources: false,
        strictSourceFiltering: Boolean(config.strictSourceFiltering),
        referenceLimit: Number(config.referenceLimit || 2),
        preferDatabaseOnlyForLawSections: Boolean(config.preferDatabaseOnlyForLawSections),
        followUpStrength: config.followUpStrength || "basic",
        allowDeepAnalysis: false,
      };
    case "deep":
      return {
        code: "deep",
        instructionTone: "ตอบแบบละเอียด เป็นระบบ และเชื่อมโยงหลายแหล่งข้อมูลเมื่อจำเป็น",
        summaryRange: config.summaryRange || "5 ถึง 8 ข้อ",
        detailRange: config.detailRange || "5 ถึง 8 ข้อ",
        aiSourceLimit: config.aiSourceLimit || 7,
        aiTimeoutMs: Number(config.aiTimeoutMs || 6500),
        aiMaxOutputTokens: Number(config.aiMaxOutputTokens || 420),
        aiSourceContextCharLimit: Number(config.aiSourceContextCharLimit || 900),
        compareSources: true,
        strictSourceFiltering: Boolean(config.strictSourceFiltering),
        referenceLimit: Number(config.referenceLimit || 6),
        preferDatabaseOnlyForLawSections: Boolean(config.preferDatabaseOnlyForLawSections),
        followUpStrength: config.followUpStrength || "deep",
        allowDeepAnalysis: Boolean(config.allowDeepAnalysis),
      };
    case "detailed":
      return {
        code: "detailed",
        instructionTone: "ตอบแบบละเอียดพอสมควร พร้อมเหตุผลหรือเงื่อนไขที่เกี่ยวข้อง",
        summaryRange: config.summaryRange || "4 ถึง 6 ข้อ",
        detailRange: config.detailRange || "4 ถึง 6 ข้อ",
        aiSourceLimit: config.aiSourceLimit || 5,
        aiTimeoutMs: Number(config.aiTimeoutMs || 5500),
        aiMaxOutputTokens: Number(config.aiMaxOutputTokens || 320),
        aiSourceContextCharLimit: Number(config.aiSourceContextCharLimit || 700),
        compareSources: false,
        strictSourceFiltering: Boolean(config.strictSourceFiltering),
        referenceLimit: Number(config.referenceLimit || 4),
        preferDatabaseOnlyForLawSections: Boolean(config.preferDatabaseOnlyForLawSections),
        followUpStrength: config.followUpStrength || "enhanced",
        allowDeepAnalysis: Boolean(config.allowDeepAnalysis),
      };
    default:
      return {
        code: "template",
        instructionTone: "ตอบตามข้อมูลจากฐานข้อมูลภายในระบบ",
        summaryRange: config.summaryRange || "4 ถึง 6 ข้อ",
        detailRange: config.detailRange || "3 ถึง 5 ข้อ",
        aiSourceLimit: config.aiSourceLimit || 0,
        aiTimeoutMs: Number(config.aiTimeoutMs || 0),
        aiMaxOutputTokens: Number(config.aiMaxOutputTokens || 0),
        aiSourceContextCharLimit: Number(config.aiSourceContextCharLimit || 0),
        compareSources: false,
        strictSourceFiltering: Boolean(config.strictSourceFiltering),
        referenceLimit: Number(config.referenceLimit || 3),
        preferDatabaseOnlyForLawSections: Boolean(config.preferDatabaseOnlyForLawSections),
        followUpStrength: config.followUpStrength || "basic",
        allowDeepAnalysis: Boolean(config.allowDeepAnalysis),
      };
  }
}

function resolveUserPlanContext(user = {}) {
  const code = normalizePlanCode(user.plan);
  const config = getPlanConfig(code);
  const promptProfile = getPromptProfile(code);

  return {
    ...config,
    code,
    label: config.label,
    priceBaht: Number(config.priceBaht || 0),
    monthlyLimit: config.monthlyLimit,
    isPaid: isPaidPlan(code),
    isUnlimited: isUnlimitedPlan(code),
    promptProfile,
  };
}

function listPurchasablePlans() {
  return PLAN_ORDER.filter((planCode) => isPaidPlan(planCode)).map((planCode) => {
    const config = getPlanConfig(planCode);
    return {
      value: config.code,
      code: config.code,
      label: config.label,
      priceBaht: Number(config.priceBaht || 0),
      monthlyLimit: config.monthlyLimit,
      description:
        config.code === "standard"
          ? "สรุปด้วย AI แบบกระชับจากฐานข้อมูล"
          : config.code === "pro"
            ? "คำตอบละเอียดขึ้น พร้อม internet แบบจำกัด"
            : "คำตอบเต็มรูปแบบ พร้อม internet และการวิเคราะห์เชิงลึก",
    };
  });
}

function listPlanComparisons() {
  return PLAN_ORDER.map((planCode) => {
    const config = getPlanConfig(planCode);
    return {
      code: config.code,
      label: config.label,
      priceBaht: Number(config.priceBaht || 0),
      monthlyLimit: config.monthlyLimit,
      allowSearchHistory: Boolean(config.allowSearchHistory),
      searchHistoryRetentionDays: getSearchHistoryRetentionDays(planCode),
      searchHistoryRetentionLabel: getSearchHistoryRetentionLabel(planCode),
      allowAiPreview: canUseAiPreview(planCode),
      aiPreviewMonthlyLimit: getAiPreviewMonthlyLimit(planCode),
      useAI: Boolean(config.useAI),
      useInternet: Boolean(config.useInternet),
      detailLevel: config.detailLevel || "template",
      allowDeepAnalysis: Boolean(config.allowDeepAnalysis),
      aiSourceLimit: Number(config.aiSourceLimit || 0),
      sourceLimit: Number(config.sourceLimit || 0),
      planSummary: config.planSummary || "",
      highlights: Array.isArray(config.highlights) ? config.highlights : [],
    };
  });
}

function getPlanDurationDays() {
  return DEFAULT_PLAN_DURATION_DAYS;
}

module.exports = {
  DEFAULT_PLAN_CODE,
  DEFAULT_PLAN_DURATION_DAYS,
  getMonthlyLimit,
  getPlanConfig,
  getPlanDurationDays,
  getAiPreviewMonthlyLimit,
  getPlanLabel,
  getPlanPriceBaht,
  getSearchHistoryRetentionDays,
  getSearchHistoryRetentionLabel,
  getPromptProfile,
  canUseAiPreview,
  canUseSearchHistory,
  isPaidPlan,
  isPlanAllowedToUseAI,
  isPlanAllowedToUseInternet,
  isUnlimitedPlan,
  listPurchasablePlans,
  listPlanComparisons,
  normalizePlanCode,
  resolveUserPlanContext,
  shouldUseAIForPlan,
};
