const LawChatbotModel = require("../models/lawChatbotModel");
const LawChatbotKnowledgeModel = require("../models/lawChatbotKnowledgeModel");
const LawChatbotKnowledgeSuggestionModel = require("../models/lawChatbotKnowledgeSuggestionModel");
const LawSearchModel = require("../models/lawSearchModel");
const LawChatbotFeedbackModel = require("../models/lawChatbotFeedbackModel");
const LawChatbotPdfChunkModel = require("../models/lawChatbotPdfChunkModel");
const LawChatbotAnswerCacheModel = require("../models/lawChatbotAnswerCacheModel");
const PaymentRequestModel = require("../models/paymentRequestModel");
const UserModel = require("../models/userModel");
const runtimeFlags = require("../config/runtimeFlags");
const { buildQuestionCacheIdentity } = require("./lawChatbotAnswerCacheUtils");
const { sendPaymentRequestNotification } = require("./telegramService");
const { generateChatSummary, wantsExplanation } = require("./chatAnswerService");
const { chunkText, extractTextFromFile } = require("./documentTextExtractor");
const {
  extractKeywords,
  extractDocumentKeywords,
} = require("./keywordExtractionService");
const { extractDocumentMetadata } = require("./documentMetadataService");
const { normalizeForSearch, segmentWords, uniqueTokens } = require("./thaiTextUtils");

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

