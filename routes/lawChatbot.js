const express = require("express");

const controller = require("../controllers/lawChatbotController");
const lawChatbotService = require("../services/lawChatbotService");
const {
  attachCurrentUser,
  enforceLawChatbotMonthlyUsageLimit,
  requireAdminAuth,
  requireLawChatbotNoticeAccepted,
  requireSignedInUser,
} = require("../middlewares/authMiddleware");
const upload = require("../middlewares/lawChatbotUpload");
const paymentRequestUpload = require("../middlewares/paymentRequestUpload");

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

function handlePaymentRequestUpload(req, res, next) {
  paymentRequestUpload.single("slipImage")(req, res, (error) => {
    if (!error) {
      return next();
    }

    if (error.code === "LIMIT_FILE_SIZE") {
      return res.redirect(
        "/law-chatbot/payment-request?error=" +
          encodeURIComponent("ไฟล์สลิปมีขนาดใหญ่เกินกำหนด อัปโหลดได้ไม่เกิน 10 MB")
      );
    }

    return res.redirect(
      "/law-chatbot/payment-request?error=" +
        encodeURIComponent(error.message || "ไม่สามารถอัปโหลดสลิปได้")
    );
  });
}

router.get("/", attachCurrentUser, controller.renderIndex);
router.post("/accept-notice", attachCurrentUser, controller.acceptAccessNotice);
router.post("/chat", attachCurrentUser, requireLawChatbotNoticeAccepted, requireSignedInUser, enforceLawChatbotMonthlyUsageLimit, controller.chat);
router.post("/chat-summary", attachCurrentUser, requireLawChatbotNoticeAccepted, requireSignedInUser, controller.chatSummary);
router.post("/chat-feedback", attachCurrentUser, requireLawChatbotNoticeAccepted, requireSignedInUser, controller.chatFeedback);
router.post("/admin-knowledge", requireAdminAuth, controller.saveKnowledgeFromChat);
router.post("/knowledge-suggestion", attachCurrentUser, requireLawChatbotNoticeAccepted, requireSignedInUser, controller.submitKnowledgeSuggestion);
router.post("/reset-context", attachCurrentUser, requireLawChatbotNoticeAccepted, requireSignedInUser, controller.resetContext);
router.get("/upload", requireAdminAuth, controller.renderUpload);
router.get("/upload/search-test", requireAdminAuth, controller.searchUploadTest);
router.post("/upload", requireAdminAuth, handleUploadMiddleware, controller.handleUpload);
router.get("/feedback", requireAdminAuth, controller.renderFeedback);
router.post("/feedback", requireAdminAuth, controller.submitFeedback);
router.get("/payment-request", attachCurrentUser, requireSignedInUser, controller.renderPaymentRequest);
router.post("/payment-request", attachCurrentUser, requireSignedInUser, handlePaymentRequestUpload, controller.submitPaymentRequest);

// Debug endpoint for detailed AI decision data
router.post('/debug-decision', requireAdminAuth, async (req, res) => {
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
