const LawChatbotModel = require("../models/lawChatbotModel");
const LawChatbotKnowledgeModel = require("../models/lawChatbotKnowledgeModel");
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
const { normalizeForSearch, segmentWords, uniqueTokens } = require("./thaiTextUtils");

const CHAT_CONTEXT_KEY = "lawChatbotContext";
const CONTEXT_HISTORY_LIMIT = 8;
const ANSWER_CACHE_TTL_MS = Number(process.env.LAW_CHATBOT_ANSWER_CACHE_TTL_MS || 5 * 60 * 1000);
const KEYWORD_CONCURRENCY = Number(process.env.KEYWORD_CONCURRENCY || 4);
const WEB_SEARCH_LIMIT = Number(process.env.LAW_CHATBOT_WEB_SEARCH_LIMIT || 3);
const WEB_SEARCH_TIMEOUT_MS = Number(process.env.LAW_CHATBOT_WEB_SEARCH_TIMEOUT_MS || 8000);
const WEB_SEARCH_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";
const answerCache = new Map();

function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function buildAnswerCacheKey(message, target) {
  return `${target}::${normalizeForSearch(message).toLowerCase()}`;
}

function shouldUseAnswerCache(message) {
  const text = String(message || "").trim();
  return Boolean(text) && !looksLikeFollowUpQuestion(text);
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

async function fetchText(url) {
  if (typeof fetch !== "function") {
    throw new Error("fetch is not available in this runtime");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), WEB_SEARCH_TIMEOUT_MS);

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

async function searchInternetSources(message, target) {
  const query = String(message || "").trim();
  if (!query) {
    return [];
  }

  const targetKeyword =
    target === "group" ? "กลุ่มเกษตรกร" : target === "coop" ? "สหกรณ์" : "สหกรณ์ กลุ่มเกษตรกร";
  const searchQuery = `${query} ${targetKeyword}`.trim();
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}&kl=th-th&ia=web`;

  try {
    const html = await fetchText(searchUrl);
    return extractWebSearchResults(html, WEB_SEARCH_LIMIT)
      .map((result, index) => ({
        ...result,
        source: "internet_search",
        reference: result.title || result.domain || result.url || "ข้อมูลจากอินเทอร์เน็ต",
        content: result.snippet || result.title || "",
        score: scoreInternetSource(searchQuery, result) - index,
      }))
      .filter((result) => result.score > 0)
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, WEB_SEARCH_LIMIT);
  } catch {
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

  const asksLawSection =
    /มาตรา\s*\d+|มาตรา|วรรค|อนุมาตรา|ข้อ\s*\d+/.test(text);
  const asksDocumentStyle =
    /กฎกระทรวง|ประกาศ|หนังสือเวียน|ข้อหารือ|หนังสือสั่งการ|หนังสือกรม|เอกสาร|ฉบับ/.test(text);
  const asksQaStyle =
    /แนววินิจฉัย|วินิจฉัย|ตีความ|ข้อหารือ|ถามตอบ|คำถามคำตอบ/.test(text);
  const asksShortAnswer =
    text.length <= 60 &&
    /คืออะไร|หมายถึง|เท่าไร|เท่าไหร่|กี่บาท|กี่เปอร์เซ็นต์|กี่ร้อยละ|เมื่อไร|เมื่อไหร่|ต้อง|ควร|ได้ไหม|ได้หรือไม่/.test(
      text,
    );

  if (asksLawSection) {
    return "law_section";
  }

  if (asksDocumentStyle) {
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
          admin_knowledge: 2,
          knowledge_base: 1,
        },
        limits: {
          documents: 2,
          pdf_chunks: 4,
          structured_laws: 2,
          vinichai: 1,
          admin_knowledge: 1,
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

async function searchDatabaseSources(message, target) {
  const intent = classifyQuestionIntent(message);
  const routingPlan = getSourceRoutingPlan(intent);
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
    LawChatbotPdfChunkModel.searchChunks(message, 6),
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
    .slice(0, 30);
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

async function resolveSearchPlan(message, target, session) {
  const baseMessage = String(message || "").trim();
  const contextualCandidate = resolveMessageWithContext(baseMessage, target, session);

  const standaloneMatches = await searchDatabaseSources(baseMessage, target);
  const standaloneScore = scoreMatchSet(standaloneMatches);

  if (!contextualCandidate.usedContext) {
    return {
      effectiveMessage: baseMessage,
      matches: standaloneMatches,
      resolvedContext: contextualCandidate,
    };
  }

  const contextualMatches = await searchDatabaseSources(contextualCandidate.effectiveMessage, target);
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

function selectTieredSources(groups, intent = "general") {
  const routingPlan = getSourceRoutingPlan(intent);
  const plan = [
    { key: "structured_laws", limit: routingPlan.limits.structured_laws || 3 },
    { key: "admin_knowledge", limit: routingPlan.limits.admin_knowledge || 2 },
    { key: "vinichai", limit: routingPlan.limits.vinichai || 2 },
    { key: "documents", limit: routingPlan.limits.documents || 2 },
    { key: "pdf_chunks", limit: routingPlan.limits.pdf_chunks || 3 },
    { key: "internet", limit: 2 },
    { key: "knowledge_base", limit: routingPlan.limits.knowledge_base || 1 },
  ];

  const selected = [];
  const usedTiers = [];

  plan.forEach(({ key, limit }) => {
    const ranked = sortByScore(groups[key]).slice(0, limit);
    if (ranked.length > 0) {
      usedTiers.push(key);
      selected.push(...ranked);
    }
  });

  return {
    selectedSourceTier: usedTiers.join(" > ") || "none",
    selectedSources: selected,
  };
}

async function collectAnswerSources(message, target, session) {
  const startedAt = nowMs();
  const questionIntent = classifyQuestionIntent(message);
  const searchPlan = await resolveSearchPlan(message, target, session);
  const afterDatabaseSearchAt = nowMs();
  const effectiveMessage = searchPlan.effectiveMessage || String(message || "").trim();
  const databaseMatches = Array.isArray(searchPlan.matches) ? searchPlan.matches : [];
  const shouldUseInternetFallback = databaseMatches.length === 0;
  const internetMatches = shouldUseInternetFallback
    ? await searchInternetSources(effectiveMessage, target)
    : [];
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

  return {
    ...searchPlan,
    questionIntent,
    effectiveMessage,
    databaseMatches,
    internetMatches,
    sources: selectedSources,
    selectedSourceTier,
    usedInternetFallback: internetMatches.length > 0,
    attemptedInternetFallback: shouldUseInternetFallback,
    timing: {
      databaseSearchMs: Math.round(afterDatabaseSearchAt - startedAt),
      internetSearchMs: Math.round(afterInternetSearchAt - afterDatabaseSearchAt),
      totalSourceCollectionMs: Math.round(afterInternetSearchAt - startedAt),
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

  const cacheKey = buildAnswerCacheKey(message, target);
  const canUseCache = shouldUseAnswerCache(message);
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

  const evidence = await collectAnswerSources(message, target, session);
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
    answer = await generateChatSummary(message, wantsExplanation(message) ? sources : sources.slice(0, 5), {
      conversationalFollowUp: resolvedContext.usedContext,
      topicLabel: resolvedContext.topicHints && resolvedContext.topicHints[0] ? resolvedContext.topicHints[0] : "",
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

  if (debugMode) {
    result.debug = {
      selectedSourceTier: evidence.selectedSourceTier || "none",
      sourceCount: sources.length,
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

async function getKnowledgeAdminData() {
  const [knowledgeCount, recentKnowledge] = await Promise.all([
    LawChatbotKnowledgeModel.count(),
    LawChatbotKnowledgeModel.listRecent(10),
  ]);

  return {
    appName: "Coopbot Law Chatbot",
    knowledgeCount,
    recentKnowledge,
    targets: [
      { value: "coop", label: "สหกรณ์" },
      { value: "group", label: "กลุ่มเกษตรกร" },
    ],
  };
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
  getKnowledgeAdminData,
  saveKnowledgeEntry,
  deleteKnowledgeEntry,
  saveFeedback,
};
