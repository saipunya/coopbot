const LawChatbotModel = require("../models/lawChatbotModel");
const LawSearchModel = require("../models/lawSearchModel");
const LawChatbotFeedbackModel = require("../models/lawChatbotFeedbackModel");
const LawChatbotPdfChunkModel = require("../models/lawChatbotPdfChunkModel");
const { generateChatSummary, wantsExplanation } = require("./chatAnswerService");
const { chunkText, extractTextFromFile } = require("./documentTextExtractor");
const {
  extractKeywords,
  extractDocumentKeywords,
} = require("./keywordExtractionService");
const { extractDocumentMetadata } = require("./documentMetadataService");
const { uniqueTokens } = require("./thaiTextUtils");

const CHAT_CONTEXT_KEY = "lawChatbotContext";
const CONTEXT_HISTORY_LIMIT = 8;
const KEYWORD_CONCURRENCY = Number(process.env.KEYWORD_CONCURRENCY || 4);

function getSessionContext(session) {
  if (!session) {
    return [];
  }

  if (!Array.isArray(session[CHAT_CONTEXT_KEY])) {
    session[CHAT_CONTEXT_KEY] = [];
  }

  return session[CHAT_CONTEXT_KEY];
}

function stripQuestionTail(message) {
  return String(message || "")
    .replace(/^(อธิบาย|รายละเอียด|ขยายความ|ยกตัวอย่าง)\s*/i, "")
    .replace(/(คืออะไร|คืออะไรครับ|คืออะไรคะ|คืออะไร\?|คือ|หมายถึงอะไร|หมายถึง|จะจัดขึ้นเมื่อไร|จะจัดขึ้นเมื่อไหร่|จัดขึ้นเมื่อไร|จัดขึ้นเมื่อไหร่|เมื่อไร|เมื่อไหร่|ทำอย่างไร|อย่างไร|ยังไง|ได้หรือไม่|ได้ไหม|ได้หรือเปล่า|หรือไม่|หรือเปล่า|กี่วัน|กี่ครั้ง|เท่าไร|ไหม|มั้ย)\s*[\?？]*$/i, "")
    .trim();
}

function looksLikeFollowUpQuestion(message) {
  const text = String(message || "").trim();
  if (!text) {
    return false;
  }

  if (text.length <= 18) {
    return true;
  }

  return /^(คืออะไร|คือ|เมื่อไร|เมื่อไหร่|อย่างไร|ยังไง|ได้หรือไม่|ได้ไหม|ได้หรือเปล่า|หรือไม่|สมาชิก|คณะกรรมการ|จะ|ต้อง|ควร|หาก)/.test(
    text,
  );
}

function extractTopicHints(message, matches) {
  const hints = [];
  const strippedMessage = stripQuestionTail(message);

  if (strippedMessage && strippedMessage.length >= 6) {
    hints.push(strippedMessage);
  }

  matches.slice(0, 3).forEach((item) => {
    if (item.reference) {
      hints.push(String(item.reference).trim());
    }
    if (item.title) {
      hints.push(String(item.title).trim());
    }
  });

  return uniqueTokens(
    hints
      .map((hint) => hint.replace(/\s+/g, " ").trim())
      .filter((hint) => hint && hint.length >= 4),
  );
}

function resolveMessageWithContext(message, target, session) {
  const text = String(message || "").trim();
  if (!text) {
    return { effectiveMessage: "", usedContext: false, topicHints: [] };
  }

  const baseTopic = stripQuestionTail(text);
  const history = getSessionContext(session)
    .filter((item) => item && item.target === target)
    .slice(0, CONTEXT_HISTORY_LIMIT);

  if (!looksLikeFollowUpQuestion(text) || history.length === 0) {
    return {
      effectiveMessage: text,
      usedContext: false,
      topicHints: baseTopic ? [baseTopic] : [],
    };
  }

  const recent = history[0];
  const recentTopic = Array.isArray(recent.topicHints) ? recent.topicHints[0] : "";

  if (!recentTopic) {
    return {
      effectiveMessage: text,
      usedContext: false,
      topicHints: baseTopic ? [baseTopic] : [],
    };
  }

  const alreadyContainsTopic = baseTopic && recentTopic.includes(baseTopic);
  const effectiveMessage = alreadyContainsTopic ? text : `${recentTopic} ${text}`.trim();

  return {
    effectiveMessage,
    usedContext: effectiveMessage !== text,
    topicHints: [recentTopic, ...(baseTopic ? [baseTopic] : [])].filter(Boolean),
  };
}

