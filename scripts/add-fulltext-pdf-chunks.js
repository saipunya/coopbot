#!/usr/bin/env node

require("dotenv").config();

const { connectDb, getDbPool } = require("../config/db");

const TARGET_TABLE = "pdf_chunks";
const TARGET_INDEX = "idx_pdf_chunks_search";
const TARGET_COLUMNS = ["keyword", "chunk_text", "clean_text"];
const SUPPORTED_ENGINES = new Set(["innodb", "myisam", "aria", "mroonga"]);

function printDivider() {
  console.log("========================================");
}

function formatList(items) {
  return Array.isArray(items) && items.length > 0 ? items.join(", ") : "(none)";
}

async function fetchTableInfo(pool) {
  const dbNameRows = await pool.query("SELECT DATABASE() AS db_name");
  const dbName = String(dbNameRows[0]?.[0]?.db_name || "").trim();
  if (!dbName) {
    throw new Error("No active database selected");
  }

  const [tableRows] = await pool.query(
    `
      SELECT TABLE_NAME, ENGINE, TABLE_COLLATION
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?
      LIMIT 1
    `,
    [dbName, TARGET_TABLE],
  );

  return {
    dbName,
    table: tableRows[0] || null,
  };
}

async function fetchColumnNames(pool) {
  const [rows] = await pool.query(`SHOW COLUMNS FROM ${TARGET_TABLE}`);
  return rows.map((row) => String(row.Field || "").trim().toLowerCase());
}

async function fetchFulltextIndexes(pool) {
  const [rows] = await pool.query(`SHOW INDEX FROM ${TARGET_TABLE} WHERE Index_type = 'FULLTEXT'`);
  return rows;
}

function hasTargetIndex(indexRows) {
  return indexRows.some((row) => String(row.Key_name || "").trim() === TARGET_INDEX);
}

function hasRequiredColumns(columnNames) {
  const columnSet = new Set(columnNames);
  return TARGET_COLUMNS.every((column) => columnSet.has(column));
}

async function addFulltextIndex() {
  printDivider();
  console.log("Add FULLTEXT Index: pdf_chunks");
  printDivider();

  await connectDb();
  const pool = getDbPool();

  if (!pool) {
    console.error("Status: failed");
    console.error("Reason: database connection is unavailable");
    process.exitCode = 1;
    return;
  }

  const { dbName, table } = await fetchTableInfo(pool);
  if (!table) {
    console.log("Status: skipped");
    console.log(`Reason: table \`${TARGET_TABLE}\` does not exist in schema \`${dbName}\``);
    return;
  }

  const engine = String(table.ENGINE || "").trim();
  const collation = String(table.TABLE_COLLATION || "").trim();
  const normalizedEngine = engine.toLowerCase();

  console.log(`Database: ${dbName}`);
  console.log(`Table: ${TARGET_TABLE}`);
  console.log(`Engine: ${engine || "unknown"}`);
  console.log(`Collation: ${collation || "unknown"}`);

  if (!SUPPORTED_ENGINES.has(normalizedEngine)) {
    console.log("Status: skipped");
    console.log(
      `Reason: storage engine \`${engine || "unknown"}\` is not in the known-compatible set (${formatList(
        Array.from(SUPPORTED_ENGINES),
      )})`,
    );
    console.log("Note: MariaDB/MySQL FULLTEXT support depends on engine/version; verify manually before forcing.");
    return;
  }

  const columnNames = await fetchColumnNames(pool);
  console.log(`Columns found: ${formatList(columnNames)}`);

  if (!hasRequiredColumns(columnNames)) {
    const missingColumns = TARGET_COLUMNS.filter((column) => !columnNames.includes(column));
    console.log("Status: skipped");
    console.log(`Reason: missing required columns: ${formatList(missingColumns)}`);
    return;
  }

  const indexRows = await fetchFulltextIndexes(pool);
  const existingFulltextNames = [...new Set(indexRows.map((row) => String(row.Key_name || "").trim()).filter(Boolean))];
  console.log(`Existing FULLTEXT indexes: ${formatList(existingFulltextNames)}`);

  if (hasTargetIndex(indexRows)) {
    console.log("Status: skipped");
    console.log(`Reason: FULLTEXT index \`${TARGET_INDEX}\` already exists`);
    return;
  }

  try {
    await pool.query(
      `
        ALTER TABLE ${TARGET_TABLE}
        ADD FULLTEXT ${TARGET_INDEX} (${TARGET_COLUMNS.join(", ")})
      `,
    );

    console.log("Status: success");
    console.log(
      `Created FULLTEXT index \`${TARGET_INDEX}\` on columns: ${TARGET_COLUMNS.join(", ")}`,
    );
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    const duplicateLike =
      error &&
      (error.code === "ER_DUP_KEYNAME" ||
        error.code === "ER_FT_MATCHING_KEY_NOT_FOUND" ||
        /Duplicate key name/i.test(message));

    if (duplicateLike) {
      console.log("Status: skipped");
      console.log(`Reason: FULLTEXT index \`${TARGET_INDEX}\` already exists or was created concurrently`);
      return;
    }

    console.error("Status: failed");
    console.error(`Reason: ${message}`);
    console.error(
      "Note: FULLTEXT support varies by MySQL/MariaDB version, storage engine, and column definition.",
    );
    process.exitCode = 1;
  }
}

addFulltextIndex()
  .catch((error) => {
    console.error("Status: failed");
    console.error(`Reason: ${error.message || error}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    const pool = getDbPool();
    if (pool && typeof pool.end === "function") {
      try {
        await pool.end();
      } catch (_error) {}
    }
  });
