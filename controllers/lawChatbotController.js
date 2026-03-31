const lawChatbotService = require("../services/lawChatbotService");

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
  const result = await lawChatbotService.replyToChat(req.body, req.session);
  res.json(result);
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
};
