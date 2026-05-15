const fs = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_TRAINING_LOG_PATH = path.join(__dirname, "..", "logs", "law-chatbot-training-examples.jsonl");

function isTestRuntime() {
  if (String(process.env.NODE_ENV || "").toLowerCase() === "test") {
    return true;
  }

  if (process.env.NODE_TEST_CONTEXT) {
    return true;
  }

  return process.argv.some((arg) => /(?:^|[/\\])tests(?:[/\\])|\.test\.js$|--test/.test(String(arg || "")));
}

function getTrainingLogPath() {
  return String(process.env.LAW_CHATBOT_TRAINING_LOG_PATH || "").trim() || DEFAULT_TRAINING_LOG_PATH;
}

function normalizeText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function safeNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

async function appendTrainingExample(record = {}) {
  if (isTestRuntime()) {
    return null;
  }

  const payload = {
    type: String(record.type || "event").trim() || "event",
    timestamp: new Date().toISOString(),
    question: normalizeText(record.question || record.query || ""),
    answer: normalizeText(record.answer || record.answerShown || record.answerPreview || ""),
    target: String(record.target || "all").trim() || "all",
    planCode: String(record.planCode || record.plan || "").trim().toLowerCase() || null,
    source: String(record.source || record.sourceName || "").trim() || null,
    sourceLabel: String(record.sourceLabel || "").trim() || null,
    answerMode: String(record.answerMode || "").trim() || null,
    usedAI: record.usedAI === true,
    helpful: typeof record.helpful === "boolean" ? record.helpful : null,
    confidence: safeNumber(record.confidence, null),
    searchStage: String(record.searchStage || "").trim() || null,
    searchTrace: record.searchTrace || null,
    metadata: record.metadata && typeof record.metadata === "object" ? record.metadata : null,
  };

  if (!payload.question && !payload.answer) {
    return null;
  }

  await fs.mkdir(path.dirname(getTrainingLogPath()), { recursive: true });
  await fs.appendFile(getTrainingLogPath(), `${JSON.stringify(payload)}\n`, "utf8");
  return payload;
}

module.exports = {
  appendTrainingExample,
};