function buildAnswerCacheKey(message, target) {
  return `${target}::${normalizeForSearch(message).toLowerCase()}`;
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

function shouldPersistDbAnswerCache(answer, options = {}) {
  const text = String(answer || "").trim();
  if (!text || options.debugMode) {
    return false;
  }

  return !/(เข้าสู่ระบบด้วย google|guest ครบ 2 ครั้ง|ครบ 20 ครั้ง|อัปเกรดแพลน|mock ai|โหมดทดสอบ)/i.test(text);
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

  try {
    const html = await fetchText(searchUrl, timeoutMs);
    if (process.env.DEBUG_INTERNET_SEARCH === "true") {
      console.log("[searchInternetSources] HTML length:", html?.length || 0);
      console.log("[searchInternetSources] Has result__a:", html?.includes("result__a"));
    }
    const rawResults = extractWebSearchResults(html, WEB_SEARCH_LIMIT);
    if (process.env.DEBUG_INTERNET_SEARCH === "true") {
      console.log("[searchInternetSources] Raw results:", rawResults?.length || 0);
    }
    const scoredResults = rawResults.map((result, index) => {
      const baseScore = scoreInternetSource(searchQuery, result);
      return {
        ...result,
        source: "internet_search",
        reference: result.title || result.domain || result.url || "ข้อมูลจากอินเทอร์เน็ต",
        content: result.snippet || result.title || "",
        score: baseScore,
      };
    });
    if (process.env.DEBUG_INTERNET_SEARCH === "true") {
      console.log("[searchInternetSources] Scores:", scoredResults.map(r => r.score));
    }
    return scoredResults
      .filter((result) => result.score > 0)
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, WEB_SEARCH_LIMIT);
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
          vinichai: 6,
          admin_knowledge: 5,
          structured_laws: 3,
          documents: 2,
          pdf_chunks: 2,
          knowledge_base: 1,
        },
        limits: {
          vinichai: 3,
          admin_knowledge: 2,
          structured_laws: 2,
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
  const hybridTimeoutMs = Math.max(1000, Number(options.hybridTimeoutMs || HYBRID_SEARCH_TIMEOUT_MS));
  const [
    rawKnowledgeMatches,
    rawDocumentMatches,
    rawPdfMatches,
    rawFallbackKnowledge,
    rawStructuredMatches,
    rawVinichaiMatches,
  ] = await Promise.all([
    LawChatbotKnowledgeModel.searchKnowledge(message, target, 5),
    LawChatbotPdfChunkModel.searchDocuments(message, 5),
    withTimeout(() => LawChatbotPdfChunkModel.hybridSearch(message, 6), hybridTimeoutMs, [], "hybrid-search"),
    Promise.resolve(LawChatbotModel.searchKnowledge(message, target)),
    LawSearchModel.searchStructuredLaws(message, target, 6),
    LawSearchModel.searchVinichai(message, 5),
  ]);

  const knowledgeMatches = prioritizeMatches(rawKnowledgeMatches, {
    retrievalPriority: routingPlan.priorities.admin_knowledge || 4,
    sourceOverride: "admin_knowledge",
  });
  const documentMatches = prioritizeMatches(rawDocumentMatches, {
    retrievalPriority: routingPlan.priorities.documents || 3,
  });
  const pdfMatches = prioritizeMatches(rawPdfMatches, {
    retrievalPriority: routingPlan.priorities.pdf_chunks || 2,
  });
  const fallbackKnowledge = prioritizeMatches(rawFallbackKnowledge, {
    retrievalPriority: routingPlan.priorities.knowledge_base || 1,
    sourceOverride: "knowledge_base",
  });
  const structuredMatches = prioritizeMatches(rawStructuredMatches, {
    retrievalPriority: routingPlan.priorities.structured_laws || 5,
  });
  const vinichaiMatches = prioritizeMatches(rawVinichaiMatches, {
    retrievalPriority: routingPlan.priorities.vinichai || 4,
  });

  return [
    ...structuredMatches,
    ...knowledgeMatches,
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

  if (isStandaloneLawLookup(text)) {
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

function scoreMatchSet(matches) {
  if (!matches.length) {
    return 0;
  }

  const top = Number(matches[0]?.score || 0);
  const second = Number(matches[1]?.score || 0);
  return top + second * 0.35;
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

async function resolveSearchPlan(message, target, session, options = {}) {
  const baseMessage = String(message || "").trim();
  const contextualCandidate = resolveMessageWithContext(baseMessage, target, session);

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
  const shouldUseContext =
    contextualMatches.length > 0 &&
    (standaloneMatches.length === 0 ||
      contextualScore >= standaloneScore + 8 ||
      contextualScore >= standaloneScore * 1.2);

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

function compactSourcesForSummarization(groups, intent = "general") {
  const plan = getFinalSourceCompactionPlan(intent);
  const compacted = [];
  const pushUnique = (items, limit) => {
    dedupeSourcesConservatively(items)
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

  if (compacted.length < plan.totalLimit) {
    const fallbackPool = [
      ...(groups.vinichai || []),
      ...(groups.knowledge_base || []),
      ...(groups.structured_laws || []),
      ...(groups.admin_knowledge || []),
      ...(groups.documents || []),
      ...(groups.pdf_chunks || []),
      ...(groups.internet || []),
    ];

    pushUnique(fallbackPool, plan.totalLimit - compacted.length);
  }

  return sortByScore(compacted).slice(0, plan.totalLimit);
}

function selectTieredSources(groups, intent = "general") {
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

  plan.forEach(({ key, limit }) => {
    const ranked = dedupeSourcesConservatively(groups[key]).slice(0, limit);
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

  const searchPlan = await resolveSearchPlan(message, target, session, options);
  const afterDbSearchAt = nowMs();

  const resolvedEffectiveMessage = searchPlan.effectiveMessage || effectiveMessage;
  const databaseMatches = Array.isArray(searchPlan.matches) ? searchPlan.matches : [];
  const shouldSearchInternet =
    isClearlyCurrentOrExternalQuestion(resolvedEffectiveMessage) ||
    isLowConfidenceDatabaseResult(databaseMatches, questionIntent);
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
    });
  }
  const afterInternetSearchAt = nowMs();

  const grouped = {
    structured_laws: databaseMatches.filter(
      (item) => item && (item.source === "tbl_laws" || item.source === "tbl_glaws"),
    ),
    admin_knowledge: databaseMatches.filter((item) => item && item.source === "admin_knowledge"),
    vinichai: databaseMatches.filter((item) => item && item.source === "tbl_vinichai"),
    documents: databaseMatches.filter((item) => item && item.source === "documents"),
    pdf_chunks: databaseMatches.filter((item) => item && item.source === "pdf_chunks"),
    knowledge_base: databaseMatches.filter((item) => item && item.source === "knowledge_base"),
    internet: internetMatches,
  };

  const { selectedSourceTier, selectedSources } = selectTieredSources(grouped, questionIntent);
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
    timing: {
      dbSearchMs: Math.round(afterDbSearchAt - startedAt),
      internetSearchMs: Math.round(afterInternetSearchAt - afterDbSearchAt),
      sourceSelectionMs: Math.round(afterSourceSelectionAt - afterInternetSearchAt),
      totalSourceCollectionMs: Math.round(afterSourceSelectionAt - startedAt),
      remainingBudgetBeforeInternetMs:
        remainingBudgetBeforeInternetMs === Number.POSITIVE_INFINITY ? null : remainingBudgetBeforeInternetMs,
    },
  };
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

  const { normalizedQuestion, questionHash } = buildQuestionCacheIdentity(message, target);

  if (runtimeFlags.useMockAI) {
    const highlightTerms = message.split(/\s+/).filter(Boolean).slice(0, 8);

    return {
      hasContext: true,
      answer: `Mock AI\n\nคำถาม: "${message}"\n\nสรุปจำลอง: ระบบกำลังอยู่ในโหมดทดสอบและยังไม่ได้เรียก AI จริง`,
      highlightTerms,
      usedFollowUpContext: false,
      usedInternetFallback: false,
      fromCache: false,
    };
  }

  const cacheKey = buildAnswerCacheKey(message, target);
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

    return cachedResult;
  }

  if (canUseCache && questionHash) {
    try {
      const dbCachedAnswer = await LawChatbotAnswerCacheModel.findByQuestionHash(questionHash);
      if (dbCachedAnswer?.answer_text) {
        await LawChatbotAnswerCacheModel.incrementHitCount(dbCachedAnswer.id);

        const cachedResult = buildDbCachedChatResult(dbCachedAnswer, message);

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
          effectiveMessage: dbCachedAnswer.normalized_question || message,
          resolvedContext: { usedContext: false, topicHints: [] },
          sources: [],
        });

        return cachedResult;
      }
    } catch (error) {
      console.error("[replyToChat] Answer cache lookup failed:", error.message || error);
    }
  }

  const evidence = await collectAnswerSources(message, target, session, {
    requestStartedAt: startedAt,
    totalBudgetMs: CHAT_REPLY_BUDGET_MS,
  });
  const afterCollectSourcesAt = nowMs();
  const resolvedContext = evidence.resolvedContext;
  const effectiveMessage = evidence.effectiveMessage || message;
  const sources = evidence.sources;
  const highlightTerms = effectiveMessage.split(/\s+/).filter(Boolean).slice(0, 8);

  let answer = "";

  if (sources.length === 0) {
    answer =
      "ไม่ปรากฏข้อมูลที่ตรงกับประเด็นคำถามอย่างชัดเจนทั้งในฐานข้อมูลและแหล่งข้อมูลสาธารณะ\n\nกรุณาระบุคำสำคัญเพิ่มเติม เช่น การประชุมใหญ่ สมาชิก คณะกรรมการ หรือการจัดตั้งกลุ่มเกษตรกร";
  } else {
    const remainingBudgetBeforeAnswerMs = getRemainingBudgetMs(startedAt, CHAT_REPLY_BUDGET_MS);
    answer = await generateChatSummary(message, wantsExplanation(message) ? sources : sources.slice(0, 5), {
      conversationalFollowUp: resolvedContext.usedContext,
      topicLabel: resolvedContext.topicHints && resolvedContext.topicHints[0] ? resolvedContext.topicHints[0] : "",
      forceFallback: remainingBudgetBeforeAnswerMs < MIN_AI_SUMMARY_BUDGET_MS,
      aiTimeoutMs: Math.max(1000, remainingBudgetBeforeAnswerMs - 500),
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

  return result;
}

async function summarizeChat(payload, session) {
  const message = String(payload.message || "").trim();
  if (!message) {
    return { summary: "" };
  }

  const target =
    payload.target === "group" ? "group" : payload.target === "coop" ? "coop" : "all";
  const evidence = await collectAnswerSources(message, target, session);
  const resolvedContext = evidence.resolvedContext;
  const effectiveMessage = evidence.effectiveMessage || message;
  const sources = evidence.sources;

  return {
    summary: await generateChatSummary(message, sources, {
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

async function getPaymentRequestPageData(user) {
  const signedInUser = user || {};
  const userId = Number(signedInUser.userId || signedInUser.id || 0);

  return {
    appName: "Coopbot Law Chatbot",
    plans: [
      { value: "premium-monthly", label: "Premium Monthly" },
      { value: "premium-yearly", label: "Premium Yearly" },
    ],
    user: signedInUser,
    recentRequests: userId ? await PaymentRequestModel.listByUserId(userId, 10) : [],
  };
}

async function submitPaymentRequest(payload, file, user) {
  const signedInUser = user || {};
  const userId = Number(signedInUser.userId || signedInUser.id || 0);
  const planName = String(payload.planName || "").trim();
  const amount = Number(payload.amount || 0);
  const note = String(payload.note || "").trim();

  if (!userId) {
    throw new Error("Please sign in before submitting a payment request.");
  }

  if (!planName || !Number.isFinite(amount) || amount <= 0) {
    throw new Error("Please provide a valid plan and amount.");
  }

  const paymentRequest = await PaymentRequestModel.create({
    userId,
    planName,
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

async function getAdminPaymentRequestsData() {
  const requests = await PaymentRequestModel.listAll(100);

  return {
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

  return { request };
}

async function approvePaymentRequest(id, reviewMeta = {}) {
  const request = await PaymentRequestModel.findById(id);
  if (!request || request.status !== "pending") {
    return { ok: false, reason: "not_found" };
  }

  const activated = await UserModel.activatePremiumPlan(request.user_id, 30);
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

  return { ok: true, requestId: id };
}

async function rejectPaymentRequest(id, reviewMeta = {}) {
  const request = await PaymentRequestModel.findById(id);
  if (!request || request.status !== "pending") {
    return { ok: false, reason: "not_found" };
  }

  const updatedUser = await UserModel.downgradeToFree(request.user_id);
  if (!updatedUser) {
    return { ok: false, reason: "user_not_updated" };
  }

  const reviewed = await PaymentRequestModel.updateReviewStatus(
    id,
    "rejected",
    reviewMeta.reviewedBy || "",
  );

  if (!reviewed) {
    return { ok: false, reason: "review_not_updated" };
  }

  return { ok: true, requestId: id };
}

async function getKnowledgeAdminData() {
  const [knowledgeCount, recentKnowledge, pendingSuggestionCount, pendingSuggestions] = await Promise.all([
    LawChatbotKnowledgeModel.count(),
    LawChatbotKnowledgeModel.listRecent(10),
    LawChatbotKnowledgeSuggestionModel.countPending(),
    LawChatbotKnowledgeSuggestionModel.listPending(12),
  ]);

  return {
    appName: "Coopbot Law Chatbot",
    knowledgeCount,
    recentKnowledge,
    pendingSuggestionCount,
    pendingSuggestions,
    targets: [
      { value: "coop", label: "สหกรณ์" },
      { value: "group", label: "กลุ่มเกษตรกร" },
    ],
  };
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
  getPaymentRequestPageData,
  getAdminPaymentRequestsData,
  getAdminPaymentRequestDetail,
  getKnowledgeAdminData,
  submitKnowledgeSuggestion,
  approveKnowledgeSuggestion,
  rejectKnowledgeSuggestion,
  saveKnowledgeEntry,
  deleteKnowledgeEntry,
  saveFeedback,
  submitPaymentRequest,
  approvePaymentRequest,
  rejectPaymentRequest,
};
