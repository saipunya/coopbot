const express = require("express");

const controller = require("../controllers/lawChatbotController");
const lawChatbotService = require("../services/lawChatbotService");
const {
  attachCurrentUser,
  requireAdminAuth,
} = require("../middlewares/authMiddleware");
const upload = require("../middlewares/lawChatbotUpload");

const router = express.Router();

function handleUploadMiddleware(req, res, next) {
  upload.single("lawPdf")(req, res, (error) => {
    if (!error) {
      return next();
    }

    if (error.code === "LIMIT_FILE_SIZE") {
      return res.redirect(
        "/law-chatbot/upload?error=" +
          encodeURIComponent("ไฟล์ใหญ่เกินกำหนด อัปโหลดได้ไม่เกิน 20 MB")
      );
    }

    return res.redirect(
      "/law-chatbot/upload?error=" +
        encodeURIComponent(error.message || "ไม่สามารถอัปโหลดไฟล์ได้")
    );
  });
}

router.get("/", attachCurrentUser, controller.renderIndex);
router.post("/chat", attachCurrentUser, controller.chat);
router.post("/chat-summary", attachCurrentUser, controller.chatSummary);
router.post("/chat-feedback", attachCurrentUser, controller.chatFeedback);
router.post("/admin-knowledge", requireAdminAuth, controller.saveKnowledgeFromChat);
router.post("/reset-context", attachCurrentUser, controller.resetContext);
router.get("/upload", requireAdminAuth, controller.renderUpload);
router.post("/upload", requireAdminAuth, handleUploadMiddleware, controller.handleUpload);
router.get("/feedback", requireAdminAuth, controller.renderFeedback);
router.post("/feedback", requireAdminAuth, controller.submitFeedback);

// Debug endpoint for detailed AI decision data
router.post('/debug-decision', async (req, res) => {
  try {
    const { message, target } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Invalid or missing message in request body' });
    }
    const session = req.session;
    const evidence = await lawChatbotService.collectAnswerSources(message, target || 'all', session);
    res.json({
      message,
      target: target || 'all',
      selectedSourceTier: evidence.selectedSourceTier || 'none',
      timing: evidence.timing || {},
      sources: (evidence.sources || []).map((item) => ({
        source: item.source || '',
        reference: item.reference || item.title || '',
        score: Number(item.score || 0),
        content: String(item.content || item.chunk_text || '').slice(0, 500),
        retrievalPriority: Number(item.retrievalPriority || 0)
      })),
      databaseSources: (evidence.databaseMatches || []).map((item) => ({
        source: item.source || '',
        reference: item.reference || item.title || '',
        score: Number(item.score || 0),
        content: String(item.content || item.chunk_text || '').slice(0, 500),
        retrievalPriority: Number(item.retrievalPriority || 0)
      })),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error in debug-decision endpoint:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

module.exports = router;
