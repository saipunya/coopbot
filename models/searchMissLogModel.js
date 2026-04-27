const fs = require("node:fs/promises");
const path = require("node:path");

const SEARCH_MISSES_PATH = path.join(__dirname, "..", "logs", "search-misses.jsonl");

function normalizeQuery(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function getRecordQuery(record = {}) {
  return normalizeQuery(record.originalQuery || record.query || record.normalizedQuery || "");
}

function getRecordTimestamp(record = {}) {
  const timestamp = String(record.timestamp || "").trim();
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getRecordConfidence(record = {}) {
  const value = record.confidence ?? record.answerabilityScore ?? record.topResultScore ?? "";
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : "";
}

async function readJsonlRecords(filePath = SEARCH_MISSES_PATH) {
  let raw = "";
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }

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
}

async function readJsonlLines(filePath = SEARCH_MISSES_PATH) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw.split(/\r?\n/);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

class SearchMissLogModel {
  static async listGrouped(options = {}) {
    const records = await readJsonlRecords(options.filePath || SEARCH_MISSES_PATH);
    const grouped = new Map();

    records.forEach((record) => {
      const query = getRecordQuery(record);
      if (!query) {
        return;
      }

      const existing = grouped.get(query) || {
        query,
        normalizedQuery: normalizeQuery(record.normalizedQuery || query),
        count: 0,
        latestTimestamp: "",
        latestReason: "",
        latestConfidence: "",
        latestTopResultKeyword: "",
        latestTopResultScore: "",
      };
      const recordTimestampMs = getRecordTimestamp(record);
      const existingTimestampMs = getRecordTimestamp({ timestamp: existing.latestTimestamp });

      existing.count += 1;
      if (!existing.latestTimestamp || recordTimestampMs >= existingTimestampMs) {
        existing.latestTimestamp = String(record.timestamp || "");
        existing.latestReason = String(record.reason || "");
        existing.latestConfidence = getRecordConfidence(record);
        existing.latestTopResultKeyword = String(record.topResultKeyword || "");
        existing.latestTopResultScore = Number(record.topResultScore || 0);
      }

      grouped.set(query, existing);
    });

    return Array.from(grouped.values()).sort((left, right) => {
      const countDiff = Number(right.count || 0) - Number(left.count || 0);
      if (countDiff !== 0) {
        return countDiff;
      }

      return getRecordTimestamp({ timestamp: right.latestTimestamp }) - getRecordTimestamp({ timestamp: left.latestTimestamp });
    });
  }

  static async removeQuery(query, options = {}) {
    const normalizedQuery = normalizeQuery(query);
    if (!normalizedQuery) {
      return { removedCount: 0 };
    }

    const filePath = options.filePath || SEARCH_MISSES_PATH;
    const lines = await readJsonlLines(filePath);
    if (lines.length === 0) {
      return { removedCount: 0 };
    }

    let removedCount = 0;
    const keptLines = [];

    lines.forEach((line) => {
      const trimmed = String(line || "").trim();
      if (!trimmed) {
        return;
      }

      let record = null;
      try {
        record = JSON.parse(trimmed);
      } catch (_error) {
        keptLines.push(line);
        return;
      }

      if (getRecordQuery(record) === normalizedQuery) {
        removedCount += 1;
        return;
      }

      keptLines.push(line);
    });

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, keptLines.length ? `${keptLines.join("\n")}\n` : "", "utf8");

    return { removedCount };
  }
}

module.exports = SearchMissLogModel;
