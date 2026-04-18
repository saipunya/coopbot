const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildDbOnlyMainChatAnswerResult,
  formatDbOnlyMainChatAnswer,
} = require("../services/chatAnswerService");

test("preserves complete structured legal lists and removes metadata headings", () => {
  const answer = formatDbOnlyMainChatAnswer([
    {
      source: "tbl_laws",
      reference: "มาตรา 70",
      content: `
มาตรา 70
สรุปสาระสำคัญ:
สหกรณ์ย่อมเลิก เมื่อมีเหตุดังต่อไปนี้ (1) มีเหตุตามที่กำหนดในข้อบังคับ (2) สมาชิกเหลือน้อยกว่าสิบคน (3) ที่ประชุมใหญ่ลงมติให้เลิก (4) ล้มละลาย (5) นายทะเบียนสหกรณ์สั่งให้เลิก
แหล่งอ้างอิง:
- tbl_laws: มาตรา 70
      `,
    },
  ]);

  assert.doesNotMatch(answer, /^มาตรา\s*70$/m);
  assert.doesNotMatch(answer, /สรุปสาระสำคัญ/i);
  assert.doesNotMatch(answer, /แหล่งอ้างอิง/i);

  assert.match(answer, /\(1\)\s*มีเหตุตามที่กำหนดในข้อบังคับ/);
  assert.match(answer, /\(2\)\s*สมาชิกเหลือน้อยกว่าสิบคน/);
  assert.match(answer, /\(3\)\s*ที่ประชุมใหญ่ลงมติให้เลิก/);
  assert.match(answer, /\(4\)\s*ล้มละลาย/);
  assert.match(answer, /\(5\)\s*นายทะเบียนสหกรณ์สั่งให้เลิก/);

  const listLines = answer.split("\n").filter((line) => /^\([1-5]\)/.test(line.trim()));
  assert.equal(listLines.length, 5);
});

test("keeps legal substance while stripping section-number metadata prefix", () => {
  const answer = formatDbOnlyMainChatAnswer([
    {
      source: "tbl_laws",
      reference: "มาตรา 74",
      content:
        "มาตรา 74 ถ้าสหกรณ์ล้มละลาย การชำระบัญชีให้เป็นไปตามกฎหมายว่าด้วยล้มละลาย",
    },
  ]);

  assert.doesNotMatch(answer, /^มาตรา\s*74\b/m);
  assert.match(answer, /ถ้าสหกรณ์ล้มละลาย/);
  assert.match(answer, /การชำระบัญชีให้เป็นไปตามกฎหมายว่าด้วยล้มละลาย/);
});

test("removes inline keyword metadata tails from legal body lines", () => {
  const answer = formatDbOnlyMainChatAnswer([
    {
      source: "tbl_laws",
      reference: "มาตรา 75",
      content:
        "ในกรณีสหกรณ์เลิกด้วยเหตุอื่นนอกจากล้มละลาย ให้ที่ประชุมใหญ่เลือกตั้งผู้ชำระบัญชี คำสำคัญ: ผู้ชำระบัญชี, แต่งตั้งผู้ชำระบัญชี",
    },
  ]);

  assert.match(answer, /ที่ประชุมใหญ่เลือกตั้งผู้ชำระบัญชี/);
  assert.doesNotMatch(answer, /คำสำคัญ:/);
});

test("removes speaker and assistant metadata labels", () => {
  const answer = formatDbOnlyMainChatAnswer([
    {
      source: "tbl_laws",
      reference: "มาตรา 70",
      content: `
KR
DA
ผู้ช่วยดาว
สหกรณ์ย่อมเลิก เมื่อมีเหตุดังต่อไปนี้ (1) มีเหตุตามที่กำหนดในข้อบังคับ (2) สมาชิกเหลือน้อยกว่าสิบคน
      `,
    },
  ]);

  assert.doesNotMatch(answer, /\bKR\b/);
  assert.doesNotMatch(answer, /\bDA\b/);
  assert.doesNotMatch(answer, /ผู้ช่วยดาว/);
  assert.match(answer, /สหกรณ์ย่อมเลิก/);
});

