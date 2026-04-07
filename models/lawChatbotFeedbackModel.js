const feedbackEntries = [];

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function tokenizeQuestion(value) {
  return [...new Set(normalizeText(value).split(/\s+/).filter((token) => token.length >= 2))];
}

class LawChatbotFeedbackModel {
  static create(entry) {
    const record = {
      id: feedbackEntries.length + 1,
      createdAt: new Date().toISOString(),
      ...entry,
    };

    feedbackEntries.unshift(record);
    return record;
  }

  static count() {
    return feedbackEntries.length;
  }

  static list(limit = 10, offset = 0) {
    const normalizedLimit = Math.max(1, Number(limit || 10));
    const normalizedOffset = Math.max(0, Number(offset || 0));
    return feedbackEntries.slice(normalizedOffset, normalizedOffset + normalizedLimit);
  }

  static stats() {
    return {
      total: feedbackEntries.length,
      helpful: feedbackEntries.filter((item) => item.isHelpful === true).length,
      needsImprovement: feedbackEntries.filter((item) => item.isHelpful === false).length,
    };
  }

  static getHelpfulBoostProfile(message = "", target = "all", sourceName = "") {
    const normalizedTarget = normalizeText(target || "all") || "all";
    const normalizedSource = normalizeText(sourceName);
    const messageTokens = tokenizeQuestion(message);
    if (!normalizedSource || messageTokens.length === 0) {
      return {
        boost: 0,
        helpfulMatches: 0,
        harmfulMatches: 0,
      };
    }

    let helpfulMatches = 0;
    let harmfulMatches = 0;

    for (const entry of feedbackEntries) {
      const entrySource = normalizeText(entry.source || entry.sourceName || "");
      if (!entrySource || entrySource !== normalizedSource) {
        continue;
      }

      const entryTarget = normalizeText(entry.target || "all") || "all";
      if (entryTarget !== "all" && normalizedTarget !== "all" && entryTarget !== normalizedTarget) {
        continue;
      }

      const entryTokens = tokenizeQuestion(entry.message || "");
      const overlapCount = messageTokens.filter((token) => entryTokens.includes(token)).length;
      const overlapRatio = overlapCount / Math.max(1, Math.min(messageTokens.length, entryTokens.length || 1));
      if (overlapCount < 2 && overlapRatio < 0.5) {
        continue;
      }

      if (entry.isHelpful === true) {
        helpfulMatches += 1;
      } else if (entry.isHelpful === false) {
        harmfulMatches += 1;
      }
    }

    const netHelpful = Math.max(0, helpfulMatches - harmfulMatches);
    return {
      boost: Math.min(6, netHelpful * 2),
      helpfulMatches,
      harmfulMatches,
    };
  }
}

module.exports = LawChatbotFeedbackModel;
