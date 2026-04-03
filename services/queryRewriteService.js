const { getOpenAiConfig, generateOpenAiCompletion } = require("./openAiService");
const { getSessionContext, startsWithFollowUpLead } = require("./contextService");
const {
  expandSearchConcepts,
  extractExplicitTopicHints,
  getQueryFocusProfile,
  normalizeForSearch,
  segmentWords,
  uniqueTokens,
} = require("./thaiTextUtils");

const QUERY_REWRITE_TIMEOUT_MS = Number(process.env.LAW_CHATBOT_QUERY_REWRITE_TIMEOUT_MS || 3500);
const QUERY_REWRITE_AI_ENABLED = String(process.env.LAW_CHATBOT_QUERY_REWRITE_AI_ENABLED || "1") !== "0";
const QUERY_REWRITE_MAX_KEYWORDS = 8;
const QUERY_REWRITE_MAX_ALIASES = 6;

const QUERY_REWRITE_SYSTEM_PROMPT = [
  "คุณเป็นระบบ rewrite คำค้นสำหรับ chatbot กฎหมายสหกรณ์ไทย",
  "เป้าหมายคือช่วย retrieval ในฐานข้อมูล ไม่ใช่ตอบคำถาม",
  "ตอบกลับเป็น JSON object เท่านั้น โดยมี key ดังนี้:",
  'effectiveQuery: string',
  'expandedKeywords: string[]',
  'legalAliases: string[]',
  'reason: string',
  "กติกา:",
  "1. รักษาความหมายเดิมของผู้ใช้",
  "2. ถ้าคำถามสั้น กำกวม หรือเป็น follow-up ให้ใช้ context ที่ให้มาเพื่อขยายคำค้น",
  "3. ห้ามแต่งมาตรา ข้อ ปี ชื่อกฎหมาย หรือข้อเท็จจริงใหม่ที่ไม่มีในข้อความหรือ context",
  "4. expandedKeywords ให้เป็นคำสั้นหรือวลีสั้นที่ช่วย recall",
  "5. legalAliases ให้เป็นคำพ้องหรือคำทางกฎหมายที่เกี่ยวข้องจริง",
  "6. ถ้าข้อมูลไม่พอ ให้คงคำถามเดิมไว้และส่ง array ว่างได้",
].join("\n");

