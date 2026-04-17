const fs = require("node:fs");
const path = require("node:path");
const multer = require("multer");

const uploadDir = path.join(__dirname, "..", "uploads", "adminDocxImports");
const allowedMimeTypes = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/octet-stream",
  "application/zip",
]);

fs.mkdirSync(uploadDir, { recursive: true });

function decodeFileName(name) {
  const raw = String(name || "").trim();
  if (!raw) {
    return "document.docx";
  }

  try {
    const decoded = Buffer.from(raw, "latin1").toString("utf8").trim();
    return decoded || raw;
  } catch (_error) {
    return raw;
  }
}

function sanitizeStoredFileName(name) {
  return String(name || "document.docx")
    .replace(/[\/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const decodedName = decodeFileName(file.originalname);
    const extension = path.extname(decodedName).toLowerCase() || ".docx";
    const baseName = path.basename(decodedName, extension);
    const safeFileName = sanitizeStoredFileName(baseName || "document");

    file.originalname = decodedName;
    cb(null, `${Date.now()}-${safeFileName}${extension}`);
  },
});

function fileFilter(_req, file, cb) {
  const decodedName = decodeFileName(file.originalname);
  const extension = path.extname(decodedName).toLowerCase();
  const mimeType = String(file.mimetype || "").toLowerCase();
  const isDocx = extension === ".docx";
  const isAllowedMime = !mimeType || allowedMimeTypes.has(mimeType);

  file.originalname = decodedName;

  if (!isDocx || !isAllowedMime) {
    return cb(new Error("Only .docx files are allowed."));
  }

  return cb(null, true);
}

module.exports = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: Number(process.env.MAX_DOCX_UPLOAD_BYTES || 10 * 1024 * 1024),
    files: 1,
  },
});
