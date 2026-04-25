#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_LOG_PATH = path.join(__dirname, "..", "logs", "search-queries.jsonl");
const DEFAULT_LIMIT = 25;
const LOW_CONFIDENCE_MAX = 6;
const MEDIUM_CONFIDENCE_MAX = 12;

function parseArgs(argv) {
  const args = {
    file: DEFAULT_LOG_PATH,
    limit: DEFAULT_LIMIT,
    minCount: 2,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--file" && argv[index + 1]) {
      args.file = path.resolve(argv[index + 1]);
      index += 1;
    } else if (arg === "--limit" && argv[index + 1]) {
      args.limit = Math.max(1, Number(argv[index + 1]) || DEFAULT_LIMIT);
      index += 1;
    } else if (arg === "--min-count" && argv[index + 1]) {
      args.minCount = Math.max(1, Number(argv[index + 1]) || 2);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    }
  }

  return args;
}

function printUsage() {
  console.log("Usage: node scripts/review-search-log.js [--file logs/search-queries.jsonl] [--limit 25] [--min-count 2]");
}

function parseJsonl(filePath) {
  if (!fs.existsSync(filePath)) {
    return { records: [], invalidLines: [] };
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  const records = [];
  const invalidLines = [];

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    try {
      const parsed = JSON.parse(trimmed);
      records.push({
        query: String(parsed.query || "").trim(),
        expandedQuery: String(parsed.expandedQuery || "").trim(),
        confidence: Number.isFinite(Number(parsed.confidence)) ? Number(parsed.confidence) : null,
        usedAI: parsed.usedAI === true,
      });
    } catch (error) {
      invalidLines.push({ line: index + 1, error: error.message || String(error) });
    }
  });

  return { records: records.filter((record) => record.query), invalidLines };
}

function confidenceLabel(confidence) {
  if (confidence === null) {
    return "unknown";
  }

  if (confidence <= LOW_CONFIDENCE_MAX) {
    return "low";
  }

  if (confidence <= MEDIUM_CONFIDENCE_MAX) {
    return "medium";
  }

  return "high";
}

function groupRecords(records) {
  const groups = new Map();

  records.forEach((record) => {
    const key = record.query.toLowerCase();
    const group = groups.get(key) || {
      query: record.query,
      expandedQueries: new Set(),
      count: 0,
      usedAICount: 0,
      confidences: [],
      lowMediumCount: 0,
    };

    group.count += 1;
    if (record.expandedQuery) {
      group.expandedQueries.add(record.expandedQuery);
    }
    if (record.usedAI) {
      group.usedAICount += 1;
    }
    if (record.confidence !== null) {
      group.confidences.push(record.confidence);
    }
    if (["low", "medium"].includes(confidenceLabel(record.confidence))) {
      group.lowMediumCount += 1;
    }

    groups.set(key, group);
  });

  return Array.from(groups.values()).map((group) => {
    const minConfidence = group.confidences.length ? Math.min(...group.confidences) : null;
    const maxConfidence = group.confidences.length ? Math.max(...group.confidences) : null;
    const averageConfidence = group.confidences.length
      ? group.confidences.reduce((sum, value) => sum + value, 0) / group.confidences.length
      : null;

    return {
      ...group,
      expandedQueries: Array.from(group.expandedQueries),
      minConfidence,
      maxConfidence,
      averageConfidence,
    };
  });
}

function sortByReviewPriority(left, right) {
  return (
    right.lowMediumCount - left.lowMediumCount ||
    right.usedAICount - left.usedAICount ||
    right.count - left.count ||
    (left.minConfidence ?? Number.POSITIVE_INFINITY) - (right.minConfidence ?? Number.POSITIVE_INFINITY)
  );
}

function formatConfidence(group) {
  if (group.averageConfidence === null) {
    return "unknown";
  }

  return `${group.averageConfidence.toFixed(1)} avg (${group.minConfidence}-${group.maxConfidence})`;
}

function printSection(title, groups, limit, emptyMessage) {
  console.log(`\n${title}`);
  console.log("-".repeat(title.length));

  if (!groups.length) {
    console.log(emptyMessage);
    return;
  }

  groups.slice(0, limit).forEach((group, index) => {
    console.log(`${index + 1}. ${group.query}`);
    console.log(`   count=${group.count} confidence=${formatConfidence(group)} usedAI=${group.usedAICount}`);
    if (group.expandedQueries.length) {
      console.log(`   expanded=${group.expandedQueries.slice(0, 2).join(" | ")}`);
    }
  });
}

function getFaqCandidates(groups, minCount) {
  return groups
    .filter((group) => {
      if (group.count < minCount) {
        return false;
      }

      if (group.usedAICount > 0 || group.lowMediumCount > 0) {
        return true;
      }

      return group.averageConfidence !== null && group.averageConfidence <= MEDIUM_CONFIDENCE_MAX;
    })
    .sort(sortByReviewPriority);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const { records, invalidLines } = parseJsonl(args.file);
  const groups = groupRecords(records);
  const repeated = groups
    .filter((group) => group.count >= args.minCount)
    .sort((left, right) => right.count - left.count || sortByReviewPriority(left, right));
  const lowMedium = groups
    .filter((group) => group.lowMediumCount > 0)
    .sort(sortByReviewPriority);
  const usedAI = groups
    .filter((group) => group.usedAICount > 0)
    .sort(sortByReviewPriority);
  const faqCandidates = getFaqCandidates(groups, args.minCount);

  console.log("Search Log Review");
  console.log("=================");
  console.log(`file=${args.file}`);
  console.log(`records=${records.length} groupedQueries=${groups.length} invalidLines=${invalidLines.length}`);

  printSection("Repeated Queries", repeated, args.limit, "No repeated queries found.");
  printSection("Low/Medium Confidence", lowMedium, args.limit, "No low or medium confidence queries found.");
  printSection("Used AI", usedAI, args.limit, "No usedAI=true queries found.");
  printSection("Possible FAQ Candidates", faqCandidates, args.limit, "No FAQ candidates found.");

  if (invalidLines.length) {
    console.log("\nInvalid JSONL Lines");
    console.log("-------------------");
    invalidLines.slice(0, args.limit).forEach((item) => {
      console.log(`line ${item.line}: ${item.error}`);
    });
  }
}

main();
