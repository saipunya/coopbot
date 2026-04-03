const LawChatbotModel = require("../models/lawChatbotModel");
const LawChatbotKnowledgeModel = require("../models/lawChatbotKnowledgeModel");
const LawChatbotKnowledgeSuggestionModel = require("../models/lawChatbotKnowledgeSuggestionModel");
const LawChatbotSuggestedQuestionModel = require("../models/lawChatbotSuggestedQuestionModel");
const LawSearchModel = require("../models/lawSearchModel");
const LawChatbotFeedbackModel = require("../models/lawChatbotFeedbackModel");
const LawChatbotPdfChunkModel = require("../models/lawChatbotPdfChunkModel");
const LawChatbotAnswerCacheModel = require("../models/lawChatbotAnswerCacheModel");
const PaymentRequestModel = require("../models/paymentRequestModel");
const UserModel = require("../models/userModel");
const UserMonthlyUsageModel = require("../models/userMonthlyUsageModel");
const UserSearchHistoryModel = require("../models/userSearchHistoryModel");
const runtimeFlags = require("../config/runtimeFlags");
const { isAiEnabled } = require("./runtimeSettingsService");
const { getOpenAiConfig } = require("./openAiService");
const { buildQuestionCacheIdentity } = require("./lawChatbotAnswerCacheUtils");
const { sendPaymentRequestNotification } = require("./telegramService");
const { generateChatSummary, wantsExplanation } = require("./chatAnswerService");
const {
  getPlanDurationDays,
  getPlanConfig,
  getPlanLabel,
  getPlanPriceBaht,
  getSearchHistoryRetentionLabel,
  isPaidPlan,
  listPurchasablePlans,
  listPlanComparisons,
  normalizePlanCode,
  resolveUserPlanContext,
  canUseSearchHistory,
  shouldUseAIForPlan,
} = require("./planService");
const {
  chunkText,
  extractTextResultFromFile,
} = require("./documentTextExtractor");
const {
  extractKeywords,
  extractDocumentKeywords,
} = require("./keywordExtractionService");
const { extractDocumentMetadata } = require("./documentMetadataService");
const {
  extractExplicitTopicHints,
  getQueryFocusProfile,
  normalizeForSearch,
  scoreQueryFocusAlignment,
  segmentWords,
  uniqueTokens,
} = require("./thaiTextUtils");

const CHAT_CONTEXT_KEY = "lawChatbotContext";
const CONTEXT_HISTORY_LIMIT = 8;
const CHAT_REQUEST_TIMEOUT_MS = Number(process.env.CHAT_REQUEST_TIMEOUT_MS || 25000);
const CHAT_BUDGET_BUFFER_MS = Number(process.env.CHAT_BUDGET_BUFFER_MS || 3000);
const CHAT_REPLY_BUDGET_MS = Math.max(2000, CHAT_REQUEST_TIMEOUT_MS - CHAT_BUDGET_BUFFER_MS);
const ANSWER_CACHE_TTL_MS = Number(process.env.LAW_CHATBOT_ANSWER_CACHE_TTL_MS || 5 * 60 * 1000);
const KEYWORD_CONCURRENCY = Number(process.env.KEYWORD_CONCURRENCY || 4);
const WEB_SEARCH_LIMIT = Number(process.env.LAW_CHATBOT_WEB_SEARCH_LIMIT || 3);
const WEB_SEARCH_TIMEOUT_MS = Number(process.env.LAW_CHATBOT_WEB_SEARCH_TIMEOUT_MS || 8000);
const HYBRID_SEARCH_TIMEOUT_MS = Number(process.env.LAW_CHATBOT_HYBRID_SEARCH_TIMEOUT_MS || 4000);
const MIN_CONTEXT_RESEARCH_BUDGET_MS = Number(process.env.LAW_CHATBOT_CONTEXT_RESEARCH_MIN_BUDGET_MS || 7000);
const MIN_INTERNET_SEARCH_BUDGET_MS = Number(process.env.LAW_CHATBOT_INTERNET_SEARCH_MIN_BUDGET_MS || 5000);
const MIN_AI_SUMMARY_BUDGET_MS = Number(process.env.LAW_CHATBOT_AI_SUMMARY_MIN_BUDGET_MS || 2500);
const WEB_SEARCH_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";
const ANSWER_CACHE_SCOPE_VERSION = "v13";
const answerCache = new Map();
const suggestionThrottleMap = new Map();

function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function getRemainingBudgetMs(startedAt, totalBudgetMs = CHAT_REPLY_BUDGET_MS) {
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.max(0, Math.round(totalBudgetMs - (nowMs() - startedAt)));
}

function getExtractionMethodLabel(method) {
  switch (String(method || "").trim()) {
    case "pdf_text_layer":
      return "PDF text layer";
    case "ocrmypdf_text_layer":
      return "OCRmyPDF text layer";
    case "tesseract_ocr":
      return "Tesseract OCR";
    case "ocrmypdf+tesseract_ocr":
      return "OCRmyPDF + Tesseract OCR";
    case "docx_text":
      return "DOCX text";
    case "doc_text":
      return "DOC text";
    default:
      return "";
  }
}

function getExtractionNoteLabel(note) {
  switch (String(note || "").trim()) {
    case "ocrmypdf_missing_language_data":
      return "OCRmyPDF ยังไม่มี language pack ภาษาไทย";
    case "ocrmypdf_not_installed":
      return "ยังไม่ได้ติดตั้ง OCRmyPDF";
    case "preprocessed_with_ocrmypdf":
      return "preprocess PDF ด้วย OCRmyPDF";
    default:
      return "";
  }
}

function getMinimumExtractionQualityScore(file = null) {
  const extension = String(file?.originalname || file?.filename || "")
    .toLowerCase()
    .split(".")
    .pop();

  if (extension === "pdf") {
    return Number(process.env.PDF_MIN_EXTRACTION_QUALITY_SCORE || process.env.DOCUMENT_MIN_EXTRACTION_QUALITY_SCORE || 50);
  }

  return Number(process.env.DOCUMENT_MIN_EXTRACTION_QUALITY_SCORE || 45);
}

function decideDocumentIndexing(extractionResult, file = null, chunkCount = 0) {
  const qualityScore = Number(extractionResult?.qualityScore);
  const minimumScore = getMinimumExtractionQualityScore(file);
  const notes = Array.isArray(extractionResult?.notes) ? extractionResult.notes : [];
  const extractionMethod = String(extractionResult?.extractionMethod || "").trim();
  const reliedOnOcr = extractionMethod.includes("tesseract_ocr");

  if (chunkCount <= 0 || !String(extractionResult?.text || "").trim()) {
    return {
      isSearchable: false,
      qualityStatus: "quarantined",
      reason: "ไม่พบข้อความที่นำไปสร้างดัชนีได้",
    };
  }

  if (Number.isFinite(qualityScore) && qualityScore < minimumScore) {
    return {
      isSearchable: false,
      qualityStatus: "quarantined",
      reason: `คะแนนคุณภาพข้อความต่ำกว่าเกณฑ์ (${qualityScore}/${minimumScore})`,
    };
  }

  if (reliedOnOcr && notes.includes("ocrmypdf_missing_language_data")) {
    return {
      isSearchable: false,
      qualityStatus: "quarantined",
      reason: "ยังไม่มี OCR ภาษาไทยพร้อมใช้งานบนเครื่องนี้",
    };
  }

  return {
    isSearchable: true,
    qualityStatus: "accepted",
    reason: "",
  };
}

async function withTimeout(task, timeoutMs, fallbackValue, label = "task") {
  const normalizedTimeoutMs = Number(timeoutMs || 0);
  if (!Number.isFinite(normalizedTimeoutMs) || normalizedTimeoutMs <= 0) {
    return typeof task === "function" ? task() : task;
  }

  let timeoutId = null;
  let timedOut = false;

  try {
    return await Promise.race([
      Promise.resolve().then(() => (typeof task === "function" ? task() : task)),
      new Promise((resolve) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          resolve(fallbackValue);
        }, normalizedTimeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    if (timedOut && process.env.CHATBOT_DEBUG === "1") {
      console.warn(`[law-chatbot] ${label} reached timeout budget ${normalizedTimeoutMs}ms`);
    }
  }
}

function isStandaloneLawLookup(message) {
  const text = normalizeForSearch(String(message || "")).toLowerCase();
  return /^(มาตรา|ข้อ|วรรค|อนุมาตรา)\s*\d+\b/.test(text);
}

function buildAnswerCacheScope(planContext = {}) {
  const planCode = normalizePlanCode(planContext.code || planContext.plan || "free");
  const promptProfileCode =
    String(planContext.promptProfile?.code || "").trim().toLowerCase() || "template";
  const internetMode = planContext.useInternet
    ? String(planContext.internetMode || "full").trim().toLowerCase()
    : "none";

  return [ANSWER_CACHE_SCOPE_VERSION, planCode, promptProfileCode, internetMode].join("::");
}

function buildAnswerCacheKey(message, target, planContext = {}) {
  return `${target}::${buildAnswerCacheScope(planContext)}::${normalizeForSearch(message).toLowerCase()}`;
}

function resolveChatPlanContext(session, options = {}) {
  const aiAvailable = Boolean(options.aiAvailable);
  const baseUser =
    session?.adminUser
      ? { plan: "premium" }
      : session?.user || { plan: "free" };
  const configuredContext = resolveUserPlanContext(baseUser);
  const effectiveUseAI = aiAvailable && configuredContext.useAI;
  const effectiveUseInternet = effectiveUseAI && configuredContext.useInternet;
  const promptProfile = effectiveUseAI
    ? configuredContext.promptProfile
    : {
        ...configuredContext.promptProfile,
        code: configuredContext.code === "free" ? "template" : "dbonly",
        aiSourceLimit: 0,
      };

  return {
    ...configuredContext,
    useAI: effectiveUseAI,
    useInternet: effectiveUseInternet,
    promptProfile,
  };
}

function applyEconomyDatabaseOnlyMode(planContext, message, databaseMatches, questionIntent) {
  if (!planContext?.useAI) {
    return {
      ...planContext,
      answerMode: "db_only",
    };
  }

  const shouldUseAI = shouldUseAIForPlan(planContext.code, {
    dbConfidence: computeDbConfidence(databaseMatches, questionIntent),
    simpleQuestion: isSimpleQuestion(message, questionIntent),
    needsExplain: wantsExplanation(message),
    fewResults: (Array.isArray(databaseMatches) ? databaseMatches.length : 0) < 2,
    isCurrentOrExternalQuestion: isClearlyCurrentOrExternalQuestion(message),
  });

  if (shouldUseAI) {
    return {
      ...planContext,
      answerMode: "ai",
    };
  }

  return {
    ...planContext,
    useAI: false,
    useInternet: false,
    promptProfile: {
      ...planContext.promptProfile,
      code: `dbonly-${planContext.promptProfile?.code || planContext.code || "plan"}`,
      aiSourceLimit: 0,
    },
    answerMode: "economy_db_only",
  };
}

function shouldUseAnswerCache(message) {
  const text = String(message || "").trim();
  return Boolean(text) && !looksLikeFollowUpQuestion(text) && !isStandaloneLawLookup(text);
}

function getCachedAnswer(cacheKey) {
  const cached = answerCache.get(cacheKey);
  if (!cached) {
    return null;
  }

  if (Date.now() - cached.createdAt > ANSWER_CACHE_TTL_MS) {
    answerCache.delete(cacheKey);
    return null;
  }

  return cached.value;
}

function setCachedAnswer(cacheKey, value) {
  answerCache.set(cacheKey, {
    createdAt: Date.now(),
    value,
  });

  if (answerCache.size > 200) {
    const oldestKey = answerCache.keys().next().value;
    if (oldestKey) {
      answerCache.delete(oldestKey);
    }
  }
}

function clearAnswerCache() {
  answerCache.clear();
}

function buildManagedSuggestedQuestionSource(match = {}) {
  return {
    id: match.id || null,
    target: match.target || "all",
    title: match.questionText || "",
    reference: match.questionText || "คำถามแนะนำ",
    content: match.answerText || "",
    source: "managed_suggested_question",
    comment: "คำตอบที่ผู้ดูแลกำหนดไว้ล่วงหน้า",
    score: 1000,
  };
}

async function findManagedSuggestedQuestionMatch(message, target = "all") {
  const match = await LawChatbotSuggestedQuestionModel.findAnswerMatch(message, target);
  if (!match?.answerText) {
    return null;
  }

  return {
    ...match,
    source: buildManagedSuggestedQuestionSource(match),
  };
}

function shouldPersistDbAnswerCache(answer, options = {}) {
  const text = String(answer || "").trim();
  if (!text || options.debugMode) {
    return false;
  }

  return !/(เข้าสู่ระบบด้วย google|guest ครบ|ใช้สิทธิ์ถามคำถามครบ|อัปเกรดแพลน|mock ai|โหมดทดสอบ)/i.test(
    text,
  );
}

function buildDbCachedChatResult(cacheEntry, message) {
  const metadata = cacheEntry?.metadata || {};
  const highlightTerms = Array.isArray(metadata.highlightTerms)
    ? metadata.highlightTerms
    : String(message || "")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 8);

  return {
    hasContext: metadata.hasContext !== false,
    answer: String(cacheEntry?.answer_text || "").trim(),
    highlightTerms,
    usedFollowUpContext: false,
    usedInternetFallback: Boolean(metadata.usedInternetFallback),
    fromCache: true,
  };
}

function cleanupSuggestionThrottle() {
  if (suggestionThrottleMap.size <= 200) {
    return;
  }

  for (const [key, value] of suggestionThrottleMap.entries()) {
    if (Date.now() - value.createdAt > 10 * 60 * 1000) {
      suggestionThrottleMap.delete(key);
    }
  }
}

function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&nbsp;/gi, " ");
}

