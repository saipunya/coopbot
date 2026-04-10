const THAI_TO_ARABIC_DIGITS = {
  "๐": "0",
  "๑": "1",
  "๒": "2",
  "๓": "3",
  "๔": "4",
  "๕": "5",
  "๖": "6",
  "๗": "7",
  "๘": "8",
  "๙": "9",
};

const ARABIC_TO_THAI_DIGITS = {
  "0": "๐",
  "1": "๑",
  "2": "๒",
  "3": "๓",
  "4": "๔",
  "5": "๕",
  "6": "๖",
  "7": "๗",
  "8": "๘",
  "9": "๙",
};

const THAI_NUMBER_WORD_VALUES = {
  ศูนย์: 0,
  หนึ่ง: 1,
  เอ็ด: 1,
  สอง: 2,
  ยี่: 2,
  สาม: 3,
  สี่: 4,
  ห้า: 5,
  หก: 6,
  เจ็ด: 7,
  แปด: 8,
  เก้า: 9,
};

const THAI_NUMBER_MAGNITUDES = {
  สิบ: 10,
  ร้อย: 100,
  พัน: 1000,
  หมื่น: 10000,
  แสน: 100000,
  ล้าน: 1000000,
};

const THAI_NUMBER_TOKEN_ORDER = [
  "แสน",
  "หมื่น",
  "พัน",
  "ร้อย",
  "สิบ",
  "เอ็ด",
  "ศูนย์",
  "หนึ่ง",
  "สอง",
  "ยี่",
  "สาม",
  "สี่",
  "ห้า",
  "หก",
  "เจ็ด",
  "แปด",
  "เก้า",
  "ล้าน",
];

function thaiDigitsToArabic(text) {
  return String(text || "").replace(/[๐-๙]/g, (digit) => THAI_TO_ARABIC_DIGITS[digit] || digit);
}

function arabicDigitsToThai(text) {
  return String(text || "").replace(/[0-9]/g, (digit) => ARABIC_TO_THAI_DIGITS[digit] || digit);
}

function tokenizeThaiNumberWords(text) {
  const compact = String(text || "").replace(/\s+/g, "");
  if (!compact) {
    return [];
  }

  const tokens = [];
  let cursor = 0;

  while (cursor < compact.length) {
    let matchedToken = "";

    for (const token of THAI_NUMBER_TOKEN_ORDER) {
      if (compact.startsWith(token, cursor) && token.length > matchedToken.length) {
        matchedToken = token;
      }
    }

    if (!matchedToken) {
      return [];
    }

    tokens.push(matchedToken);
    cursor += matchedToken.length;
  }

  return tokens;
}

function parseThaiNumberWords(text) {
  const tokens = tokenizeThaiNumberWords(String(text || ""));
  if (tokens.length === 0) {
    return null;
  }

  let total = 0;
  let section = 0;
  let pendingUnit = null;

  for (const token of tokens) {
    if (Object.prototype.hasOwnProperty.call(THAI_NUMBER_MAGNITUDES, token)) {
      const magnitude = THAI_NUMBER_MAGNITUDES[token];
      if (magnitude === 1000000) {
        const millionBase = (section + (pendingUnit || 0)) || 1;
        total += millionBase * magnitude;
        section = 0;
        pendingUnit = null;
        continue;
      }

      const multiplier = pendingUnit !== null ? pendingUnit : 1;
      section += multiplier * magnitude;
      pendingUnit = null;
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(THAI_NUMBER_WORD_VALUES, token)) {
      pendingUnit = THAI_NUMBER_WORD_VALUES[token];
      continue;
    }

    return null;
  }

  if (pendingUnit !== null) {
    section += pendingUnit;
  }

  return String(total + section);
}

function replaceThaiNumberWords(text) {
  return String(text || "").replace(
    /(^|[^\p{L}\p{N}])((?:ศูนย์|หนึ่ง|เอ็ด|สอง|ยี่|สาม|สี่|ห้า|หก|เจ็ด|แปด|เก้า|สิบ|ร้อย|พัน|หมื่น|แสน|ล้าน)(?:\s*(?:ศูนย์|หนึ่ง|เอ็ด|สอง|ยี่|สาม|สี่|ห้า|หก|เจ็ด|แปด|เก้า|สิบ|ร้อย|พัน|หมื่น|แสน|ล้าน))*)(?=$|[^\p{L}\p{N}])/gu,
    (match, prefix, phrase) => {
      const parsed = parseThaiNumberWords(phrase);
      if (!parsed) {
        return match;
      }

      return `${prefix}${parsed}`;
    },
  );
}

function normalizeThaiNumberSearchText(text) {
  const normalized = String(text || "")
    .normalize("NFC")
    .replace(/\u0000/g, " ")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  if (!normalized) {
    return "";
  }

  return replaceThaiNumberWords(thaiDigitsToArabic(normalized)).trim();
}

function buildThaiNumberSearchVariants(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return [];
  }

  const normalized = normalizeThaiNumberSearchText(raw);
  const variants = [raw, thaiDigitsToArabic(raw), arabicDigitsToThai(raw), normalized];

  if (/^[0-9]+$/.test(normalized)) {
    variants.push(arabicDigitsToThai(normalized));
  } else if (/^[๐-๙]+$/.test(raw)) {
    variants.push(thaiDigitsToArabic(raw));
  }

  return [...new Set(variants.map((item) => String(item || "").trim()).filter(Boolean))];
}

function formatThaiLegalNumberForDisplay(value, options = {}) {
  const normalized = String(value ?? "").trim();
  const converted = options.useThaiDigits ? arabicDigitsToThai(normalized) : thaiDigitsToArabic(normalized);
  const prefix = String(options.prefix || "");
  const suffix = String(options.suffix || "");
  const rendered = prefix && converted.startsWith(prefix) ? converted : `${prefix}${converted}`;
  return `${rendered}${suffix}`;
}

module.exports = {
  arabicDigitsToThai,
  buildThaiNumberSearchVariants,
  formatThaiLegalNumberForDisplay,
  normalizeThaiNumberSearchText,
  thaiDigitsToArabic,
};
