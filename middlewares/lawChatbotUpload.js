const fs = require("fs");
const path = require("path");
const multer = require("multer");

const uploadDir = path.join(__dirname, "..", "uploads", "lawChatbot");
const allowedMimeTypes = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const allowedExtensions = new Set([".pdf", ".doc", ".docx"]);

fs.mkdirSync(uploadDir, { recursive: true });

function decodeFileName(name) {
  const raw = String(name || "").trim();
  if (!raw) {
    return "document";
  }

  try {
    const decoded = Buffer.from(raw, "latin1").toString("utf8").trim();
    if (decoded && /[ก-๙]|[^\u0000-\u007f]/.test(decoded)) {
      return decoded;
    }
  } catch (_) {}

  return raw;
}

function sanitizeStoredFileName(name) {
  return String(name || "document")
    .replace(/[\/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const decodedName = decodeFileName(file.originalname);
    file.originalname = decodedName;
    const safeName = `${Date.now()}-${sanitizeStoredFileName(decodedName)}`;
    cb(null, safeName);
  },
});

const fileFilter = (req, file, cb) => {
  file.originalname = decodeFileName(file.originalname);
  const extension = path.extname(file.originalname || "").toLowerCase();
  const isAllowed =
    allowedMimeTypes.has(file.mimetype) || allowedExtensions.has(extension);

  if (!isAllowed) {
    return cb(new Error("Only PDF, DOC, and DOCX files are allowed."));
  }

  cb(null, true);
};

module.exports = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: Number(process.env.MAX_UPLOAD_BYTES || 20 * 1024 * 1024),
  },
});
