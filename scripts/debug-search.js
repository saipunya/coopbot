#!/usr/bin/env node

require("dotenv").config();

const { connectDb, getDbPool } = require("../config/db");
const LawChatbotPdfChunkModel = require("../models/lawChatbotPdfChunkModel");

function printDivider() {
  console.log("========================================");
}

function formatValue(value, fallback = "n/a") {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  return value;
}

function formatList(items = []) {
  if (!Array.isArray(items) || items.length === 0) {
    return "(none)";
  }
  return items.join(", ");
}

function truncatePreview(text, maxLength = 180) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized || "(empty)";
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function printUsage() {
  console.error('Usage: node scripts/debug-search.js "<query>"');
  console.error('Example: node scripts/debug-search.js "คพช"');
}

async function main() {
  const query = process.argv.slice(2).join(" ").trim();

  if (!query) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  try {
    await connectDb();

    const pool = getDbPool();
    if (!pool) {
      console.error("Database connection is unavailable. Check your environment variables and DB status.");
      process.exitCode = 1;
      return;
    }

    const debugResult = await LawChatbotPdfChunkModel.debugSearch(query, 10);
    const { searchContext, totalResults, rawCandidateCount, usedFallback, fulltextEnabled, results } = debugResult;

    printDivider();
    console.log("Search Debug");
    printDivider();
    console.log(`Query: ${query}`);
    console.log(`Normalized: ${formatValue(debugResult.normalizedQuery)}`);
    console.log(`Expanded Terms: ${formatList(searchContext.searchTerms)}`);
    console.log(`Fallback Terms: ${formatList(searchContext.fallbackTerms)}`);
    console.log(`Fulltext Enabled: ${fulltextEnabled ? "yes" : "no"}`);
    console.log(`Used Fallback: ${usedFallback ? "yes" : "no"}`);
    console.log(`Raw Candidate Rows: ${rawCandidateCount}`);
    console.log(`Total Results: ${totalResults}`);

    if (!results.length) {
      console.log("\nNo results found.");
      return;
    }

    results.forEach((row, index) => {
      console.log("");
      console.log(`#${index + 1}`);
      console.log(`id: ${formatValue(row.id)}`);
      console.log(`keyword: ${formatValue(row.keyword)}`);
      console.log(`document_id: ${formatValue(row.document_id)}`);
      console.log(`quality_score: ${formatValue(row.quality_score)}`);
      console.log(`sql_score: ${formatValue(row.sql_score)}`);
      console.log(`finalScore: ${formatValue(row.score)}`);
      console.log(`preview: ${truncatePreview(row.chunk_text, 180)}`);
    });
  } catch (error) {
    console.error(
      /database/i.test(String(error && error.message ? error.message : error))
        ? `Failed to connect to database: ${error.message || error}`
        : `Search debug failed: ${error.message || error}`,
    );
    process.exitCode = 1;
  } finally {
    const pool = getDbPool();
    if (pool && typeof pool.end === "function") {
      try {
        await pool.end();
      } catch (_error) {}
    }
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
