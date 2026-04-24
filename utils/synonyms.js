const { normalizeThai } = require("./thaiNormalizer");
const QUERY_SYNONYMS = require("../config/querySynonyms");

const SYNONYM_DICTIONARY = Object.freeze({});

function expandKeywords(keyword) {
  const normalizedKeyword = normalizeThai(keyword);
  if (!normalizedKeyword) {
    return [];
  }

  const expanded = new Set([normalizedKeyword]);
  const rules = Array.isArray(QUERY_SYNONYMS) ? QUERY_SYNONYMS : [];

  rules.forEach((rule) => {
    const triggers = Array.isArray(rule?.triggers)
      ? rule.triggers.map((term) => normalizeThai(term)).filter(Boolean)
      : [];
    const unless = Array.isArray(rule?.unless)
      ? rule.unless.map((term) => normalizeThai(term)).filter(Boolean)
      : [];
    const additions = Array.isArray(rule?.additions)
      ? rule.additions.map((term) => normalizeThai(term)).filter(Boolean)
      : [];
    const allTerms = [...triggers, ...additions];
    const matchesTerm = allTerms.some((term) => term && normalizedKeyword.includes(term));

    if (!matchesTerm) {
      return;
    }

    if (unless.some((term) => term && normalizedKeyword.includes(term))) {
      return;
    }

    additions.forEach((term) => {
      if (term) {
        expanded.add(term);
      }
    });
  });

  return Array.from(expanded);
}

module.exports = {
  SYNONYM_DICTIONARY,
  expandKeywords,
};
