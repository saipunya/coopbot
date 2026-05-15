const CHATBOT_DATASET_TYPES = Object.freeze([
  "feedback",
  "search",
  "search_history",
  "search_miss",
  "event",
]);

const CHATBOT_FEEDBACK_LABELS = Object.freeze([
  "helpful",
  "needs_improvement",
  "unknown",
]);

const CHATBOT_SEARCH_LABELS = Object.freeze([
  "route_db",
  "route_ai",
]);

const CHATBOT_MISS_LABELS = Object.freeze([
  "needs_coverage",
]);

function normalizeLabelValue(value, fallback = "unknown") {
  const text = String(value || "").trim();
  if (!text) {
    return fallback;
  }

  return text.toLowerCase().replace(/\s+/g, "_");
}

module.exports = {
  CHATBOT_DATASET_TYPES,
  CHATBOT_FEEDBACK_LABELS,
  CHATBOT_SEARCH_LABELS,
  CHATBOT_MISS_LABELS,
  normalizeLabelValue,
};
