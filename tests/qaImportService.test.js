const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildQaBulkPreviewRows,
  normalizeImportText,
  splitImportBlocks,
} = require("../services/qaImportService");

test("splitImportBlocks rejects text that does not start with a numbered question", () => {
  assert.throws(() => splitImportBlocks("คำถาม: ไม่มีเลขข้อ"), /ต้องเริ่มแต่ละข้อด้วยเลขลำดับ/);
});

test("buildQaBulkPreviewRows parses Thai Q&A blocks into preview rows", () => {
  const rows = buildQaBulkPreviewRows({
    qaText: `1. สมาชิกรายหนึ่งต้องทำอย่างไร
คำตอบ: ต้องชำระค่าหุ้นตามข้อบังคับ
2. คณะกรรมการมีอำนาจอะไร
คำตอบ: มีอำนาจตามที่กฎหมายกำหนด`,
    sourceReference: "คู่มือผู้ดูแล",
    domain: "legal",
    target: "all",
  });

  assert.equal(rows.length, 2);
  assert.equal(rows[0].displayOrder, 1);
  assert.equal(rows[0].questionText, "สมาชิกรายหนึ่งต้องทำอย่างไร");
  assert.equal(rows[0].answerText, "ต้องชำระค่าหุ้นตามข้อบังคับ");
  assert.equal(rows[0].sourceReference, "คู่มือผู้ดูแล");
  assert.equal(rows[1].displayOrder, 2);
  assert.equal(rows[1].questionText, "คณะกรรมการมีอำนาจอะไร");
  assert.equal(rows[1].answerText, "มีอำนาจตามที่กฎหมายกำหนด");
});

test("normalizeImportText collapses whitespace and special characters", () => {
  assert.equal(normalizeImportText("  สวัสดี,   โลก!  "), "สวัสดี โลก");
});

