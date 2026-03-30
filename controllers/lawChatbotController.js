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
      encodeURIComponent("อัปโหลดไฟล์สำเร็จและนำเข้าข้อมูลเรียบร้อยแล้ว")
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
  renderUpload,
  handleUpload,
  renderFeedback,
  submitFeedback,
};
