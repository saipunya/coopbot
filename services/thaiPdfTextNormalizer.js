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
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/[•●▪▫◦]/g, "-")
    .replace(/[ \t]*([:：])\s*/g, "$1 ")
    .replace(/([0-9๐-๙])\s*\/\s*([0-9๐-๙])/g, "$1/$2")
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
    .replace(/ข\s*้\s*อ(?=\s*[0-9๐-๙])/g, "ข้อ")
    .replace(/ค\s*ำ\s*ถ\s*า\s*ม\s*[:：]/g, "คำถาม:")
    .replace(/ค\s*ำ\s*ต\s*อ\s*บ\s*[:：]/g, "คำตอบ:")
    .replace(/ข\s*ั้\s*น\s*ต\s*อ\s*น\s*ท\s*ี่(?=\s*[0-9๐-๙])/g, "ขั้นตอนที่");

  // Join OCR-split Thai character sequences when every token is a single Thai glyph.
  value = value.replace(/(?:[ก-๙]\s+){2,}[ก-๙]/g, (match) => match.replace(/\s+/g, ""));

  value = value
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([,.;:!?])([^\s\n\r])/g, "$1 $2")
    .replace(/([(\[{])\s+/g, "$1")
    .replace(/\s+([)\]}])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n\s*(?=(?:มาตรา|ข้อ|คำถาม|คำตอบ|ขั้นตอนที่)\s*[0-9๐-๙:：]?)/g, "\n\n")
    .replace(/(ขั้นตอนที่)([0-9๐-๙])/g, "$1 $2")
    .replace(/([0-9๐-๙])\s+([0-9๐-๙])/g, "$1$2")
    .replace(/([0-9๐-๙])(?=[ก-ฮ])/g, "$1 ")
    .replace(/พ\.\s*ศ\s*\.?/gi, "พ.ศ.");

  return value.trim();
}

module.exports = {
  normalizeThaiPdfText,
};
