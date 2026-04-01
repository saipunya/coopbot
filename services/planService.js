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

function shouldPreferDatabaseOnlyForEconomy(planCode = DEFAULT_PLAN_CODE, context = {}) {
  const config = getPlanConfig(planCode);
  const economyMode = config.economyMode || {};
  if (!config.useAI || economyMode.enabled !== true) {
    return false;
  }

  const questionIntent = String(context.questionIntent || "")
    .trim()
    .toLowerCase();
  if (!questionIntent) {
    return false;
  }

  const dbOnlyIntents = Array.isArray(economyMode.dbOnlyIntents) ? economyMode.dbOnlyIntents : [];
  if (!dbOnlyIntents.includes(questionIntent)) {
    return false;
  }

  if (economyMode.requireHighConfidenceDb && context.hasHighConfidenceDb !== true) {
    return false;
  }

  if (economyMode.skipCurrentOrExternal !== false && context.isCurrentOrExternalQuestion === true) {
    return false;
  }

  if (context.forceAI === true) {
    return false;
  }

  return true;
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
        summaryRange: "3 ถึง 5 ข้อ",
        detailRange: "2 ถึง 4 ข้อ",
        aiSourceLimit: config.aiSourceLimit || 3,
        compareSources: false,
      };
    case "deep":
      return {
        code: "deep",
        instructionTone: "ตอบแบบละเอียด เป็นระบบ และเชื่อมโยงหลายแหล่งข้อมูลเมื่อจำเป็น",
        summaryRange: "5 ถึง 8 ข้อ",
        detailRange: "5 ถึง 8 ข้อ",
        aiSourceLimit: config.aiSourceLimit || 7,
        compareSources: true,
      };
    case "detailed":
      return {
        code: "detailed",
        instructionTone: "ตอบแบบละเอียดพอสมควร พร้อมเหตุผลหรือเงื่อนไขที่เกี่ยวข้อง",
        summaryRange: "4 ถึง 6 ข้อ",
        detailRange: "4 ถึง 6 ข้อ",
        aiSourceLimit: config.aiSourceLimit || 5,
        compareSources: false,
      };
    default:
      return {
        code: "template",
        instructionTone: "ตอบตามข้อมูลจากฐานข้อมูลภายในระบบ",
        summaryRange: "4 ถึง 6 ข้อ",
        detailRange: "3 ถึง 5 ข้อ",
        aiSourceLimit: config.aiSourceLimit || 0,
        compareSources: false,
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

function getPlanDurationDays() {
  return DEFAULT_PLAN_DURATION_DAYS;
}

module.exports = {
  DEFAULT_PLAN_CODE,
  DEFAULT_PLAN_DURATION_DAYS,
  getMonthlyLimit,
  getPlanConfig,
  getPlanDurationDays,
  getPlanLabel,
  getPlanPriceBaht,
  getPromptProfile,
  isPaidPlan,
  isPlanAllowedToUseAI,
  isPlanAllowedToUseInternet,
  isUnlimitedPlan,
  listPurchasablePlans,
  normalizePlanCode,
  resolveUserPlanContext,
  shouldPreferDatabaseOnlyForEconomy,
};
