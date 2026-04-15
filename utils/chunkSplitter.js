const { normalizeThai } = require("./thaiNormalizer");

const DEFAULT_MIN_CHUNK_LENGTH = 80;
const DEFAULT_MAX_CHUNK_LENGTH = 350;
const DEFAULT_TARGET_CHUNK_LENGTH = 220;
const DEFAULT_MAX_CHUNKS = 12;

const STOPWORDS = new Set([
  "และ",
  "หรือ",
  "ของ",
  "ใน",
  "ที่",
  "ให้",
  "เป็น",
  "ได้",
  "มี",
  "ว่า",
  "กับ",
  "โดย",
  "ตาม",
  "เพื่อ",
  "จาก",
  "แก่",
  "แต่",
  "เมื่อ",
  "ซึ่ง",
  "นั้น",
  "ทุก",
  "ทุกคน",
  "คน",
  "จึง",
  "ต้อง",
  "อาจ",
  "ควร",
  "หาก",
  "ถ้า",
  "เพราะ",
  "ดังนั้น",
  "รวม",
  "ถึง",
  "ยัง",
  "แล้ว",
  "รวมทั้ง",
  "ทั้ง",
  "ดัง",
  "เป็นต้น",
  "อีก",
  "การ",
  "ความ",
  "เรื่อง",
  "ส่วน",
  "หรือไม่",
  "ไม่",
  "มาก",
  "น้อย",
  "ประมาณ",
  "เกี่ยวกับ",
  "สำหรับ",
  "แก่",
  "ภายใต้",
  "ต่อ",
  "ผ่าน",
]);

const KEYWORD_ANCHORS = [
  "โครงสร้างสหกรณ์",
  "คณะกรรมการดำเนินการ",
  "ผู้จัดการสหกรณ์",
  "เจ้าหน้าที่สหกรณ์",
  "ผู้ชำระบัญชี",
  "ผู้ตรวจสอบกิจการ",
  "นายทะเบียนสหกรณ์",
  "นายทะเบียน",
  "รองนายทะเบียนสหกรณ์",
  "รัฐมนตรี",
  "สมาชิกสมทบ",
  "สมาชิก",
  "ประชาธิปไตย",
  "สหกรณ์",
];

const BOUNDARY_MARKERS = [
  { phrase: "ตามพระราชบัญญัติ", priority: 100 },
  { phrase: "ตามกฎหมาย", priority: 95 },
  { phrase: "ตามข้อบังคับ", priority: 92 },
  { phrase: "กำหนดให้มี", priority: 90 },
  { phrase: "มีอำนาจหน้าที่", priority: 88 },
  { phrase: "มีหน้าที่", priority: 84 },
  { phrase: "คณะกรรมการดำเนินการควร", priority: 82 },
  { phrase: "คณะกรรมการดำเนินการอาจ", priority: 81 },
  { phrase: "ผู้จัดการสหกรณ์", priority: 80 },
  { phrase: "ผู้จัดการควร", priority: 79 },
  { phrase: "และผู้จัดการอาจ", priority: 78 },
  { phrase: "เพื่อช่วยเหลือ", priority: 77 },
  { phrase: "เพื่อให้", priority: 76 },
  { phrase: "ตามความเหมาะสม", priority: 75 },
  { phrase: "จึงต้อง", priority: 74 },
  { phrase: "จึง", priority: 68 },
  { phrase: "แต่ทุกคน", priority: 67 },
  { phrase: "สมาชิกทุกคน", priority: 66 },
  { phrase: "โครงสร้างของสหกรณ์", priority: 65 },
  { phrase: "คณะกรรมการดำเนินการ", priority: 62 },
  { phrase: "ผู้จัดการอาจ", priority: 60 },
  { phrase: "เจ้าหน้าที่โดยความเห็นชอบ", priority: 58 },
  { phrase: "สมาชิกมีสิทธิ", priority: 56 },
  { phrase: "สมาชิกมีหน้าที่", priority: 55 },
  { phrase: "ประชาธิปไตย", priority: 54 },
];

