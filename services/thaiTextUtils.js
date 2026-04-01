const SEARCH_CONCEPT_EXPANSIONS = [
  {
    triggers: ["ประชุมใหญ่สามัญประจำปี"],
    additions: ["ประชุมใหญ่", "ประชุมใหญ่สามัญประจำปี"],
  },
  {
    triggers: ["ประชุมใหญ่วิสามัญ"],
    additions: ["ประชุมใหญ่", "ประชุมใหญ่วิสามัญ"],
  },
  {
    triggers: ["ประชุมใหญ่"],
    unless: ["ประชุมใหญ่สามัญประจำปี", "ประชุมใหญ่วิสามัญ"],
    additions: ["ประชุมใหญ่", "ประชุมใหญ่สามัญประจำปี", "ประชุมใหญ่วิสามัญ"],
  },
  {
    triggers: ["ประชุมกรรมการ", "ประชุมคณะกรรมการ", "ประชุมคณะกรรมการดำเนินการ"],
    additions: ["ประชุมกรรมการ", "ประชุมคณะกรรมการ", "ประชุมคณะกรรมการดำเนินการ"],
  },
];
const EXCLUSIVE_MEANING_RULES = [
  {
    primary: "นายทะเบียนสหกรณ์",
    conflicts: ["รองนายทะเบียนสหกรณ์"],
  },
  {
    primary: "รองนายทะเบียนสหกรณ์",
    conflicts: ["นายทะเบียนสหกรณ์"],
  },
  {
    primary: "สมาชิก",
    conflicts: ["สมาชิกสมทบ"],
  },
  {
    primary: "สมาชิกสมทบ",
    conflicts: ["สมาชิก"],
  },
  {
    primary: "ผู้ตรวจสอบกิจการ",
    conflicts: ["ผู้สอบบัญชี"],
  },
  {
    primary: "ผู้สอบบัญชี",
    conflicts: ["ผู้ตรวจสอบกิจการ"],
  },
];

function normalizeForSearch(text) {
  return String(text || "")
    .replace(/\u0000/g, " ")
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function expandSearchConcepts(text) {
  const normalized = normalizeForSearch(text).toLowerCase();
  if (!normalized) {
    return "";
  }

  const phrases = [normalized];

  for (const rule of SEARCH_CONCEPT_EXPANSIONS) {
    const triggers = Array.isArray(rule.triggers) ? rule.triggers : [];
    const unless = Array.isArray(rule.unless) ? rule.unless : [];
    const matched = triggers.some((trigger) => normalized.includes(String(trigger || "").trim().toLowerCase()));

    if (!matched) {
      continue;
    }

    const blocked = unless.some((trigger) => normalized.includes(String(trigger || "").trim().toLowerCase()));
    if (blocked) {
      continue;
    }

    const additions = Array.isArray(rule.additions) ? rule.additions : [];
    additions.forEach((phrase) => {
      const cleaned = normalizeForSearch(phrase).toLowerCase();
      if (cleaned) {
        phrases.push(cleaned);
      }
    });
  }

  return [...new Set(phrases)].join(" ");
}

function hasExclusiveMeaningMismatch(query, text) {
  const normalizedQuery = normalizeForSearch(query).toLowerCase();
  const normalizedText = normalizeForSearch(text).toLowerCase();
  if (!normalizedQuery || !normalizedText) {
    return false;
  }

  return EXCLUSIVE_MEANING_RULES.some((rule) => {
    const primary = normalizeForSearch(rule.primary).toLowerCase();
    const conflicts = Array.isArray(rule.conflicts)
      ? rule.conflicts
          .map((phrase) => normalizeForSearch(phrase).toLowerCase())
          .filter(Boolean)
      : [];
    if (!primary || !normalizedQuery.includes(primary)) {
      return false;
    }

    const queryWithoutPrimary = normalizedQuery.split(primary).join(" ");
    const queryContainsExplicitConflict = conflicts.some((phrase) => {
      if (!normalizedQuery.includes(phrase)) {
        return false;
      }

      if (!primary.includes(phrase)) {
        return true;
      }

      return queryWithoutPrimary.includes(phrase);
    });
    if (queryContainsExplicitConflict) {
      return false;
    }

    const conflictsContainingPrimary = conflicts.filter((phrase) => phrase.includes(primary));
    let textContainsPrimary = normalizedText.includes(primary);
    if (textContainsPrimary && conflictsContainingPrimary.some((phrase) => normalizedText.includes(phrase))) {
      const textWithoutOverlappingConflicts = conflictsContainingPrimary.reduce((buffer, phrase) => {
        return buffer.split(phrase).join(" ");
      }, normalizedText);
      textContainsPrimary = textWithoutOverlappingConflicts.includes(primary);
    }

    if (textContainsPrimary) {
      return false;
    }

    return conflicts.some((phrase) => normalizedText.includes(phrase));
  });
}

function segmentWords(text) {
  const normalized = expandSearchConcepts(text);

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
  expandSearchConcepts,
  hasExclusiveMeaningMismatch,
  makeBigrams,
  normalizeForSearch,
  segmentWords,
  uniqueTokens,
};
