const fs = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_INPUT = path.join(__dirname, "..", "logs", "law-chatbot-ml-dataset.jsonl");

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = String(argv[index] || "");
    const next = String(argv[index + 1] || "");
    if (arg === "--input" && next) {
      args.input = next;
      index += 1;
    }
  }

  return args;
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

function increment(map, key) {
  const normalizedKey = String(key || "unknown").trim() || "unknown";
  map.set(normalizedKey, (map.get(normalizedKey) || 0) + 1);
}

async function main() {
  const args = parseArgs(process.argv);
  const records = await readJsonl(args.input);
  const byDatasetType = new Map();
  const byLabel = new Map();
  const byIntent = new Map();
  const byTopicFamily = new Map();

  for (const record of records) {
    increment(byDatasetType, record.datasetType);
    increment(byLabel, record.label);
    const intent = record.metadata?.intent || record.intent;
    const topicFamily = record.metadata?.topicFamily || record.topicFamily;
    if (intent) {
      increment(byIntent, intent);
    }
    if (topicFamily) {
      increment(byTopicFamily, topicFamily);
    }
  }

  const summary = {
    total: records.length,
    datasetTypes: Object.fromEntries(byDatasetType.entries()),
    labels: Object.fromEntries(byLabel.entries()),
    intents: Object.fromEntries(byIntent.entries()),
    topicFamilies: Object.fromEntries(byTopicFamily.entries()),
  };

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
