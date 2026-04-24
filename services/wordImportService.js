const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const { randomUUID } = require("node:crypto");
const { getDbPool } = require("../config/db");
const { parseDocx } = require("../utils/wordParser");
const { analyzeExtractedText } = require("./documentTextExtractor");

const REQUIRED_COLUMNS = [
  "clean_text",
  "chunk_type",
  "title",
  "question",
  "answer",
  "note_value",
  "step_no",
  "detail",
  "reference_note",
  "source_file_name",
  "source_file_hash",
  "import_batch_id",
  "sort_order",
];

let cachedColumnSet = null;

function makeError(message, statusCode = 500) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function resolvePdfChunkColumns(pool) {
  if (cachedColumnSet) {
    return cachedColumnSet;
  }

  const [rows] = await pool.query("SHOW COLUMNS FROM pdf_chunks");
  cachedColumnSet = new Set(rows.map((row) => String(row.Field || "").trim().toLowerCase()));
  return cachedColumnSet;
}

async function ensureImportColumns(pool) {
  const columnSet = await resolvePdfChunkColumns(pool);
  const missingColumns = REQUIRED_COLUMNS.filter((columnName) => !columnSet.has(columnName));

  if (missingColumns.length > 0) {
    throw makeError(
      `Missing required pdf_chunks columns: ${missingColumns.join(", ")}. Run scripts/sql/20260417_add_pdf_chunks_word_import_columns.sql first.`,
      500,
    );
  }
}

async function createFileHash(filePath) {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function buildQualityMetadata(row = {}) {
  const analysis = analyzeExtractedText(row.cleanText || row.chunkText || "");
  const qualityScore = Number(analysis.qualityScore || 0);
  const lowQualityThreshold = Number(process.env.WORD_IMPORT_LOW_QUALITY_SCORE || 45);

  return {
    qualityScore,
    isActive: qualityScore >= lowQualityThreshold ? 1 : 0,
    notes: Array.isArray(analysis.notes) ? analysis.notes : [],
  };
}

function buildInsertColumns(columnSet) {
  const columns = [
    "keyword",
    "chunk_text",
    "clean_text",
    "document_id",
    "chunk_type",
    "title",
    "question",
    "answer",
    "note_value",
    "step_no",
    "detail",
    "reference_note",
    "source_file_name",
    "source_file_hash",
    "import_batch_id",
    "sort_order",
  ];

  if (columnSet.has("original_text")) {
    columns.push("original_text");
  }
  if (columnSet.has("quality_score")) {
    columns.push("quality_score");
  }
  if (columnSet.has("is_active")) {
    columns.push("is_active");
  }

  return columns;
}

function buildInsertValues(rows, context, columnSet) {
  return rows.map((row) => {
    const quality = buildQualityMetadata(row);
    const values = [
      row.keyword,
      row.chunkText,
      row.cleanText,
      null,
      row.chunkType,
      row.title || null,
      row.question || null,
      row.answer || null,
      row.noteValue || null,
      row.stepNo,
      row.detail || null,
      row.referenceNote || null,
      context.sourceFileName,
      context.sourceFileHash,
      context.importBatchId,
      row.sortOrder,
    ];

    if (columnSet.has("original_text")) {
      values.push(row.originalText || row.chunkText);
    }
    if (columnSet.has("quality_score")) {
      values.push(quality.qualityScore);
    }
    if (columnSet.has("is_active")) {
      values.push(quality.isActive);
    }

    return values;
  });
}

async function importDocxToPdfChunks(file) {
  if (!file || !file.path) {
    throw makeError("DOCX file is required.", 400);
  }

  const pool = getDbPool();
  if (!pool) {
    throw makeError("Database connection is unavailable.", 500);
  }

  await ensureImportColumns(pool);

  const parsed = await parseDocx(file.path);
  if (!parsed.rows.length) {
    throw makeError("No importable content was parsed from the DOCX file.", 400);
  }

  const sourceFileName = String(file.originalname || file.filename || "document.docx").trim();
  const sourceFileHash = await createFileHash(file.path);
  const importBatchId = randomUUID();
  const columnSet = await resolvePdfChunkColumns(pool);
  const columns = buildInsertColumns(columnSet);
  const qualityRows = parsed.rows.map((row) => ({
    ...row,
    quality: buildQualityMetadata(row),
  }));
  const values = buildInsertValues(qualityRows, {
    sourceFileName,
    sourceFileHash,
    importBatchId,
  }, columnSet);

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    await connection.query(
      `INSERT INTO pdf_chunks (${columns.join(", ")}) VALUES ?`,
      [values],
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  return {
    importBatchId,
    sourceFileName,
    sourceFileHash,
    insertedRows: values.length,
    stats: parsed.stats,
    warnings: parsed.messages,
    quality: {
      lowQualityRows: qualityRows.filter((row) => row.quality.isActive === 0).length,
      inactiveFlagApplied: columnSet.has("is_active"),
      qualityScoreApplied: columnSet.has("quality_score"),
    },
    preview: parsed.rows.slice(0, 10).map((row) => ({
      chunkType: row.chunkType,
      title: row.title,
      question: row.question,
      stepNo: row.stepNo,
      sortOrder: row.sortOrder,
      chunkTextPreview: String(row.chunkText || "").slice(0, 240),
    })),
  };
}

module.exports = {
  importDocxToPdfChunks,
};
