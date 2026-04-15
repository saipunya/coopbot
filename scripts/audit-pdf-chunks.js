#!/usr/bin/env node

require("dotenv").config();

const { connectDb, getDbPool } = require("../config/db");
const {
  inspectChunkQualityRows,
  summarizeChunkQualityInspection,
} = require("../utils/chunkQualityInspector");

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_THRESHOLD = 80;
const DEFAULT_TOP = 50;

function printDivider() {
  console.log("========================================");
}

function printUsage() {
  console.log("Usage:");
  console.log("  node scripts/audit-pdf-chunks.js");
  console.log("  node scripts/audit-pdf-chunks.js --document-id=12 --threshold=75");
  console.log("  node scripts/audit-pdf-chunks.js --active-only --top=100 --all");
  console.log("");
  console.log("Options:");
  console.log("  --document-id=ID   Audit only one document_id");
  console.log("  --active-only      Audit only rows with is_active = 1");
  console.log("  --limit=N          Limit total rows scanned");
  console.log("  --threshold=N      Score threshold for highlighting rows (default 80)");
  console.log("  --top=N            Maximum suspicious rows to print (default 50)");
  console.log("  --all              Print every scanned row instead of only suspicious rows");
}

function parseArgs(argv) {
  const args = {
    documentId: null,
    activeOnly: false,
    limit: null,
    threshold: DEFAULT_THRESHOLD,
    top: DEFAULT_TOP,
    all: false,
    help: false,
  };

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }

    if (arg === "--active-only") {
      args.activeOnly = true;
      continue;
    }

    if (arg === "--all") {
      args.all = true;
      continue;
    }

    if (arg.startsWith("--document-id=")) {
      const value = Number(arg.slice("--document-id=".length));
      args.documentId = Number.isFinite(value) && value > 0 ? value : null;
      continue;
    }

    if (arg.startsWith("--limit=")) {
      const value = Number(arg.slice("--limit=".length));
      args.limit = Number.isFinite(value) && value > 0 ? value : null;
      continue;
    }

    if (arg.startsWith("--threshold=")) {
      const value = Number(arg.slice("--threshold=".length));
      if (Number.isFinite(value) && value >= 0 && value <= 100) {
        args.threshold = value;
      }
      continue;
    }

    if (arg.startsWith("--top=")) {
      const value = Number(arg.slice("--top=".length));
      args.top = Number.isFinite(value) && value > 0 ? value : DEFAULT_TOP;
      continue;
    }
  }

  return args;
}

function truncatePreview(text, maxLength = 140) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "(empty)";
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function formatList(items = [], emptyValue = "(none)") {
  if (!Array.isArray(items) || items.length === 0) {
    return emptyValue;
  }

  return items.join(", ");
}

function formatNumber(value, fallback = "n/a") {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function formatValue(value, fallback = "n/a") {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  return String(value);
}

function buildWhereClause({ documentId, activeOnly, hasIsActiveColumn, hasDocumentIdColumn }) {
  const clauses = ["1=1"];
  const params = [];

  if (hasDocumentIdColumn && documentId !== null && documentId !== undefined) {
    clauses.push("document_id = ?");
    params.push(documentId);
  }

  if (hasIsActiveColumn && activeOnly) {
    clauses.push("is_active = 1");
  }

  return {
    clause: clauses.join(" AND "),
    params,
  };
}

async function resolveColumnMetadata(pool) {
  const [rows] = await pool.query("SHOW COLUMNS FROM pdf_chunks");
  const columns = new Set((rows || []).map((row) => String(row.Field || "").toLowerCase()));

  return {
    hasDocumentIdColumn: columns.has("document_id"),
    hasIsActiveColumn: columns.has("is_active"),
    hasQualityScoreColumn: columns.has("quality_score"),
    hasCleanTextColumn: columns.has("clean_text"),
  };
}

async function countRows(pool, whereClause, params) {
  const [rows] = await pool.query(`SELECT COUNT(*) AS total FROM pdf_chunks WHERE ${whereClause}`, params);
  return Number(rows[0]?.total || 0);
}

async function fetchRows(pool, selectColumns, whereClause, params, lastId, batchSize, limit) {
  const batchParams = [...params, lastId];
  let limitClause = `LIMIT ${batchSize}`;

  if (Number.isFinite(limit) && limit > 0) {
    const remaining = Math.max(0, limit);
    limitClause = `LIMIT ${Math.min(batchSize, remaining)}`;
  }

  const [rows] = await pool.query(
    `
      SELECT ${selectColumns.join(", ")}
      FROM pdf_chunks
      WHERE ${whereClause}
        AND id > ?
      ORDER BY id ASC
      ${limitClause}
    `,
    batchParams,
  );

  return rows;
}

function printFlagCounts(flagCounts) {
  const entries = Object.entries(flagCounts || {}).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    console.log("Top Flags: (none)");
    return;
  }

  console.log("Top Flags:");
  entries.slice(0, 10).forEach(([flag, count]) => {
    console.log(`  - ${flag}: ${count}`);
  });
}

