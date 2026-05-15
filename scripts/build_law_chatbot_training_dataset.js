const fs = require("node:fs/promises");
const path = require("node:path");

const { connectDb } = require("../config/db");
const SearchMissLogModel = require("../models/searchMissLogModel");
const { classifyQuestionIntent } = require("../services/sourceSelectionService");
const { detectTopicFamily, getQueryFocusProfile } = require("../services/thaiTextUtils");

const DEFAULT_OUTPUT = path.join(__dirname, "..", "logs", "law-chatbot-ml-dataset.jsonl");
const DEFAULT_TRAINING_LOG = path.join(__dirname, "..", "logs", "law-chatbot-training-examples.jsonl");
const DEFAULT_SEARCH_LOG = path.join(__dirname, "..", "logs", "search-queries.jsonl");

function parseArgs(argv) {
  const args = {
    output: DEFAULT_OUTPUT,
    trainingLog: DEFAULT_TRAINING_LOG,
    searchLog: DEFAULT_SEARCH_LOG,
    includeSearchHistory: true,
    includeSearchMisses: true,
    includeSearchQueries: true,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = String(argv[index] || "");
    const next = String(argv[index + 1] || "");

    if (arg === "--output" && next) {
      args.output = next;
      index += 1;
    } else if (arg === "--training-log" && next) {
      args.trainingLog = next;
      index += 1;
    } else if (arg === "--search-log" && next) {
      args.searchLog = next;
      index += 1;
    } else if (arg === "--no-search-history") {
      args.includeSearchHistory = false;
    } else if (arg === "--no-search-misses") {
      args.includeSearchMisses = false;
    } else if (arg === "--no-search-queries") {
      args.includeSearchQueries = false;
    }
  }

  return args;
}

function normalizeText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function safeJson(value, fallback = null) {
  if (value == null) {
    return fallback;
  }

  if (typeof value !== "object") {
    return fallback;
  }

  return value;
}

function buildQuestionLabels(question = "") {
  const focusProfile = getQueryFocusProfile(question);
  const topicFamily = detectTopicFamily(question);
  return {
    intent: classifyQuestionIntent(question) || focusProfile.intent || "general",
    topicFamily: topicFamily ? String(topicFamily.id || "").trim() || null : null,
    topicHints: Array.isArray(focusProfile.topics) ? focusProfile.topics.map((topic) => topic.primary).filter(Boolean) : [],
  };
}

async function readJsonl(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (_error) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function readSearchQueries(filePath) {
  const records = await readJsonl(filePath);
  return records.map((record) => ({
    datasetType: "search_query",
    question: normalizeText(record.query || ""),
    answer: "",
    label: record.usedAI === true ? "route_ai" : "route_db",
    source: "search_queries",
    target: "all",
    planCode: null,
    usedAI: record.usedAI === true,
    confidence: record.confidence ?? null,
    searchStage: record.searchStage || null,
    searchTrace: safeJson(record.searchTrace),
    metadata: {
      expandedQuery: normalizeText(record.expandedQuery || ""),
      ...buildQuestionLabels(record.query || ""),
    },
    timestamp: record.timestamp || null,
  })).filter((record) => record.question);
}

async function readTrainingExamples(filePath) {
  const records = await readJsonl(filePath);
  return records.map((record) => ({
    datasetType: String(record.type || "event").trim() || "event",
    question: normalizeText(record.question || ""),
    answer: normalizeText(record.answer || ""),
    label: record.type === "feedback"
      ? (record.helpful === true ? "helpful" : record.helpful === false ? "needs_improvement" : "unknown")
      : "observed",
    source: String(record.source || record.type || "training").trim() || "training",
    target: String(record.target || "all").trim() || "all",
    planCode: record.planCode || null,
    usedAI: record.usedAI === true,
    confidence: record.confidence ?? null,
    searchStage: record.searchStage || null,
    searchTrace: safeJson(record.searchTrace),
    metadata: {
      ...safeJson(record.metadata, null),
      ...buildQuestionLabels(record.question || ""),
    },
    timestamp: record.timestamp || null,
  })).filter((record) => record.question || record.answer);
}

async function readUserSearchHistoryRows(includeSearchHistory) {
  if (!includeSearchHistory) {
    return [];
  }

  await connectDb();
  const pool = require("../config/db").getDbPool();
  if (!pool) {
    return [];
  }

  const [rows] = await pool.query(
    `SELECT id, user_id, plan_code, target, question_text, answer_preview, created_at, expires_at
     FROM user_search_history
     ORDER BY created_at DESC, id DESC`,
  );

  return rows.map((row) => ({
    datasetType: "search_history",
    question: normalizeText(row.question_text || ""),
    answer: normalizeText(row.answer_preview || ""),
    label: "observed",
    source: "user_search_history",
    target: String(row.target || "all").trim() || "all",
    planCode: String(row.plan_code || "free").trim().toLowerCase() || "free",
    usedAI: null,
    confidence: null,
    searchStage: null,
    searchTrace: null,
    metadata: {
      userId: Number(row.user_id || 0),
      expiresAt: row.expires_at || null,
      ...buildQuestionLabels(row.question_text || ""),
    },
    timestamp: row.created_at || null,
  })).filter((record) => record.question);
}

async function readSearchMisses(includeSearchMisses) {
  if (!includeSearchMisses) {
    return [];
  }

  const grouped = await SearchMissLogModel.listGrouped();
  return grouped.map((item) => ({
    datasetType: "search_miss",
    question: normalizeText(item.query || ""),
    answer: "",
    label: "needs_coverage",
    source: "search_misses",
    target: "all",
    planCode: null,
    usedAI: null,
    confidence: item.latestConfidence ?? null,
    searchStage: null,
    searchTrace: null,
    metadata: {
      normalizedQuery: normalizeText(item.normalizedQuery || ""),
      count: Number(item.count || 0),
      latestReason: String(item.latestReason || "") || null,
      latestTopResultKeyword: String(item.latestTopResultKeyword || "") || null,
      latestTopResultScore: Number(item.latestTopResultScore || 0),
      ...buildQuestionLabels(item.query || ""),
    },
    timestamp: item.latestTimestamp || null,
  })).filter((record) => record.question);
}

async function writeJsonl(filePath, records) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, records.length ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n` : "", "utf8");
}

async function main() {
  const args = parseArgs(process.argv);
  const [trainingExamples, searchQueries, userSearchHistory, searchMisses] = await Promise.all([
    readTrainingExamples(args.trainingLog),
    args.includeSearchQueries ? readSearchQueries(args.searchLog) : [],
    readUserSearchHistoryRows(args.includeSearchHistory),
    readSearchMisses(args.includeSearchMisses),
  ]);

  const merged = [
    ...trainingExamples,
    ...searchQueries,
    ...userSearchHistory,
    ...searchMisses,
  ].filter((record) => record && record.question);

  await writeJsonl(args.output, merged);

  const summary = merged.reduce((acc, record) => {
    const type = String(record.datasetType || "unknown").trim() || "unknown";
    acc[type] = (acc[type] || 0) + 1;
    return acc;
  }, {});

  console.log(`Wrote ${merged.length} training records to ${args.output}`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
