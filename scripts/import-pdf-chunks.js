#!/usr/bin/env node

require("dotenv").config();

const fs = require("node:fs/promises");
const path = require("node:path");
const { connectDb, getDbPool } = require("../config/db");
const LawChatbotPdfChunkModel = require("../models/lawChatbotPdfChunkModel");
const {
  generateKeywordFromChunk,
  isGarbageChunk,
  normalizeChunkText,
  splitIntoKnowledgeChunks,
} = require("../utils/chunkSplitter");
const { normalizeThai } = require("../utils/thaiNormalizer");

const DEFAULT_QUALITY_SCORE = 80;
const BATCH_INSERT_SIZE = 200;
const PREVIEW_LIMIT = 5;

function printDivider() {
  console.log("========================================");
}

function printUsage() {
  console.log("Usage:");
  console.log("  node scripts/import-pdf-chunks.js --file=./input.txt --document-id=12");
  console.log("  node scripts/import-pdf-chunks.js --file=./input.json --dry-run");
  console.log("");
  console.log("Options:");
  console.log("  --file=PATH         Path to .txt or .json input file");
  console.log("  --document-id=ID    Optional document_id to assign to imported rows");
  console.log("  --dry-run           Parse and validate only, do not insert");
}

function parseArgs(argv) {
  const args = {
    file: "",
    dryRun: false,
    documentId: null,
  };

  for (const arg of argv) {
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }

    if (arg.startsWith("--file=")) {
      args.file = arg.slice("--file=".length).trim();
      continue;
    }

    if (arg.startsWith("--document-id=")) {
      const value = Number(arg.slice("--document-id=".length));
      args.documentId = Number.isFinite(value) && value > 0 ? value : null;
    }
  }

  return args;
}

function truncate(text, maxLength = 160) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "(empty)";
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function buildDuplicateKey(documentId, chunkText) {
  return `${documentId === null ? "null" : String(documentId)}|${normalizeThai(normalizeChunkText(chunkText))}`;
}

function isValidQualityScore(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= 100;
}

function resolveQualityScore(value) {
  if (isValidQualityScore(value)) {
    return Number(value);
  }
  return DEFAULT_QUALITY_SCORE;
}

function deriveBaseKeywordFromText(text, filePath) {
  const normalizedText = normalizeChunkText(text);
  const firstLine = String(normalizedText.split("\n").find((line) => line.trim()) || "").trim();
  if (firstLine && firstLine.length <= 60 && !/[.!?。！？]$/.test(firstLine)) {
    return firstLine.slice(0, 255);
  }

  const fileStem = path.basename(filePath, path.extname(filePath)).replace(/[-_]+/g, " ").trim();
  return fileStem.slice(0, 255) || "";
}

