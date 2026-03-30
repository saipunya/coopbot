const express = require("express");

const controller = require("../controllers/lawChatbotController");
const authMiddleware = require("../middlewares/authMiddleware");
const upload = require("../middlewares/lawChatbotUpload");

const router = express.Router();

router.get("/", authMiddleware, controller.renderIndex);
router.post("/chat", authMiddleware, controller.chat);
router.post("/chat-summary", authMiddleware, controller.chatSummary);
router.post("/chat-feedback", authMiddleware, controller.chatFeedback);
router.get("/upload", authMiddleware, controller.renderUpload);
router.post("/upload", authMiddleware, upload.single("lawPdf"), controller.handleUpload);
router.get("/feedback", authMiddleware, controller.renderFeedback);
router.post("/feedback", authMiddleware, controller.submitFeedback);

module.exports = router;
