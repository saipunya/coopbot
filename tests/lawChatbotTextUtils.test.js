const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildHighlightTerms,
  extractAdditionalInfoParts,
  extractReferenceParts,
  normalizeAnswerLineBreaksForDisplay,
  sanitizeDisplayText,
  splitPresentationAndBodyText,
  splitSummaryIntoBullets,
  restorePreparedQaTitle,
  shouldShowAdditionalInfoText,
} = require("../public/js/lawChatbotTextUtils");

test("sanitizeDisplayText removes database boilerplate and keeps compact numbered lists", () => {
  const input = [
    "ข้อมูลที่พบจากฐานข้อมูลกฎหมาย:",
    "มาตรา 70",
    "(1) เหตุแรก",
    "(2) เหตุที่สอง",
  ].join("\n");

  const output = sanitizeDisplayText(input);

  assert.doesNotMatch(output, /ข้อมูลที่พบจากฐานข้อมูลกฎหมาย/);
  assert.match(output, /มาตรา 70/);
  assert.match(output, /มาตรา 70\(1\)เหตุแรก/);
  assert.match(output, /\(2\) เหตุที่สอง/);
});

test("sanitizeDisplayText keeps law section number with its label across line breaks", () => {
  const input = "1. กรณีสหกรณ์เลิกตามกฎหมาย (มาตรา\n70)";

  const output = sanitizeDisplayText(input);

  assert.equal(output, "1. กรณีสหกรณ์เลิกตามกฎหมาย (มาตรา 70)");
  assert.doesNotMatch(output, /มาตรา\s*\n\s*70/);
});

test("splitSummaryIntoBullets preserves real bullet lists", () => {
  const output = splitSummaryIntoBullets("1. ข้อแรก\n2. ข้อสอง\n3. ข้อสาม");

  assert.deepEqual(output, ["1. ข้อแรก", "2. ข้อสอง", "3. ข้อสาม"]);
});

test("normalizeAnswerLineBreaksForDisplay keeps clause markers on separate lines when appropriate", () => {
  const output = normalizeAnswerLineBreaksForDisplay("ตามข้อกำหนด (1) เหตุแรก (2) เหตุที่สอง");

  assert.equal(output, "ตามข้อกำหนด\n(1) เหตุแรก\n(2) เหตุที่สอง");
});

test("extractReferenceParts splits the last reference marker block", () => {
  const output = extractReferenceParts("คำตอบ\nแหล่งอ้างอิง: มาตรา 70\nอ้างอิง: คู่มือ");

  assert.equal(output.mainText, "คำตอบ\nแหล่งอ้างอิง: มาตรา 70");
  assert.equal(output.referenceText, "คู่มือ");
});

test("extractAdditionalInfoParts splits additional information correctly", () => {
  const output = extractAdditionalInfoParts("สรุป\nข้อมูลเพิ่มเติม: รายละเอียด\nต่อท้าย");

  assert.equal(output.mainText, "สรุป");
  assert.equal(output.additionalText, "รายละเอียด\nต่อท้าย");
});

test("buildHighlightTerms prefers longer phrases first", () => {
  const output = buildHighlightTerms("สหกรณ์ เลิก สหกรณ์ เลิกกิจการ");

  assert.deepEqual(output, ["สหกรณ์ เลิก สหกรณ์ เลิกกิจการ", "เลิกกิจการ", "สหกรณ์", "เลิก"]);
});

test("splitPresentationAndBodyText separates intro-like text from body text", () => {
  const output = splitPresentationAndBodyText('สำหรับ "คพช"\nเนื้อหาคำตอบ\nหากมีข้อสงสัยเพิ่มเติม');

  assert.equal(output.presentationText, 'สำหรับ "คพช"\nหากมีข้อสงสัยเพิ่มเติม');
  assert.equal(output.bodyText, "เนื้อหาคำตอบ");
});

test("shouldShowAdditionalInfoText filters duplicate info but keeps meaningful detail", () => {
  assert.equal(shouldShowAdditionalInfoText("สรุปผล", "สรุปผล"), false);
  assert.equal(shouldShowAdditionalInfoText("สรุปผล", "รายละเอียดที่ต่างออกไป"), true);
});

test("restorePreparedQaTitle restores the prepared title for numbered answers", () => {
  const output = restorePreparedQaTitle("1. เนื้อหาคำตอบ", {
    question: "คำถามตัวอย่าง",
    responseMeta: {
      usesPreparedQa: true,
      preparedQaTitle: "คำถามตัวอย่าง",
    },
  });

  assert.equal(output, "คำถามตัวอย่าง\n1. เนื้อหาคำตอบ");
});
