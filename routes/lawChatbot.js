const express = require("express");

const controller = require("../controllers/lawChatbotController");
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
router.get("/upload", requireAdminAuth, controller.renderUpload);
router.post("/upload", requireAdminAuth, handleUploadMiddleware, controller.handleUpload);
router.get("/feedback", requireAdminAuth, controller.renderFeedback);
router.post("/feedback", requireAdminAuth, controller.submitFeedback);

module.exports = router;
