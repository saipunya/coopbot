const LawChatbotModel = require("../models/lawChatbotModel");
const LawChatbotFeedbackModel = require("../models/lawChatbotFeedbackModel");
const LawChatbotPdfChunkModel = require("../models/lawChatbotPdfChunkModel");
const { chunkText, extractTextFromFile } = require("./documentTextExtractor");
const { extractKeywords } = require("./keywordExtractionService");
const { uniqueTokens } = require("./thaiTextUtils");

async function getDashboardData() {
  const uploadedChunkCount = await LawChatbotPdfChunkModel.countChunks();

  return {
    appName: "Coopbot Law Chatbot",
    description: "ระบบต้นแบบสำหรับค้นหากฎหมายสหกรณ์และกลุ่มเกษตรกร พร้อมเก็บคำถามและข้อเสนอแนะ",
    status: "Knowledge base ready",
    conversationCount: LawChatbotModel.count(),
    uploadedPdfCount: LawChatbotPdfChunkModel.countDocuments(),
    uploadedChunkCount,
    recentConversations: LawChatbotModel.listRecent(6),
  };
}

async function replyToChat(payload) {
  const message = String(payload.message || "").trim();
  const target = payload.target === "group" ? "group" : "coop";

  if (!message) {
    return {
      hasContext: false,
      answer: "กรุณาระบุคำถามก่อนส่งข้อความ",
      highlightTerms: [],
    };
  }

  const dbMatches = await LawChatbotPdfChunkModel.searchChunks(message, 3);
  const matches =
    dbMatches.length > 0 ? dbMatches : LawChatbotModel.searchKnowledge(message, target);
  const highlightTerms = message.split(/\s+/).filter(Boolean).slice(0, 8);

  let answer = "";

  if (matches.length === 0) {
    answer =
      "ไม่พบข้อมูลที่ตรงชัดเจนในคลังตัวอย่างของระบบ\n\nลองระบุคำสำคัญเพิ่ม เช่น การประชุมใหญ่ สมาชิก คณะกรรมการ หรือการจัดตั้งกลุ่มเกษตรกร";
  } else {
    answer = matches
      .map((item, index) => {
        return [
          `${index + 1}. ${item.title || item.keyword || "ข้อความที่เกี่ยวข้อง"}`,
          `อ้างอิง: ${item.lawNumber || item.keyword || "pdf_chunks"}`,
          item.content || item.chunk_text,
        ].join("\n");
      })
      .join("\n\n");
  }

  LawChatbotModel.create({
    message,
    target,
    answer,
    matchedSources: matches.map((item) => ({
      id: item.id,
      title: item.title || item.keyword,
      lawNumber: item.lawNumber || item.keyword,
    })),
  });

  return {
    hasContext: matches.length > 0,
    answer,
    highlightTerms,
  };
}

async function summarizeChat(payload) {
  const message = String(payload.message || "").trim();
  const target = payload.target === "group" ? "กฎหมายกลุ่มเกษตรกร" : "กฎหมายสหกรณ์";

  if (!message) {
    return { summary: "" };
  }

  const dbMatches = await LawChatbotPdfChunkModel.searchChunks(message, 3);
  const matches =
    dbMatches.length > 0
      ? dbMatches
      : LawChatbotModel.searchKnowledge(message, payload.target === "group" ? "group" : "coop");

  const sourcesText =
    matches.length === 0
      ? "ยังไม่พบมาตราหรือหัวข้อที่ตรงชัดเจนในฐานข้อมูลตัวอย่าง"
      : matches
          .map((item) => `- ${item.title || item.keyword} (${item.lawNumber || item.keyword})`)
          .join("\n");

  return {
    summary: `หัวข้อที่ค้นหา: ${message}\nฐานข้อมูลที่เลือก: ${target}\nแหล่งข้อมูลที่เกี่ยวข้อง:\n${sourcesText}`,
  };
}

async function saveChatFeedback(payload) {
  return LawChatbotFeedbackModel.create({
    name: "Chat Feedback",
    email: "",
    message: payload.message || "",
    answerShown: payload.answerShown || "",
    isHelpful: Boolean(payload.isHelpful),
    target: payload.target || "coop",
    expectedAnswer: payload.expectedAnswer || "",
    suggestedLawNumber: payload.suggestedLawNumber || "",
  });
}

async function getUploadPageData() {
  const uploadedChunkCount = await LawChatbotPdfChunkModel.countChunks();
  const maxUploadBytes = Number(process.env.MAX_UPLOAD_BYTES || 20 * 1024 * 1024);

  return {
    appName: "Coopbot Law Chatbot",
    uploadPath: "/law-chatbot/upload",
    acceptedTypes: [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    maxUploadBytes,
    maxUploadMb: Math.floor(maxUploadBytes / (1024 * 1024)),
    uploadedPdfCount: LawChatbotPdfChunkModel.countDocuments(),
    uploadedChunkCount,
    uploadedFiles: LawChatbotPdfChunkModel.list(10),
  };
}

async function recordUpload(file) {
  if (!file) {
    return null;
  }

  const extractedText = await extractTextFromFile(file);
  const chunks = chunkText(extractedText, Number(process.env.CHUNK_SIZE || 1400));
  const chunkRecords = [];

  for (const chunk of chunks) {
    const keywords = await extractKeywords(chunk);
    chunkRecords.push({
      keyword: uniqueTokens(keywords).join(", ").slice(0, 255) || "document",
      chunkText: chunk,
    });
  }

  const insertedChunkCount = await LawChatbotPdfChunkModel.insertChunks(chunkRecords);

  LawChatbotPdfChunkModel.createUpload({
    filename: file.filename,
    originalname: file.originalname,
    mimetype: file.mimetype,
    size: file.size,
    insertedChunkCount,
  });

  return {
    filename: file.filename,
    originalname: file.originalname,
    insertedChunkCount,
  };
}

async function getFeedbackPageData() {
  const stats = LawChatbotFeedbackModel.stats();

  return {
    appName: "Coopbot Law Chatbot",
    feedbackCount: LawChatbotFeedbackModel.count(),
    helpfulCount: stats.helpful,
    needsImprovementCount: stats.needsImprovement,
    recentFeedback: LawChatbotFeedbackModel.list(),
  };
}

async function saveFeedback(payload) {
  return LawChatbotFeedbackModel.create({
    name: payload.name || "Anonymous",
    email: payload.email || "",
    message: payload.message || "",
  });
}

module.exports = {
  getDashboardData,
  replyToChat,
  summarizeChat,
  saveChatFeedback,
  getUploadPageData,
  recordUpload,
  getFeedbackPageData,
  saveFeedback,
};
