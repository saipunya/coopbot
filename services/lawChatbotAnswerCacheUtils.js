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

function buildQuestionHash(target, normalizedQuestion) {
  return crypto
    .createHash("sha256")
    .update(`${String(target || "all").trim()}::${String(normalizedQuestion || "").trim()}`)
    .digest("hex");
}

function buildQuestionCacheIdentity(message, target) {
  const normalizedQuestion = normalizeQuestionForAnswerCache(message);
  return {
    normalizedQuestion,
    questionHash: normalizedQuestion ? buildQuestionHash(target, normalizedQuestion) : "",
  };
}

module.exports = {
  normalizeQuestionForAnswerCache,
  buildQuestionHash,
  buildQuestionCacheIdentity,
};