function mergeTopicHints(...hintGroups) {
  const seen = new Set();
  const results = [];

  hintGroups.flat().forEach((hint) => {
    const normalized = String(hint || "").replace(/\s+/g, " ").trim();
    if (!normalized) {
      return;
    }

    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    results.push(normalized);
  });

  return results.slice(0, 6);
}

function storeConversationContext(session, target, originalMessage, effectiveMessage, matches, resolvedContext) {
  if (!session) {
    return;
  }

  const history = getSessionContext(session);
  const topicHints = mergeTopicHints(
    resolvedContext && Array.isArray(resolvedContext.topicHints) ? resolvedContext.topicHints : [],
    extractTopicHints(originalMessage, matches),
    history[0] && Array.isArray(history[0].topicHints) ? history[0].topicHints : [],
  );

  history.unshift({
    target,
    originalMessage,
    effectiveMessage,
    topicHints,
    createdAt: new Date().toISOString(),
  });

  session[CHAT_CONTEXT_KEY] = history.slice(0, CONTEXT_HISTORY_LIMIT);
}

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

async function replyToChat(payload, session) {
  const message = String(payload.message || "").trim();
  const target = payload.target === "group" ? "group" : "coop";

  if (!message) {
    return {
      hasContext: false,
      answer: "กรุณาระบุคำถามหรือประเด็นที่ต้องการสอบถามก่อนส่งข้อความ",
      highlightTerms: [],
    };
  }

  const resolvedContext = resolveMessageWithContext(message, target, session);
  const effectiveMessage = resolvedContext.effectiveMessage || message;

  const structuredMatches = await LawSearchModel.searchStructuredLaws(effectiveMessage, target, 4);
  const pdfMatches = await LawChatbotPdfChunkModel.searchChunks(effectiveMessage, 4);
  const fallbackMatches = LawChatbotModel.searchKnowledge(effectiveMessage, target);
  const matches = [...structuredMatches, ...pdfMatches, ...fallbackMatches]
    .filter(Boolean)
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 5);
  const highlightTerms = effectiveMessage.split(/\s+/).filter(Boolean).slice(0, 8);

  let answer = "";

  if (matches.length === 0) {
    answer =
      "ไม่ปรากฏข้อมูลที่ตรงกับประเด็นคำถามอย่างชัดเจนในระบบ\n\nกรุณาระบุคำสำคัญเพิ่มเติม เช่น การประชุมใหญ่ สมาชิก คณะกรรมการ หรือการจัดตั้งกลุ่มเกษตรกร";
  } else {
    const topSources = matches.slice(0, wantsExplanation(message) ? 3 : 2);
    answer = await generateChatSummary(message, topSources, {
      conversationalFollowUp: resolvedContext.usedContext,
      topicLabel: resolvedContext.topicHints && resolvedContext.topicHints[0] ? resolvedContext.topicHints[0] : "",
    });
  }

  storeConversationContext(session, target, message, effectiveMessage, matches, resolvedContext);

  LawChatbotModel.create({
    message,
    effectiveMessage,
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
    usedFollowUpContext: resolvedContext.usedContext,
  };
}

