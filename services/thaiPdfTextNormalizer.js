function normalizeThaiPdfText(text) {
  let value = String(text || "");

  if (!value) {
    return "";
  }

  value = value
    .normalize("NFC")
    .replace(/\u0000/g, " ")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ");

  // High-confidence legal Thai spacing fixes only.
  value = value
    .replace(/พ\s*\.\s*ศ\s*\.?/gi, "พ.ศ.")
    .replace(/พ\.\s*ศ\s*\.?/gi, "พ.ศ.")
    .replace(/พ\s*\.\s*ศ/gi, "พ.ศ")
    .replace(/พ\.\s*ศ\./g, "พ.ศ.")
    .replace(/พ\.\s*ศ\s*\./g, "พ.ศ.")
    .replace(/พ\.\s*ศ/g, "พ.ศ")
    .replace(/ม\s*า\s*ต\s*ร\s*า(?=\s*[0-9๐-๙])/g, "มาตรา")
    .replace(/ข\s*้\s*อ(?=\s*[0-9๐-๙])/g, "ข้อ");

  // Join OCR-split Thai character sequences when every token is a single Thai glyph.
  value = value.replace(/(?:[ก-๙]\s+){2,}[ก-๙]/g, (match) => match.replace(/\s+/g, ""));

  value = value
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([,.;:!?])([^\s\n\r])/g, "$1 $2")
    .replace(/([(\[{])\s+/g, "$1")
    .replace(/\s+([)\]}])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/พ\.\s*ศ\s*\.?/gi, "พ.ศ.");

  return value.trim();
}

module.exports = {
  normalizeThaiPdfText,
};