function stripHtml(text) {
  return decodeHtmlEntities(String(text || "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function normalizeSearchUrl(rawUrl) {
  const cleaned = decodeHtmlEntities(String(rawUrl || "").trim());
  if (!cleaned) {
    return "";
  }

  try {
    const parsed = new URL(cleaned, "https://duckduckgo.com");
    const redirectUrl = parsed.searchParams.get("uddg");
    if (redirectUrl) {
      return decodeURIComponent(redirectUrl);
    }
    return parsed.toString();
  } catch {
    return cleaned;
  }
}

function getUrlDomain(rawUrl) {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

async function fetchText(url, timeoutMs = WEB_SEARCH_TIMEOUT_MS) {
  if (typeof fetch !== "function") {
    throw new Error("fetch is not available in this runtime");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "th-TH,th;q=0.9,en;q=0.8",
        "user-agent": WEB_SEARCH_USER_AGENT,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeoutId);
  }
}

function scoreInternetSource(query, source) {
  const queryText = normalizeForSearch(query).toLowerCase();
  const sourceText = normalizeForSearch(`${source.title || ""} ${source.snippet || ""} ${source.domain || ""}`).toLowerCase();
  const queryTokens = uniqueTokens(segmentWords(query));
  const sourceTokens = new Set(uniqueTokens(segmentWords(sourceText)));

  let score = 8;

  if (queryText && sourceText.includes(queryText)) {
    score += 20;
  }

  const tokenHits = queryTokens.filter((token) => sourceTokens.has(token)).length;
  score += tokenHits * 6;

  const coverage = queryTokens.length > 0 ? tokenHits / queryTokens.length : 0;
  score += coverage * 18;

  if (source.domain) {
    score += 4;
  }

  if (source.snippet) {
    score += 4;
  }

  return score;
}

function extractWebSearchResults(html, limit = WEB_SEARCH_LIMIT) {
  const results = [];
  const titlePattern = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match = null;

  while ((match = titlePattern.exec(html)) && results.length < limit) {
    const url = normalizeSearchUrl(match[1]);
    const title = stripHtml(match[2]);

    if (!title) {
      continue;
    }

    const windowText = html.slice(match.index, titlePattern.lastIndex + 1200);
    const snippetMatch =
      windowText.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|span|div)>/i) ||
      windowText.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)$/i);
    const snippet = stripHtml(snippetMatch?.[1] || "");

    results.push({
      title,
      url,
      snippet,
      domain: getUrlDomain(url),
    });
  }

  return results;
}