function printRowInspection(row) {
  const inspection = row.inspection || {};
  console.log("");
  console.log(`#${formatNumber(row.id)}`);
  console.log(`score: ${formatNumber(inspection.score)}`);
  console.log(`flags: ${formatList(inspection.flags)}`);
  console.log(`suggestions: ${formatList(inspection.suggestions)}`);
  console.log(`keyword: ${formatValue(row.keyword)}`);
  console.log(`document_id: ${formatNumber(row.document_id)}`);
  console.log(`quality_score: ${formatNumber(row.quality_score)}`);
  console.log(`chunk_length: ${formatNumber(inspection.metrics?.chunkLength)}`);
  console.log(`keyword_length: ${formatNumber(inspection.metrics?.keywordLength)}`);
  console.log(`keyword_coverage: ${formatNumber(inspection.metrics?.keywordCoverage)}`);
  console.log(`topics: ${formatList(inspection.metrics?.matchedTopics)}`);
  console.log(`preview: ${truncatePreview(row.chunk_text, 180)}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
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

    const metadata = await resolveColumnMetadata(pool);
    const { clause, params } = buildWhereClause({
      documentId: args.documentId,
      activeOnly: args.activeOnly,
      hasIsActiveColumn: metadata.hasIsActiveColumn,
      hasDocumentIdColumn: metadata.hasDocumentIdColumn,
    });

    if (args.activeOnly && !metadata.hasIsActiveColumn) {
      console.warn("Warning: is_active column not found, --active-only will be ignored.");
    }

    if (args.documentId !== null && !metadata.hasDocumentIdColumn) {
      console.warn("Warning: document_id column not found, --document-id will be ignored.");
    }

    const totalRows = await countRows(pool, clause, params);
    if (totalRows === 0) {
      printDivider();
      console.log("PDF Chunk Audit");
      printDivider();
      console.log("No rows matched the selected filters.");
      return;
    }

    const baseSelectColumns = [
      "id",
      "keyword",
      "chunk_text",
      metadata.hasCleanTextColumn ? "clean_text" : "NULL AS clean_text",
      metadata.hasDocumentIdColumn ? "document_id" : "NULL AS document_id",
      metadata.hasIsActiveColumn ? "is_active" : "1 AS is_active",
      metadata.hasQualityScoreColumn ? "quality_score" : "NULL AS quality_score",
    ];

    const allRows = [];
    let lastId = 0;
    let remaining = Number.isFinite(args.limit) && args.limit > 0 ? args.limit : null;

    while (true) {
      const batchSize = remaining === null ? DEFAULT_BATCH_SIZE : Math.min(DEFAULT_BATCH_SIZE, remaining);
      if (batchSize <= 0) {
        break;
      }

      const rows = await fetchRows(pool, baseSelectColumns, clause, params, lastId, batchSize, remaining);
      if (!rows.length) {
        break;
      }

      allRows.push(...rows);
      lastId = Number(rows[rows.length - 1].id || 0);

      if (remaining !== null) {
        remaining -= rows.length;
        if (remaining <= 0) {
          break;
        }
      }
    }

    const inspected = inspectChunkQualityRows(allRows);
    const summary = summarizeChunkQualityInspection(inspected);
    const rowsToShow = inspected
      .filter((row) => {
        const score = Number(row.inspection?.score || 0);
        return args.all || score < args.threshold || (row.inspection?.flags || []).length > 0;
      })
      .sort((a, b) => {
        const scoreA = Number(a.inspection?.score || 0);
        const scoreB = Number(b.inspection?.score || 0);
        if (scoreA !== scoreB) {
          return scoreA - scoreB;
        }
        return Number(a.id || 0) - Number(b.id || 0);
      });

    const displayedRows = args.all ? rowsToShow : rowsToShow.slice(0, args.top);

    printDivider();
    console.log("PDF Chunk Audit");
    printDivider();
    console.log(`Rows matched filters: ${totalRows}`);
    console.log(`Rows scanned: ${inspected.length}${Number.isFinite(args.limit) && args.limit > 0 ? ` (limit=${args.limit})` : ""}`);
    console.log(`Average score: ${summary.averageScore}`);
    console.log(`Rows shown: ${displayedRows.length}`);
    console.log(`Flagged rows: ${summary.flaggedRows}`);
    console.log(`Worst score: ${summary.worstScore === null ? "n/a" : summary.worstScore}`);
    console.log(`Best score: ${summary.bestScore === null ? "n/a" : summary.bestScore}`);
    printFlagCounts(summary.flagCounts);

    if (displayedRows.length === 0) {
      console.log("");
      console.log("No suspicious chunks found.");
      return;
    }

    console.log("");
    console.log(`Showing ${displayedRows.length} rows${args.all ? " (all rows)" : ""}:`);
    displayedRows.forEach((row) => printRowInspection(row));
  } catch (error) {
    console.error(`Audit failed: ${error.message || error}`);
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
