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
  };

  await fs.mkdir(path.dirname(SEARCH_LOG_PATH), { recursive: true });
  await fs.appendFile(SEARCH_LOG_PATH, `${JSON.stringify(record)}\n`, "utf8");
}

module.exports = {
  logSearchQuery,
};
