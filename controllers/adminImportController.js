const fs = require("node:fs/promises");
const { importDocxToPdfChunks } = require("../services/wordImportService");
const { searchPdfChunks } = require("../services/hybridSearchService");

function resolveUploadedFile(req) {
  if (req.file) {
    return req.file;
  }

  if (Array.isArray(req.files)) {
    return req.files[0] || null;
  }

  if (req.files && typeof req.files === "object") {
    return (req.files.file && req.files.file[0]) || (req.files.docx && req.files.docx[0]) || null;
  }

  return null;
}

async function safeUnlink(filePath) {
  if (!filePath) {
    return;
  }

  try {
    await fs.unlink(filePath);
  } catch (_error) {}
}

async function importDocx(req, res) {
  const file = resolveUploadedFile(req);

  if (!file) {
    return res.status(400).json({
      ok: false,
      message: "DOCX file is required. Upload field name should be `file` or `docx`.",
    });
  }

  try {
    const result = await importDocxToPdfChunks(file);
    return res.status(201).json({
      ok: true,
      message: `Imported ${result.insertedRows} rows into pdf_chunks.`,
      data: result,
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      ok: false,
      message: error.message || "DOCX import failed.",
    });
  } finally {
    await safeUnlink(file.path);
  }
}

async function searchTest(req, res) {
  const query = String(req.query.q || req.query.query || "").trim();
  const limit = Number(req.query.limit || 10);

  if (!query) {
    return res.status(400).json({
      ok: false,
      message: "Query is required. Use ?q=...",
    });
  }

  try {
    const result = await searchPdfChunks(query, { limit });
    return res.json({
      ok: true,
      data: result,
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      ok: false,
      message: error.message || "Search test failed.",
    });
  }
}

module.exports = {
  importDocx,
  searchTest,
};
