const crypto = require("crypto");
const { normalizeForSearch } = require("./thaiTextUtils");

function normalizeQuestionForAnswerCache(message) {
  return normalizeForSearch(String(message || ""))
    .toLowerCase()
    .replace(/[!?.,;:()[\]{}"'`~@#$%^&*+=_|\\/<>-]+/g, " ")
    .replace(/([ก-๙])\s+([ก-๙])/g, "$1$2")
    .replace(/^(?:การ|เรื่อง|เกี่ยวกับ|กรณี)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildQuestionHash(target, normalizedQuestion, scopeKey = "") {
  return crypto
    .createHash("sha256")
    .update(
      [
        String(target || "all").trim(),
        String(scopeKey || "").trim(),
        String(normalizedQuestion || "").trim(),
      ].join("::"),
    )
    .digest("hex");
}

function buildQuestionCacheIdentity(message, target, scopeKey = "") {
  const normalizedQuestion = normalizeQuestionForAnswerCache(message);
  return {
    normalizedQuestion,
    questionHash: normalizedQuestion ? buildQuestionHash(target, normalizedQuestion, scopeKey) : "",
  };
}

module.exports = {
  normalizeQuestionForAnswerCache,
  buildQuestionHash,
  buildQuestionCacheIdentity,
};
