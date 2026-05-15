const fs = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_INPUT = path.join(__dirname, "..", "logs", "law-chatbot-training-examples.jsonl");
const DEFAULT_OUTPUT = path.join(__dirname, "..", "logs", "law-chatbot-feedback-dataset.jsonl");

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    type: "feedback",
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = String(argv[index] || "");
    const next = String(argv[index + 1] || "");

    if (arg === "--input" && next) {
      args.input = next;
      index += 1;
    } else if (arg === "--output" && next) {
      args.output = next;
      index += 1;
    } else if (arg === "--type" && next) {
      args.type = next;
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

async function main() {
  const args = parseArgs(process.argv);
  const records = await readJsonl(args.input);
  const filtered = records.filter((record) => String(record?.type || "").trim() === args.type);
  const outputLines = filtered.map((record) => JSON.stringify(record));

  await fs.mkdir(path.dirname(args.output), { recursive: true });
  await fs.writeFile(args.output, outputLines.length ? `${outputLines.join("\n")}\n` : "", "utf8");

  console.log(`Exported ${outputLines.length} ${args.type} records to ${args.output}`);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
