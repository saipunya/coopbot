function normalizeForSearch(text) {
  return String(text || "")
    .replace(/\u0000/g, " ")
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function segmentWords(text) {
  const normalized = normalizeForSearch(text);

  if (!normalized) {
    return [];
  }

  const segmenter = new Intl.Segmenter("th", { granularity: "word" });
  const tokens = [];

  for (const segment of segmenter.segment(normalized)) {
    const token = String(segment.segment || "").trim().toLowerCase();
    if (!token) {
      continue;
    }
    if (/^[^\p{L}\p{M}\p{N}]+$/u.test(token)) {
      continue;
    }
    tokens.push(token);
  }

  return tokens;
}

function uniqueTokens(tokens) {
  return [...new Set((tokens || []).filter(Boolean))];
}

function makeBigrams(tokens) {
  const bigrams = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    bigrams.push(`${tokens[index]} ${tokens[index + 1]}`);
  }
  return bigrams;
}

module.exports = {
  makeBigrams,
  normalizeForSearch,
  segmentWords,
  uniqueTokens,
};
