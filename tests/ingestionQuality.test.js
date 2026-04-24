const test = require("node:test");
const assert = require("node:assert/strict");

const {
  analyzeExtractedText,
  chunkText,
  chunkTextWithMetadata,
  normalizeText,
} = require("../services/documentTextExtractor");
const { normalizeThaiPdfText } = require("../services/thaiPdfTextNormalizer");

test("Thai normalization repairs common legal OCR spacing", () => {
  const normalized = normalizeThaiPdfText(
    "ม า ต ร า ๗๕  ให้ผู้ชำระบัญชี\nค ำ ถ า ม: ปิดสหกรณ์ทำอย่างไร\nขั้นตอนที่ ๑ ยื่นคำขอ",
  );

  assert.match(normalized, /มาตรา ๗๕/);
  assert.match(normalized, /คำถาม: ปิดสหกรณ์ทำอย่างไร/);
  assert.match(normalized, /ขั้นตอนที่ ๑ ยื่นคำขอ/);
});

test("document chunking keeps legal, FAQ, and process structures separate", () => {
  const chunks = chunkTextWithMetadata(
    [
      "คำถาม: ปิดสหกรณ์ทำอย่างไร",
      "คำตอบ: ให้ดำเนินการเลิกสหกรณ์และชำระบัญชี",
      "",
      "ขั้นตอนที่ 1 ยื่นคำขอ",
      "รวบรวมเอกสารและเสนอที่ประชุมใหญ่",
      "",
      "มาตรา 75 ผู้ชำระบัญชีต้องได้รับความเห็นชอบจากนายทะเบียนสหกรณ์",
    ].join("\n"),
    220,
  );

  assert.deepEqual(chunks.map((chunk) => chunk.chunkType), ["faq", "process", "legal_section"]);
  assert.match(chunks[0].chunkText, /คำถาม:/);
  assert.match(chunks[1].chunkText, /ขั้นตอนที่ 1/);
  assert.match(chunks[2].chunkText, /มาตรา 75/);
  assert.equal(chunkText(chunks.map((chunk) => chunk.chunkText).join("\n\n"), 220).length, 3);
});

test("quality analysis flags garbled text for low-quality ingestion handling", () => {
  const good = analyzeExtractedText(normalizeText("มาตรา 75 สหกรณ์ เลิกสหกรณ์ ชำระบัญชี ผู้ชำระบัญชี นายทะเบียนสหกรณ์"));
  const bad = analyzeExtractedText("◊◊◊ ËËË 1234567890 ____");

  assert.ok(good.qualityScore > bad.qualityScore);
  assert.ok(bad.qualityScore < 45);
  assert.ok(bad.notes.length > 0);
});
