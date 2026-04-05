const { wantsExplanation } = require("./chatAnswerService");
const {
  extractExplicitTopicHints,
  normalizeForSearch,
  segmentWords,
  uniqueTokens,
} = require("./thaiTextUtils");

const CHAT_CONTEXT_KEY = "lawChatbotContext";
const CONTEXT_HISTORY_LIMIT = 8;

function isStandaloneLawLookup(message) {
  const text = normalizeForSearch(String(message || "")).toLowerCase();
  return /^(มาตรา|ข้อ|วรรค|อนุมาตรา)\s*\d+\b/.test(text);
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
    .replace(/^(อธิบาย|แสดงรายละเอียด|รายละเอียด|ขยายความ|ยกตัวอย่าง|ยังไม่ครบ|แจ้งเพิ่มเติม)\s*/i, "")
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
    return Boolean(recentTopic);
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
  const explicitHints = extractExplicitTopicHints(message);
  const strippedMessage = stripQuestionTail(message);
  const hints = [];

  if (strippedMessage && strippedMessage.length >= 6) {
    hints.push(strippedMessage);
  }

  hints.push(...explicitHints);

  (Array.isArray(matches) ? matches : []).slice(0, 3).forEach((item) => {
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

function storeConversationContext(session, target, originalMessage, effectiveMessage, matches, resolvedContext, storeOptions) {
  if (!session) {
    return;
  }

  const history = getSessionContext(session);
  const topicHints = mergeTopicHints(
    resolvedContext && Array.isArray(resolvedContext.topicHints) ? resolvedContext.topicHints : [],
    extractTopicHints(originalMessage, matches),
    history[0] && Array.isArray(history[0].topicHints) ? history[0].topicHints : [],
  );

  const entry = {
    target,
    originalMessage,
    effectiveMessage,
    topicHints,
    focusSources: mergeUniqueSources(Array.isArray(matches) ? matches.slice(0, 6) : []).slice(0, 6),
    createdAt: new Date().toISOString(),
  };

  if (storeOptions && typeof storeOptions.answerText === "string" && storeOptions.answerText.trim()) {
    entry.answerText = storeOptions.answerText.trim().slice(0, 500);
  }

  history.unshift(entry);

  session[CHAT_CONTEXT_KEY] = history.slice(0, CONTEXT_HISTORY_LIMIT);
}

const CONVERSATION_HISTORY_TURNS = 3;

function getConversationHistory(session, target) {
  const history = getSessionContext(session);
  const turns = [];
  const relevant = history.filter((item) => item && item.target === target).slice(0, CONVERSATION_HISTORY_TURNS);

  for (let i = relevant.length - 1; i >= 0; i--) {
    const entry = relevant[i];
    turns.push({ role: "user", content: String(entry.originalMessage || "").trim() });
    if (entry.answerText) {
      turns.push({ role: "assistant", content: String(entry.answerText).trim() });
    }
  }
  return turns;
}

function getFollowUpCarrySources(session, target, message, resolvedContext = {}) {
  if (!wantsExplanation(message)) {
    return [];
  }

  const recent = getSessionContext(session).find((item) => item && item.target === target);
  if (!recent || !Array.isArray(recent.focusSources)) {
    return [];
  }

  const strippedMessage = stripQuestionTail(message);
  const normalizedFollowUpText = normalizeForSearch(strippedMessage).toLowerCase();
  const followUpTokens = uniqueTokens(segmentWords(normalizedFollowUpText)).filter(
    (token) => String(token || "").trim().length >= 3,
  );
  const broadFollowUpOnly = followUpTokens.length === 0;
  const highConfidenceCarrySources = new Set([
    "managed_suggested_question",
    "admin_knowledge",
    "knowledge_suggestion",
    "tbl_laws",
    "tbl_glaws",
    "tbl_vinichai",
  ]);

  return recent.focusSources
    .map((source, index) => {
      const compacted = compactContextSource(source);
      if (!compacted) {
        return null;
      }

      const sourceName = String(compacted.source || "").trim().toLowerCase();
      const sourceSearchText = normalizeForSearch(
        [
          compacted.reference,
          compacted.title,
          compacted.lawNumber,
          compacted.keyword,
          compacted.content,
        ]
          .filter(Boolean)
          .join(" "),
      ).toLowerCase();
      const tokenOverlapCount = followUpTokens.filter((token) => sourceSearchText.includes(token)).length;
      const carryScore = Math.max(Number(compacted.score || 0), 92 - index * 3);

      if (broadFollowUpOnly) {
        if (!highConfidenceCarrySources.has(sourceName) || carryScore < 84) {
          return null;
        }
      } else if (tokenOverlapCount === 0 && carryScore < 88) {
        return null;
      } else if (
        ["documents", "pdf_chunks", "knowledge_base"].includes(sourceName) &&
        tokenOverlapCount === 0
      ) {
        return null;
      }

      return {
        ...compacted,
        score: carryScore,
        contextCarry: true,
      };
    })
    .filter(Boolean)
    .slice(0, broadFollowUpOnly ? 2 : 3);
}

module.exports = {
  extractTopicHints,
  getConversationHistory,
  getFollowUpCarrySources,
  getSessionContext,
  isStandaloneLawLookup,
  looksLikeFollowUpQuestion,
  mergeTopicHints,
  mergeUniqueSources,
  resolveMessageWithContext,
  startsWithFollowUpLead,
  storeConversationContext,
};
