const fs = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_INPUT = path.join(__dirname, "..", "logs", "law-chatbot-feedback-dataset.jsonl");
const DEFAULT_OUTPUT_DIR = path.join(__dirname, "..", "logs", "dataset-splits");

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    outputDir: DEFAULT_OUTPUT_DIR,
    trainRatio: 0.8,
    validationRatio: 0.1,
    seed: 42,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = String(argv[index] || "");
    const next = String(argv[index + 1] || "");

    if (arg === "--input" && next) {
      args.input = next;
      index += 1;
    } else if (arg === "--output-dir" && next) {
      args.outputDir = next;
      index += 1;
    } else if (arg === "--train-ratio" && next) {
      args.trainRatio = Number(next);
      index += 1;
    } else if (arg === "--validation-ratio" && next) {
      args.validationRatio = Number(next);
      index += 1;
    } else if (arg === "--seed" && next) {
      args.seed = Number(next);
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

function createSeededRandom(seed = 42) {
  let state = Number.isFinite(seed) ? seed : 42;
  return function nextRandom() {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function shuffle(values, seed = 42) {
  const random = createSeededRandom(seed);
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

async function writeJsonl(filePath, records) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, records.length ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n` : "", "utf8");
}

async function main() {
  const args = parseArgs(process.argv);
  const records = await readJsonl(args.input);
  const cleanRecords = records.filter((record) => record && typeof record === "object");
  const shuffled = shuffle(cleanRecords, args.seed);

  const trainRatio = Math.min(0.95, Math.max(0.05, Number.isFinite(args.trainRatio) ? args.trainRatio : 0.8));
  const validationRatio = Math.min(0.9, Math.max(0, Number.isFinite(args.validationRatio) ? args.validationRatio : 0.1));
  const testRatio = Math.max(0, 1 - trainRatio - validationRatio);
  const total = shuffled.length;
  const trainCount = Math.floor(total * trainRatio);
  const validationCount = Math.floor(total * validationRatio);
  const train = shuffled.slice(0, trainCount);
  const validation = shuffled.slice(trainCount, trainCount + validationCount);
  const test = shuffled.slice(trainCount + validationCount);

  await writeJsonl(path.join(args.outputDir, "train.jsonl"), train);
  await writeJsonl(path.join(args.outputDir, "validation.jsonl"), validation);
  await writeJsonl(path.join(args.outputDir, "test.jsonl"), test);

  console.log(
    `Split ${total} records into train=${train.length}, validation=${validation.length}, test=${test.length} (target ratios ${trainRatio}/${validationRatio}/${testRatio.toFixed(2)})`,
  );
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
