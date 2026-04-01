const lawChatbotService = require("../services/lawChatbotService");
const runtimeFlags = require("../config/runtimeFlags");
const CHAT_REQUEST_TIMEOUT_MS = Number(process.env.CHAT_REQUEST_TIMEOUT_MS || 25000);

async function renderIndex(req, res) {
  const data = await lawChatbotService.getDashboardData();

  res.render("lawChatbot/index", {
    title: "แชตบอทกฎหมายสหกรณ์",
    themeColor: "#2f5f7a",
    manifestPath: "/manifest-law-chatbot.json",
    data,
  });
}

async function chat(req, res) {
  try {
    const result = await Promise.race([
      lawChatbotService.replyToChat(req.body, req.session),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`chat request timed out after ${CHAT_REQUEST_TIMEOUT_MS}ms`)), CHAT_REQUEST_TIMEOUT_MS),
      ),
    ]);
    res.json(result);
  } catch (error) {
    const errorMessage = String(error?.message || "").trim().toLowerCase();
    const answer = errorMessage.includes("timed out")
      ? "ระบบใช้เวลานานเกินไป กรุณาลองใหม่อีกครั้ง"
      : "ขออภัยครับ ระบบไม่สามารถประมวลผลคำถามได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง";

    res.json({
      hasContext: false,
      answer,
      highlightTerms: [],
      usedFollowUpContext: false,
      usedInternetFallback: false,
      fromCache: false,
    });
  }
}

async function chatSummary(req, res) {
  const result = await lawChatbotService.summarizeChat(req.body, req.session);
  res.json(result);
}

async function chatFeedback(req, res) {
  await lawChatbotService.saveChatFeedback(req.body);
  res.json({ success: true });
}

async function saveKnowledgeFromChat(req, res) {
  const title = String(req.body.title || req.body.question || "").trim();
  const content = String(req.body.content || "").trim();

  if (!title || !content) {
    return res.status(400).json({
      success: false,
      message: "กรุณาระบุหัวข้อและคำตอบที่ถูกต้องก่อนบันทึก",
    });
  }

  const entry = await lawChatbotService.saveKnowledgeEntry(req.body);
  return res.json({
    success: true,
    message: "บันทึกคำตอบที่ถูกต้องเรียบร้อยแล้ว",
    entry,
  });
}

async function submitKnowledgeSuggestion(req, res) {
  const title = String(req.body.title || req.body.question || "").trim();
  const content = String(req.body.content || "").trim();

  if (!title || !content) {
    return res.status(400).json({
      success: false,
      message: "กรุณาระบุคำถามและคำตอบที่ต้องการเสนอ",
    });
  }

  try {
    const entry = await lawChatbotService.submitKnowledgeSuggestion(req.body, {
      submittedBy: req.body.name || "",
      sessionId: req.sessionID || "",
      ip: req.ip || req.headers["x-forwarded-for"] || "",
    });

    return res.json({
      success: true,
      message: "ส่งข้อเสนอคำตอบเรียบร้อยแล้ว ระบบจะรอผู้ดูแลตรวจสอบก่อนนำเข้า",
      entry,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message || "ไม่สามารถส่งข้อเสนอคำตอบได้",
    });
  }
}

async function resetContext(req, res) {
  if (req.session) {
    req.session.lawChatbotContext = [];
  }

  res.json({ success: true });
}

async function renderUpload(req, res) {
  const data = await lawChatbotService.getUploadPageData();

  res.render("lawChatbot/upload", {
    title: "Upload Legal Documents",
    page: "upload",
    errorMessage: req.query.error || "",
    successMessage: req.query.success || "",
    data,
  });
}

async function handleUpload(req, res) {
  if (!req.file) {
    return res.redirect(
      "/law-chatbot/upload?error=" +
        encodeURIComponent("กรุณาเลือกไฟล์ PDF, DOC หรือ DOCX ขนาดไม่เกิน 20 MB")
    );
  }

  await lawChatbotService.recordUpload(req.file);
  return res.redirect(
    "/law-chatbot/upload?success=" +
      encodeURIComponent("อัปโหลดไฟล์สำเร็จ ระบบกำลังประมวลผลเอกสารในพื้นหลัง")
  );
}

async function renderFeedback(req, res) {
  const data = await lawChatbotService.getFeedbackPageData();

  res.render("lawChatbot/feedback", {
    title: "Feedback",
    page: "feedback",
    data,
  });
}

async function submitFeedback(req, res) {
  await lawChatbotService.saveFeedback(req.body);
  res.redirect("/law-chatbot/feedback");
}

async function renderPaymentRequest(req, res) {
  const data = await lawChatbotService.getPaymentRequestPageData(req.signedInUser);

  res.render("lawChatbot/paymentRequest", {
    title: "Payment Request",
    page: "payment-request",
    errorMessage: req.query.error || "",
    successMessage: req.query.success || "",
    data,
  });
}

async function submitPaymentRequest(req, res) {
  try {
    if (runtimeFlags.useMockPayment) {
      return res.json({
        success: true,
        message: "Mock payment submitted",
        paymentId: Math.floor(Math.random() * 100000),
      });
    }

    await lawChatbotService.submitPaymentRequest(req.body, req.file, req.signedInUser);
    return res.redirect(
      "/law-chatbot/payment-request?success=" +
        encodeURIComponent("ส่งคำขอชำระเงินเรียบร้อยแล้ว กรุณารอการตรวจสอบจากทีมงาน")
    );
  } catch (error) {
    return res.redirect(
      "/law-chatbot/payment-request?error=" +
        encodeURIComponent(error.message || "ไม่สามารถส่งคำขอชำระเงินได้")
    );
  }
}

module.exports = {
  renderIndex,
  chat,
  chatSummary,
  chatFeedback,
  saveKnowledgeFromChat,
  submitKnowledgeSuggestion,
  resetContext,
  renderUpload,
  handleUpload,
  renderFeedback,
  submitFeedback,
  renderPaymentRequest,
  submitPaymentRequest,
};