async function summarizeChat(payload, session) {
  const message = String(payload.message || "").trim();
  if (!message) {
    return { summary: "" };
  }

  const target = payload.target === "group" ? "group" : "coop";
  const resolvedContext = resolveMessageWithContext(message, target, session);
  const effectiveMessage = resolvedContext.effectiveMessage || message;
  const structuredMatches = await LawSearchModel.searchStructuredLaws(effectiveMessage, target, 4);
  const pdfMatches = await LawChatbotPdfChunkModel.searchChunks(effectiveMessage, 4);
  const fallbackMatches = LawChatbotModel.searchKnowledge(effectiveMessage, target);
  const matches = [...structuredMatches, ...pdfMatches, ...fallbackMatches]
    .filter(Boolean)
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 5);

  return {
    summary: await generateChatSummary(message, matches, {
      conversationalFollowUp: resolvedContext.usedContext,
      topicLabel: resolvedContext.topicHints && resolvedContext.topicHints[0] ? resolvedContext.topicHints[0] : "",
    }),
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

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function processUploadInBackground(file, uploadRecord) {
  try {
    LawChatbotPdfChunkModel.updateUpload(uploadRecord.id, {
      status: "processing",
      processingMessage: "กำลังอ่านไฟล์และแปลงข้อความ",
    });

    const extractedText = await extractTextFromFile(file);
    const chunks = chunkText(extractedText, Number(process.env.CHUNK_SIZE || 1400));
    const documentMetadata = await extractDocumentMetadata(extractedText, file);

    LawChatbotPdfChunkModel.updateUpload(uploadRecord.id, {
      processingMessage: `กำลังสร้างดัชนีเอกสาร ${chunks.length} ส่วน`,
      title: documentMetadata.title || file.originalname,
      documentNumber: documentMetadata.documentNumber || "",
      documentDateText: documentMetadata.documentDateText || "",
      documentSource: documentMetadata.documentSource || "",
    });

    const documentRecord = await LawChatbotPdfChunkModel.createDocument({
      title: documentMetadata.title || file.originalname,
      documentNumber: documentMetadata.documentNumber || "",
      documentDate: documentMetadata.documentDate || null,
      documentDateText: documentMetadata.documentDateText || "",
      documentSource: documentMetadata.documentSource || "",
      filename: file.filename,
      originalname: file.originalname,
      mimetype: file.mimetype,
      fileSize: file.size,
    });

    const documentKeywords = await extractDocumentKeywords(extractedText);
    const chunkRecords = await mapWithConcurrency(
      chunks,
      KEYWORD_CONCURRENCY,
      async (chunk) => {
        const chunkKeywords = await extractKeywords(chunk);
        const mergedKeywords = uniqueTokens([...documentKeywords, ...chunkKeywords]).slice(0, 12);

        return {
          keyword: mergedKeywords.join(", ").slice(0, 255) || "document",
          chunkText: chunk,
          documentId: documentRecord.id,
        };
      },
    );

    const insertedChunkCount = await LawChatbotPdfChunkModel.insertChunks(chunkRecords, documentRecord.id);

    LawChatbotPdfChunkModel.updateUpload(uploadRecord.id, {
      status: "completed",
      processingMessage: "นำเข้าข้อมูลเรียบร้อยแล้ว",
      insertedChunkCount,
      title: documentRecord.title || file.originalname,
      documentNumber: documentRecord.documentNumber || "",
      documentDateText: documentRecord.documentDateText || "",
      documentSource: documentRecord.documentSource || "",
    });
  } catch (error) {
    LawChatbotPdfChunkModel.updateUpload(uploadRecord.id, {
      status: "failed",
      processingMessage: error.message || "ไม่สามารถประมวลผลเอกสารได้",
    });
  }
}

async function recordUpload(file) {
  if (!file) {
    return null;
  }

  const uploadRecord = LawChatbotPdfChunkModel.createUpload({
    filename: file.filename,
    originalname: file.originalname,
    mimetype: file.mimetype,
    size: file.size,
    status: "queued",
    processingMessage: "รอเริ่มประมวลผล",
  });

  setImmediate(() => {
    void processUploadInBackground(file, uploadRecord);
  });

  return {
    filename: file.filename,
    originalname: file.originalname,
    insertedChunkCount: 0,
    status: "queued",
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
