const lawChatbotService = require("../services/lawChatbotService");
const runtimeFlags = require("../config/runtimeFlags");
const UserModel = require("../models/userModel");
const {
  hasAcceptedLawChatbotNotice,
  markLawChatbotNoticeAccepted,
  LAW_CHATBOT_NOTICE_VERSION,
} = require("../middlewares/authMiddleware");
const CHAT_REQUEST_TIMEOUT_MS = Number(process.env.CHAT_REQUEST_TIMEOUT_MS || 25000);

function sanitizeLawChatbotReturnPath(value, fallbackPath, expectedPrefix) {
  const path = String(value || "").trim();
  if (!path || !path.startsWith("/") || path.startsWith("//")) {
    return fallbackPath;
  }

  if (!path.startsWith(expectedPrefix)) {
    return fallbackPath;
  }

  return path;
}

function sanitizeLawChatbotUserReturnPath(value, fallbackPath = "/law-chatbot") {
  const path = String(value || "").trim();
  if (!path || !path.startsWith("/") || path.startsWith("//")) {
    return fallbackPath;
  }

  if (!/^(?:\/law-chatbot(?:[/?#].*)?|\/user(?:[/?#].*)?)$/.test(path)) {
    return fallbackPath;
  }

  return path;
}

async function renderIndex(req, res) {
  const returnTo = sanitizeLawChatbotUserReturnPath(req.query.returnTo, "/law-chatbot");
  if (!req.signedInUser) {
    return res.redirect(`/auth/google?returnTo=${encodeURIComponent(returnTo)}`);
  }

  if (!hasAcceptedLawChatbotNotice(req)) {
    return res.render("lawChatbot/accessNotice", {
      title: "คำประกาศชี้แจงก่อนใช้งาน",
      themeColor: "#2f5f7a",
      manifestPath: "/manifest-law-chatbot.json",
      errorMessage: req.query.error || "",
      returnTo,
      requiresGoogleLogin: false,
    });
  }

  const data = await lawChatbotService.getDashboardData(req.signedInUser);

  res.render("lawChatbot/index", {
    title: "แชตบอทกฎหมายสหกรณ์",
    themeColor: "#2f5f7a",
    manifestPath: "/manifest-law-chatbot.json",
    data,
  });
}

async function acceptAccessNotice(req, res) {
  const returnTo = sanitizeLawChatbotUserReturnPath(req.body.returnTo, "/law-chatbot");
  if (String(req.body.acceptNotice || "") !== "1") {
    return res.redirect(
      `/law-chatbot?returnTo=${encodeURIComponent(returnTo)}&error=` +
        encodeURIComponent("กรุณาอ่านคำประกาศชี้แจงและกดยอมรับก่อนดำเนินการต่อ")
    );
  }

  const signedInUser = req.signedInUser || req.session?.user || null;
  const userId = Number(signedInUser?.userId || signedInUser?.id || 0);

  if (!userId) {
    return res.redirect(`/auth/google?returnTo=${encodeURIComponent(returnTo)}`);
  }

  await UserModel.markLawChatbotNoticeAccepted(userId, LAW_CHATBOT_NOTICE_VERSION);
  markLawChatbotNoticeAccepted(req);
  if (req.session?.user) {
    req.session.user.lawChatbotNoticeAcceptedVersion = LAW_CHATBOT_NOTICE_VERSION;
    req.session.user.lawChatbotNoticeAcceptedAt = new Date().toISOString();
  }
  return req.session.save((error) => {
    if (error) {
      return res.redirect(
        `/law-chatbot?returnTo=${encodeURIComponent(returnTo)}&error=` +
          encodeURIComponent("ไม่สามารถบันทึกการยอมรับคำประกาศได้ กรุณาลองใหม่อีกครั้ง")
      );
    }

    return res.redirect(returnTo);
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
  const signedInUser = req.signedInUser || req.session?.user || null;
  const submittedByUserId = Number(signedInUser?.userId || signedInUser?.id || 0);
  const submittedByName = String(signedInUser?.name || "").trim();
  const submittedByEmail = String(signedInUser?.email || signedInUser?.username || "").trim();
  const submittedBy = submittedByName && submittedByEmail && submittedByName !== submittedByEmail
    ? `${submittedByName} (${submittedByEmail})`
    : submittedByName || submittedByEmail || String(req.body.name || "").trim();

  if (!title || !content) {
    return res.status(400).json({
      success: false,
      message: "กรุณาระบุคำถามและคำตอบที่ต้องการเสนอ",
    });
  }

  try {
    const entry = await lawChatbotService.submitKnowledgeSuggestion(req.body, {
      submittedBy,
      submittedByUserId,
      sessionId: req.sessionID || "",
      ip: req.ip || req.headers["x-forwarded-for"] || "",
    });

    return res.json({
      success: true,
      message: "ส่งข้อเสนอคำตอบเรียบร้อยแล้ว หากผู้ดูแลอนุมัติ คุณจะได้รับสิทธิ์ถามเพิ่ม 1 ครั้งต่อเดือน",
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
  const data = await lawChatbotService.getUploadPageData({
    page: req.query.page || 1,
    pageSize: req.query.perPage || 10,
  });

  res.render("lawChatbot/upload", {
    title: "Upload Legal Documents",
    page: "upload",
    errorMessage: req.query.error || "",
    successMessage: req.query.success || "",
    data,
    returnPath: req.originalUrl || "/law-chatbot/upload",
  });
}

async function handleUpload(req, res) {
  const returnTo = sanitizeLawChatbotReturnPath(req.body.returnTo, "/law-chatbot/upload", "/law-chatbot/upload");
  if (!req.file) {
    return res.redirect(
      `${returnTo}${returnTo.includes("?") ? "&" : "?"}error=` +
        encodeURIComponent("กรุณาเลือกไฟล์ PDF, DOC หรือ DOCX ขนาดไม่เกิน 20 MB")
    );
  }

  await lawChatbotService.recordUpload(req.file);
  return res.redirect(
    `${returnTo}${returnTo.includes("?") ? "&" : "?"}success=` +
      encodeURIComponent("อัปโหลดไฟล์สำเร็จ ระบบกำลังประมวลผลเอกสารในพื้นหลัง")
  );
}

async function renderFeedback(req, res) {
  const data = await lawChatbotService.getFeedbackPageData({
    page: req.query.page || 1,
    pageSize: req.query.perPage || 10,
  });

  res.render("lawChatbot/feedback", {
    title: "Feedback",
    page: "feedback",
    data,
    returnPath: req.originalUrl || "/law-chatbot/feedback",
  });
}

async function submitFeedback(req, res) {
  const returnTo = sanitizeLawChatbotReturnPath(req.body.returnTo, "/law-chatbot/feedback", "/law-chatbot/feedback");
  await lawChatbotService.saveFeedback(req.body);
  res.redirect(returnTo);
}

async function renderPaymentRequest(req, res) {
  const data = await lawChatbotService.getPaymentRequestPageData(req.signedInUser, {
    source: req.query.source || "payment-request-direct",
  });

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
  acceptAccessNotice,
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
