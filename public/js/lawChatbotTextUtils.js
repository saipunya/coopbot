(function (root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.CoopbotLawChatbotTextUtils = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function () {
  function buildHighlightTerms(query) {
    const source = String(query || "").trim();
    if (!source) return [];

    const terms = new Set([source]);
    source
      .split(/\s+/)
      .map((part) => part.trim())
      .filter((part) => part.length >= 2)
      .forEach((part) => terms.add(part));

    return Array.from(terms).sort((a, b) => b.length - a.length);
  }

  function replaceUserVisibleAiTerms(text) {
    return String(text || "").replace(/\bsuper bot\b/gi, "AI");
  }

  function normalizeProtectedDisplayLineBreaks(text) {
    return String(text || "")
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
      .replace(
        /((?:พ\.ศ\.?|ค\.ศ\.?|(?:[\u0E01-\u0E2E]{1,2}\.){2,}))\s*[\r\n]+\s*(?=[0-9๐-๙]{4}(?:\b|$))/gu,
        "$1"
      );
  }

  function shouldBreakBeforeClauseMarker(contextText, currentLineText) {
    const context = String(contextText || "").replace(/\s+/g, " ").trim();
    const currentLine = String(currentLineText || "").replace(/\s+/g, " ").trim();

    if (!context) {
      return false;
    }

    if (/(?:ตาม|ในกรณีตาม|ตามข้อ|ตามวรรค|ตามอนุมาตรา|หรือ)\s*$/u.test(context)) {
      return false;
    }

    if (
      /^(?:ข้อ|มาตรา|หมวด|ส่วน|บท)\s*[0-9๐-๙]+(?:\/[0-9๐-๙]+)?(?:\s|$)/u.test(currentLine) &&
      !/[0-9๐-๙]\s*$/u.test(currentLine)
    ) {
      return true;
    }

    if (
      /(?:ดังนี้|ดังต่อไปนี้|ต่อไปนี้|มีกรณีดังต่อไปนี้|มีเหตุดังต่อไปนี้|เหตุหนึ่งเหตุใดต่อไปนี้|ได้แก่)\s*$/u.test(
        context,
      )
    ) {
      return true;
    }

    return /^\([0-9๐-๙]{1,3}\)/u.test(currentLine);
  }

  function normalizeClauseMarkerLineBreaks(text) {
    const raw = String(text || "");
    if (!raw) {
      return raw;
    }

    let result = "";
    let lastIndex = 0;
    const markerPattern = /\s+\([0-9๐-๙]{1,3}\)/gu;

    raw.replace(markerPattern, (match, offset) => {
      const leadingSegment = raw.slice(lastIndex, offset);
      result += leadingSegment;

      const contextText = result.slice(-80);
      const currentLineText = result.split("\n").pop() || "";
      const markerText = String(match || "").trim();

      if (shouldBreakBeforeClauseMarker(contextText, currentLineText)) {
        result = result.replace(/[ \t]+$/g, "");
        result += `\n${markerText}`;
      } else {
        result += ` ${markerText}`;
      }

      lastIndex = offset + match.length;
      return match;
    });

    result += raw.slice(lastIndex);
    return result;
  }

  function shouldBreakBeforeDisplayListMarker(contextText, markerText) {
    const context = String(contextText || "").replace(/\s+/g, " ").trim();
    const marker = String(markerText || "").trim();
    if (!context || !marker) {
      return false;
    }

    if (/(?:ตาม|ในกรณีตาม|ตามข้อ|ตามวรรค|ตามอนุมาตรา|มาตรา|วรรค|อนุมาตรา|หรือ|และ|พ\.ศ\.?|ค\.ศ\.?|วันที่|เลขที่|ครั้งที่)\s*$/u.test(context)) {
      return false;
    }

    return true;
  }

  function normalizeDisplayListMarkerLineBreaks(text) {
    const raw = String(text || "");
    if (!raw) {
      return raw;
    }

    return raw.replace(
      /([^\n])\s+((?:[0-9๐-๙]{1,3}[.)])|(?:ข้อ\s*[0-9๐-๙]{1,3}[.)]?))(?=\s*[^\s])/gu,
      (match, prefix, marker, offset, fullText) => {
        const context = String(fullText || "").slice(Math.max(0, Number(offset || 0) - 80), Number(offset || 0));
        if (!shouldBreakBeforeDisplayListMarker(context, marker)) {
          return match;
        }

        return `${prefix}\n${marker}`;
      },
    );
  }

  function sanitizeDisplayText(text) {
    return normalizeDisplayListMarkerLineBreaks(
      normalizeClauseMarkerLineBreaks(replaceUserVisibleAiTerms(normalizeProtectedDisplayLineBreaks(text)))
    )
      .replace(/(^|\n)\s*ข้อมูลที่พบจากฐานข้อมูลกฎหมาย(?:\s*\([^)]*\))?:?\s*(?=\n|$)/gu, "$1")
      .replace(/(^|\n)\s*\/\/\s*/g, "$1")
      .replace(/(^|[\s(])\/\/(?=[\s)]|$)/g, "$1")
      .replace(/[ \t]{2,}/g, " ")
      .replace(
        /(มาตรา\s*[0-9๐-๙]+(?:\/[0-9๐-๙]+)?)\s*(?:\r?\n\s*)?((?:\([0-9๐-๙]{1,3}\)\s*){1,})/gu,
        (_, sectionRef, subsectionRefs) => `${sectionRef}${String(subsectionRefs || "").replace(/\s+/g, "")}`,
      )
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function stripBotUiNoiseText(text) {
    const raw = String(text || "")
      .replace(/\r\n?/g, "\n")
      .trim();
    if (!raw) {
      return raw;
    }

    const noisePatterns = [
      /^หากต้องการ(?:เจาะลึกต่อ|ข้อมูลเพิ่มเติม|เพิ่มเติม)\s*พิมพ์:/iu,
      /^(?:คำอธิบายเพิ่มเติม|อธิบายเพิ่มเติม|แสดงรายละเอียด|รายละเอียด|ใจความทั้งหมด|ฉันไม่เข้าใจ|แจ้งเพิ่มเติม)$/iu,
    ];

    const filteredLines = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !noisePatterns.some((pattern) => pattern.test(line)));

    return filteredLines.join("\n").trim();
  }

  function shouldMergeBulletContinuationLine(currentLine, nextLine) {
    const current = sanitizeDisplayText(currentLine).replace(/\s+/g, " ").trim();
    const next = sanitizeDisplayText(nextLine).replace(/\s+/g, " ").trim();

    if (!current || !next) {
      return false;
    }

    const endsWithProtectedAbbreviation =
      /(?:พ\.ศ\.?|ค\.ศ\.?|(?:[\u0E01-\u0E2E]{1,2}\.){2,})$/u.test(current);
    const nextStartsWithYear =
      /^(?:[0-9๐-๙]{4})(?:\b|$)/u.test(next);

    return endsWithProtectedAbbreviation && nextStartsWithYear;
  }

  function mergeProtectedBulletLines(lines) {
    const merged = [];

    for (let index = 0; index < lines.length; index += 1) {
      const current = String(lines[index] || "").trim();
      const next = String(lines[index + 1] || "").trim();

      if (!current) {
        continue;
      }

      if (next && shouldMergeBulletContinuationLine(current, next)) {
        merged.push(`${current} ${next}`.replace(/\s+/g, " ").trim());
        index += 1;
        continue;
      }

      merged.push(current);
    }

    return merged;
  }

  function extractReferenceLines(referenceText) {
    return sanitizeDisplayText(referenceText)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replace(/^-\s*/, "").trim())
      .filter(Boolean);
  }

  function normalizeSourceReferencesForDisplay(sourceReferences) {
    if (!Array.isArray(sourceReferences)) return "";

    return sourceReferences
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (!item || typeof item !== "object") return "";
        const label = String(item.sourceLabel || item.source || "").trim();
        const reference = String(item.reference || item.title || item.keyword || "").trim();
        return [label, reference].filter(Boolean).join(": ");
      })
      .filter(Boolean)
      .join("\n");
  }

  function isPresentationLine(line) {
    return /^(?:ตามประเด็น\s*["“]|สำหรับ\s*["“]|เรื่อง\s*["“]|หากมีข้อสงสัยเพิ่มเติม|หากต้องการรายละเอียดเพิ่มเติม|ถ้ายังงงตรงไหน)/u.test(
      String(line || "").trim(),
    );
  }

  function splitPresentationAndBodyText(text) {
    const presentation = [];
    const body = [];
    String(text || "")
      .split("\n")
      .forEach((line) => {
        if (isPresentationLine(line)) {
          presentation.push(line);
        } else {
          body.push(line);
        }
      });

    return {
      presentationText: presentation.join("\n").trim(),
      bodyText: body.join("\n").trim(),
    };
  }

  function splitSummaryIntoBullets(text) {
    const raw = sanitizeDisplayText(text);
    if (!raw) return [];

    const explicitLines = mergeProtectedBulletLines(raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean));

    if (explicitLines.length > 1) {
      return explicitLines;
    }

    const normalized = raw.replace(/\s+/g, " ").trim();
    const numberedMatches = normalized.match(/(?:\(?\d+\)|\d+\.)\s*[^0-9]+(?=(?:\s+\(?\d+\)|\s+\d+\.|$))/g);
    const numberedParts = (numberedMatches || [])
      .map((line) => line.replace(/^(\(?\d+\)|\d+\.)\s*/, "").trim())
      .filter((line) => line.length >= 4);

    if (numberedParts.length > 1) {
      return numberedParts;
    }

    return [normalized];
  }

  function extractAdditionalInfoParts(text) {
    const raw = String(text || "").trim();
    const markerMatch = raw.match(/(^|\n)\s*(?:เพิ่มเติมจากข้อมูลอื่น|ข้อมูลเพิ่มเติม)\s*:\s*/i);
    if (!markerMatch || typeof markerMatch.index !== "number") {
      return {
        mainText: raw,
        additionalText: "",
      };
    }

    const leadingBreak = String(markerMatch[1] || "");
    const markerIndex = markerMatch.index + leadingBreak.length;
    const markerLength = markerMatch[0].length - leadingBreak.length;

    return {
      mainText: raw.slice(0, markerIndex).trim(),
      additionalText: raw.slice(markerIndex + markerLength).trim(),
    };
  }

  function normalizeAdditionalCompareText(text) {
    return String(text || "")
      .replace(/(?:^|\n)\s*(?:สรุป(?:สาระสำคัญ|ใจความสำคัญ)|รายละเอียดเพิ่มเติม|ข้อมูลเพิ่มเติม|เพิ่มเติมจากข้อมูลอื่น)\s*:\s*/gi, "\n")
      .replace(/(?:^|\n)\s*(?:แหล่งอ้างอิง|อ้างอิง)\s*:\s*[\s\S]*$/i, "")
      .replace(/[^\p{L}\p{N}]+/gu, "")
      .toLowerCase()
      .trim();
  }

  function getAdditionalContentLines(text) {
    return String(text || "")
      .replace(/(?:^|\n)\s*(?:แหล่งอ้างอิง|อ้างอิง)\s*:\s*[\s\S]*$/i, "")
      .split(/\n+/)
      .map((line) => line.replace(/^\s*[-•]\s*/, "").trim())
      .filter((line) => line && !/^(?:สรุป(?:สาระสำคัญ|ใจความสำคัญ)|รายละเอียดเพิ่มเติม|ข้อมูลเพิ่มเติม|เพิ่มเติมจากข้อมูลอื่น)\s*:?$/i.test(line));
  }

  function shouldShowAdditionalInfoText(mainText, additionalText) {
    const cleanedAdditional = String(additionalText || "").trim();
    if (!cleanedAdditional) return false;

    const normalizedMain = normalizeAdditionalCompareText(mainText);
    const normalizedAdditional = normalizeAdditionalCompareText(cleanedAdditional);
    if (!normalizedAdditional) return false;
    if (normalizedMain && (
      normalizedMain === normalizedAdditional ||
      normalizedMain.includes(normalizedAdditional) ||
      normalizedAdditional.includes(normalizedMain)
    )) {
      return false;
    }

    const mainLineKeys = new Set(getAdditionalContentLines(mainText).map(normalizeAdditionalCompareText).filter(Boolean));
    const additionalLines = getAdditionalContentLines(cleanedAdditional);
    const uniqueAdditionalLines = additionalLines.filter((line) => {
      const key = normalizeAdditionalCompareText(line);
      return key && !mainLineKeys.has(key);
    });

    return uniqueAdditionalLines.length > 0;
  }

  function hasReferenceMarker(text) {
    return /(?:^|\n)\s*(?:แหล่งอ้างอิง|อ้างอิง):\s*/i.test(String(text || ""));
  }

  function normalizeAnswerLineBreaksForDisplay(text) {
    const inlineReferenceSpace = "__LAW_INLINE_REFERENCE_SPACE__";
    return String(text || "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(
        /(\S)\s+((?:\([0-9๐-๙]{1,3}\)\s*){2,}(?:(?:หรือ|และ)\s*\([0-9๐-๙]{1,3}\))?)/gu,
        (_match, prefix, references) => `${prefix}${inlineReferenceSpace}${String(references || "").replace(/\s+/g, inlineReferenceSpace)}`,
      )
      .replace(/([^\n])\s+(\([0-9๐-๙]{1,3}\))(?=\s*[^\s(])/g, (match, prefix, marker, offset, fullText) => {
        const context = String(fullText || "").slice(Math.max(0, Number(offset || 0) - 80), Number(offset || 0)).replace(/\s+/g, " ").trim();
        if (/(?:ตาม|ในกรณีตาม|ตามข้อ|ตามวรรค|ตามอนุมาตรา|หรือ|และ)$/u.test(context)) {
          return `${prefix} ${marker}`;
        }
        return `${prefix}\n${marker}`;
      })
      .replaceAll(inlineReferenceSpace, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function extractReferenceParts(text) {
    const raw = String(text || "");
    if (!hasReferenceMarker(raw)) {
      return {
        mainText: raw,
        referenceText: "",
      };
    }

    const markerMatches = Array.from(raw.matchAll(/(^|\n)\s*(?:แหล่งอ้างอิง|อ้างอิง):\s*/gi));
    const markerMatch = markerMatches.length ? markerMatches[markerMatches.length - 1] : null;
    if (!markerMatch || typeof markerMatch.index !== "number") {
      return {
        mainText: raw,
        referenceText: "",
      };
    }

    const leadingMarkerText = String(markerMatch[1] || "");
    const markerIndex = markerMatch.index + leadingMarkerText.length;
    const markerLength = markerMatch[0].length - leadingMarkerText.length;

    return {
      mainText: raw.slice(0, markerIndex).trim(),
      referenceText: raw.slice(markerIndex + markerLength).trim(),
    };
  }

  const api = {
    buildHighlightTerms,
    extractAdditionalInfoParts,
    extractReferenceLines,
    extractReferenceParts,
    getAdditionalContentLines,
    hasReferenceMarker,
    isPresentationLine,
    mergeProtectedBulletLines,
    normalizeAdditionalCompareText,
    normalizeAnswerLineBreaksForDisplay,
    normalizeClauseMarkerLineBreaks,
    normalizeDisplayListMarkerLineBreaks,
    normalizeProtectedDisplayLineBreaks,
    normalizeSourceReferencesForDisplay,
    replaceUserVisibleAiTerms,
    sanitizeDisplayText,
    shouldBreakBeforeClauseMarker,
    shouldBreakBeforeDisplayListMarker,
    shouldMergeBulletContinuationLine,
    shouldShowAdditionalInfoText,
    splitPresentationAndBodyText,
    splitSummaryIntoBullets,
    stripBotUiNoiseText,
  };

  return {
    ...api,
    createLawChatbotTextUtils() {
      return api;
    },
  };
});
