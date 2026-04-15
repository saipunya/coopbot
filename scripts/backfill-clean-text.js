#!/usr/bin/env node

require("dotenv").config();

const { connectDb, getDbPool } = require("../config/db");
const { normalizeThai } = require("../utils/thaiNormalizer");

const BATCH_SIZE = 200;
const PREVIEW_LIMIT = 5;

function truncate(text, maxLength = 140) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "(empty)";
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function printDivider() {
  console.log("========================================");
}

async function ensureCleanTextColumn(pool) {
  const [rows] = await pool.query("SHOW COLUMNS FROM pdf_chunks LIKE 'clean_text'");
  return Array.isArray(rows) && rows.length > 0;
}

async function countPendingRows(pool) {
  const [rows] = await pool.query(`
    SELECT COUNT(*) AS total
    FROM pdf_chunks
    WHERE clean_text IS NULL OR TRIM(clean_text) = ''
  `);

  return Number(rows[0]?.total || 0);
}

async function fetchPendingRows(pool, limit) {
  const [rows] = await pool.query(
    `
      SELECT id, chunk_text, clean_text
      FROM pdf_chunks
      WHERE clean_text IS NULL OR TRIM(clean_text) = ''
      ORDER BY id ASC
      LIMIT ?
    `,
    [limit],
  );

  return rows;
}

async function runDryMode(pool) {
  const total = await countPendingRows(pool);

  printDivider();
  console.log("Backfill Clean Text (Dry Run)");
  printDivider();
  console.log(`Rows to process: ${total}`);

  if (total === 0) {
    console.log("Nothing to backfill.");
    return;
  }

  const previewRows = await fetchPendingRows(pool, PREVIEW_LIMIT);
  console.log(`Previewing first ${previewRows.length} rows:\n`);

  previewRows.forEach((row, index) => {
    const normalized = normalizeThai(row.chunk_text || "");
    console.log(`#${index + 1} id=${row.id}`);
    console.log(`before: ${truncate(row.chunk_text)}`);
    console.log(`after : ${truncate(normalized)}`);
    console.log("");
  });
}

async function processBatch(pool, rows, counters) {
  if (!rows.length) {
    return;
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    for (const row of rows) {
      counters.processed += 1;

      const rawChunkText = String(row.chunk_text || "");
      if (!rawChunkText.trim()) {
        counters.skipped += 1;
        console.warn(`Warning: skipped id=${row.id} because chunk_text is empty`);
        continue;
      }

      const cleanText = normalizeThai(rawChunkText);
      if (!cleanText) {
        counters.skipped += 1;
        console.warn(`Warning: skipped id=${row.id} because normalized clean_text is empty`);
        continue;
      }

      try {
        const [result] = await connection.query(
          `
            UPDATE pdf_chunks
            SET clean_text = ?
            WHERE id = ?
              AND (clean_text IS NULL OR TRIM(clean_text) = '')
          `,
          [cleanText, row.id],
        );

        if (Number(result?.affectedRows || 0) > 0) {
          counters.updated += 1;
        } else {
          counters.skipped += 1;
        }
      } catch (error) {
        counters.errors += 1;
        console.error(`Error: failed updating id=${row.id} (${error.message || error})`);
      }
    }

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function runBackfill(pool) {
  const total = await countPendingRows(pool);
  const counters = {
    total,
    processed: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
  };

  printDivider();
  console.log("Backfill Clean Text");
  printDivider();
  console.log(`Total rows to process: ${total}`);

  if (total === 0) {
    console.log("Nothing to backfill.");
    return;
  }

  while (true) {
    const rows = await fetchPendingRows(pool, BATCH_SIZE);
    if (!rows.length) {
      break;
    }

    await processBatch(pool, rows, counters);

    console.log(
      `Progress: processed=${counters.processed}/${counters.total} ` +
      `updated=${counters.updated} skipped=${counters.skipped} errors=${counters.errors}`,
    );
  }

  console.log("\nDone.");
  console.log(`Processed: ${counters.processed}`);
  console.log(`Updated: ${counters.updated}`);
  console.log(`Skipped: ${counters.skipped}`);
  console.log(`Errors: ${counters.errors}`);
}

async function main() {
  const isDryRun = process.argv.includes("--dry-run");

  try {
    await connectDb();

    const pool = getDbPool();
    if (!pool) {
      console.error("Database connection is unavailable. Check your environment variables and DB status.");
      process.exitCode = 1;
      return;
    }

    const hasCleanTextColumn = await ensureCleanTextColumn(pool);
    if (!hasCleanTextColumn) {
      console.error("Column `clean_text` does not exist on table `pdf_chunks`.");
      process.exitCode = 1;
      return;
    }

    if (isDryRun) {
      await runDryMode(pool);
      return;
    }

    await runBackfill(pool);
  } catch (error) {
    console.error(`Backfill failed: ${error.message || error}`);
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