function normalizeChunkText(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function tokenizeThaiText(text) {
  const normalized = normalizeChunkText(text)
    .replace(/[^\p{L}\p{M}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

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

function countMeaningfulChars(text) {
  return (String(text || "").match(/[\p{L}\p{M}\p{N}]/gu) || []).length;
}

function isGarbageChunk(text) {
  const normalized = normalizeChunkText(text);
  if (!normalized) {
    return true;
  }

  const compact = normalizeThai(normalized);
  if (!compact) {
    return true;
  }

  const visibleLength = compact.replace(/\s+/g, "").length;
  if (visibleLength < 12) {
    return true;
  }

  if (/^[^\p{L}\p{M}\p{N}\s]+$/u.test(normalized)) {
    return true;
  }

  if (/^https?:\/\//i.test(normalized) || /^www\./i.test(normalized)) {
    return true;
  }

  if (/^[0-9\s.,\-\/()]+$/.test(compact)) {
    return true;
  }

  const alphaNumericCount = countMeaningfulChars(normalized);
  const symbolCount = normalized.length - alphaNumericCount - (normalized.match(/\s/g) || []).length;
  const symbolRatio = normalized.length > 0 ? symbolCount / normalized.length : 1;
  if (symbolRatio > 0.5) {
    return true;
  }

  const compactNoSpace = compact.replace(/\s+/g, "");
  if (compactNoSpace.length >= 8 && /^(.)\1{7,}$/.test(compactNoSpace)) {
    return true;
  }

  return false;
}

function getNormalizedTokensForMatch(text) {
  return uniqueTokens(tokenizeThaiText(text));
}

function phraseMatchScore(text, phrase) {
  const normalizedText = normalizeThai(text);
  const normalizedPhrase = normalizeThai(phrase);
  if (!normalizedText || !normalizedPhrase) {
    return 0;
  }

  if (normalizedText.includes(normalizedPhrase)) {
    return 1000 + normalizedPhrase.length;
  }

  const textTokens = new Set(getNormalizedTokensForMatch(text));
  const phraseTokens = getNormalizedTokensForMatch(phrase);
  if (phraseTokens.length === 0) {
    return 0;
  }

  const hits = phraseTokens.filter((token) => textTokens.has(token)).length;
  if (hits === 0) {
    return 0;
  }

  const coverage = hits / phraseTokens.length;
  return coverage * 100 + normalizedPhrase.length;
}

function matchesPhraseByTokens(text, phrase) {
  return phraseMatchScore(text, phrase) > 0;
}

function dedupeKeywordParts(parts) {
  const output = [];

  for (const part of parts) {
    const normalized = normalizeChunkText(part).replace(/\s+/g, " ").trim();
    if (!normalized) {
      continue;
    }

    const normalizedCompact = normalizeThai(normalized).replace(/\s+/g, "");
    if (!normalizedCompact) {
      continue;
    }

    const alreadyCovered = output.some((existing) => {
      const existingCompact = normalizeThai(existing).replace(/\s+/g, "");
      return (
        existing === normalized ||
        existingCompact === normalizedCompact ||
        existingCompact.includes(normalizedCompact) ||
        normalizedCompact.includes(existingCompact)
      );
    });

    if (!alreadyCovered) {
      output.push(normalized);
    }
  }

  return output;
}

function extractLeadingKeywordTokens(text, maxTokens = 6) {
  const tokens = tokenizeThaiText(text).filter((token) => !STOPWORDS.has(token));
  if (tokens.length === 0) {
    return "";
  }

  const selected = [];
  for (const token of tokens) {
    if (!selected.includes(token)) {
      selected.push(token);
    }
    if (selected.length >= maxTokens) {
      break;
    }
  }

  return selected.join(" ").trim();
}

function detectDescriptor(text) {
  const normalized = normalizeThai(text);
  if (!normalized) {
    return "";
  }

  if (/หมายความว่า|หมายถึง/.test(normalized)) {
    return "ความหมาย";
  }

  if (/มีอำนาจหน้าที่|อำนาจหน้าที่/.test(normalized)) {
    return "อำนาจหน้าที่";
  }

  if (/ประชาธิปไตย/.test(normalized) || /สมาชิกทุกคนเป็นเจ้าของ/.test(normalized)) {
    return "ประชาธิปไตย";
  }

  if (/กำหนดให้มี/.test(normalized) && /ไม่เกิน\s*\d+/.test(normalized)) {
    const quantityMatch = String(text || "").match(/ไม่เกิน\s*\d+\s*คน?/);
    if (quantityMatch) {
      return quantityMatch[0].replace(/\s+/g, " ").trim();
    }

    const countMatch = String(text || "").match(/\d+\s*คน?/);
    if (countMatch) {
      return countMatch[0].replace(/\s+/g, " ").trim();
    }

    return "กำหนดจำนวน";
  }

  if (/กำหนดให้มี/.test(normalized) && /คณะกรรมการดำเนินการ/.test(normalized)) {
    return "คณะกรรมการดำเนินการ";
  }

  if (/ควรจัดจ้างผู้จัดการ/.test(normalized) || /ผู้จัดการอาจจัดจ้างเจ้าหน้าที่/.test(normalized)) {
    return "ผู้จัดการสหกรณ์";
  }

  if (/เจ้าหน้าที่โดยความเห็นชอบ/.test(normalized) || /จัดจ้างเจ้าหน้าที่/.test(normalized)) {
    return "เจ้าหน้าที่สหกรณ์";
  }

  if (/นายทะเบียนสหกรณ์/.test(normalized) || /นายทะเบียน/.test(normalized)) {
    return "นายทะเบียนสหกรณ์";
  }

  if (/ผู้ชำระบัญชี/.test(normalized) || /ชำระบัญชี/.test(normalized)) {
    return "การชำระบัญชี";
  }

  if (/เลิกสหกรณ์/.test(normalized)) {
    return "การเลิกสหกรณ์";
  }

  if (/คณะกรรมการดำเนินการ/.test(normalized)) {
    return "คณะกรรมการดำเนินการ";
  }

  if (/ผู้จัดการสหกรณ์/.test(normalized) || /ผู้จัดการ/.test(normalized)) {
    return "ผู้จัดการสหกรณ์";
  }

  if (/เจ้าหน้าที่สหกรณ์/.test(normalized) || /เจ้าหน้าที่/.test(normalized)) {
    return "เจ้าหน้าที่สหกรณ์";
  }

  if (/สมาชิกสมทบ/.test(normalized)) {
    return "สมาชิกสมทบ";
  }

  if (/สมาชิก/.test(normalized)) {
    return "สมาชิก";
  }

  if (/รัฐมนตรี/.test(normalized)) {
    return "รัฐมนตรี";
  }

  if (/สหกรณ์/.test(normalized)) {
    return "สหกรณ์";
  }

  return "";
}

function findBestAnchor(text, context = {}) {
  const candidateAnchors = [];
  const baseKeyword = normalizeChunkText(context.baseKeyword || context.topic || "");
  if (baseKeyword) {
    candidateAnchors.push(baseKeyword);
  }
  candidateAnchors.push(...KEYWORD_ANCHORS);

  let bestAnchor = "";
  let bestScore = 0;

  for (const anchor of candidateAnchors) {
    const score = phraseMatchScore(text, anchor);
    if (score > bestScore) {
      bestScore = score;
      bestAnchor = normalizeChunkText(anchor).replace(/\s+/g, " ").trim();
    }
  }

  return bestAnchor;
}

function generateKeywordFromChunk(chunkText, context = {}) {
  const text = normalizeChunkText(chunkText);
  if (!text) {
    return normalizeChunkText(context.baseKeyword || context.topic || "").slice(0, 255);
  }

  const baseKeyword = normalizeChunkText(context.baseKeyword || context.topic || "");
  const bestAnchor = findBestAnchor(text, context);
  const descriptor = detectDescriptor(text);
  const keywordParts = [];
  const baseKeywordRelevant = baseKeyword && matchesPhraseByTokens(text, baseKeyword);

  if (baseKeywordRelevant) {
    keywordParts.push(baseKeyword);
  }

  if (bestAnchor) {
    keywordParts.push(bestAnchor);
  }

  if (descriptor) {
    keywordParts.push(descriptor);
  }

  if (keywordParts.length === 0 && baseKeyword) {
    keywordParts.push(baseKeyword);
  }

  if (keywordParts.length === 0) {
    const leadingTokens = extractLeadingKeywordTokens(text, 6);
    if (leadingTokens) {
      keywordParts.push(leadingTokens);
    }
  }

  const dedupedParts = dedupeKeywordParts(keywordParts);
  const keyword = dedupedParts.join(" ").replace(/\s+/g, " ").trim();

  return keyword.slice(0, 255);
}

function splitTextByMarkers(text, markers, targetLength, minLength) {
  const breaks = new Set([0, text.length]);
  const normalizedMarkers = Array.isArray(markers) ? markers : [];

  for (const marker of normalizedMarkers) {
    const phrase = String(marker?.phrase || marker || "").trim();
    if (!phrase) {
      continue;
    }

    let searchIndex = 0;
    while (searchIndex < text.length) {
      const foundIndex = text.indexOf(phrase, searchIndex);
      if (foundIndex === -1) {
        break;
      }

      if (foundIndex > 0 && foundIndex < text.length) {
        breaks.add(foundIndex);
      }

      searchIndex = foundIndex + phrase.length;
    }
  }

  const orderedBreaks = Array.from(breaks).sort((a, b) => a - b);
  const filteredBreaks = [orderedBreaks[0]];

  for (let index = 1; index < orderedBreaks.length - 1; index += 1) {
    const current = orderedBreaks[index];
    const previous = filteredBreaks[filteredBreaks.length - 1];
    const remaining = text.length - current;
    if (current - previous < Math.max(20, Math.floor(minLength * 0.5))) {
      continue;
    }
    if (remaining < Math.max(20, Math.floor(minLength * 0.5))) {
      continue;
    }
    filteredBreaks.push(current);
  }

  if (filteredBreaks[filteredBreaks.length - 1] !== text.length) {
    filteredBreaks.push(text.length);
  }

  if (filteredBreaks.length < 2) {
    return [text];
  }

  const segments = [];
  for (let index = 0; index < filteredBreaks.length - 1; index += 1) {
    const start = filteredBreaks[index];
    const end = filteredBreaks[index + 1];
    const segment = text.slice(start, end).trim();
    if (segment) {
      segments.push(segment);
    }
  }

  if (segments.length === 0) {
    return [text];
  }

  return segments;
}

function findBestFallbackSplitIndex(text, targetLength, minLength, maxLength) {
  const safeTarget = Math.max(minLength, Math.min(maxLength, targetLength));
  const searchRadius = Math.max(24, Math.floor((maxLength - minLength) / 2));
  let bestIndex = -1;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const marker of BOUNDARY_MARKERS) {
    const phrase = String(marker.phrase || "").trim();
    if (!phrase) {
      continue;
    }

    let searchIndex = 0;
    while (searchIndex < text.length) {
      const foundIndex = text.indexOf(phrase, searchIndex);
      if (foundIndex === -1) {
        break;
      }

      if (foundIndex >= minLength && foundIndex <= text.length - minLength) {
        const score = Math.abs(foundIndex - safeTarget) - marker.priority;
        if (score < bestScore) {
          bestScore = score;
          bestIndex = foundIndex;
        }
      }

      searchIndex = foundIndex + phrase.length;
    }
  }

  if (bestIndex !== -1) {
    return bestIndex;
  }

  const start = Math.max(minLength, safeTarget - searchRadius);
  const end = Math.min(text.length - minLength, safeTarget + searchRadius);

  for (let offset = 0; offset <= searchRadius; offset += 1) {
    const leftIndex = safeTarget - offset;
    const rightIndex = safeTarget + offset;

    if (leftIndex >= start && leftIndex <= end && /\s/.test(text[leftIndex])) {
      return leftIndex;
    }

    if (rightIndex >= start && rightIndex <= end && /\s/.test(text[rightIndex])) {
      return rightIndex;
    }
  }

  for (let index = start; index <= end; index += 1) {
    if (/\s/.test(text[index])) {
      return index;
    }
  }

  return -1;
}

function splitLongSegment(segment, options = {}) {
  const text = normalizeChunkText(segment);
  if (!text) {
    return [];
  }

  const minLength = Math.max(20, Number(options.minLength || DEFAULT_MIN_CHUNK_LENGTH));
  const maxLength = Math.max(minLength, Number(options.maxLength || DEFAULT_MAX_CHUNK_LENGTH));
  const targetLength = Math.max(minLength, Math.min(maxLength, Number(options.targetLength || DEFAULT_TARGET_CHUNK_LENGTH)));

  if (text.length <= maxLength) {
    return [text];
  }

  const splitIndex = findBestFallbackSplitIndex(text, targetLength, minLength, maxLength);
  if (splitIndex <= 0 || splitIndex >= text.length) {
    return [text];
  }

  const left = text.slice(0, splitIndex).trim();
  const right = text.slice(splitIndex).trim();

  if (!left || !right) {
    return [text];
  }

  const leftParts = left.length > maxLength ? splitLongSegment(left, options) : [left];
  const rightParts = right.length > maxLength ? splitLongSegment(right, options) : [right];
  return [...leftParts, ...rightParts];
}

function normalizeChunkItem(chunk, index) {
  if (typeof chunk === "string") {
    return {
      chunkText: normalizeChunkText(chunk),
      sourceIndices: [index],
    };
  }

  const chunkText = normalizeChunkText(chunk?.chunkText || chunk?.text || "");
  return {
    ...chunk,
    chunkText,
    sourceIndices: Array.isArray(chunk?.sourceIndices)
      ? [...chunk.sourceIndices]
      : [index],
  };
}

function shouldMergeChunks(previousText, currentText, options = {}) {
  const minLength = Math.max(20, Number(options.minLength || DEFAULT_MIN_CHUNK_LENGTH));
  const maxLength = Math.max(minLength, Number(options.maxLength || DEFAULT_MAX_CHUNK_LENGTH));
  const mergeBelowLength = Math.max(
    20,
    Number(options.mergeBelowLength || Math.floor(minLength * 0.6) || 45),
  );

  if (!previousText || !currentText) {
    return false;
  }

  if (previousText.length + currentText.length > maxLength) {
    return false;
  }

  if (previousText.length <= mergeBelowLength || currentText.length <= mergeBelowLength) {
    return true;
  }

  if (/[,:;、，]\s*$/u.test(previousText)) {
    return true;
  }

  if (/^(?:และ|แต่|เพื่อ|โดย|ตาม|จึง|ซึ่ง|ที่|ให้|แล้ว)\b/u.test(currentText)) {
    return true;
  }

  if (/(?:และ|เพื่อ|โดย|ตาม|จึง|ซึ่ง|ที่|ให้|แล้ว)\s*$/u.test(previousText)) {
    return true;
  }

  return false;
}

function maybeMergeNeighborChunks(chunks, options = {}) {
  const items = Array.isArray(chunks) ? chunks.map((chunk, index) => normalizeChunkItem(chunk, index)) : [];
  if (items.length <= 1) {
    return items;
  }

  const merged = [];

  for (const item of items) {
    if (isGarbageChunk(item.chunkText)) {
      continue;
    }

    if (merged.length === 0) {
      merged.push({ ...item });
      continue;
    }

    const previous = merged[merged.length - 1];
    if (shouldMergeChunks(previous.chunkText, item.chunkText, options)) {
      previous.chunkText = normalizeChunkText(`${previous.chunkText} ${item.chunkText}`);
      previous.cleanText = normalizeThai(previous.chunkText);
      previous.sourceIndices = uniqueTokens([...(previous.sourceIndices || []), ...(item.sourceIndices || [])]);
      continue;
    }

    merged.push({ ...item });
  }

  return merged;
}

function splitParagraphIntoSegments(paragraph, options = {}) {
  const text = normalizeChunkText(paragraph);
  if (!text) {
    return [];
  }

  const minLength = Math.max(20, Number(options.minLength || DEFAULT_MIN_CHUNK_LENGTH));
  const maxLength = Math.max(minLength, Number(options.maxLength || DEFAULT_MAX_CHUNK_LENGTH));
  const targetLength = Math.max(minLength, Math.min(maxLength, Number(options.targetLength || DEFAULT_TARGET_CHUNK_LENGTH)));

  const punctuationPieces = text
    .split(/(?<=[!?;:ฯ])\s+/u)
    .map((piece) => piece.trim())
    .filter(Boolean);

  const basePieces = [];

  for (const piece of punctuationPieces) {
    if (piece.length <= maxLength) {
      basePieces.push(piece);
      continue;
    }

    const markerPieces = splitTextByMarkers(piece, BOUNDARY_MARKERS, targetLength, minLength);
    for (const markerPiece of markerPieces) {
      if (markerPiece.length <= maxLength) {
        basePieces.push(markerPiece);
      } else {
        basePieces.push(...splitLongSegment(markerPiece, options));
      }
    }
  }

  if (basePieces.length === 0) {
    basePieces.push(text);
  }

  const normalizedPieces = [];
  for (const piece of basePieces) {
    const cleaned = normalizeChunkText(piece);
    if (!cleaned) {
      continue;
    }
    if (cleaned.length > maxLength) {
      normalizedPieces.push(...splitLongSegment(cleaned, options));
      continue;
    }
    normalizedPieces.push(cleaned);
  }

  return normalizedPieces;
}

function splitIntoKnowledgeChunks(text, options = {}) {
  const normalizedText = normalizeChunkText(text);
  if (!normalizedText) {
    return [];
  }

  const baseKeyword = normalizeChunkText(options.baseKeyword || options.topic || "");
  const minLength = Math.max(20, Number(options.minLength || DEFAULT_MIN_CHUNK_LENGTH));
  const maxLength = Math.max(minLength, Number(options.maxLength || DEFAULT_MAX_CHUNK_LENGTH));
  const targetLength = Math.max(minLength, Math.min(maxLength, Number(options.targetLength || DEFAULT_TARGET_CHUNK_LENGTH)));
  const maxChunks = Math.max(1, Number(options.maxChunks || DEFAULT_MAX_CHUNKS));

  const paragraphs = normalizedText
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const rawSegments = [];
  for (const paragraph of paragraphs) {
    rawSegments.push(...splitParagraphIntoSegments(paragraph, { minLength, maxLength, targetLength }));
  }

  const mergedSegments = maybeMergeNeighborChunks(
    rawSegments.map((chunkText, index) => ({
      chunkText,
      sourceIndices: [index],
    })),
    { minLength, maxLength, mergeBelowLength: Math.floor(minLength * 0.6) },
  );

  const filteredSegments = mergedSegments
    .map((item) => normalizeChunkText(item.chunkText))
    .filter((chunkText) => chunkText && !isGarbageChunk(chunkText));

  const limitedSegments = filteredSegments.slice(0, maxChunks);

  return limitedSegments.map((chunkText, index) => {
    const keyword = generateKeywordFromChunk(chunkText, {
      baseKeyword,
      topic: options.topic || baseKeyword,
      index,
      totalChunks: limitedSegments.length,
    });

    return {
      keyword,
      chunkText,
      cleanText: normalizeThai(chunkText),
      index,
      length: chunkText.length,
    };
  });
}

module.exports = {
  generateKeywordFromChunk,
  isGarbageChunk,
  maybeMergeNeighborChunks,
  normalizeChunkText,
  splitIntoKnowledgeChunks,
};
