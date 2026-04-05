const feedbackEntries = [];

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
}

module.exports = LawChatbotFeedbackModel;
