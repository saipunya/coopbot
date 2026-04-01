const DEFAULT_PLAN_CODE = "free";
const DEFAULT_PLAN_DURATION_DAYS = 30;

const PLAN_ORDER = ["free", "standard", "pro", "premium"];
const PAID_PLAN_CODES = ["standard", "pro", "premium"];

const PLAN_ALIASES = {
  "premium-monthly": "premium",
  "premium-yearly": "premium",
  professional: "pro",
  blue: "pro",
};

const PLAN_DEFINITIONS = {
  free: {
    code: "free",
    label: "Free",
    priceBaht: 0,
    monthlyLimit: 50,
    useAI: false,
    useInternet: false,
    internetMode: "none",
    maxInternetSources: 0,
    detailLevel: "template",
    sourceLimit: 10,
    allowDeepAnalysis: false,
    aiSourceLimit: 0,
    isPurchasable: false,
    economyMode: {
      enabled: false,
      dbOnlyIntents: [],
      requireHighConfidenceDb: false,
      skipCurrentOrExternal: false,
    },
  },
  standard: {
    code: "standard",
    label: "Standard",
    priceBaht: 29,
    monthlyLimit: 100,
    useAI: true,
    useInternet: false,
    internetMode: "none",
    maxInternetSources: 0,
    detailLevel: "brief",
    sourceLimit: 5,
    allowDeepAnalysis: false,
    aiSourceLimit: 3,
    isPurchasable: true,
    economyMode: {
      enabled: true,
      dbOnlyIntents: ["short_answer", "law_section"],
      requireHighConfidenceDb: true,
      skipCurrentOrExternal: true,
    },
  },
  pro: {
    code: "pro",
    label: "Pro",
    priceBaht: 39,
    monthlyLimit: 250,
    useAI: true,
    useInternet: true,
    internetMode: "limited",
    maxInternetSources: 2,
    detailLevel: "detailed",
    sourceLimit: 8,
    allowDeepAnalysis: false,
    aiSourceLimit: 5,
    isPurchasable: true,
    economyMode: {
      enabled: true,
      dbOnlyIntents: ["short_answer", "law_section"],
      requireHighConfidenceDb: true,
      skipCurrentOrExternal: true,
    },
  },
  premium: {
    code: "premium",
    label: "Premium",
    priceBaht: 69,
    monthlyLimit: 500,
    useAI: true,
    useInternet: true,
    internetMode: "full",
    maxInternetSources: 4,
    detailLevel: "deep",
    sourceLimit: 12,
    allowDeepAnalysis: true,
    aiSourceLimit: 7,
    isPurchasable: true,
    economyMode: {
      enabled: true,
      dbOnlyIntents: ["short_answer", "law_section"],
      requireHighConfidenceDb: true,
      skipCurrentOrExternal: true,
    },
  },
};

module.exports = {
  DEFAULT_PLAN_CODE,
  DEFAULT_PLAN_DURATION_DAYS,
  PLAN_ALIASES,
  PLAN_DEFINITIONS,
  PLAN_ORDER,
  PAID_PLAN_CODES,
};
