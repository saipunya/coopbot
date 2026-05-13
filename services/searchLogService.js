const fs = require("node:fs/promises");
const path = require("node:path");

const SEARCH_LOG_PATH = path.join(__dirname, "..", "logs", "search-queries.jsonl");

function isTestRuntime() {
  if (String(process.env.NODE_ENV || "").toLowerCase() === "test") {
    return true;
  }

  if (process.env.NODE_TEST_CONTEXT) {
    return true;
  }

  return process.argv.some((arg) => /(?:^|[/\\])tests(?:[/\\])|\.test\.js$|--test/.test(String(arg || "")));
}

async function logSearchQuery(entry = {}) {
  if (isTestRuntime()) {
    return;
  }

  const record = {
    query: String(entry.query || ""),
    expandedQuery: String(entry.expandedQuery || ""),
    confidence: entry.confidence ?? null,
    usedAI: entry.usedAI === true,
    searchStage: String(entry.searchStage || "").trim() || null,
    searchTrace: entry.searchTrace && Array.isArray(entry.searchTrace.stages)
      ? {
          selectedStage: String(entry.searchTrace.selectedStage || "").trim() || null,
          fallbackUsed: entry.searchTrace.fallbackUsed === true,
          stages: entry.searchTrace.stages.map((stage) => ({
            stage: String(stage.stage || "").trim(),
            matched: stage.matched === true,
            matchCount: Number(stage.matchCount || 0),
            topScore: Number(stage.topScore || 0),
            sourceCount: Number(stage.sourceCount || 0),
          })),
        }
      : null,
  };

  await fs.mkdir(path.dirname(SEARCH_LOG_PATH), { recursive: true });
  await fs.appendFile(SEARCH_LOG_PATH, `${JSON.stringify(record)}\n`, "utf8");
}

module.exports = {
  logSearchQuery,
};