function normalizeRewriteQuery(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function stripFollowUpLeadText(message) {
  return normalizeRewriteQuery(
    String(message || "").replace(
      /^(ตกลง|แล้ว|แล้วถ้า|ส่วน|ประเด็นนี้|กรณีนี้|สรุปแล้ว|ท้ายที่สุด|เรื่องนี้|หัวข้อนี้)\s*/i,
      "",
    ),
  );
}

function extractLawReferenceTokens(text) {
  const normalizedMessage = normalizeForSearch(String(text || "")).toLowerCase();
  if (!normalizedMessage) {
    return [];
  }

  const references = [];
  const matcher = /(?:มาตรา|ข้อ|วรรค|อนุมาตรา)\s*([0-9]+(?:\/[0-9]+)?)/g;
  let match = matcher.exec(normalizedMessage);
  while (match) {
    if (match[1]) {
      references.push(match[1]);
    }
    match = matcher.exec(normalizedMessage);
  }

  return uniqueTokens(references);
}

function getAllowedLawReferenceTokens(message, context = {}) {
  return uniqueTokens([
    ...extractLawReferenceTokens(message),
    ...extractLawReferenceTokens(context.topicAnchor || ""),
    ...(Array.isArray(context.sourceAnchors) ? context.sourceAnchors : []).flatMap((value) => extractLawReferenceTokens(value)),
  ]);
}

function containsDisallowedLawReference(text, allowedReferences = []) {
  const allowedSet = new Set((allowedReferences || []).map((value) => String(value).trim()));
  const foundReferences = extractLawReferenceTokens(text);
  if (foundReferences.length === 0) {
    return false;
  }

  return foundReferences.some((reference) => !allowedSet.has(reference));
}

function sanitizeRewriteTerms(terms, allowedReferences = [], maxItems = 8) {
  return uniqueTokens(
    (Array.isArray(terms) ? terms : [])
      .map((term) => normalizeRewriteQuery(term))
      .filter((term) => {
        if (!term) {
          return false;
        }

        if (term.length < 2 || term.length > 60) {
          return false;
        }

        return !containsDisallowedLawReference(term, allowedReferences);
      }),
  ).slice(0, maxItems);
}

function getRecentRewriteAnchors(session, target) {
  const recent = getSessionContext(session).find((item) => item && item.target === target);
  const recentTopic = Array.isArray(recent?.topicHints) ? String(recent.topicHints[0] || "").trim() : "";
  const sourceAnchors = (Array.isArray(recent?.focusSources) ? recent.focusSources : [])
    .map((source) => String(source.reference || source.title || source.lawNumber || source.keyword || "").trim())
    .filter((value) => value && value.length >= 4)
    .slice(0, 2);

  return {
    recentTopic,
    sourceAnchors,
  };
}

function isAmbiguousFollowUpQuestion(message, contextualCandidate = {}) {
  const text = normalizeRewriteQuery(message);
  if (!text) {
    return false;
  }

  if (contextualCandidate?.usedContext) {
    return true;
  }

  if (text.length <= 18) {
    return true;
  }

  if (startsWithFollowUpLead(text)) {
    return true;
  }

  return (
    extractExplicitTopicHints(text).length === 0 &&
    /(มาตราไหน|ข้อไหน|วรรคไหน|อันไหน|แบบไหน|เรื่องนี้|กรณีนี้|อย่างไร|ยังไง|ได้ไหม|ได้หรือไม่|มีหน้าที่|คุณสมบัติ|ลักษณะต้องห้าม)/.test(
      text,
    )
  );
}

function getLegalRewriteAliases(message) {
  const normalizedMessage = normalizeForSearch(String(message || "")).toLowerCase();
  if (!normalizedMessage) {
    return [];
  }

  const aliases = [];

  if (/(ได้ไหม|ได้หรือไม่|ทำได้ไหม|ทำได้หรือไม่)/.test(normalizedMessage)) {
    aliases.push("ได้หรือไม่", "มีสิทธิ", "สามารถ");
  }

  if (/(มาตราไหน|ข้อไหน|วรรคไหน|อนุมาตราไหน)/.test(normalizedMessage)) {
    aliases.push("มาตรา", "ข้อ", "วรรค", "อนุมาตรา");
  }

  if (/(หน้าที่|มีหน้าที่|อำนาจหน้าที่)/.test(normalizedMessage)) {
    aliases.push("อำนาจหน้าที่", "หน้าที่ของ", "บทบาท");
  }

  if (/(คุณสมบัติ|ลักษณะต้องห้าม|ขาดจากการเป็น)/.test(normalizedMessage)) {
    aliases.push("คุณสมบัติ", "ลักษณะต้องห้าม", "ขาดจากการเป็น");
  }

  if (/(ประชุมใหญ่|ประชุมคณะกรรมการ|ประชุมกรรมการ)/.test(normalizedMessage)) {
    aliases.push("องค์ประชุม", "วาระการประชุม");
  }

  return uniqueTokens(
    aliases
      .map((alias) => normalizeRewriteQuery(alias))
      .filter(Boolean),
  ).slice(0, QUERY_REWRITE_MAX_ALIASES);
}

function buildRetrievalQuery(effectiveQuery, expandedKeywords = [], legalAliases = []) {
  return normalizeRewriteQuery(
    [
      effectiveQuery,
      ...expandedKeywords.slice(0, 3),
      ...legalAliases.slice(0, 2),
    ].join(" "),
  ) || normalizeRewriteQuery(effectiveQuery);
}

function buildHeuristicQueryRewrite(message, context = {}) {
  const baseMessage = normalizeRewriteQuery(message);
  const expandedQueryText = normalizeRewriteQuery(expandSearchConcepts(baseMessage)) || baseMessage;
  const focusProfile = getQueryFocusProfile(expandedQueryText);
  const topicAliases = uniqueTokens(
    focusProfile.topics.flatMap((topic) => [topic.primary, ...(topic.aliases || [])]).filter(Boolean),
  );
  const contextSignals = uniqueTokens(
    focusProfile.topics.flatMap((topic) => topic.contextSignals || []).filter(Boolean),
  );
  const legalAliases = sanitizeRewriteTerms([
    ...topicAliases,
    ...getLegalRewriteAliases(expandedQueryText),
  ], getAllowedLawReferenceTokens(message, context), QUERY_REWRITE_MAX_ALIASES)
    .filter((alias) => alias.toLowerCase() !== expandedQueryText.toLowerCase());
  const expandedKeywords = sanitizeRewriteTerms([
    ...(context.topicAnchor ? [context.topicAnchor] : []),
    ...(context.sourceAnchors || []),
    ...extractExplicitTopicHints(expandedQueryText),
    ...segmentWords(stripFollowUpLeadText(expandedQueryText)).filter((token) => String(token || "").trim().length >= 3),
    ...contextSignals,
  ], getAllowedLawReferenceTokens(message, context), QUERY_REWRITE_MAX_KEYWORDS)
    .filter((keyword) => {
      const normalizedKeyword = keyword.toLowerCase();
      if (normalizedKeyword === expandedQueryText.toLowerCase()) {
        return false;
      }

      return !legalAliases.some((alias) => alias.toLowerCase() === normalizedKeyword);
    });

  return {
    effectiveQuery: expandedQueryText,
    retrievalQuery: buildRetrievalQuery(expandedQueryText, expandedKeywords, legalAliases),
    expandedKeywords,
    legalAliases,
    method: "heuristic",
    reason: context.reason || "heuristic rewrite",
    fallbackReason: "",
  };
}

function shouldAttemptAiRewrite(message, context = {}, options = {}) {
  if (options.allowAiRewrite === false) {
    return false;
  }

  if (options.forceHeuristic === true || !QUERY_REWRITE_AI_ENABLED || !getOpenAiConfig()) {
    return false;
  }

  const normalizedMessage = normalizeRewriteQuery(message);
  if (!normalizedMessage) {
    return false;
  }

  if (/^(มาตรา|ข้อ|วรรค|อนุมาตรา)\s*\d+\b/i.test(normalizedMessage)) {
    return false;
  }

  if (options.forceAiRewrite === true) {
    return true;
  }

  if (context.candidateType && !["original", "contextual"].includes(context.candidateType)) {
    return false;
  }

  const explicitTopicCount = extractExplicitTopicHints(normalizedMessage).length;
  const shortQuestion = normalizedMessage.length <= 24;
  const briefLowContextQuestion = normalizedMessage.length <= 42 && explicitTopicCount === 0;
  const followUpLike =
    startsWithFollowUpLead(normalizedMessage) ||
    /(ได้ไหม|ได้หรือไม่|มาตราไหน|ข้อไหน|วรรคไหน|กรณีนี้|เรื่องนี้|อย่างไร|ยังไง|อันไหน|แบบไหน)/.test(
      normalizedMessage,
    );

  return Boolean(
    context.ambiguousFollowUp ||
    context.contextualUsed ||
    shortQuestion ||
    briefLowContextQuestion ||
    followUpLike,
  );
}

function buildAiRewritePromptPayload(message, context = {}, heuristic = {}) {
  return JSON.stringify({
    originalMessage: normalizeRewriteQuery(message),
    candidateType: context.candidateType || "original",
    ambiguousFollowUp: Boolean(context.ambiguousFollowUp),
    contextualUsed: Boolean(context.contextualUsed),
    topicAnchor: normalizeRewriteQuery(context.topicAnchor || ""),
    sourceAnchors: Array.isArray(context.sourceAnchors) ? context.sourceAnchors.slice(0, 2) : [],
    heuristicRewrite: {
      effectiveQuery: heuristic.effectiveQuery || "",
      expandedKeywords: heuristic.expandedKeywords || [],
      legalAliases: heuristic.legalAliases || [],
    },
  });
}

async function requestAiQueryRewrite(message, context = {}, heuristic = {}, options = {}) {
  const responseText = await generateOpenAiCompletion({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    systemInstruction: QUERY_REWRITE_SYSTEM_PROMPT,
    userContent: buildAiRewritePromptPayload(message, context, heuristic),
    responseFormat: "json_object",
    temperature: 0,
    timeoutMs: Math.max(1000, Number(options.timeoutMs || QUERY_REWRITE_TIMEOUT_MS)),
  });

  if (!responseText) {
    return null;
  }

  const parsed = JSON.parse(String(responseText || "{}"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const allowedReferences = getAllowedLawReferenceTokens(message, context);
  const effectiveQuery = normalizeRewriteQuery(parsed.effectiveQuery || "");
  if (!effectiveQuery || containsDisallowedLawReference(effectiveQuery, allowedReferences)) {
    return null;
  }

  const expandedKeywords = sanitizeRewriteTerms(parsed.expandedKeywords, allowedReferences, QUERY_REWRITE_MAX_KEYWORDS);
  const legalAliases = sanitizeRewriteTerms(parsed.legalAliases, allowedReferences, QUERY_REWRITE_MAX_ALIASES);

  return {
    effectiveQuery,
    retrievalQuery: buildRetrievalQuery(effectiveQuery, expandedKeywords, legalAliases),
    expandedKeywords,
    legalAliases,
    method: "ai",
    reason: normalizeRewriteQuery(parsed.reason || "ai rewrite"),
    fallbackReason: "",
  };
}

function mergeRewriteResult(heuristic = {}, aiResult = null) {
  if (!aiResult) {
    return heuristic;
  }

  const effectiveQuery = aiResult.effectiveQuery || heuristic.effectiveQuery;
  const expandedKeywords = uniqueTokens([
    ...(aiResult.expandedKeywords || []),
    ...(heuristic.expandedKeywords || []),
  ]).slice(0, QUERY_REWRITE_MAX_KEYWORDS);
  const legalAliases = uniqueTokens([
    ...(aiResult.legalAliases || []),
    ...(heuristic.legalAliases || []),
  ]).slice(0, QUERY_REWRITE_MAX_ALIASES);

  return {
    effectiveQuery,
    retrievalQuery: buildRetrievalQuery(effectiveQuery, expandedKeywords, legalAliases),
    expandedKeywords,
    legalAliases,
    method: aiResult.method || "ai",
    reason: aiResult.reason || heuristic.reason || "",
    fallbackReason: "",
  };
}

async function rewriteSearchQuery(message, context = {}, options = {}) {
  const heuristic = buildHeuristicQueryRewrite(message, context);
  if (!shouldAttemptAiRewrite(message, context, options)) {
    return heuristic;
  }

  const memoKey = JSON.stringify({
    message: normalizeRewriteQuery(message),
    candidateType: context.candidateType || "original",
    topicAnchor: normalizeRewriteQuery(context.topicAnchor || ""),
    sourceAnchors: Array.isArray(context.sourceAnchors) ? context.sourceAnchors.slice(0, 2) : [],
  });

  if (options.aiMemo && options.aiMemo.has(memoKey)) {
    return options.aiMemo.get(memoKey);
  }

  const task = (async () => {
    try {
      const aiResult = await requestAiQueryRewrite(message, context, heuristic, options);
      if (!aiResult) {
        return {
          ...heuristic,
          fallbackReason: "ai_empty_or_invalid",
        };
      }

      return mergeRewriteResult(heuristic, aiResult);
    } catch (_) {
      return {
        ...heuristic,
        fallbackReason: "ai_failed",
      };
    }
  })();

  if (options.aiMemo) {
    options.aiMemo.set(memoKey, task);
  }

  return task;
}

async function buildQueryRewriteCandidates(message, target, session, contextualCandidate = {}, options = {}) {
  const baseMessage = normalizeRewriteQuery(message);
  const strippedMessage = stripFollowUpLeadText(baseMessage) || baseMessage;
  const { recentTopic, sourceAnchors } = getRecentRewriteAnchors(session, target);
  const topicAnchor = String(contextualCandidate?.topicHints?.[0] || recentTopic || "").trim();
  const ambiguousFollowUp = isAmbiguousFollowUpQuestion(baseMessage, contextualCandidate);
  const asksLawSection = /(มาตรา|ข้อ|วรรค|อนุมาตรา|มาตราไหน|ข้อไหน)/.test(baseMessage);
  const aiMemo = new Map();
  const seen = new Set();
  const candidates = [];

  const pushCandidate = async (query, metadata = {}) => {
    const rewritten = await rewriteSearchQuery(query, {
      topicAnchor,
      sourceAnchors,
      ambiguousFollowUp,
      candidateType: metadata.type,
      contextualUsed: contextualCandidate?.usedContext === true,
      reason: metadata.reason || "",
    }, {
      allowAiRewrite: metadata.allowAiRewrite !== false,
      timeoutMs: options.timeoutMs,
      aiMemo,
    });
    const normalizedKey = String(rewritten.retrievalQuery || "").toLowerCase();
    if (!rewritten.effectiveQuery || !normalizedKey || seen.has(normalizedKey)) {
      return;
    }

    seen.add(normalizedKey);
    candidates.push({
      query: rewritten.retrievalQuery,
      effectiveQuery: rewritten.effectiveQuery,
      retrievalQuery: rewritten.retrievalQuery,
      expandedKeywords: rewritten.expandedKeywords,
      legalAliases: rewritten.legalAliases,
      method: rewritten.method,
      fallbackReason: rewritten.fallbackReason || "",
      type: metadata.type || "original",
      seedReason: metadata.reason || "",
      reason: rewritten.reason || metadata.reason || "",
    });
  };

  await pushCandidate(baseMessage, {
    type: "original",
    reason: "original user query",
    allowAiRewrite: true,
  });

  if (contextualCandidate?.usedContext && contextualCandidate.effectiveMessage && contextualCandidate.effectiveMessage !== baseMessage) {
    await pushCandidate(contextualCandidate.effectiveMessage, {
      type: "contextual",
      reason: "session follow-up context",
      allowAiRewrite: true,
    });
  }

  if (ambiguousFollowUp && topicAnchor) {
    await pushCandidate(`${topicAnchor} ${strippedMessage}`, {
      type: "topic_anchor",
      reason: "recent topic anchor",
      allowAiRewrite: false,
    });
  }

  if (ambiguousFollowUp && sourceAnchors.length > 0 && (asksLawSection || strippedMessage.length <= 40)) {
    await pushCandidate(`${sourceAnchors[0]} ${strippedMessage}`, {
      type: "source_anchor",
      reason: "recent source anchor",
      allowAiRewrite: false,
    });
  }

  return {
    ambiguousFollowUp,
    candidates: candidates.slice(0, 4),
  };
}

function buildQueryRewriteTrace(baseMessage, candidateResults, selectedCandidate, options = {}) {
  const selectedSummary = selectedCandidate
    ? [
        selectedCandidate.reason || "",
        selectedCandidate.seedReason && selectedCandidate.seedReason !== selectedCandidate.reason
          ? selectedCandidate.seedReason
          : "",
        selectedCandidate.method === "ai" ? "ai rewrite" : "heuristic rewrite",
        Array.isArray(selectedCandidate.expandedKeywords) && selectedCandidate.expandedKeywords.length > 0
          ? `expanded with ${selectedCandidate.expandedKeywords.slice(0, 2).join(", ")}`
          : "",
        Array.isArray(selectedCandidate.legalAliases) && selectedCandidate.legalAliases.length > 0
          ? `legal aliases ${selectedCandidate.legalAliases.slice(0, 2).join(", ")}`
          : "",
        selectedCandidate.fallbackReason ? `fallback ${selectedCandidate.fallbackReason}` : "",
      ]
        .filter(Boolean)
        .join(" + ")
    : "";

  return {
    originalQuery: baseMessage,
    effectiveQuery: selectedCandidate?.effectiveQuery || baseMessage,
    selectedQuery: selectedCandidate?.retrievalQuery || selectedCandidate?.query || baseMessage,
    selectedType: selectedCandidate?.type || "original",
    method: selectedCandidate?.method || "heuristic",
    fallbackReason: selectedCandidate?.fallbackReason || "",
    decision: options.decision || "",
    summary: selectedSummary,
    usedContext: Boolean(options.usedContext),
    ambiguousFollowUp: Boolean(options.ambiguousFollowUp),
    implicitFollowUpQuestion: Boolean(options.implicitFollowUpQuestion),
    shortFollowUpBias: Boolean(options.shortFollowUpBias),
    expandedKeywords: Array.isArray(selectedCandidate?.expandedKeywords) ? selectedCandidate.expandedKeywords : [],
    legalAliases: Array.isArray(selectedCandidate?.legalAliases) ? selectedCandidate.legalAliases : [],
    candidates: (Array.isArray(candidateResults) ? candidateResults : []).map((candidate) => ({
      type: candidate.type || "original",
      method: candidate.method || "heuristic",
      fallbackReason: candidate.fallbackReason || "",
      seedReason: candidate.seedReason || "",
      effectiveQuery: candidate.effectiveQuery || candidate.query || "",
      query: candidate.retrievalQuery || candidate.query || "",
      reason: candidate.reason || "",
      expandedKeywords: Array.isArray(candidate.expandedKeywords) ? candidate.expandedKeywords : [],
      legalAliases: Array.isArray(candidate.legalAliases) ? candidate.legalAliases : [],
      matchCount: Number(candidate.matchCount || 0),
      topScore: Number(candidate.topScore || 0),
      aggregateScore: Number(candidate.score || 0),
      selected:
        candidate.type === selectedCandidate?.type &&
        (candidate.retrievalQuery || candidate.query) === (selectedCandidate?.retrievalQuery || selectedCandidate?.query),
    })),
  };
}

module.exports = {
  buildQueryRewriteCandidates,
  buildQueryRewriteTrace,
  rewriteSearchQuery,
};