async function readJsonFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON file: ${error.message}`);
  }
}

function toCandidateRow({
  keyword,
  chunkText,
  documentId,
  qualityScore,
  isActive = 1,
  sourceType = "",
  sourceIndex = 0,
}) {
  const normalizedChunkText = normalizeChunkText(chunkText);
  const normalizedKeyword = String(keyword || "").replace(/\s+/g, " ").trim().slice(0, 255);

  return {
    keyword: normalizedKeyword,
    chunkText: normalizedChunkText,
    cleanText: normalizeThai(normalizedChunkText),
    documentId: documentId === undefined ? null : documentId,
    isActive: Number(isActive) === 0 ? 0 : 1,
    qualityScore: resolveQualityScore(qualityScore),
    sourceType,
    sourceIndex,
  };
}

function parseTxtContent(text, filePath, documentId) {
  const baseKeyword = deriveBaseKeywordFromText(text, filePath);
  const chunks = splitIntoKnowledgeChunks(text, {
    baseKeyword,
    topic: baseKeyword,
    minLength: 80,
    maxLength: 350,
    targetLength: 220,
  });

  const rows = [];
  let invalidCount = 0;

  chunks.forEach((chunk, index) => {
    if (!chunk || !chunk.chunkText) {
      invalidCount += 1;
      return;
    }

    const keyword = chunk.keyword || generateKeywordFromChunk(chunk.chunkText, { baseKeyword, topic: baseKeyword });
    if (!keyword || !normalizeChunkText(chunk.chunkText)) {
      invalidCount += 1;
      return;
    }

    rows.push(
      toCandidateRow({
        keyword,
        chunkText: chunk.chunkText,
        documentId,
        qualityScore: DEFAULT_QUALITY_SCORE,
        isActive: 1,
        sourceType: "txt",
        sourceIndex: index,
      }),
    );
  });

  const filteredRows = rows.filter((row) => row.chunkText && !isGarbageChunk(row.chunkText));

  return {
    rows: filteredRows,
    invalidCount: invalidCount + (rows.length - filteredRows.length),
  };
}

function extractJsonItems(parsed) {
  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (!parsed || typeof parsed !== "object") {
    return [];
  }

  if (Array.isArray(parsed.chunks)) {
    return parsed.chunks;
  }

  if (Array.isArray(parsed.items)) {
    return parsed.items;
  }

  if (Array.isArray(parsed.rows)) {
    return parsed.rows;
  }

  return [parsed];
}

function parseJsonContent(parsed, filePath, documentId) {
  const items = extractJsonItems(parsed);
  const baseKeyword = deriveBaseKeywordFromText(JSON.stringify(parsed).slice(0, 2000), filePath);
  const rows = [];
  let invalidCount = 0;

  items.forEach((item, index) => {
    if (!item || typeof item !== "object") {
      invalidCount += 1;
      return;
    }

    const itemDocumentId =
      documentId !== null && documentId !== undefined
        ? documentId
        : Number.isFinite(Number(item.document_id))
          ? Number(item.document_id)
          : Number.isFinite(Number(item.documentId))
            ? Number(item.documentId)
            : null;

    const itemKeyword = String(item.keyword || item.baseKeyword || item.topic || baseKeyword || "").trim();
    const itemQualityScore = isValidQualityScore(item.quality_score)
      ? Number(item.quality_score)
      : isValidQualityScore(item.qualityScore)
        ? Number(item.qualityScore)
        : DEFAULT_QUALITY_SCORE;
    const itemIsActive = item.is_active === 0 || item.isActive === 0 ? 0 : 1;

    const explicitChunkText = String(item.chunk_text || item.chunkText || "").trim();
    const rawText = String(item.text || item.content || item.body || "").trim();

    if (explicitChunkText) {
      const normalizedExplicitChunkText = normalizeChunkText(explicitChunkText);
      if (!normalizedExplicitChunkText) {
        invalidCount += 1;
        return;
      }

      rows.push(
        toCandidateRow({
          keyword:
            itemKeyword ||
            generateKeywordFromChunk(explicitChunkText, { baseKeyword: itemKeyword || baseKeyword, topic: itemKeyword || baseKeyword }),
          chunkText: explicitChunkText,
          documentId: itemDocumentId,
          qualityScore: itemQualityScore,
          isActive: itemIsActive,
          sourceType: "json",
          sourceIndex: index,
        }),
      );
      return;
    }

    if (rawText) {
      const splitRows = splitIntoKnowledgeChunks(rawText, {
        baseKeyword: itemKeyword || baseKeyword,
        topic: itemKeyword || baseKeyword,
        minLength: 80,
        maxLength: 350,
        targetLength: 220,
      });

      splitRows.forEach((chunk, chunkIndex) => {
        if (!chunk || !chunk.chunkText) {
          invalidCount += 1;
          return;
        }

        rows.push(
          toCandidateRow({
            keyword: chunk.keyword || generateKeywordFromChunk(chunk.chunkText, { baseKeyword: itemKeyword || baseKeyword, topic: itemKeyword || baseKeyword }),
            chunkText: chunk.chunkText,
            documentId: itemDocumentId,
            qualityScore: itemQualityScore,
            isActive: itemIsActive,
            sourceType: "json",
            sourceIndex: `${index}:${chunkIndex}`,
          }),
        );
      });
    }
  });

  const filteredRows = rows.filter((row) => row.chunkText && !isGarbageChunk(row.chunkText));

  return {
    rows: filteredRows,
    invalidCount: invalidCount + (rows.length - filteredRows.length),
  };
}

async function loadExistingDuplicateSet(pool, documentId) {
  const query =
    documentId !== null && documentId !== undefined
      ? "SELECT document_id, chunk_text FROM pdf_chunks WHERE document_id = ?"
      : "SELECT document_id, chunk_text FROM pdf_chunks";
  const params = documentId !== null && documentId !== undefined ? [documentId] : [];
  const [rows] = await pool.query(query, params);

  const duplicateSet = new Set();
  rows.forEach((row) => {
    duplicateSet.add(buildDuplicateKey(row.document_id ?? null, row.chunk_text));
  });

  return duplicateSet;
}

function dedupeRows(rows, existingDuplicateSet, documentIdOverride = null) {
  const seen = new Set(existingDuplicateSet);
  const uniqueRows = [];
  let duplicateCount = 0;

  rows.forEach((row) => {
    const resolvedDocumentId =
      documentIdOverride !== null && documentIdOverride !== undefined ? documentIdOverride : row.documentId;
    const key = buildDuplicateKey(resolvedDocumentId, row.chunkText);
    if (seen.has(key)) {
      duplicateCount += 1;
      return;
    }

    seen.add(key);
    uniqueRows.push(row);
  });

  return { uniqueRows, duplicateCount };
}

async function insertRowsInBatches(rows, documentIdOverride) {
  let inserted = 0;

  for (let index = 0; index < rows.length; index += BATCH_INSERT_SIZE) {
    const batch = rows.slice(index, index + BATCH_INSERT_SIZE);
    const payload = batch.map((row) => ({
      keyword: row.keyword,
      chunkText: row.chunkText,
      cleanText: row.cleanText,
      documentId: documentIdOverride !== null && documentIdOverride !== undefined ? documentIdOverride : row.documentId,
      isActive: 1,
      qualityScore: row.qualityScore,
    }));

    inserted += await LawChatbotPdfChunkModel.insertChunks(payload, documentIdOverride);
  }

  return inserted;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.file) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const inputPath = path.resolve(args.file);
  const ext = path.extname(inputPath).toLowerCase();
  if (![".txt", ".json"].includes(ext)) {
    console.error("Only .txt or .json input files are supported.");
    process.exitCode = 1;
    return;
  }

  let inputContent;
  try {
    inputContent = ext === ".json" ? await fs.readFile(inputPath, "utf8") : await fs.readFile(inputPath);
  } catch (error) {
    console.error(`Failed to read input file: ${error.message || error}`);
    process.exitCode = 1;
    return;
  }

  let preparedRows = [];
  try {
    if (ext === ".txt") {
      const text = String(inputContent || "").trim();
      if (!text) {
        console.error("Input text file is empty.");
        process.exitCode = 1;
        return;
      }
      const parsed = parseTxtContent(text, inputPath, args.documentId);
      preparedRows = parsed.rows;
      args.invalidCount = parsed.invalidCount;
    } else {
      const parsed = await readJsonFile(inputPath);
      const result = parseJsonContent(parsed, inputPath, args.documentId);
      preparedRows = result.rows;
      args.invalidCount = result.invalidCount;
    }
  } catch (error) {
    console.error(`Failed to parse input file: ${error.message || error}`);
    process.exitCode = 1;
    return;
  }

  if (preparedRows.length === 0) {
    console.log("No valid chunks found in the input.");
    return;
  }

  await connectDb();
  const pool = getDbPool();

  if (!pool) {
    console.error("Database connection is unavailable. Check your environment variables and DB status.");
    process.exitCode = 1;
    return;
  }

  let existingDuplicateSet;
  try {
    existingDuplicateSet = await loadExistingDuplicateSet(pool, args.documentId);
  } catch (error) {
    console.error(`Failed to inspect existing pdf_chunks rows: ${error.message || error}`);
    process.exitCode = 1;
    return;
  }

  const { uniqueRows, duplicateCount: inputDuplicateCount } = dedupeRows(
    preparedRows,
    existingDuplicateSet,
    args.documentId,
  );
  const invalidCount = Number(args.invalidCount || 0);
  const skippedCount = inputDuplicateCount + invalidCount;

  printDivider();
  console.log("Import PDF Chunks");
  printDivider();
  console.log(`File: ${inputPath}`);
  console.log(`Type: ${ext.slice(1)}`);
  console.log(`Document ID: ${args.documentId === null ? "(none)" : args.documentId}`);
  console.log(`Mode: ${args.dryRun ? "dry-run" : "import"}`);
  console.log(`Parsed chunks: ${preparedRows.length}`);
  console.log(`Unique chunks after duplicate check: ${uniqueRows.length}`);
  console.log(`Skipped: ${skippedCount} (duplicates=${inputDuplicateCount}, invalid=${invalidCount})`);

  uniqueRows.slice(0, PREVIEW_LIMIT).forEach((row, index) => {
    console.log("");
    console.log(`#Preview ${index + 1}`);
    console.log(`keyword: ${row.keyword}`);
    console.log(`document_id: ${row.documentId === null ? "(none)" : row.documentId}`);
    console.log(`quality_score: ${row.qualityScore}`);
    console.log(`chunk_text: ${truncate(row.chunkText)}`);
  });

  if (args.dryRun) {
    console.log("");
    console.log("Dry run complete. No rows were inserted.");
    console.log(`Summary: inserted=0, skipped=${skippedCount}`);
    return;
  }

  let inserted = 0;
  try {
    inserted = await insertRowsInBatches(uniqueRows, args.documentId);
  } catch (error) {
    console.error(`Import failed: ${error.message || error}`);
    process.exitCode = 1;
    return;
  }

  console.log("");
  console.log("Import complete.");
  console.log(`Inserted: ${inserted}`);
  console.log(`Skipped: ${skippedCount}`);
}

main()
  .catch((error) => {
    console.error(`Unexpected import failure: ${error.message || error}`);
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