test("answers dissolution question with section 70 causes first and keeps reference separate", () => {
  const answer = formatDbOnlyMainChatAnswer(
    [
      {
        source: "tbl_laws",
        score: 1000,
        reference: "มาตรา 70",
        content:
          "สหกรณ์ย่อมเลิก เมื่อมีเหตุดังต่อไปนี้ (1) มีเหตุตามที่กำหนดในข้อบังคับ (2) สมาชิกเหลือน้อยกว่าสิบคน (3) ที่ประชุมใหญ่ลงมติให้เลิก (4) ล้มละลาย (5) นายทะเบียนสหกรณ์สั่งให้เลิกตามมาตรา 71",
      },
      {
        source: "tbl_laws",
        score: 900,
        reference: "มาตรา 71",
        content:
          "นายทะเบียนสหกรณ์มีอำนาจสั่งให้สหกรณ์เลิกได้ เมื่อไม่เริ่มดำเนินกิจการภายในหนึ่งปี หรือหยุดดำเนินกิจการติดต่อกันเป็นเวลาสองปี",
      },
    ],
    {
      message: "สหกรณ์เลิกเมื่อใด",
    },
  );

  assert.match(answer, /\(1\)\s*มีเหตุตามที่กำหนดในข้อบังคับ/);
  assert.match(answer, /\(2\)\s*สมาชิกเหลือน้อยกว่าสิบคน/);
  assert.match(answer, /\(3\)\s*ที่ประชุมใหญ่ลงมติให้เลิก/);
  assert.match(answer, /\(4\)\s*ล้มละลาย/);
  assert.match(answer, /\(5\)\s*นายทะเบียนสหกรณ์สั่งให้เลิก/);

  assert.doesNotMatch(answer, /ไม่เริ่มดำเนินกิจการภายในหนึ่งปี/);
  assert.match(answer, /\n\nอ้างอิง:\n- มาตรา 70/);
});

test("liquidation appointment question keeps only section 75 as the answer source", () => {
  const result = buildDbOnlyMainChatAnswerResult(
    [
      {
        source: "tbl_laws",
        score: 980,
        reference: "มาตรา 75",
        content:
          "ในกรณีสหกรณ์เลิกด้วยเหตุอื่นนอกจากล้มละลาย ให้ที่ประชุมใหญ่เลือกตั้งผู้ชำระบัญชี และถ้าที่ประชุมใหญ่ไม่เลือกตั้งหรือเลือกตั้งแล้วไม่ได้รับความเห็นชอบ ให้นายทะเบียนสหกรณ์มีอำนาจตั้งผู้ชำระบัญชี",
      },
      {
        source: "tbl_laws",
        score: 930,
        reference: "มาตรา 28",
        content:
          "คณะกรรมการดำเนินการมีอำนาจหน้าที่จัดการทั่วไปในกิจการของสหกรณ์ตามข้อบังคับ",
      },
    ],
    {
      message: "ใครมีอำนาจแต่งตั้งผู้ชำระบัญชี",
      maxPrimarySections: 1,
    },
  );

  assert.equal(result.selectedSources.length, 1);
  assert.equal(result.selectedSources[0].reference, "มาตรา 75");
  assert.match(result.answer, /ที่ประชุมใหญ่เลือกตั้งผู้ชำระบัญชี/);
  assert.match(result.answer, /นายทะเบียนสหกรณ์มีอำนาจตั้งผู้ชำระบัญชี/);
  assert.doesNotMatch(result.answer, /คณะกรรมการดำเนินการมีอำนาจหน้าที่จัดการทั่วไป/);
  assert.doesNotMatch(result.answer, /มาตรา 28/);
});
