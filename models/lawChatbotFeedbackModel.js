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

  static list() {
    return feedbackEntries.slice(0, 10);
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
