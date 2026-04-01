const fs = require("fs");
const path = require("path");
const multer = require("multer");

const uploadDir = path.join(__dirname, "..", "uploads", "paymentRequests");
const allowedMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const allowedExtensions = new Set([".jpg", ".jpeg", ".png", ".webp"]);

fs.mkdirSync(uploadDir, { recursive: true });

function sanitizeStoredFileName(name) {
  return String(name || "slip")
    .replace(/[\/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const extension = path.extname(String(file.originalname || "")).toLowerCase() || ".jpg";
    const basename = path.basename(String(file.originalname || "slip"), extension);
    cb(null, `${Date.now()}-${sanitizeStoredFileName(basename)}${extension}`);
  },
});

const fileFilter = (req, file, cb) => {
  const extension = path.extname(String(file.originalname || "")).toLowerCase();
  const isAllowed = allowedMimeTypes.has(file.mimetype) || allowedExtensions.has(extension);

  if (!isAllowed) {
    return cb(new Error("Only JPG, PNG, and WEBP slip images are allowed."));
  }

  cb(null, true);
};

module.exports = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: Number(process.env.MAX_PAYMENT_SLIP_UPLOAD_BYTES || 10 * 1024 * 1024),
  },
});
