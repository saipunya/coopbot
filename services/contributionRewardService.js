const LawChatbotKnowledgeSuggestionModel = require("../models/lawChatbotKnowledgeSuggestionModel");
const { normalizePlanCode } = require("./planService");

async function getContributionRewardSummary(user = {}) {
  const planCode = normalizePlanCode(user.plan || "free");
  const userId = Number(user.userId || user.id || 0);

  if (planCode !== "free" || !userId) {
    return {
      eligible: false,
      approvedContributionCount: 0,
      bonusQuestionLimit: 0,
    };
  }

  const approvedContributionCount = await LawChatbotKnowledgeSuggestionModel.countApprovedByContributor({
    userId,
  });

  return {
    eligible: true,
    approvedContributionCount,
    bonusQuestionLimit: approvedContributionCount,
  };
}

module.exports = {
  getContributionRewardSummary,
};