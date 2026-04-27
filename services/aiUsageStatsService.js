const RuntimeSettingModel = require("../models/runtimeSettingModel");

const AI_REWRITE_TOTAL_KEY = "ai_rewrite_total_calls";
const AI_REWRITE_SUCCESS_KEY = "ai_rewrite_success_calls";
const AI_REWRITE_FAILURE_KEY = "ai_rewrite_failure_calls";
const AI_REWRITE_MODEL = process.env.OPENAI_AI_REWRITE_MODEL || "gpt-5.4-mini";
const GPT_54_MINI_INPUT_USD_PER_1M = Number(process.env.AI_REWRITE_INPUT_USD_PER_1M || 0.75);
const GPT_54_MINI_OUTPUT_USD_PER_1M = Number(process.env.AI_REWRITE_OUTPUT_USD_PER_1M || 4.5);
const ESTIMATED_INPUT_TOKENS_PER_CALL = Number(process.env.AI_REWRITE_EST_INPUT_TOKENS_PER_CALL || 700);
const ESTIMATED_OUTPUT_TOKENS_PER_CALL = Number(process.env.AI_REWRITE_EST_OUTPUT_TOKENS_PER_CALL || 250);
const USD_TO_THB_RATE = Number(process.env.AI_REWRITE_USD_TO_THB_RATE || 32.69);

function formatDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getTodayKey(date = new Date()) {
  return `ai_rewrite_calls_${formatDateKey(date)}`;
}

function parseCount(row) {
  const count = Number(row?.setting_value || 0);
  return Number.isFinite(count) ? count : 0;
}

function roundCurrency(value, decimals = 2) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) {
    return 0;
  }

  return Number(number.toFixed(decimals));
}

function estimateRewriteCost(callCount = 0) {
  const calls = Math.max(0, Number(callCount || 0));
  const inputTokens = calls * Math.max(0, ESTIMATED_INPUT_TOKENS_PER_CALL);
  const outputTokens = calls * Math.max(0, ESTIMATED_OUTPUT_TOKENS_PER_CALL);
  const estimatedUsd =
    (inputTokens / 1_000_000) * GPT_54_MINI_INPUT_USD_PER_1M +
    (outputTokens / 1_000_000) * GPT_54_MINI_OUTPUT_USD_PER_1M;

  return {
    model: AI_REWRITE_MODEL,
    estimatedInputTokens: Math.round(inputTokens),
    estimatedOutputTokens: Math.round(outputTokens),
    estimatedUsd: roundCurrency(estimatedUsd, 4),
    estimatedThb: roundCurrency(estimatedUsd * USD_TO_THB_RATE, 2),
    usdToThbRate: USD_TO_THB_RATE,
    assumptions: {
      inputTokensPerCall: ESTIMATED_INPUT_TOKENS_PER_CALL,
      outputTokensPerCall: ESTIMATED_OUTPUT_TOKENS_PER_CALL,
      inputUsdPer1MTokens: GPT_54_MINI_INPUT_USD_PER_1M,
      outputUsdPer1MTokens: GPT_54_MINI_OUTPUT_USD_PER_1M,
    },
  };
}

async function incrementKey(settingKey) {
  try {
    await RuntimeSettingModel.incrementNumber(settingKey, 1, "system");
  } catch (error) {
    console.error("[ai-usage-stats] Failed to increment AI usage:", error.message || error);
  }
}

async function recordAiRewriteCall(status = "success") {
  const statusKey = status === "failure" ? AI_REWRITE_FAILURE_KEY : AI_REWRITE_SUCCESS_KEY;
  await Promise.all([
    incrementKey(AI_REWRITE_TOTAL_KEY),
    incrementKey(statusKey),
    incrementKey(getTodayKey()),
  ]);
}

async function getAiRewriteUsageSummary() {
  const [total, success, failure, today] = await Promise.all([
    RuntimeSettingModel.findByKey(AI_REWRITE_TOTAL_KEY),
    RuntimeSettingModel.findByKey(AI_REWRITE_SUCCESS_KEY),
    RuntimeSettingModel.findByKey(AI_REWRITE_FAILURE_KEY),
    RuntimeSettingModel.findByKey(getTodayKey()),
  ]);

  const totalCalls = parseCount(total);
  const todayCalls = parseCount(today);

  return {
    totalCalls,
    successCalls: parseCount(success),
    failureCalls: parseCount(failure),
    todayCalls,
    estimatedTotalCost: estimateRewriteCost(totalCalls),
    estimatedTodayCost: estimateRewriteCost(todayCalls),
  };
}

module.exports = {
  estimateRewriteCost,
  getAiRewriteUsageSummary,
  recordAiRewriteCall,
};
