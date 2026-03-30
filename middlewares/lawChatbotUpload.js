const fs = require("fs");
const path = require("path");
const multer = require("multer");

const uploadDir = path.join(__dirname, "..", "uploads", "lawChatbot");

fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const safeName = `${Date.now()}-${file.originalname.replace(/\s+/g, "-")}`;
    cb(null, safeName);
  },
});

const fileFilter = (req, file, cb) => {
  if (file.mimetype !== "application/pdf") {
    return cb(new Error("Only PDF files are allowed."));
  }

  cb(null, true);
};

module.exports = multer({ storage, fileFilter });