async function searchInternetSources(message, target, options = {}) {
  const query = String(message || "").trim();
  if (!query) {
    return [];
  }

  const targetKeyword =
    target === "group" ? "กลุ่มเกษตรกร" : target === "coop" ? "สหกรณ์" : "สหกรณ์ กลุ่มเกษตรกร";
  const searchQuery = `${query} ${targetKeyword}`.trim();
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}&kl=th-th&ia=web`;
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || WEB_SEARCH_TIMEOUT_MS));
  const resultLimit = Math.max(1, Number(options.limit || WEB_SEARCH_LIMIT));

  try {
    const html = await fetchText(searchUrl, timeoutMs);
    if (process.env.DEBUG_INTERNET_SEARCH === "true") {
      console.log("[searchInternetSources] HTML length:", html?.length || 0);
      console.log("[searchInternetSources] Has result__a:", html?.includes("result__a"));
    }
    const rawResults = extractWebSearchResults(html, resultLimit);
    if (process.env.DEBUG_INTERNET_SEARCH === "true") {
      console.log("[searchInternetSources] Raw results:", rawResults?.length || 0);
    }
    const scoredResults = rawResults.map((result, index) => {
      const baseScore = scoreInternetSource(searchQuery, result);
      return {
        ...result,
        source: "internet_search",
        reference: result.title || result.domain || result.url || "ข้อมูลจากอินเทอร์เน็ต",
        content: result.snippet || "",
        score: baseScore,
      };
    });
    if (process.env.DEBUG_INTERNET_SEARCH === "true") {
      console.log("[searchInternetSources] Scores:", scoredResults.map(r => r.score));
    }
    return scoredResults
      .filter((result) => result.score > 0)
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, resultLimit);
  } catch (err) {
    console.error("[searchInternetSources] Error:", err?.message || err);
    return [];
  }
}

function prioritizeMatches(matches, options = {}) {
  const retrievalPriority = Number(options.retrievalPriority || 0);
  const scoreBoost = Number(options.scoreBoost || 0);
  const sourceOverride = options.sourceOverride || "";

  return (Array.isArray(matches) ? matches : []).map((item) => ({
    ...item,
    source: sourceOverride || item.source,
    retrievalPriority,
    score: Number(item.score || 0) + scoreBoost,
  }));
}

function classifyQuestionIntent(message) {
  const text = normalizeForSearch(String(message || "")).toLowerCase();
  const asksExplanation = wantsExplanation(text);

  const asksLawSection =
    /มาตรา\s*\d+|มาตรา|วรรค|อนุมาตรา|ข้อ\s*\d+/.test(text);
  const asksDocumentStyle =
    /กฎกระทรวง|ประกาศ|หนังสือเวียน|ข้อหารือ|หนังสือสั่งการ|หนังสือกรม|เอกสาร|ฉบับ/.test(text);
  const asksFeeOrAmountStyle =
    /ค่าบำรุง|สันนิบาต|อัตรา|ร้อยละ|เปอร์เซ็นต์|%|จำนวนเงิน|ต้องจ่าย|ชำระ|จ่าย/.test(text);
  const asksQaStyle =
    /แนววินิจฉัย|วินิจฉัย|ตีความ|ข้อหารือ|ถามตอบ|คำถามคำตอบ/.test(text);
  const asksShortAnswer =
    text.length <= 60 &&
    /คืออะไร|หมายถึง|เท่าไร|เท่าไหร่|กี่บาท|กี่เปอร์เซ็นต์|กี่ร้อยละ|เมื่อไร|เมื่อไหร่|ต้อง|ควร|ได้ไหม|ได้หรือไม่/.test(
      text,
    );

  if (asksExplanation) {
    return "explain";
  }

  if (asksLawSection) {
    return "law_section";
  }

  if (asksDocumentStyle || asksFeeOrAmountStyle) {
    return "document";
  }

  if (asksQaStyle) {
    return "qa";
  }

  if (asksShortAnswer) {
    return "short_answer";
  }

  return "general";
}

function isLawPrioritySearch(message) {
  return /(มาตรา|ข้อ|วรรค|อนุมาตรา)/.test(normalizeForSearch(message).toLowerCase());
}

function isLiquidationPrioritySearch(message) {
  return /ชำระบัญชี|ผู้ชำระบัญชี/.test(normalizeForSearch(message).toLowerCase());
}

function isDissolutionPrioritySearch(message) {
  const normalized = normalizeForSearch(message).toLowerCase();
  if (!normalized) {
    return false;
  }

  return /(?:การเลิกสหกรณ์|เลิกสหกรณ์|สั่งเลิกสหกรณ์|สหกรณ์(?:ย่อม)?(?:ต้อง)?เลิก)/.test(normalized);
}

function isVinichaiPrioritySearch(message) {
  const normalized = normalizeForSearch(message).toLowerCase();
  if (!normalized) {
    return false;
  }

  return /แนววินิจฉัย|วินิจฉัย|ตีความ|ข้อหารือ|ถามตอบ|คำถามคำตอบ/.test(normalized);
}

function isFreePlanSearch(planCode = "") {
  return normalizePlanCode(planCode || "free") === "free";
}

function resolvePreferredStructuredLawSources(message, target = "all") {
  const normalizedMessage = normalizeForSearch(message).toLowerCase();
  const normalizedTarget = String(target || "all").trim().toLowerCase();
  const mentionsGroupLaw = /กลุ่มเกษตรกร|พรบ\.?\s*กลุ่มเกษตรกร|พระราชกฤษฎีกากลุ่มเกษตรกร|กฎหมายกลุ่มเกษตรกร/.test(
    normalizedMessage,
  );
  const mentionsCoopLaw = /สหกรณ์|พรบ\.?\s*สหกรณ์|พระราชบัญญัติสหกรณ์|กฎหมายสหกรณ์/.test(
    normalizedMessage,
  );

  if (normalizedTarget === "group" || (mentionsGroupLaw && !mentionsCoopLaw)) {
    return {
      primaryLawSource: "tbl_glaws",
      secondaryLawSource: "tbl_laws",
    };
  }

  return {
    primaryLawSource: "tbl_laws",
    secondaryLawSource: "tbl_glaws",
  };
}

function getFreeSourcePriorityPlan(message, target = "all") {
  const { primaryLawSource, secondaryLawSource } = resolvePreferredStructuredLawSources(message, target);
  if (isVinichaiPrioritySearch(message)) {
    return {
      vinichai: 10,
      admin_knowledge: 9,
      knowledge_suggestion: 6,
      [primaryLawSource]: 4,
      [secondaryLawSource]: 3,
      documents: 2,
      pdf_chunks: 1,
      knowledge_base: 1,
    };
  }

  if (isLawPrioritySearch(message)) {
    return {
      [primaryLawSource]: 10,
      admin_knowledge: 8,
      vinichai: 7,
      knowledge_suggestion: 6,
      [secondaryLawSource]: 5,
      documents: 2,
      pdf_chunks: 1,
      knowledge_base: 1,
    };
  }

  if (isLiquidationPrioritySearch(message)) {
    return {
      [primaryLawSource]: 10,
      admin_knowledge: 8,
      vinichai: 7,
      knowledge_suggestion: 6,
      documents: 3,
      [secondaryLawSource]: 2,
      pdf_chunks: 1,
      knowledge_base: 1,
    };
  }

  if (isDissolutionPrioritySearch(message)) {
    return {
      [primaryLawSource]: 10,
      admin_knowledge: 9,
      vinichai: 8,
      knowledge_suggestion: 6,
      documents: 3,
      [secondaryLawSource]: 2,
      pdf_chunks: 1,
      knowledge_base: 1,
    };
  }

  return {
    admin_knowledge: 10,
    vinichai: 9,
    knowledge_suggestion: 7,
    [primaryLawSource]: 6,
    [secondaryLawSource]: 5,
    documents: 3,
    pdf_chunks: 1,
    knowledge_base: 1,
  };
}

function getSourceRoutingPlan(intent) {
  switch (intent) {
    case "explain":
      return {
        priorities: {
          structured_laws: 6,
          documents: 5,
          pdf_chunks: 5,
          vinichai: 4,
          admin_knowledge: 4,
          knowledge_base: 1,
        },
        limits: {
          structured_laws: 4,
          documents: 3,
          pdf_chunks: 5,
          vinichai: 3,
          admin_knowledge: 2,
          knowledge_base: 1,
        },
      };
    case "law_section":
      return {
        priorities: {
          structured_laws: 7,
          admin_knowledge: 4,
          vinichai: 3,
          documents: 2,
          pdf_chunks: 2,
          knowledge_base: 1,
        },
        limits: {
          structured_laws: 4,
          admin_knowledge: 1,
          vinichai: 1,
          documents: 1,
          pdf_chunks: 1,
          knowledge_base: 1,
        },
      };
    case "document":
      return {
        priorities: {
          documents: 6,
          pdf_chunks: 6,
          structured_laws: 3,
          vinichai: 3,
          admin_knowledge: 5,
          knowledge_base: 1,
        },
        limits: {
          documents: 2,
          pdf_chunks: 4,
          structured_laws: 2,
          vinichai: 1,
          admin_knowledge: 2,
          knowledge_base: 1,
        },
      };
    case "qa":
      return {
        priorities: {
          vinichai: 8,
          admin_knowledge: 6,
          structured_laws: 3,
          documents: 1,
          pdf_chunks: 1,
          knowledge_base: 1,
        },
        limits: {
          vinichai: 4,
          admin_knowledge: 2,
          structured_laws: 1,
          documents: 1,
          pdf_chunks: 1,
          knowledge_base: 1,
        },
      };
    case "short_answer":
      return {
        priorities: {
          admin_knowledge: 6,
          structured_laws: 5,
          vinichai: 3,
          documents: 2,
          pdf_chunks: 2,
          knowledge_base: 1,
        },
        limits: {
          admin_knowledge: 3,
          structured_laws: 2,
          vinichai: 1,
          documents: 1,
          pdf_chunks: 1,
          knowledge_base: 1,
        },
      };
    default:
      return {
        priorities: {
          structured_laws: 5,
          admin_knowledge: 4,
          vinichai: 4,
          documents: 3,
          pdf_chunks: 3,
          knowledge_base: 1,
        },
        limits: {
          structured_laws: 3,
          admin_knowledge: 2,
          vinichai: 2,
          documents: 2,
          pdf_chunks: 3,
          knowledge_base: 1,
        },
      };
  }
}

async function searchDatabaseSources(message, target, options = {}) {
  const intent = classifyQuestionIntent(message);
  const routingPlan = getSourceRoutingPlan(intent);
  const freePlanSearch = isFreePlanSearch(options.planCode);
  const freeSourcePriorityPlan = freePlanSearch ? getFreeSourcePriorityPlan(message, target) : null;
  const hybridTimeoutMs = Math.max(1000, Number(options.hybridTimeoutMs || HYBRID_SEARCH_TIMEOUT_MS));
  const prioritizeStructuredLawSearch = isLawPrioritySearch(message);

  if (prioritizeStructuredLawSearch && !freePlanSearch) {
    const structuredMatchesFirst = prioritizeMatches(
      await LawSearchModel.searchStructuredLaws(message, target, 8),
      {
        retrievalPriority: routingPlan.priorities.structured_laws || 5,
      },
    );

    if (structuredMatchesFirst.length > 0) {
      return structuredMatchesFirst;
    }
  }

  const [
    rawKnowledgeMatches,
    rawSuggestionMatches,
    rawDocumentMatches,
    rawPdfMatches,
    rawFallbackKnowledge,
    rawStructuredMatches,
    rawVinichaiMatches,
  ] = await Promise.all([
    LawChatbotKnowledgeModel.searchKnowledge(message, target, 5),
    freePlanSearch
      ? LawChatbotKnowledgeSuggestionModel.searchApproved(message, target, 5)
      : Promise.resolve([]),
    LawChatbotPdfChunkModel.searchDocuments(message, 5),
    withTimeout(() => LawChatbotPdfChunkModel.hybridSearch(message, 6), hybridTimeoutMs, [], "hybrid-search"),
    Promise.resolve(LawChatbotModel.searchKnowledge(message, target)),
    LawSearchModel.searchStructuredLaws(message, target, 6),
    LawSearchModel.searchVinichai(message, 5),
  ]);

  const knowledgeMatches = prioritizeMatches(rawKnowledgeMatches, {
    retrievalPriority:
      freeSourcePriorityPlan?.admin_knowledge || routingPlan.priorities.admin_knowledge || 4,
    sourceOverride: "admin_knowledge",
  });
  const suggestionMatches = prioritizeMatches(rawSuggestionMatches, {
    retrievalPriority: freeSourcePriorityPlan?.knowledge_suggestion || 0,
    sourceOverride: "knowledge_suggestion",
  });
  const documentMatches = prioritizeMatches(rawDocumentMatches, {
    retrievalPriority: freeSourcePriorityPlan?.documents || routingPlan.priorities.documents || 3,
  });
  const pdfMatches = prioritizeMatches(rawPdfMatches, {
    retrievalPriority: freeSourcePriorityPlan?.pdf_chunks || routingPlan.priorities.pdf_chunks || 2,
  });
  const fallbackKnowledge = prioritizeMatches(rawFallbackKnowledge, {
    retrievalPriority: freeSourcePriorityPlan?.knowledge_base || routingPlan.priorities.knowledge_base || 1,
    sourceOverride: "knowledge_base",
  });
  const vinichaiMatches = prioritizeMatches(rawVinichaiMatches, {
    retrievalPriority: freeSourcePriorityPlan?.vinichai || routingPlan.priorities.vinichai || 4,
  });
  const structuredMatches = freePlanSearch
    ? [
        ...prioritizeMatches(
          rawStructuredMatches.filter((item) => item && item.source === "tbl_laws"),
          {
            retrievalPriority: freeSourcePriorityPlan?.tbl_laws || routingPlan.priorities.structured_laws || 5,
            sourceOverride: "tbl_laws",
          },
        ),
        ...prioritizeMatches(
          rawStructuredMatches.filter((item) => item && item.source === "tbl_glaws"),
          {
            retrievalPriority: freeSourcePriorityPlan?.tbl_glaws || routingPlan.priorities.structured_laws || 5,
            sourceOverride: "tbl_glaws",
          },
        ),
      ]
    : prioritizeMatches(rawStructuredMatches, {
        retrievalPriority: routingPlan.priorities.structured_laws || 5,
      });

  const combinedMatches = [
    ...structuredMatches,
    ...knowledgeMatches,
    ...suggestionMatches,
    ...vinichaiMatches,
    ...documentMatches,
    ...pdfMatches,
    ...fallbackKnowledge,
  ]
    .filter(Boolean)
    .sort((a, b) => {
      const priorityDiff = (b.retrievalPriority || 0) - (a.retrievalPriority || 0);
      if (priorityDiff !== 0) {
        return priorityDiff;
      }

      return (b.score || 0) - (a.score || 0);
    })
    .slice(0, 120);

  return pruneFocusedQueryMatches(combinedMatches, message);
}

function getSessionContext(session) {
  if (!session) {
    return [];
  }

  if (!Array.isArray(session[CHAT_CONTEXT_KEY])) {
    session[CHAT_CONTEXT_KEY] = [];
  }

  return session[CHAT_CONTEXT_KEY];
}

function buildContextSourceKey(source = {}) {
  return [
    String(source.source || "").trim().toLowerCase(),
    String(source.id || "").trim(),
    String(source.reference || "").trim().toLowerCase(),
    String(source.title || "").trim().toLowerCase(),
    String(source.lawNumber || "").trim().toLowerCase(),
    String(source.url || "").trim().toLowerCase(),
  ].join("::");
}

function compactContextSource(source = {}) {
  if (!source || typeof source !== "object") {
    return null;
  }

  const content = String(
    source.content || source.chunk_text || source.comment || "",
  ).replace(/\s+/g, " ").trim();

  return {
    id: source.id || null,
    source: source.source || "",
    title: source.title || "",
    reference: source.reference || source.title || "",
    lawNumber: source.lawNumber || "",
    url: source.url || "",
    score: Number(source.score || 0),
    keyword: source.keyword || "",
    content: content.slice(0, 900),
    chunk_text: content.slice(0, 900),
    comment: content.slice(0, 900),
  };
}

function mergeUniqueSources(...groups) {
  const seen = new Set();
  const results = [];

  groups.flat().forEach((source) => {
    const compacted = compactContextSource(source);
    if (!compacted) {
      return;
    }

    const key = buildContextSourceKey(compacted);
    if (!key || seen.has(key)) {
      return;
    }

    seen.add(key);
    results.push(compacted);
  });

  return results;
}

function stripQuestionTail(message) {
  return String(message || "")
    .replace(/^(อธิบาย|รายละเอียด|ขยายความ|ยกตัวอย่าง)\s*/i, "")
    .replace(/(คืออะไร|คืออะไรครับ|คืออะไรคะ|คืออะไร\?|คือ|หมายถึงอะไร|หมายถึง|จะจัดขึ้นเมื่อไร|จะจัดขึ้นเมื่อไหร่|จัดขึ้นเมื่อไร|จัดขึ้นเมื่อไหร่|เมื่อไร|เมื่อไหร่|ทำอย่างไร|อย่างไร|ยังไง|ได้หรือไม่|ได้ไหม|ได้หรือเปล่า|หรือไม่|หรือเปล่า|กี่วัน|กี่ครั้ง|เท่าไร|ไหม|มั้ย)\s*[\?？]*$/i, "")
    .trim();
}

function startsWithFollowUpLead(message) {
  return /^(ตกลง|แล้ว|ส่วน|ประเด็นนี้|กรณีนี้|สรุปแล้ว|ท้ายที่สุด|เรื่องนี้|หัวข้อนี้)/.test(
    String(message || "").trim(),
  );
}

function normalizeTopicHintForCompare(value) {
  return normalizeForSearch(String(value || ""))
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function hasTopicHintOverlap(topicHints, recentTopic = "") {
  const normalizedRecentTopic = normalizeTopicHintForCompare(recentTopic);
  if (!normalizedRecentTopic) {
    return false;
  }

  return (Array.isArray(topicHints) ? topicHints : []).some((hint) => {
    const normalizedHint = normalizeTopicHintForCompare(hint);
    if (!normalizedHint) {
      return false;
    }

    return (
      normalizedRecentTopic.includes(normalizedHint) ||
      normalizedHint.includes(normalizedRecentTopic)
    );
  });
}

function countMeaningfulQuestionTokens(message) {
  return uniqueTokens(segmentWords(message)).filter((token) => String(token || "").trim().length >= 3).length;
}

function looksLikeNewTopicQuestion(message, recentTopic = "") {
  const text = String(message || "").trim();
  if (!text || isStandaloneLawLookup(text)) {
    return false;
  }

  if (text.length <= 18 || startsWithFollowUpLead(text)) {
    return false;
  }

  const explicitTopicHints = extractExplicitTopicHints(text);
  const hasTopicOverlap = hasTopicHintOverlap(explicitTopicHints, recentTopic);
  const meaningfulTokenCount = countMeaningfulQuestionTokens(text);

  if (explicitTopicHints.length > 0 && !hasTopicOverlap && text.length >= 24) {
    return true;
  }

  if (explicitTopicHints.length > 0 && !hasTopicOverlap && text.length >= 18 && meaningfulTokenCount >= 5) {
    return true;
  }

  return false;
}

function looksLikeFollowUpQuestion(message, recentTopic = "") {
  const text = String(message || "").trim();
  if (!text) {
    return false;
  }

  if (isStandaloneLawLookup(text)) {
    return false;
  }

  if (text.length <= 18) {
    return true;
  }

  if (looksLikeNewTopicQuestion(text, recentTopic)) {
    return false;
  }

  if (startsWithFollowUpLead(text)) {
    return true;
  }

  if (
    /(อำนาจหน้าที่|มีหน้าที่|หน้าที่|คุณสมบัติ|ลักษณะต้องห้าม|ขาดจากการเป็น)/.test(text) &&
    extractExplicitTopicHints(text).length === 0
  ) {
    return true;
  }

  return /^(คืออะไร|คือ|เมื่อไร|เมื่อไหร่|อย่างไร|ยังไง|ได้หรือไม่|ได้ไหม|ได้หรือเปล่า|หรือไม่|สมาชิก|คณะกรรมการ|จะ|ต้อง|ควร|หาก)/.test(
    text,
  );
}

function extractTopicHints(message, matches) {
  const hints = [...extractExplicitTopicHints(message)];
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
  const recent = history[0];
  const recentTopic = Array.isArray(recent?.topicHints) ? recent.topicHints[0] : "";

  if (history.length === 0 || !looksLikeFollowUpQuestion(text, recentTopic)) {
    return {
      effectiveMessage: text,
      usedContext: false,
      topicHints: baseTopic ? [baseTopic] : [],
    };
  }

  if (!recentTopic) {
    return {
      effectiveMessage: text,
      usedContext: false,
      topicHints: baseTopic ? [baseTopic] : [],
    };
  }

  const alreadyContainsTopic = baseTopic && hasTopicHintOverlap([baseTopic], recentTopic);
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
    focusSources: mergeUniqueSources(Array.isArray(matches) ? matches.slice(0, 6) : []).slice(0, 6),
    createdAt: new Date().toISOString(),
  });

  session[CHAT_CONTEXT_KEY] = history.slice(0, CONTEXT_HISTORY_LIMIT);
}

function getFollowUpCarrySources(session, target, message, resolvedContext = {}) {
  if (!resolvedContext?.usedContext || !wantsExplanation(message)) {
    return [];
  }

  const recent = getSessionContext(session).find((item) => item && item.target === target);
  if (!recent || !Array.isArray(recent.focusSources)) {
    return [];
  }

  return recent.focusSources
    .map((source, index) => {
      const compacted = compactContextSource(source);
      if (!compacted) {
        return null;
      }

      return {
        ...compacted,
        score: Math.max(Number(compacted.score || 0), 92 - index * 3),
        contextCarry: true,
      };
    })
    .filter(Boolean)
    .slice(0, 6);
}

function scoreMatchSet(matches) {
  if (!matches.length) {
    return 0;
  }

  const top = Number(matches[0]?.score || 0);
  const second = Number(matches[1]?.score || 0);
  return top + second * 0.35;
}

function computeDbConfidence(matches, questionIntent = "general") {
  const ranked = sortByScore(matches);
  if (!ranked.length) {
    return 0;
  }

  const topScore = Number(ranked[0]?.score || 0);
  const aggregateScore = scoreMatchSet(ranked);
  let confidence = Math.round(Math.max(topScore / 10, aggregateScore / 8));

  if (questionIntent === "law_section" && topScore >= 90) {
    confidence += 2;
  }

  if (ranked.length >= 3 && aggregateScore >= 120) {
    confidence += 1;
  }

  return Math.max(0, Math.min(20, confidence));
}

function isSimpleQuestion(message, questionIntent = "general") {
  const text = normalizeForSearch(String(message || "")).toLowerCase();
  if (!text) {
    return false;
  }

  if (questionIntent === "short_answer") {
    return true;
  }

  if (questionIntent === "law_section" && isStandaloneLawLookup(text)) {
    return true;
  }

  return text.length <= 60 && /คืออะไร|หมายถึง|เท่าไร|เท่าไหร่|กี่|เมื่อไร|เมื่อไหร่|ได้ไหม|ได้หรือไม่|ต้องไหม|ต้องหรือไม่/.test(text);
}

function isClearlyCurrentOrExternalQuestion(message) {
  const text = normalizeForSearch(String(message || "")).toLowerCase();
  if (!text) {
    return false;
  }

  return /(วันนี้|ตอนนี้|ล่าสุด|ปัจจุบัน|ข่าว|new|update|ประกาศใหม่|เว็บไซต์|ลิงก์|link|ออนไลน์|internet|web|google|facebook|line|โทร|เบอร์|ที่อยู่|map|แผนที่|ภายนอก|external)/.test(
    text,
  );
}

function isLowConfidenceDatabaseResult(matches, questionIntent = "general") {
  const ranked = sortByScore(matches);
  if (!ranked.length) {
    return true;
  }

  const topScore = Number(ranked[0]?.score || 0);
  const secondScore = Number(ranked[1]?.score || 0);
  const aggregateScore = scoreMatchSet(ranked);

  if (questionIntent === "law_section") {
    return topScore < 90;
  }

  if (questionIntent === "short_answer") {
    return topScore < 80 && aggregateScore < 110;
  }

  return topScore < 85 || (ranked.length < 2 && topScore < 105) || aggregateScore < 120 || secondScore < 35;
}

function getFollowUpResolutionProfile(planCode = "free") {
  const normalizedPlanCode = normalizePlanCode(planCode);

  if (normalizedPlanCode === "free") {
    return {
      contextScoreBuffer: 5,
      contextScoreMultiplier: 1.1,
      shortFollowUpContextScoreBuffer: 1,
      shortFollowUpContextScoreMultiplier: 1.02,
      minimumContextTopScore: 44,
      allowStrongerContextCarry: true,
    };
  }

  if (normalizedPlanCode === "premium") {
    return {
      contextScoreBuffer: 0,
      contextScoreMultiplier: 1.0,
      shortFollowUpContextScoreBuffer: 0,
      shortFollowUpContextScoreMultiplier: 1.0,
      minimumContextTopScore: 44,
      allowStrongerContextCarry: true,
    };
  }

  if (normalizedPlanCode === "pro") {
    return {
      contextScoreBuffer: 4,
      contextScoreMultiplier: 1.08,
      shortFollowUpContextScoreBuffer: 1,
      shortFollowUpContextScoreMultiplier: 1.02,
      minimumContextTopScore: 46,
      allowStrongerContextCarry: true,
    };
  }

  return {
    contextScoreBuffer: 8,
    contextScoreMultiplier: 1.2,
    shortFollowUpContextScoreBuffer: 2,
    shortFollowUpContextScoreMultiplier: 1.05,
    minimumContextTopScore: 48,
    allowStrongerContextCarry: false,
  };
}

function shouldSearchInternetForPlan(planCode, message, matches, questionIntent = "general") {
  const config = getPlanConfig(planCode);
  if (!config.useInternet) {
    return false;
  }

  const normalizedMessage = String(message || "").trim();
  const currentOrExternal = isClearlyCurrentOrExternalQuestion(normalizedMessage);
  const lowConfidence = isLowConfidenceDatabaseResult(matches, questionIntent);
  const topScore = Number(sortByScore(matches)[0]?.score || 0);
  const mostlyInternalQuestion =
    !currentOrExternal &&
    (questionIntent === "law_section" || questionIntent === "document" || questionIntent === "short_answer");

  if (mostlyInternalQuestion) {
    return false;
  }

  if (config.internetMode === "full") {
    return currentOrExternal || lowConfidence || (questionIntent === "general" && topScore < 78);
  }

  return currentOrExternal || lowConfidence;
}

async function resolveSearchPlan(message, target, session, options = {}) {
  const baseMessage = String(message || "").trim();
  const followUpProfile = getFollowUpResolutionProfile(options.planCode || "free");
  const contextualCandidate = resolveMessageWithContext(baseMessage, target, session);
  const baseTopicHints = extractExplicitTopicHints(baseMessage);
  const implicitFollowUpQuestion =
    contextualCandidate.usedContext &&
    baseTopicHints.length === 0 &&
    (
      baseMessage.length <= 18 ||
      startsWithFollowUpLead(baseMessage) ||
      /(อำนาจหน้าที่|มีหน้าที่|หน้าที่|คุณสมบัติ|ลักษณะต้องห้าม|ขาดจากการเป็น|ต้องทำอย่างไร|ทำอย่างไร|อย่างไร|ยังไง)/.test(
        baseMessage,
      )
    );
  const shortFollowUpBias =
    contextualCandidate.usedContext &&
    (
      baseMessage.length <= 18 ||
      startsWithFollowUpLead(baseMessage) ||
      (
        /(อำนาจหน้าที่|มีหน้าที่|หน้าที่|คุณสมบัติ|ลักษณะต้องห้าม|ขาดจากการเป็น)/.test(baseMessage) &&
        baseTopicHints.length === 0
      )
    );

  const standaloneMatches = await searchDatabaseSources(baseMessage, target, options);
  const standaloneScore = scoreMatchSet(standaloneMatches);

  if (!contextualCandidate.usedContext) {
    return {
      effectiveMessage: baseMessage,
      matches: standaloneMatches,
      resolvedContext: contextualCandidate,
    };
  }

  const remainingBudgetMs = getRemainingBudgetMs(options.requestStartedAt, options.totalBudgetMs);
  if (remainingBudgetMs < MIN_CONTEXT_RESEARCH_BUDGET_MS) {
    return {
      effectiveMessage: baseMessage,
      matches: standaloneMatches,
      resolvedContext: {
        ...contextualCandidate,
        effectiveMessage: baseMessage,
        usedContext: false,
      },
    };
  }

  const contextualMatches = await searchDatabaseSources(contextualCandidate.effectiveMessage, target, options);
  const contextualScore = scoreMatchSet(contextualMatches);
  const standaloneTopScore = Number(standaloneMatches[0]?.score || 0);
  const contextualTopScore = Number(contextualMatches[0]?.score || 0);
  const contextScoreBuffer = shortFollowUpBias
    ? followUpProfile.shortFollowUpContextScoreBuffer
    : followUpProfile.contextScoreBuffer;
  const contextScoreMultiplier = shortFollowUpBias
    ? followUpProfile.shortFollowUpContextScoreMultiplier
    : followUpProfile.contextScoreMultiplier;
  const shouldPreferShortFollowUpContext =
    shortFollowUpBias &&
    contextualMatches.length > 0 &&
    (
      standaloneMatches.length === 0 ||
      contextualTopScore >= Math.max(followUpProfile.minimumContextTopScore, standaloneTopScore * 0.75) ||
      contextualScore >= Math.max(60, standaloneScore - 18)
    );
  const shouldUseContext =
    contextualMatches.length > 0 &&
    (implicitFollowUpQuestion ||
      shouldPreferShortFollowUpContext ||
      (
        followUpProfile.allowStrongerContextCarry &&
        contextualCandidate.usedContext &&
        contextualTopScore >= Math.max(followUpProfile.minimumContextTopScore, standaloneTopScore * 0.7)
      ) ||
      standaloneMatches.length === 0 ||
      contextualScore >= standaloneScore + contextScoreBuffer ||
      contextualScore >= standaloneScore * contextScoreMultiplier);

  if (!shouldUseContext) {
    return {
      effectiveMessage: baseMessage,
      matches: standaloneMatches,
      resolvedContext: {
        ...contextualCandidate,
        effectiveMessage: baseMessage,
        usedContext: false,
      },
    };
  }

  return {
    effectiveMessage: contextualCandidate.effectiveMessage,
    matches: contextualMatches,
    resolvedContext: contextualCandidate,
  };
}

function sortByScore(matches) {
  return (Array.isArray(matches) ? matches : [])
    .filter(Boolean)
    .sort((a, b) => (b.score || 0) - (a.score || 0));
}

function buildSourceFocusSearchText(item = {}) {
  return normalizeForSearch(
    [
      item.reference,
      item.title,
      item.keyword,
      item.content,
      item.chunk_text,
      item.comment,
      item.documentNumber,
      item.documentDateText,
      item.documentSource,
      item.sourceNote,
    ]
      .filter(Boolean)
      .join(" "),
  ).toLowerCase();
}

function isUnionFeeQuestion(message) {
  const normalized = normalizeForSearch(String(message || "")).toLowerCase();
  if (!normalized) {
    return false;
  }

  return /(ค่าบำรุง|บำรุง)/.test(normalized) && /สันนิบาต/.test(normalized);
}

function scoreUnionFeeSourceFocus(item = {}) {
  const sourceName = String(item.source || "").trim().toLowerCase();
  const sourceText = buildSourceFocusSearchText(item);
  if (!sourceText) {
    return Number.NEGATIVE_INFINITY;
  }

  let score = 0;

  if (/ค่าบำรุง\s*สันนิบาต|บำรุง\s*สันนิบาต/.test(sourceText)) {
    score += 60;
  } else if (/สันนิบาต/.test(sourceText) && /(?:ค่าบำรุง|บำรุง|อัตรา|ร้อยละ|เปอร์เซ็นต์|กำไรสุทธิ|กฎกระทรวง)/.test(sourceText)) {
    score += 32;
  } else {
    score -= 80;
  }

  if (/(อัตรา|ร้อยละ|เปอร์เซ็นต์|กำไรสุทธิ|สามหมื่นบาท|กฎกระทรวง|จัดสรร)/.test(sourceText)) {
    score += 24;
  }

  if (/(ชำระ|จ่าย|คำนวณ|เรียกเก็บ)/.test(sourceText)) {
    score += 14;
  }

  if (sourceName === "pdf_chunks" || sourceName === "documents") {
    score += 12;
  }

  if (sourceName === "tbl_laws" || sourceName === "tbl_glaws") {
    score += 6;
  }

  if (sourceName === "knowledge_base") {
    score -= 28;
  }

  if (/(ประชุมใหญ่|คณะกรรมการ|สมาชิก|เลือกตั้ง|รับสมาชิก)/.test(sourceText)) {
    score -= 48;
  }

  score += Number(item.score || 0) * 0.15;
  return score;
}

function scoreDissolutionSourceFocus(item = {}) {
  const sourceName = String(item.source || "").trim().toLowerCase();
  const sourceText = buildSourceFocusSearchText(item);
  if (!sourceText) {
    return Number.NEGATIVE_INFINITY;
  }

  let score = 0;

  if (/(มาตรา 70|มาตรา70)/.test(sourceText)) {
    score += 56;
  }
  if (/(มาตรา 71|มาตรา71)/.test(sourceText)) {
    score += 52;
  }
  if (/(มาตรา 89 3|มาตรา89 3|89 3)/.test(sourceText)) {
    score += 34;
  }

  if (/(เลิกสหกรณ์|สหกรณ์ย่อมเลิก|สั่งเลิกสหกรณ์|การเลิกสหกรณ์)/.test(sourceText)) {
    score += 42;
  }

  if (/(มีเหตุตามที่กำหนดในข้อบังคับ|สมาชิกน้อยกว่าสิบคน|ที่ประชุมใหญ่ลงมติให้เลิก|ล้มละลาย)/.test(sourceText)) {
    score += 24;
  }

  if (/(ไม่เริ่มดำเนินกิจการภายในหนึ่งปี|หยุดดำเนินกิจการติดต่อกันเป็นเวลาสองปี|ไม่ส่งสำเนารายงานประจำปี|งบการเงินประจำปี|สามปีติดต่อกัน|ก่อให้เกิดความเสียหาย|ดำเนินกิจการไม่เป็นผลดี)/.test(sourceText)) {
    score += 28;
  }

  if (sourceName === "admin_knowledge" || sourceName === "knowledge_suggestion") {
    score += 12;
  }

  if (sourceName === "tbl_laws") {
    score += 8;
  }

  if (sourceName === "knowledge_base") {
    score -= 30;
  }

  if (/(องค์ประชุม|การประชุมใหญ่|ผู้ตรวจการสหกรณ์|กำหนดระบบบัญชี|อำนาจหน้าที่)/.test(sourceText) && !/(เลิก|สั่งเลิก)/.test(sourceText)) {
    score -= 44;
  }

  if (sourceName === "tbl_laws" && /นายทะเบียนสหกรณ์มีอำนาจหน้าที่/.test(sourceText) && !/สั่งเลิกสหกรณ์/.test(sourceText)) {
    score -= 36;
  }

  score += Number(item.score || 0) * 0.12;
  return score;
}

function normalizeLawFocusDigits(text) {
  const digitMap = {
    "๐": "0",
    "๑": "1",
    "๒": "2",
    "๓": "3",
    "๔": "4",
    "๕": "5",
    "๖": "6",
    "๗": "7",
    "๘": "8",
    "๙": "9",
  };
  return String(text || "").replace(/[๐-๙]/g, (character) => digitMap[character] || character);
}

function extractPrimaryLawFocusNumber(item = {}) {
  const candidates = [item.reference, item.title, item.keyword];
  for (const candidate of candidates) {
    const raw = normalizeLawFocusDigits(String(candidate || "").trim());
    if (!raw) {
      continue;
    }

    const explicitMatch = raw.match(/(?:มาตรา|ข้อ|วรรค|อนุมาตรา)\s*([0-9]+(?:\/[0-9]+)?)/i);
    if (explicitMatch?.[1]) {
      return explicitMatch[1];
    }

    const bareMatch = raw.match(/^([0-9]+(?:\/[0-9]+)?)$/);
    if (bareMatch?.[1]) {
      return bareMatch[1];
    }
  }

  return "";
}

function rankSourcesForMessageFocus(items, message = "") {
  const ranked = dedupeSourcesConservatively(items);
  if (!isDissolutionPrioritySearch(message)) {
    return ranked;
  }

  const preferredLawNumbers = {
    "70": 140,
    "71": 132,
    "89/3": 116,
  };

  return ranked
    .map((item) => {
      const lawNumber = extractPrimaryLawFocusNumber(item);
      const bonus = preferredLawNumbers[lawNumber] || 0;
      return {
        ...item,
        __messageFocusRank: scoreDissolutionSourceFocus(item) + bonus,
      };
    })
    .sort((left, right) => {
      const focusDiff = Number(right.__messageFocusRank || 0) - Number(left.__messageFocusRank || 0);
      if (focusDiff !== 0) {
        return focusDiff;
      }
      return Number(right.score || 0) - Number(left.score || 0);
    })
    .map((item) => {
      const normalized = { ...item };
      delete normalized.__messageFocusRank;
      return normalized;
    });
}

function pruneFocusedQueryMatches(matches, message) {
  const ranked = sortByScore(matches);
  if (isUnionFeeQuestion(message)) {
    const focusedUnionMatches = ranked
      .map((item) => ({
        ...item,
        __unionFeeScore: scoreUnionFeeSourceFocus(item),
      }))
      .filter((item) => Number(item.__unionFeeScore || 0) >= 20)
      .sort((left, right) => {
        const focusDiff = Number(right.__unionFeeScore || 0) - Number(left.__unionFeeScore || 0);
        if (focusDiff !== 0) {
          return focusDiff;
        }

        return Number(right.score || 0) - Number(left.score || 0);
      });

    if (focusedUnionMatches.length > 0) {
      return focusedUnionMatches.map((item) => {
        const normalized = { ...item };
        delete normalized.__unionFeeScore;
        return normalized;
      });
    }
  }

  if (isDissolutionPrioritySearch(message)) {
    const focusedDissolutionMatches = ranked
      .map((item) => ({
        ...item,
        __dissolutionScore: scoreDissolutionSourceFocus(item),
      }))
      .filter((item) => Number(item.__dissolutionScore || 0) >= 18)
      .sort((left, right) => {
        const focusDiff = Number(right.__dissolutionScore || 0) - Number(left.__dissolutionScore || 0);
        if (focusDiff !== 0) {
          return focusDiff;
        }

        return Number(right.score || 0) - Number(left.score || 0);
      });

    if (focusedDissolutionMatches.length > 0) {
      return focusedDissolutionMatches.map((item) => {
        const normalized = { ...item };
        delete normalized.__dissolutionScore;
        return normalized;
      });
    }
  }

  const focusProfile = getQueryFocusProfile(message);
  if (!focusProfile.topics.length) {
    return ranked;
  }

  const structuredSources = new Set(["tbl_laws", "tbl_glaws"]);
  const secondaryFocusedSources = new Set(["admin_knowledge", "knowledge_suggestion", "tbl_vinichai"]);
  const documentLikeSources = new Set(["documents", "pdf_chunks", "knowledge_base"]);
  const generalMinimumFocusScore = focusProfile.intent === "general" ? 18 : 24;
  const documentMinimumFocusScore = focusProfile.intent === "general" ? 26 : 32;

  const scoredMatches = ranked.map((item) => ({
    ...item,
    __focusScore: scoreQueryFocusAlignment(message, buildSourceFocusSearchText(item)),
  }));

  let filtered = scoredMatches.filter((item) => {
    const sourceName = String(item.source || "").trim().toLowerCase();
    const focusScore = Number(item.__focusScore || 0);

    if (structuredSources.has(sourceName)) {
      return focusScore >= generalMinimumFocusScore;
    }

    if (secondaryFocusedSources.has(sourceName)) {
      return focusScore >= generalMinimumFocusScore;
    }

    if (documentLikeSources.has(sourceName)) {
      return focusScore >= documentMinimumFocusScore;
    }

    return focusScore >= generalMinimumFocusScore;
  });

  if (focusProfile.intent !== "general") {
    const strongStructured = filtered.filter((item) => {
      const sourceName = String(item.source || "").trim().toLowerCase();
      return structuredSources.has(sourceName) && Number(item.__focusScore || 0) >= generalMinimumFocusScore;
    });

    if (strongStructured.length > 0) {
      filtered = filtered.filter((item) => {
        const sourceName = String(item.source || "").trim().toLowerCase();
        if (structuredSources.has(sourceName)) {
          return true;
        }

        if (secondaryFocusedSources.has(sourceName)) {
          const extraThreshold = sourceName === "admin_knowledge" ? 18 : 10;
          return Number(item.__focusScore || 0) >= generalMinimumFocusScore + extraThreshold;
        }

        return false;
      });
    }
  }

  if (filtered.length === 0) {
    return ranked;
  }

  return filtered.map((item) => {
    const normalized = { ...item };
    delete normalized.__focusScore;
    return normalized;
  });
}

function normalizeSourceIdentityText(value) {
  return normalizeForSearch(String(value || ""))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildDedupReferenceKey(item) {
  return normalizeSourceIdentityText(item.reference || item.title || item.keyword || "");
}

function buildDedupContentKey(item) {
  return normalizeSourceIdentityText(item.content || item.chunk_text || item.snippet || "");
}

function areNearDuplicateSources(left, right) {
  const leftSource = normalizeSourceIdentityText(left?.source || "");
  const rightSource = normalizeSourceIdentityText(right?.source || "");
  if (!leftSource || !rightSource || leftSource !== rightSource) {
    return false;
  }

  const leftReference = buildDedupReferenceKey(left);
  const rightReference = buildDedupReferenceKey(right);
  if (!leftReference || !rightReference || leftReference !== rightReference) {
    return false;
  }

  const leftContent = buildDedupContentKey(left);
  const rightContent = buildDedupContentKey(right);
  if (!leftContent || !rightContent) {
    return false;
  }

  if (leftContent === rightContent) {
    return true;
  }

  const shorterLength = Math.min(leftContent.length, rightContent.length);
  if (shorterLength < 80) {
    return false;
  }

  if (leftContent.startsWith(rightContent) || rightContent.startsWith(leftContent)) {
    const longerLength = Math.max(leftContent.length, rightContent.length);
    return shorterLength / longerLength >= 0.92;
  }

  return false;
}

function dedupeSourcesConservatively(matches) {
  const ranked = sortByScore(matches);
  const deduped = [];

  ranked.forEach((item) => {
    if (!item) {
      return;
    }

    const duplicateIndex = deduped.findIndex((existing) => areNearDuplicateSources(existing, item));
    if (duplicateIndex === -1) {
      deduped.push(item);
      return;
    }

    if (Number(item.score || 0) > Number(deduped[duplicateIndex].score || 0)) {
      deduped[duplicateIndex] = item;
    }
  });

  return deduped;
}

function getFinalSourceCompactionPlan(intent = "general") {
  switch (intent) {
    case "law_section":
      return {
        totalLimit: 4,
        quotas: {
          structured_laws: 3,
          admin_knowledge: 1,
          document_like: 1,
          internet: 1,
        },
      };
    case "short_answer":
      return {
        totalLimit: 4,
        quotas: {
          structured_laws: 2,
          admin_knowledge: 1,
          document_like: 1,
          internet: 1,
        },
      };
    case "document":
      return {
        totalLimit: 5,
        quotas: {
          structured_laws: 2,
          admin_knowledge: 1,
          document_like: 2,
          internet: 1,
        },
      };
    case "explain":
      return {
        totalLimit: 6,
        quotas: {
          structured_laws: 3,
          admin_knowledge: 1,
          document_like: 2,
          internet: 1,
        },
      };
    default:
      return {
        totalLimit: 5,
        quotas: {
          structured_laws: 2,
          admin_knowledge: 1,
          document_like: 2,
          internet: 1,
        },
      };
  }
}

function compactSourcesForSummarization(groups, intent = "general", options = {}) {
  const plan = getFinalSourceCompactionPlan(intent);
  const targetLimit = Math.max(plan.totalLimit, Number(options.sourceLimit || 0) || 0);
  const compacted = [];
  const focusMessage = String(options.originalMessage || options.message || "").trim();
  const pushUnique = (items, limit) => {
    rankSourcesForMessageFocus(items, focusMessage)
      .slice(0, limit)
      .forEach((item) => {
        if (compacted.find((existing) => areNearDuplicateSources(existing, item))) {
          return;
        }
        compacted.push(item);
      });
  };

  pushUnique(groups.structured_laws, plan.quotas.structured_laws || 0);
  pushUnique(groups.admin_knowledge, plan.quotas.admin_knowledge || 0);
  pushUnique([...(groups.documents || []), ...(groups.pdf_chunks || [])], plan.quotas.document_like || 0);
  pushUnique(groups.internet, plan.quotas.internet || 0);

  if (compacted.length < targetLimit) {
    const fallbackPool = [
      ...(groups.vinichai || []),
      ...(groups.knowledge_base || []),
      ...(groups.structured_laws || []),
      ...(groups.admin_knowledge || []),
      ...(groups.documents || []),
      ...(groups.pdf_chunks || []),
      ...(groups.internet || []),
    ];

    pushUnique(fallbackPool, targetLimit - compacted.length);
  }

  return rankSourcesForMessageFocus(compacted, focusMessage).slice(0, targetLimit || plan.totalLimit);
}

function getDatabaseOnlySelectionPlan(intent = "general", options = {}) {
  const freePlan = isFreePlanSearch(options.planCode);
  const vinichaiPrioritySearch = isVinichaiPrioritySearch(options.originalMessage || options.message || "");
  switch (intent) {
    case "law_section":
      return {
        totalLimit: 12,
        quotas: {
          admin_knowledge: 2,
          knowledge_suggestion: 1,
          tbl_laws: 4,
          tbl_glaws: 3,
          pdf_chunks: freePlan ? 1 : 3,
          tbl_vinichai: freePlan ? 2 : 1,
          documents: 1,
          knowledge_base: 1,
        },
      };
    case "short_answer":
      return {
        totalLimit: 6,
        quotas: {
          admin_knowledge: freePlan ? 3 : 2,
          knowledge_suggestion: 1,
          tbl_laws: 2,
          tbl_glaws: 1,
          pdf_chunks: 1,
          tbl_vinichai: freePlan ? 2 : 1,
          documents: 1,
          knowledge_base: 1,
        },
      };
    case "document":
      return {
        totalLimit: 8,
        quotas: {
          admin_knowledge: freePlan ? 3 : 2,
          knowledge_suggestion: 1,
          tbl_laws: 2,
          tbl_glaws: 1,
          pdf_chunks: freePlan ? 1 : 2,
          tbl_vinichai: freePlan ? 2 : 1,
          documents: freePlan ? 1 : 2,
          knowledge_base: 1,
        },
      };
    case "qa":
      return {
        totalLimit: 8,
        quotas: {
          admin_knowledge: 2,
          knowledge_suggestion: 1,
          tbl_laws: vinichaiPrioritySearch ? 1 : 2,
          tbl_glaws: vinichaiPrioritySearch ? 0 : 1,
          pdf_chunks: 1,
          tbl_vinichai: vinichaiPrioritySearch ? 4 : freePlan ? 3 : 2,
          documents: 1,
          knowledge_base: 1,
        },
      };
    case "explain":
      return {
        totalLimit: 14,
        quotas: {
          admin_knowledge: 3,
          knowledge_suggestion: freePlan ? 1 : 2,
          tbl_laws: 3,
          tbl_glaws: freePlan ? 2 : 3,
          pdf_chunks: freePlan ? 1 : 4,
          tbl_vinichai: freePlan ? 3 : 1,
          documents: 1,
          knowledge_base: 1,
        },
      };
    default:
      return {
        totalLimit: 12,
        quotas: {
          admin_knowledge: 3,
          knowledge_suggestion: 1,
          tbl_laws: freePlan ? 2 : 3,
          tbl_glaws: 1,
          pdf_chunks: freePlan ? 1 : 3,
          tbl_vinichai: freePlan ? 3 : 1,
          documents: 1,
          knowledge_base: 1,
        },
      };
  }
}

function getDatabaseOnlySourceOrder(intent = "general", options = {}) {
  const { primaryLawSource, secondaryLawSource } = resolvePreferredStructuredLawSources(
    options.originalMessage || options.message || "",
    options.target || "all",
  );
  if (isVinichaiPrioritySearch(options.originalMessage || options.message || "")) {
    return [
      "tbl_vinichai",
      "admin_knowledge",
      "knowledge_suggestion",
      primaryLawSource,
      secondaryLawSource,
      "documents",
      "pdf_chunks",
      "knowledge_base",
    ];
  }

  if (isFreePlanSearch(options.planCode) && isLawPrioritySearch(options.originalMessage || options.message || "")) {
    return [
      primaryLawSource,
      "admin_knowledge",
      "tbl_vinichai",
      "knowledge_suggestion",
      secondaryLawSource,
      "documents",
      "pdf_chunks",
      "knowledge_base",
    ];
  }

  if (isFreePlanSearch(options.planCode) && isLiquidationPrioritySearch(options.originalMessage || options.message || "")) {
    return [
      primaryLawSource,
      "admin_knowledge",
      "tbl_vinichai",
      "knowledge_suggestion",
      "documents",
      secondaryLawSource,
      "pdf_chunks",
      "knowledge_base",
    ];
  }

  if (isFreePlanSearch(options.planCode) && isDissolutionPrioritySearch(options.originalMessage || options.message || "")) {
    return [
      primaryLawSource,
      "admin_knowledge",
      "tbl_vinichai",
      "knowledge_suggestion",
      "documents",
      secondaryLawSource,
      "pdf_chunks",
      "knowledge_base",
    ];
  }

  if (isFreePlanSearch(options.planCode)) {
    return [
      "admin_knowledge",
      "tbl_vinichai",
      "knowledge_suggestion",
      primaryLawSource,
      secondaryLawSource,
      "documents",
      "pdf_chunks",
      "knowledge_base",
    ];
  }

  return [
    "admin_knowledge",
    "tbl_laws",
    "tbl_glaws",
    "pdf_chunks",
    "tbl_vinichai",
    "documents",
    "knowledge_base",
  ];
}

function selectDatabaseOnlySources(groups, intent = "general", options = {}) {
  const plan = getDatabaseOnlySelectionPlan(intent, options);
  const targetLimit = Math.max(plan.totalLimit, Number(options.sourceLimit || 0) || 0);
  const selected = [];
  const usedTiers = [];
  const focusMessage = String(options.originalMessage || options.message || "").trim();

  const pushUnique = (items, limit, tierName) => {
    const ranked = rankSourcesForMessageFocus(items, focusMessage).slice(0, limit);
    if (ranked.length === 0) {
      return;
    }

    usedTiers.push(tierName);
    ranked.forEach((item) => {
      if (selected.find((existing) => areNearDuplicateSources(existing, item))) {
        return;
      }
      selected.push(item);
    });
  };

  const structuredLaws = Array.isArray(groups.structured_laws) ? groups.structured_laws : [];
  const sourceBuckets = {
    admin_knowledge: groups.admin_knowledge || [],
    knowledge_suggestion: groups.knowledge_suggestion || [],
    tbl_laws: structuredLaws.filter((item) => item && item.source === "tbl_laws"),
    tbl_glaws: structuredLaws.filter((item) => item && item.source === "tbl_glaws"),
    pdf_chunks: groups.pdf_chunks || [],
    tbl_vinichai: groups.vinichai || [],
    documents: groups.documents || [],
    knowledge_base: groups.knowledge_base || [],
  };
  const sourceOrder = getDatabaseOnlySourceOrder(intent, options);

  sourceOrder.forEach((sourceName) => {
    pushUnique(
      sourceBuckets[sourceName] || [],
      plan.quotas[sourceName] || 0,
      sourceName,
    );
  });

  if (selected.length < targetLimit) {
    const sourceOrder = getDatabaseOnlySourceOrder(intent, options);
    const fallbackOrder = new Map(sourceOrder.map((sourceName, index) => [sourceName, index]));
    const fallbackPool = rankSourcesForMessageFocus([
      ...(groups.admin_knowledge || []),
      ...(groups.knowledge_suggestion || []),
      ...structuredLaws.filter((item) => item && item.source === "tbl_laws"),
      ...structuredLaws.filter((item) => item && item.source === "tbl_glaws"),
      ...(groups.vinichai || []),
      ...(groups.documents || []),
      ...(groups.pdf_chunks || []),
      ...(groups.knowledge_base || []),
    ], focusMessage).sort((left, right) => {
      const leftOrder = fallbackOrder.get(String(left?.source || "").trim().toLowerCase());
      const rightOrder = fallbackOrder.get(String(right?.source || "").trim().toLowerCase());
      if (leftOrder !== rightOrder) {
        return (leftOrder ?? Number.MAX_SAFE_INTEGER) - (rightOrder ?? Number.MAX_SAFE_INTEGER);
      }

      return Number(right?.score || 0) - Number(left?.score || 0);
    });

    fallbackPool.forEach((item) => {
      if (selected.length >= targetLimit) {
        return;
      }

      if (selected.find((existing) => areNearDuplicateSources(existing, item))) {
        return;
      }

      selected.push(item);
    });
  }

  return {
    selectedSourceTier: usedTiers.join(" > ") || "none",
    selectedSources: selected.slice(0, targetLimit || plan.totalLimit),
  };
}

function selectTieredSources(groups, intent = "general", options = {}) {
  if (options.databaseOnlyMode) {
    return selectDatabaseOnlySources(groups, intent, options);
  }

  const routingPlan = getSourceRoutingPlan(intent);

  // Build plan sorted by priority (highest first)
  const planItems = [
    { key: "structured_laws", limit: routingPlan.limits.structured_laws || 3, priority: routingPlan.priorities.structured_laws || 0 },
    { key: "admin_knowledge", limit: routingPlan.limits.admin_knowledge || 2, priority: routingPlan.priorities.admin_knowledge || 0 },
    { key: "vinichai", limit: routingPlan.limits.vinichai || 2, priority: routingPlan.priorities.vinichai || 0 },
    { key: "documents", limit: routingPlan.limits.documents || 2, priority: routingPlan.priorities.documents || 0 },
    { key: "pdf_chunks", limit: routingPlan.limits.pdf_chunks || 3, priority: routingPlan.priorities.pdf_chunks || 0 },
    { key: "internet", limit: 2, priority: 0 },
    { key: "knowledge_base", limit: routingPlan.limits.knowledge_base || 1, priority: routingPlan.priorities.knowledge_base || 0 },
  ];

  // Sort by priority descending so higher priority sources are selected first
  const plan = planItems.sort((a, b) => b.priority - a.priority);

  const selected = [];
  const usedTiers = [];
  const focusMessage = String(options.originalMessage || options.message || "").trim();

  plan.forEach(({ key, limit }) => {
    const ranked = rankSourcesForMessageFocus(groups[key], focusMessage).slice(0, limit);
    if (ranked.length > 0) {
      usedTiers.push(key);
      selected.push(...ranked);
    }
  });

  const compactedSelected = compactSourcesForSummarization(
    {
      ...groups,
      structured_laws: selected.filter((item) => item && (item.source === "tbl_laws" || item.source === "tbl_glaws")),
      admin_knowledge: selected.filter((item) => item && item.source === "admin_knowledge"),
      vinichai: selected.filter((item) => item && item.source === "tbl_vinichai"),
      documents: selected.filter((item) => item && item.source === "documents"),
      pdf_chunks: selected.filter((item) => item && item.source === "pdf_chunks"),
      knowledge_base: selected.filter((item) => item && item.source === "knowledge_base"),
      internet: selected.filter((item) => item && item.source === "internet_search"),
    },
    intent,
    options,
  );

  return {
    selectedSourceTier: usedTiers.join(" > ") || "none",
    selectedSources: compactedSelected,
  };
}

async function collectAnswerSources(message, target, session, options = {}) {
  const startedAt = nowMs();
  const questionIntent = classifyQuestionIntent(message);
  const effectiveMessage = String(message || "").trim();
  const allowInternetFallback =
    typeof options.allowInternetFallback === "boolean"
      ? options.allowInternetFallback
      : await isAiEnabled();

  const searchPlan =
    options.searchPlan ||
    (await resolveSearchPlan(message, target, session, options));
  const afterDbSearchAt = nowMs();

  const resolvedEffectiveMessage = searchPlan.effectiveMessage || effectiveMessage;
  const carrySources = getFollowUpCarrySources(
    session,
    target,
    message,
    searchPlan.resolvedContext || {},
  );
  const databaseMatches = mergeUniqueSources(
    carrySources,
    Array.isArray(searchPlan.matches) ? searchPlan.matches : [],
  );
  const suppressInternetForFollowUpExplanation =
    carrySources.length > 0 &&
    searchPlan.resolvedContext?.usedContext === true &&
    wantsExplanation(message);
  const shouldSearchInternet =
    allowInternetFallback &&
    !suppressInternetForFollowUpExplanation &&
    shouldSearchInternetForPlan(options.planCode || "free", resolvedEffectiveMessage, databaseMatches, questionIntent);
  let internetMatches = [];
  const remainingBudgetBeforeInternetMs = getRemainingBudgetMs(
    options.requestStartedAt,
    options.totalBudgetMs,
  );
  const shouldSkipInternetForBudget =
    shouldSearchInternet && remainingBudgetBeforeInternetMs < MIN_INTERNET_SEARCH_BUDGET_MS;

  if (shouldSearchInternet && !shouldSkipInternetForBudget) {
    const internetTimeoutMs = Math.min(
      WEB_SEARCH_TIMEOUT_MS,
      Math.max(1000, remainingBudgetBeforeInternetMs - MIN_AI_SUMMARY_BUDGET_MS),
    );
    internetMatches = await searchInternetSources(resolvedEffectiveMessage, target, {
      timeoutMs: internetTimeoutMs,
      limit: options.internetLimit,
    });
  }
  const afterInternetSearchAt = nowMs();

  const grouped = {
    structured_laws: databaseMatches.filter(
      (item) => item && (item.source === "tbl_laws" || item.source === "tbl_glaws"),
    ),
    admin_knowledge: databaseMatches.filter((item) => item && item.source === "admin_knowledge"),
    knowledge_suggestion: databaseMatches.filter((item) => item && item.source === "knowledge_suggestion"),
    vinichai: databaseMatches.filter((item) => item && item.source === "tbl_vinichai"),
    documents: databaseMatches.filter((item) => item && item.source === "documents"),
    pdf_chunks: databaseMatches.filter((item) => item && item.source === "pdf_chunks"),
    knowledge_base: databaseMatches.filter((item) => item && item.source === "knowledge_base"),
    internet: internetMatches,
  };

  const { selectedSourceTier, selectedSources } = selectTieredSources(grouped, questionIntent, {
    databaseOnlyMode: options.databaseOnlyMode === true,
    sourceLimit: options.sourceLimit,
    planCode: options.planCode,
    message,
    originalMessage: message,
  });
  const afterSourceSelectionAt = nowMs();
  const usedInternetFallback = selectedSources.some((item) => item && item.source === "internet_search");

  return {
    ...searchPlan,
    questionIntent,
    effectiveMessage: resolvedEffectiveMessage,
    databaseMatches,
    internetMatches,
    sources: selectedSources,
    selectedSourceTier,
    usedInternetFallback,
    usedInternetSearch: shouldSearchInternet && !shouldSkipInternetForBudget,
    skippedInternetSearch: shouldSkipInternetForBudget,
    allowInternetFallback,
    timing: {
      dbSearchMs: Math.round(afterDbSearchAt - startedAt),
      internetSearchMs: Math.round(afterInternetSearchAt - afterDbSearchAt),
      sourceSelectionMs: Math.round(afterSourceSelectionAt - afterInternetSearchAt),
      totalSourceCollectionMs: Math.round(afterSourceSelectionAt - startedAt),
      remainingBudgetBeforeInternetMs:
        remainingBudgetBeforeInternetMs === Number.POSITIVE_INFINITY ? null : remainingBudgetBeforeInternetMs,
      carrySourceCount: carrySources.length,
    },
  };
}

async function getDashboardData() {
  const [uploadedChunkCount, suggestedQuestions] = await Promise.all([
    LawChatbotPdfChunkModel.countChunks(),
    LawChatbotSuggestedQuestionModel.listActive(18, "all"),
  ]);

  return {
    appName: "Coopbot Law Chatbot",
    description: "ระบบต้นแบบสำหรับค้นหากฎหมายสหกรณ์และกลุ่มเกษตรกร พร้อมเก็บคำถามและข้อเสนอแนะ",
    status: "Knowledge base ready",
    conversationCount: LawChatbotModel.count(),
    uploadedPdfCount: LawChatbotPdfChunkModel.countDocuments(),
    uploadedChunkCount,
    recentConversations: LawChatbotModel.listRecent(6),
    suggestedQuestions,
  };
}

function enrichPaymentRequestRecord(record = {}) {
  const planCode = normalizePlanCode(record.plan_name || record.planName || "free");
  const currentPlanCode = normalizePlanCode(record.user_plan || "free");

  return {
    ...record,
    planCode,
    planLabel: getPlanLabel(planCode),
    userPlanCode: currentPlanCode,
    userPlanLabel: getPlanLabel(currentPlanCode),
    planPriceBaht: Number(record.amount || getPlanPriceBaht(planCode) || 0),
    userPlanExpiresAt: record.plan_expires_at || record.premium_expires_at || null,
  };
}

function listAdminManageablePlans() {
  const purchasable = listPurchasablePlans();
  return [
    {
      value: "free",
      code: "free",
      label: getPlanLabel("free"),
      priceBaht: 0,
      monthlyLimit: resolveUserPlanContext({ plan: "free" }).monthlyLimit,
      description: "ค้นฐานข้อมูลอย่างเดียว ไม่มี AI และไม่มี internet search",
    },
    ...purchasable,
  ];
}

function enrichAdminUserRecord(record = {}) {
  const planCode = normalizePlanCode(record.plan || "free");
  const planLabel = getPlanLabel(planCode);
  const expiresAt = record.plan_expires_at || record.premium_expires_at || null;
  const expiresDate = expiresAt ? new Date(expiresAt) : null;
  const now = new Date();
  const remainingDays =
    expiresDate instanceof Date && !Number.isNaN(expiresDate.getTime())
      ? Math.ceil((expiresDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
      : null;

  return {
    ...record,
    planCode,
    planLabel,
    planPriceBaht: getPlanPriceBaht(planCode),
    searchHistoryRetentionLabel: getSearchHistoryRetentionLabel(planCode),
    monthlyLimit: resolveUserPlanContext({ plan: planCode }).monthlyLimit,
    planExpiresAt: expiresAt,
    remainingDays,
    isExpired:
      remainingDays !== null &&
      Number.isFinite(remainingDays) &&
      remainingDays < 0,
  };
}

function buildSignedInProfile(signedInUser = {}, persistedUser = null) {
  if (!persistedUser) {
    return signedInUser;
  }

  return {
    ...signedInUser,
    id: persistedUser.id,
    userId: persistedUser.id,
    username: persistedUser.email,
    email: persistedUser.email,
    name: persistedUser.name || signedInUser.name || persistedUser.email,
    picture: persistedUser.avatar_url || signedInUser.picture || signedInUser.avatarUrl || "",
    avatarUrl: persistedUser.avatar_url || signedInUser.avatarUrl || signedInUser.picture || "",
    googleId: persistedUser.google_id || signedInUser.googleId || "",
    plan: persistedUser.plan || signedInUser.plan || "free",
    planStartedAt: persistedUser.plan_started_at || signedInUser.planStartedAt || null,
    planExpiresAt: persistedUser.plan_expires_at || signedInUser.planExpiresAt || null,
    status: persistedUser.status || signedInUser.status || "active",
    premiumExpiresAt: persistedUser.premium_expires_at || signedInUser.premiumExpiresAt || null,
  };
}

function buildSearchHistoryMeta(planContext = {}) {
  return {
    enabled: canUseSearchHistory(planContext.code),
    retentionDays: Math.max(0, Number(planContext.searchHistoryRetentionDays || 0)),
    retentionLabel: getSearchHistoryRetentionLabel(planContext.code),
  };
}

function buildSearchHistoryPreview(answer) {
  const text = String(answer || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }

  if (text.length <= 500) {
    return text;
  }

  return `${text.slice(0, 500).trim()}...`;
}

async function recordUserSearchHistory(session, planContext, payload = {}) {
  const sessionUser = session?.user || null;
  const userId = Number(sessionUser?.userId || sessionUser?.id || 0);
  const questionText = String(payload.questionText || "").trim();
  if (!userId || !questionText) {
    return;
  }

  const userPlanCode = normalizePlanCode(sessionUser?.plan || planContext?.code || "free");
  if (!canUseSearchHistory(userPlanCode)) {
    return;
  }

  const userPlanContext = resolveUserPlanContext({ plan: userPlanCode });
  const retentionDays = Math.max(0, Number(userPlanContext.searchHistoryRetentionDays || 0));
  if (retentionDays <= 0) {
    return;
  }

  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + retentionDays * 24 * 60 * 60 * 1000);

  try {
    await UserSearchHistoryModel.create({
      userId,
      planCode: userPlanCode,
      target: payload.target || "all",
      questionText,
      answerPreview: buildSearchHistoryPreview(payload.answerText || ""),
      createdAt,
      expiresAt,
    });
  } catch (error) {
    console.error("[recordUserSearchHistory] Failed to save search history:", error.message || error);
  }
}

async function replyToChat(payload, session) {
  const startedAt = nowMs();
  const message = String(payload.message || "").trim();
  const target =
    payload.target === "group" ? "group" : payload.target === "coop" ? "coop" : "all";
  const debugMode =
    payload && (payload.debug === true || payload.debug === "true" || process.env.CHATBOT_DEBUG === "1");

  if (!message) {
    return {
      hasContext: false,
      answer: "กรุณาระบุคำถามหรือประเด็นที่ต้องการสอบถามก่อนส่งข้อความ",
      highlightTerms: [],
    };
  }

  const aiRuntimeEnabled = await isAiEnabled();
  const openAiConfig = getOpenAiConfig();
  const aiFeatureAvailable = aiRuntimeEnabled && Boolean(openAiConfig);
  const basePlanContext = resolveChatPlanContext(session, {
    aiAvailable: aiFeatureAvailable,
  });

  const managedSuggestedQuestionMatch = await findManagedSuggestedQuestionMatch(message, target);
  if (managedSuggestedQuestionMatch) {
    const highlightTerms = message.split(/\s+/).filter(Boolean).slice(0, 8);
    const matchedSource = managedSuggestedQuestionMatch.source;
    const answer = managedSuggestedQuestionMatch.answerText;

    storeConversationContext(
      session,
      target,
      message,
      message,
      [matchedSource],
      {
        usedContext: false,
        topicHints: [normalizeForSearch(managedSuggestedQuestionMatch.questionText || message).toLowerCase()],
      },
    );

    LawChatbotModel.create({
      message,
      effectiveMessage: message,
      target,
      answer,
      matchedSources: [
        {
          id: matchedSource.id || managedSuggestedQuestionMatch.id || managedSuggestedQuestionMatch.questionText,
          title: managedSuggestedQuestionMatch.questionText,
          lawNumber: "",
          source: matchedSource.source,
          url: "",
          score: Number(matchedSource.score || 0),
        },
      ],
    });

    const result = {
      hasContext: true,
      answer,
      highlightTerms,
      usedFollowUpContext: false,
      usedInternetFallback: false,
      fromCache: false,
    };

    if (debugMode) {
      result.debug = {
        selectedSourceTier: "managed_suggested_question",
        sourceCount: 1,
        databaseMatches: 0,
        internetMatches: 0,
        answerMode: "managed_answer",
        promptProfile: "managed",
        timing: {
          totalReplyMs: Math.round(nowMs() - startedAt),
        },
        sources: [
          {
            source: matchedSource.source,
            reference: matchedSource.reference,
            score: Number(matchedSource.score || 0),
            preview: String(answer || "").replace(/\s+/g, " ").slice(0, 180),
          },
        ],
      };
    }

    await recordUserSearchHistory(session, basePlanContext, {
      questionText: message,
      target,
      answerText: answer,
    });

    return result;
  }

  if (runtimeFlags.useMockAI) {
    const highlightTerms = message.split(/\s+/).filter(Boolean).slice(0, 8);
    const answer = `Mock AI\n\nคำถาม: "${message}"\n\nสรุปจำลอง: ระบบกำลังอยู่ในโหมดทดสอบและยังไม่ได้เรียก AI จริง`;

    await recordUserSearchHistory(session, basePlanContext, {
      questionText: message,
      target,
      answerText: answer,
    });

    return {
      hasContext: true,
      answer,
      highlightTerms,
      usedFollowUpContext: false,
      usedInternetFallback: false,
      fromCache: false,
    };
  }

  const searchPlan = await resolveSearchPlan(message, target, session, {
    requestStartedAt: startedAt,
    totalBudgetMs: CHAT_REPLY_BUDGET_MS,
    planCode: basePlanContext.code,
  });
  const planContext = applyEconomyDatabaseOnlyMode(
    basePlanContext,
    searchPlan.effectiveMessage || message,
    searchPlan.matches,
    classifyQuestionIntent(message),
  );
  const cacheScope = buildAnswerCacheScope(planContext);
  const { normalizedQuestion, questionHash } = buildQuestionCacheIdentity(message, target, cacheScope);
  const cacheKey = buildAnswerCacheKey(message, target, planContext);
  const canUseCache = shouldUseAnswerCache(message) && !debugMode;
  const cachedAnswer = canUseCache ? getCachedAnswer(cacheKey) : null;
  if (cachedAnswer) {
    storeConversationContext(
      session,
      target,
      message,
      cachedAnswer.effectiveMessage || message,
      cachedAnswer.sources || [],
      cachedAnswer.resolvedContext || { usedContext: false, topicHints: [] },
    );

    LawChatbotModel.create({
      message,
      effectiveMessage: cachedAnswer.effectiveMessage || message,
      target,
      answer: cachedAnswer.answer,
      matchedSources: (cachedAnswer.sources || []).map((item) => ({
        id: item.id || item.url || item.reference || item.title,
        title: item.title || item.keyword || item.reference,
        lawNumber: item.lawNumber || item.reference || item.keyword,
        source: item.source || "",
        url: item.url || "",
        score: Number(item.score || 0),
      })),
    });

    const cachedResult = {
      hasContext: cachedAnswer.hasContext,
      answer: cachedAnswer.answer,
      highlightTerms: cachedAnswer.highlightTerms,
      usedFollowUpContext: false,
      usedInternetFallback: cachedAnswer.usedInternetFallback,
      fromCache: true,
    };

    if (debugMode) {
      cachedResult.debug = {
        selectedSourceTier: cachedAnswer.selectedSourceTier || "cache",
        sourceCount: Array.isArray(cachedAnswer.sources) ? cachedAnswer.sources.length : 0,
        answerMode: cachedAnswer.answerMode || "cache",
        timing: {
          cacheHit: true,
          totalReplyMs: Math.round(nowMs() - startedAt),
        },
        sources: (cachedAnswer.sources || []).map((item) => ({
          source: item.source || "",
          reference: item.reference || item.title || "",
          score: Number(item.score || 0),
          preview: String(item.content || item.chunk_text || "").replace(/\s+/g, " ").slice(0, 180),
        })),
      };
    }

    await recordUserSearchHistory(session, planContext, {
      questionText: message,
      target,
      answerText: cachedResult.answer,
    });

    return cachedResult;
  }

  if (canUseCache && questionHash) {
    try {
      const dbCachedAnswer = await LawChatbotAnswerCacheModel.findByQuestionHash(questionHash);
      if (dbCachedAnswer?.answer_text) {
        await LawChatbotAnswerCacheModel.incrementHitCount(dbCachedAnswer.id);

        const cachedResult = buildDbCachedChatResult(dbCachedAnswer, message);
        if (debugMode) {
          cachedResult.debug = {
            selectedSourceTier: dbCachedAnswer?.metadata?.selectedSourceTier || "db_cache",
            sourceCount: Number(dbCachedAnswer?.metadata?.sourceCount || 0),
            answerMode: dbCachedAnswer?.metadata?.answerMode || "db_cache",
            timing: {
              cacheHit: true,
              totalReplyMs: Math.round(nowMs() - startedAt),
            },
            sources: [],
          };
        }

        storeConversationContext(
          session,
          target,
          message,
          dbCachedAnswer.normalized_question || message,
          [],
          { usedContext: false, topicHints: [] },
        );

        LawChatbotModel.create({
          message,
          effectiveMessage: dbCachedAnswer.normalized_question || message,
          target,
          answer: cachedResult.answer,
          matchedSources: [],
        });

        setCachedAnswer(cacheKey, {
          hasContext: cachedResult.hasContext,
          answer: cachedResult.answer,
          highlightTerms: cachedResult.highlightTerms,
          usedInternetFallback: cachedResult.usedInternetFallback,
          selectedSourceTier: dbCachedAnswer?.metadata?.selectedSourceTier || "db_cache",
          answerMode: dbCachedAnswer?.metadata?.answerMode || "db_cache",
          effectiveMessage: dbCachedAnswer.normalized_question || message,
          resolvedContext: { usedContext: false, topicHints: [] },
          sources: [],
        });

        await recordUserSearchHistory(session, planContext, {
          questionText: message,
          target,
          answerText: cachedResult.answer,
        });

        return cachedResult;
      }
    } catch (error) {
      console.error("[replyToChat] Answer cache lookup failed:", error.message || error);
    }
  }

  const evidence = await collectAnswerSources(message, target, session, {
    searchPlan,
    requestStartedAt: startedAt,
    totalBudgetMs: CHAT_REPLY_BUDGET_MS,
    allowInternetFallback: planContext.useInternet,
    databaseOnlyMode: !planContext.useAI,
    sourceLimit: planContext.sourceLimit,
    internetLimit: planContext.maxInternetSources,
    planCode: planContext.code,
  });
  const afterCollectSourcesAt = nowMs();
  const resolvedContext = evidence.resolvedContext;
  const effectiveMessage = evidence.effectiveMessage || message;
  const sources = evidence.sources;
  const highlightTerms = effectiveMessage.split(/\s+/).filter(Boolean).slice(0, 8);

  let answer = "";

  if (sources.length === 0) {
    answer =
      evidence.usedInternetSearch
        ? "ไม่ปรากฏข้อมูลที่ตรงกับประเด็นคำถามอย่างชัดเจนทั้งในฐานข้อมูลและแหล่งข้อมูลสาธารณะ\n\nกรุณาระบุคำสำคัญเพิ่มเติม เช่น การประชุมใหญ่ สมาชิก คณะกรรมการ หรือการจัดตั้งกลุ่มเกษตรกร"
        : "ไม่ปรากฏข้อมูลที่ตรงกับประเด็นคำถามอย่างชัดเจนในฐานข้อมูลและเอกสารภายในระบบ\n\nกรุณาระบุคำสำคัญเพิ่มเติม เช่น การประชุมใหญ่ สมาชิก คณะกรรมการ หรือการจัดตั้งกลุ่มเกษตรกร";
  } else {
    const remainingBudgetBeforeAnswerMs = getRemainingBudgetMs(startedAt, CHAT_REPLY_BUDGET_MS);
    const answerSources = sources;
    answer = await generateChatSummary(message, answerSources, {
      conversationalFollowUp: resolvedContext.usedContext,
      focusMessage: effectiveMessage,
      topicLabel: resolvedContext.topicHints && resolvedContext.topicHints[0] ? resolvedContext.topicHints[0] : "",
      forceFallback: !planContext.useAI || remainingBudgetBeforeAnswerMs < MIN_AI_SUMMARY_BUDGET_MS,
      aiTimeoutMs: Math.max(
        1000,
        Math.min(
          Number(planContext.promptProfile?.aiTimeoutMs || remainingBudgetBeforeAnswerMs - 500),
          remainingBudgetBeforeAnswerMs - 500,
        ),
      ),
      questionIntent: evidence.questionIntent,
      databaseOnlyMode: !planContext.useAI,
      promptProfile: planContext.promptProfile,
      planCode: planContext.code,
      target,
    });
  }
  const afterAnswerGenerationAt = nowMs();

  storeConversationContext(session, target, message, effectiveMessage, sources, resolvedContext);

  LawChatbotModel.create({
    message,
    effectiveMessage,
    target,
    answer,
    matchedSources: sources.map((item) => ({
      id: item.id || item.url || item.reference || item.title,
      title: item.title || item.keyword || item.reference,
      lawNumber: item.lawNumber || item.reference || item.keyword,
      source: item.source || "",
      url: item.url || "",
      score: Number(item.score || 0),
    })),
  });

  const result = {
    hasContext: sources.length > 0,
    answer,
    highlightTerms,
    usedFollowUpContext: resolvedContext.usedContext,
    usedInternetFallback: evidence.usedInternetFallback,
    fromCache: false,
  };

  if (canUseCache && !resolvedContext.usedContext) {
    setCachedAnswer(cacheKey, {
      hasContext: sources.length > 0,
      answer,
      highlightTerms,
      usedInternetFallback: evidence.usedInternetFallback,
      selectedSourceTier: evidence.selectedSourceTier || "none",
      planCode: planContext.code,
      promptProfile: planContext.promptProfile?.code || "template",
      answerMode: planContext.answerMode || (planContext.useAI ? "ai" : "db_only"),
      effectiveMessage,
      resolvedContext,
      sources,
    });
  }

  if (canUseCache && !resolvedContext.usedContext && questionHash && shouldPersistDbAnswerCache(answer, { debugMode })) {
    try {
      await LawChatbotAnswerCacheModel.upsert({
        questionHash,
        normalizedQuestion: normalizedQuestion || effectiveMessage || message,
        originalQuestion: message,
        target,
        answerText: answer,
        metadata: {
          hasContext: sources.length > 0,
          highlightTerms,
          usedInternetFallback: evidence.usedInternetFallback,
          selectedSourceTier: evidence.selectedSourceTier || "none",
          effectiveMessage,
          sourceCount: sources.length,
          planCode: planContext.code,
          promptProfile: planContext.promptProfile?.code || "template",
          answerMode: planContext.answerMode || (planContext.useAI ? "ai" : "db_only"),
        },
      });
    } catch (error) {
      console.error("[replyToChat] Answer cache write failed:", error.message || error);
    }
  }

  if (debugMode) {
    result.debug = {
      selectedSourceTier: evidence.selectedSourceTier || "none",
      sourceCount: sources.length,
      databaseMatches: evidence.databaseMatches?.length || 0,
      internetMatches: evidence.internetMatches?.length || 0,
      answerMode: planContext.answerMode || (planContext.useAI ? "ai" : "db_only"),
      promptProfile: planContext.promptProfile?.code || "template",
      timing: {
        ...(evidence.timing || {}),
        answerGenerationMs: Math.round(afterAnswerGenerationAt - afterCollectSourcesAt),
        totalReplyMs: Math.round(afterAnswerGenerationAt - startedAt),
      },
      sources: sources.map((item) => ({
        source: item.source || "",
        reference: item.reference || item.title || "",
        score: Number(item.score || 0),
        preview: String(item.content || item.chunk_text || "").replace(/\s+/g, " ").slice(0, 180),
      })),
    };
  }

  await recordUserSearchHistory(session, planContext, {
    questionText: message,
    target,
    answerText: answer,
  });

  return result;
}

async function summarizeChat(payload, session) {
  const message = String(payload.message || "").trim();
  if (!message) {
    return { summary: "" };
  }
  const aiRuntimeEnabled = await isAiEnabled();
  const openAiConfig = getOpenAiConfig();
  const basePlanContext = resolveChatPlanContext(session, {
    aiAvailable: aiRuntimeEnabled && Boolean(openAiConfig),
  });

  const target =
    payload.target === "group" ? "group" : payload.target === "coop" ? "coop" : "all";
  const searchPlan = await resolveSearchPlan(message, target, session, {
    planCode: basePlanContext.code,
  });
  const planContext = applyEconomyDatabaseOnlyMode(
    basePlanContext,
    searchPlan.effectiveMessage || message,
    searchPlan.matches,
    classifyQuestionIntent(message),
  );
  const evidence = await collectAnswerSources(message, target, session, {
    searchPlan,
    allowInternetFallback: planContext.useInternet,
    databaseOnlyMode: !planContext.useAI,
    sourceLimit: planContext.sourceLimit,
    internetLimit: planContext.maxInternetSources,
    planCode: planContext.code,
  });
  const resolvedContext = evidence.resolvedContext;
  const sources = evidence.sources;

  return {
    summary: await generateChatSummary(message, sources, {
      conversationalFollowUp: resolvedContext.usedContext,
      topicLabel: resolvedContext.topicHints && resolvedContext.topicHints[0] ? resolvedContext.topicHints[0] : "",
      questionIntent: evidence.questionIntent,
      databaseOnlyMode: !planContext.useAI,
      promptProfile: planContext.promptProfile,
      planCode: planContext.code,
      target,
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
    target: payload.target || "all",
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

    const extractionResult = await extractTextResultFromFile(file);
    const extractedText = extractionResult.text;
    const chunks = chunkText(extractedText, Number(process.env.CHUNK_SIZE || 1400));
    const documentMetadata = await extractDocumentMetadata(extractedText, file);
    const extractionMethodLabel = getExtractionMethodLabel(extractionResult.extractionMethod);
    const extractionNoteLabel = (extractionResult.notes || [])
      .map((note) => getExtractionNoteLabel(note))
      .find(Boolean);
    const indexingDecision = decideDocumentIndexing(extractionResult, file, chunks.length);
    const extractionSummary = [
      extractionMethodLabel ? `วิธีอ่าน: ${extractionMethodLabel}` : "",
      Number.isFinite(Number(extractionResult.qualityScore))
        ? `คุณภาพข้อความ: ${Math.max(0, Math.min(100, Number(extractionResult.qualityScore)))}/100`
        : "",
      extractionNoteLabel,
      indexingDecision.reason || "",
    ]
      .filter(Boolean)
      .join(" | ");

    LawChatbotPdfChunkModel.updateUpload(uploadRecord.id, {
      processingMessage: `กำลังสร้างดัชนีเอกสาร ${chunks.length} ส่วน${extractionSummary ? ` | ${extractionSummary}` : ""}`,
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
      extractionMethod: extractionResult.extractionMethod || "",
      extractionQualityScore: extractionResult.qualityScore,
      extractionNotes: (extractionResult.notes || []).filter(Boolean).join(" | "),
      isSearchable: indexingDecision.isSearchable,
      qualityStatus: indexingDecision.qualityStatus,
    });

    if (!indexingDecision.isSearchable) {
      LawChatbotPdfChunkModel.updateUpload(uploadRecord.id, {
        status: "quarantined",
        processingMessage: `นำเข้าแบบกักกันแล้ว ยังไม่ถูกใช้ค้นหา${extractionSummary ? ` | ${extractionSummary}` : ""}`,
        insertedChunkCount: 0,
        title: documentRecord.title || file.originalname,
        documentNumber: documentRecord.documentNumber || "",
        documentDateText: documentRecord.documentDateText || "",
        documentSource: documentRecord.documentSource || "",
      });
      return;
    }

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
      processingMessage: `นำเข้าข้อมูลเรียบร้อยแล้ว${extractionSummary ? ` | ${extractionSummary}` : ""}`,
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

  clearAnswerCache();

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

async function getUserDashboardData(user) {
  const signedInUser = user || {};
  const userId = Number(signedInUser.userId || signedInUser.id || 0);
  if (!userId) {
    throw new Error("Please sign in before opening the user dashboard.");
  }

  const usageMonth = UserMonthlyUsageModel.getYearMonth();
  const [persistedUser, usage, recentRequests] = await Promise.all([
    UserModel.findById(userId),
    UserMonthlyUsageModel.findByUserAndMonth(userId, usageMonth),
    PaymentRequestModel.listByUserId(userId, 10),
  ]);

  const profile = buildSignedInProfile(signedInUser, persistedUser);
  const planContext = resolveUserPlanContext(profile);
  const questionCount = Number(usage?.question_count || 0);
  const questionLimit = Number.isFinite(planContext.monthlyLimit) ? planContext.monthlyLimit : null;
  const remainingQuestions =
    Number.isFinite(questionLimit) ? Math.max(0, questionLimit - questionCount) : null;

  return {
    appName: "Coopbot Law Chatbot",
    user: profile,
    planContext,
    usage: {
      usageMonth,
      questionCount,
      questionLimit,
      remainingQuestions,
      isUnlimited: planContext.isUnlimited,
    },
    searchHistory: buildSearchHistoryMeta(planContext),
    recentRequests: recentRequests.map((item) => enrichPaymentRequestRecord(item)),
  };
}

async function getUserSearchHistoryData(user) {
  const signedInUser = user || {};
  const userId = Number(signedInUser.userId || signedInUser.id || 0);
  if (!userId) {
    throw new Error("Please sign in before opening search history.");
  }

  const persistedUser = await UserModel.findById(userId);
  const profile = buildSignedInProfile(signedInUser, persistedUser);
  const planContext = resolveUserPlanContext(profile);
  const searchHistory = buildSearchHistoryMeta(planContext);
  await UserSearchHistoryModel.deleteExpired();
  const entries = await UserSearchHistoryModel.listActiveByUserId(userId, 100);

  return {
    appName: "Coopbot Law Chatbot",
    user: profile,
    planContext,
    searchHistory,
    entries,
  };
}

async function getPaymentRequestPageData(user) {
  const signedInUser = user || {};
  const userId = Number(signedInUser.userId || signedInUser.id || 0);
  const currentPlanContext = resolveUserPlanContext(signedInUser);

  return {
    appName: "Coopbot Law Chatbot",
    plans: listPurchasablePlans(),
    planComparison: listPlanComparisons(),
    currentPlanContext,
    user: signedInUser,
    recentRequests: userId
      ? (await PaymentRequestModel.listByUserId(userId, 10)).map((item) => enrichPaymentRequestRecord(item))
      : [],
  };
}

async function submitPaymentRequest(payload, file, user) {
  const signedInUser = user || {};
  const userId = Number(signedInUser.userId || signedInUser.id || 0);
  const planCode = normalizePlanCode(payload.planName || "");
  const note = String(payload.note || "").trim();

  if (!userId) {
    throw new Error("Please sign in before submitting a payment request.");
  }

  if (!isPaidPlan(planCode)) {
    throw new Error("Please select a valid paid plan.");
  }

  const amount = getPlanPriceBaht(planCode);

  const paymentRequest = await PaymentRequestModel.create({
    userId,
    planName: planCode,
    amount,
    slipImage: file ? `/uploads/paymentRequests/${file.filename}` : "",
    note,
    status: "pending",
  });

  try {
    await sendPaymentRequestNotification(paymentRequest, signedInUser);
  } catch (error) {
    console.error("[submitPaymentRequest] Telegram notification failed:", error.message || error);
  }

  return paymentRequest;
}

async function getAdminUsersData(query = "") {
  const trimmedQuery = String(query || "").trim();
  const [stats, users] = await Promise.all([
    UserModel.getAdminStats(),
    UserModel.listForAdmin({ query: trimmedQuery, limit: 100 }),
  ]);

  return {
    query: trimmedQuery,
    totalCount: Number(stats.total_count || 0),
    freeCount: Number(stats.free_count || 0),
    paidCount: Number(stats.paid_count || 0),
    activeCount: Number(stats.active_count || 0),
    defaultPlanDurationDays: getPlanDurationDays(),
    plans: listAdminManageablePlans(),
    users: users.map((item) => enrichAdminUserRecord(item)),
  };
}

async function adminUpdateUserPlan(userId, planCode, options = {}) {
  const normalizedUserId = Number(userId || 0);
  const normalizedPlanCode = normalizePlanCode(planCode || "free");
  const allowedPlans = new Set(listAdminManageablePlans().map((plan) => plan.code));
  const durationDays = Math.max(
    1,
    Number(options.durationDays || getPlanDurationDays()),
  );

  if (!normalizedUserId) {
    return { ok: false, reason: "invalid_user" };
  }

  if (!allowedPlans.has(normalizedPlanCode)) {
    return { ok: false, reason: "invalid_plan" };
  }

  const currentUser = await UserModel.findById(normalizedUserId);
  if (!currentUser) {
    return { ok: false, reason: "not_found" };
  }

  const updated = await UserModel.setPlanByAdmin(normalizedUserId, normalizedPlanCode, {
    durationDays,
  });

  if (!updated) {
    return { ok: false, reason: "not_updated" };
  }

  const refreshedUser = await UserModel.findById(normalizedUserId);
  const enrichedUser = enrichAdminUserRecord(refreshedUser || currentUser);

  return {
    ok: true,
    user: enrichedUser,
    planCode: normalizedPlanCode,
    planLabel: getPlanLabel(normalizedPlanCode),
    durationDays,
  };
}

async function getAdminPaymentRequestsData() {
  const requests = (await PaymentRequestModel.listAll(100)).map((item) => enrichPaymentRequestRecord(item));

  return {
    plans: listPurchasablePlans(),
    totalCount: requests.length,
    pendingCount: requests.filter((item) => item.status === "pending").length,
    approvedCount: requests.filter((item) => item.status === "approved").length,
    rejectedCount: requests.filter((item) => item.status === "rejected").length,
    requests,
  };
}

async function getAdminPaymentRequestDetail(id) {
  const request = await PaymentRequestModel.findById(id);
  if (!request) {
    return null;
  }

  return {
    request: enrichPaymentRequestRecord(request),
    plans: listPurchasablePlans(),
  };
}

async function updatePaymentRequestPlan(id, nextPlanCode) {
  const request = await PaymentRequestModel.findById(id);
  if (!request || request.status !== "pending") {
    return { ok: false, reason: "not_found" };
  }

  const currentPlanCode = normalizePlanCode(request.plan_name || "free");
  const planCode = normalizePlanCode(nextPlanCode || currentPlanCode);
  if (!isPaidPlan(planCode)) {
    return { ok: false, reason: "invalid_plan" };
  }

  const amount = getPlanPriceBaht(planCode);
  if (currentPlanCode === planCode && Number(request.amount || 0) === amount) {
    return {
      ok: true,
      requestId: Number(request.id || id || 0),
      planCode,
      planLabel: getPlanLabel(planCode),
      amount,
      unchanged: true,
    };
  }

  const updated = await PaymentRequestModel.updateRequestedPlan(id, planCode, amount);
  if (!updated) {
    return { ok: false, reason: "not_updated" };
  }

  return {
    ok: true,
    requestId: Number(request.id || id || 0),
    planCode,
    planLabel: getPlanLabel(planCode),
    amount,
    previousPlanCode: currentPlanCode,
    previousPlanLabel: getPlanLabel(currentPlanCode),
  };
}

async function approvePaymentRequest(id, reviewMeta = {}) {
  const request = await PaymentRequestModel.findById(id);
  if (!request || request.status !== "pending") {
    return { ok: false, reason: "not_found" };
  }

  const planCode = normalizePlanCode(request.plan_name || "free");
  if (!isPaidPlan(planCode)) {
    return { ok: false, reason: "invalid_plan" };
  }

  const activated = await UserModel.activatePlan(request.user_id, planCode, {
    durationDays: getPlanDurationDays(),
  });
  if (!activated) {
    return { ok: false, reason: "user_not_updated" };
  }

  const reviewed = await PaymentRequestModel.updateReviewStatus(
    id,
    "approved",
    reviewMeta.reviewedBy || "",
  );

  if (!reviewed) {
    return { ok: false, reason: "review_not_updated" };
  }

  return {
    ok: true,
    requestId: id,
    planCode,
    planLabel: getPlanLabel(planCode),
  };
}

async function rejectPaymentRequest(id, reviewMeta = {}) {
  const request = await PaymentRequestModel.findById(id);
  if (!request || request.status !== "pending") {
    return { ok: false, reason: "not_found" };
  }
  const planCode = normalizePlanCode(request.plan_name || "free");

  const reviewed = await PaymentRequestModel.updateReviewStatus(
    id,
    "rejected",
    reviewMeta.reviewedBy || "",
  );

  if (!reviewed) {
    return { ok: false, reason: "review_not_updated" };
  }

  return {
    ok: true,
    requestId: id,
    planCode,
    planLabel: getPlanLabel(planCode),
  };
}

async function getKnowledgeAdminData() {
  const [
    knowledgeCount,
    recentKnowledge,
    pendingSuggestionCount,
    pendingSuggestions,
    suggestedQuestionCount,
    activeSuggestedQuestionCount,
    suggestedQuestions,
  ] = await Promise.all([
    LawChatbotKnowledgeModel.count(),
    LawChatbotKnowledgeModel.listRecent(10),
    LawChatbotKnowledgeSuggestionModel.countPending(),
    LawChatbotKnowledgeSuggestionModel.listPending(12),
    LawChatbotSuggestedQuestionModel.countAll(),
    LawChatbotSuggestedQuestionModel.countActive(),
    LawChatbotSuggestedQuestionModel.listRecent(20),
  ]);

  return {
    appName: "Coopbot Law Chatbot",
    knowledgeCount,
    recentKnowledge,
    pendingSuggestionCount,
    pendingSuggestions,
    suggestedQuestionCount,
    activeSuggestedQuestionCount,
    suggestedQuestions,
    targets: [
      { value: "coop", label: "สหกรณ์" },
      { value: "group", label: "กลุ่มเกษตรกร" },
    ],
    suggestedQuestionTargets: [
      { value: "all", label: "ทุกประเภท" },
      { value: "coop", label: "สหกรณ์" },
      { value: "group", label: "กลุ่มเกษตรกร" },
    ],
  };
}

async function saveSuggestedQuestionEntry(payload = {}) {
  const entry = await LawChatbotSuggestedQuestionModel.create({
    target: payload.target,
    questionText: payload.questionText || payload.question,
    answerText: payload.answerText || payload.answer,
    displayOrder: payload.displayOrder,
    isActive: payload.isActive,
  });

  if (!entry) {
    return { ok: false, reason: "invalid_payload" };
  }

  clearAnswerCache();

  return {
    ok: true,
    entry,
  };
}

async function updateSuggestedQuestionEntry(id, payload = {}) {
  const existing = await LawChatbotSuggestedQuestionModel.findById(id);
  if (!existing) {
    return { ok: false, reason: "not_found" };
  }

  const updated = await LawChatbotSuggestedQuestionModel.updateById(id, {
    target: payload.target,
    questionText: payload.questionText || payload.question,
    answerText: payload.answerText || payload.answer,
    displayOrder: payload.displayOrder,
    isActive: payload.isActive,
  });

  if (!updated) {
    return { ok: false, reason: "not_updated" };
  }

  clearAnswerCache();
  const refreshed = await LawChatbotSuggestedQuestionModel.findById(id);

  return {
    ok: true,
    entry: refreshed,
  };
}

async function deleteSuggestedQuestionEntry(id) {
  const removed = await LawChatbotSuggestedQuestionModel.removeById(id);
  if (removed) {
    clearAnswerCache();
  }
  return removed;
}

async function submitKnowledgeSuggestion(payload, meta = {}) {
  const title = String(payload.title || payload.question || "").trim();
  const content = String(payload.content || "").trim();
  const target = payload.target === "group" ? "group" : "coop";
  const sourceType = payload.sourceType === "voice" ? "voice" : "text";

  if (!title || !content) {
    throw new Error("กรุณาระบุคำถามและคำตอบที่ต้องการเสนอ");
  }

  if (content.length < 10) {
    throw new Error("กรุณาอธิบายคำตอบที่ต้องการเสนอให้ชัดเจนมากขึ้น");
  }

  const sessionKey = String(meta.sessionId || meta.ip || "anonymous").trim() || "anonymous";
  const normalizedFingerprint = normalizeForSearch(`${target} ${title} ${content}`).toLowerCase();
  const throttleKey = `${sessionKey}::${normalizedFingerprint}`;
  const now = Date.now();
  const previous = suggestionThrottleMap.get(throttleKey);

  if (previous && now - previous.createdAt < 3 * 60 * 1000) {
    throw new Error("มีการส่งข้อเสนอแนะเดิมเข้ามาแล้ว กรุณารอสักครู่ก่อนส่งซ้ำ");
  }

  cleanupSuggestionThrottle();
  suggestionThrottleMap.set(throttleKey, { createdAt: now });

  return LawChatbotKnowledgeSuggestionModel.create({
    target,
    title,
    content,
    sourceType,
    submittedBy: meta.submittedBy || "",
    submitterSession: meta.sessionId || "",
    submitterIp: meta.ip || "",
    status: "pending",
  });
}

async function approveKnowledgeSuggestion(id, reviewMeta = {}) {
  const suggestion = await LawChatbotKnowledgeSuggestionModel.findById(id);
  if (!suggestion || suggestion.status !== "pending") {
    return { ok: false, reason: "not_found" };
  }

  const sourceNoteParts = [
    suggestion.sourceType === "voice" ? "ข้อเสนอจากผู้ใช้งาน (เสียง)" : "ข้อเสนอจากผู้ใช้งาน",
    suggestion.submittedBy ? `โดย ${suggestion.submittedBy}` : "",
  ].filter(Boolean);

  const entry = await saveKnowledgeEntry({
    target: suggestion.target,
    title: suggestion.title,
    content: suggestion.content,
    sourceNote: sourceNoteParts.join(" | "),
  });

  const updated = await LawChatbotKnowledgeSuggestionModel.updateStatus(id, "approved", {
    reviewedBy: reviewMeta.reviewedBy || "",
    reviewNote: reviewMeta.reviewNote || "",
  });

  return {
    ok: updated,
    entry,
    suggestion,
  };
}

async function updateKnowledgeSuggestion(id, patch = {}) {
  const suggestion = await LawChatbotKnowledgeSuggestionModel.findById(id);
  if (!suggestion || suggestion.status !== "pending") {
    return { ok: false, reason: "not_found" };
  }

  const updated = await LawChatbotKnowledgeSuggestionModel.updatePendingSuggestion(id, {
    target: patch.target,
    title: patch.title,
    content: patch.content,
    reviewNote: patch.reviewNote || "",
  });

  if (!updated) {
    return { ok: false, reason: "not_updated" };
  }

  const refreshed = await LawChatbotKnowledgeSuggestionModel.findById(id);

  return {
    ok: true,
    suggestion: refreshed,
  };
}

async function rejectKnowledgeSuggestion(id, reviewMeta = {}) {
  return LawChatbotKnowledgeSuggestionModel.updateStatus(id, "rejected", {
    reviewedBy: reviewMeta.reviewedBy || "",
    reviewNote: reviewMeta.reviewNote || "",
  });
}

async function saveKnowledgeEntry(payload) {
  const target = payload.target === "group" ? "group" : "coop";

  clearAnswerCache();

  return LawChatbotKnowledgeModel.create({
    target,
    title: payload.title || "",
    lawNumber: payload.lawNumber || "",
    content: payload.content || "",
    sourceNote: payload.sourceNote || payload.note || "",
  });
}

async function updateKnowledgeEntry(id, payload = {}) {
  const existing = await LawChatbotKnowledgeModel.findById(id);
  if (!existing) {
    return { ok: false, reason: "not_found" };
  }

  const target = payload.target === "group" ? "group" : "coop";

  clearAnswerCache();

  const updated = await LawChatbotKnowledgeModel.updateById(id, {
    target,
    title: payload.title || "",
    lawNumber: payload.lawNumber || "",
    content: payload.content || "",
    sourceNote: payload.sourceNote || payload.note || "",
  });

  if (!updated) {
    return { ok: false, reason: "not_updated" };
  }

  const refreshed = await LawChatbotKnowledgeModel.findById(id);

  return {
    ok: true,
    entry: refreshed,
  };
}

async function deleteKnowledgeEntry(id) {
  clearAnswerCache();
  return LawChatbotKnowledgeModel.removeById(id);
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
  collectAnswerSources,
  replyToChat,
  summarizeChat,
  saveChatFeedback,
  getUploadPageData,
  recordUpload,
  getFeedbackPageData,
  getUserDashboardData,
  getUserSearchHistoryData,
  getPaymentRequestPageData,
  getAdminUsersData,
  adminUpdateUserPlan,
  getAdminPaymentRequestsData,
  getAdminPaymentRequestDetail,
  updatePaymentRequestPlan,
  getKnowledgeAdminData,
  saveSuggestedQuestionEntry,
  updateSuggestedQuestionEntry,
  deleteSuggestedQuestionEntry,
  submitKnowledgeSuggestion,
  approveKnowledgeSuggestion,
  updateKnowledgeSuggestion,
  rejectKnowledgeSuggestion,
  saveKnowledgeEntry,
  updateKnowledgeEntry,
  deleteKnowledgeEntry,
  saveFeedback,
  submitPaymentRequest,
  approvePaymentRequest,
  rejectPaymentRequest,
};
