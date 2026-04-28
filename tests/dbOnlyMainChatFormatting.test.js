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

test("formation query does not select dissolution sources when formation evidence exists", () => {
  const result = buildDbOnlyMainChatAnswerResult(
    [
      {
        source: "tbl_laws",
        score: 1200,
        reference: "มาตรา 70",
        content:
          "สหกรณ์ย่อมเลิก เมื่อมีเหตุดังต่อไปนี้ (1) มีเหตุตามที่กำหนดในข้อบังคับ (2) สมาชิกเหลือน้อยกว่าสิบคน (3) ที่ประชุมใหญ่ลงมติให้เลิก (4) ล้มละลาย (5) นายทะเบียนสหกรณ์สั่งให้เลิก",
      },
      {
        source: "tbl_laws",
        score: 900,
        reference: "มาตรา 33",
        content:
          "สหกรณ์จะตั้งขึ้นได้โดยการจดทะเบียนตามพระราชบัญญัตินี้ และต้องมีผู้ซึ่งประสงค์จะเป็นสมาชิกของสหกรณ์นั้นเข้าชื่อกันไม่น้อยกว่าสิบคน",
      },
    ],
    {
      message: "การจัดตั้งสหกรณ์",
      maxPrimarySections: 1,
    },
  );

  assert.equal(result.selectedSources.length, 1);
  assert.equal(result.selectedSources[0].reference, "มาตรา 33");
  assert.match(result.answer, /จดทะเบียนตามพระราชบัญญัตินี้/);
  assert.doesNotMatch(result.answer, /สหกรณ์ย่อมเลิก/);
});

test("exact section query prefers matching structured law over nearby section suggestions", () => {
  const result = buildDbOnlyMainChatAnswerResult(
    [
      {
        source: "tbl_laws",
        score: 1000,
        reference: "มาตรา 8",
        title: "วรรคแรก",
        content:
          "ทุนกลางของบรรดาสหกรณ์ไม่จำกัด ให้กรมส่งเสริมสหกรณ์จัดการฝากไว้ที่ธนาคารออมสิน ธนาคารกรุงไทย หรือธนาคารเพื่อการเกษตรและสหกรณ์การเกษตร",
      },
      {
        source: "knowledge_suggestion",
        score: 1200,
        reference: "มาตรา 89/3 พรบ.สหกรณ์ พ.ศ. 2542",
        title: "การสั่งเลิกสหกรณ์ออมทรัพย์หรือสหกรณ์เครดิตยูเนี่ยน",
        content:
          "นายทะเบียนสหกรณ์มีอำนาจสั่งเลิกสหกรณ์ออมทรัพย์หรือสหกรณ์เครดิตยูเนี่ยนได้ตามมาตรา 89/3 วรรคสอง",
      },
    ],
    {
      message: "มาตรา 8 พ.ร.บ. สหกรณ์",
      questionIntent: "law_section",
      maxPrimarySections: 1,
    },
  );

  assert.equal(result.selectedSources.length, 1);
  assert.equal(result.selectedSources[0].reference, "มาตรา 8");
  assert.match(result.answer, /ทุนกลางของบรรดาสหกรณ์ไม่จำกัด/);
  assert.doesNotMatch(result.answer, /มาตรา 89\/3/);
  assert.doesNotMatch(result.answer, /สั่งเลิกสหกรณ์ออมทรัพย์/);
});

test("exact structured law query keeps all subsections under the same section number", () => {
  const result = buildDbOnlyMainChatAnswerResult(
    [
      {
        source: "tbl_laws",
        score: 1000,
        reference: "มาตรา 121",
        title: "วรรคแรก",
        content: "ให้นายทะเบียนสหกรณ์เป็นนายทะเบียนกลุ่มเกษตรกร",
      },
      {
        source: "tbl_laws",
        score: 1000,
        reference: "มาตรา 121",
        title: "วรรคสอง",
        content: "รองนายทะเบียนสหกรณ์เป็นผู้ช่วยนายทะเบียนกลุ่มเกษตรกร",
      },
      {
        source: "tbl_laws",
        score: 1000,
        reference: "มาตรา 121",
        title: "วรรคสาม",
        content: "ให้รัฐมนตรีแต่งตั้งพนักงานเจ้าหน้าที่",
      },
    ],
    {
      message: "มาตรา 121 พรบ สหกรณ์",
      questionIntent: "law_section",
      maxPrimarySections: 1,
    },
  );

  assert.equal(result.selectedSources.length, 3);
  assert.deepEqual(
    result.selectedSources.map((item) => item.title),
    ["วรรคแรก", "วรรคสอง", "วรรคสาม"],
  );
  assert.match(result.answer, /ให้นายทะเบียนสหกรณ์เป็นนายทะเบียนกลุ่มเกษตรกร/);
  assert.match(result.answer, /รองนายทะเบียนสหกรณ์เป็นผู้ช่วยนายทะเบียนกลุ่มเกษตรกร/);
  assert.match(result.answer, /ให้รัฐมนตรีแต่งตั้งพนักงานเจ้าหน้าที่/);
});

test("dissolution topic query displays multiple section 70 parts when available", () => {
  const result = buildDbOnlyMainChatAnswerResult(
    [
      {
        id: 138,
        source: "tbl_laws",
        lawNumber: "มาตรา 70",
        reference: "มาตรา 70",
        title: "วรรคแรก",
        score: 998,
        content:
          "สหกรณ์ย่อมเลิกด้วยเหตุหนึ่งเหตุใด ดังต่อไปนี้ (1) มีเหตุตามที่กำหนดในข้อบังคับ (2) สหกรณ์มีจำนวนสมาชิกน้อยกว่าสิบคน",
      },
      {
        id: 139,
        source: "tbl_laws",
        lawNumber: "มาตรา 70",
        reference: "มาตรา 70",
        title: "วรรคสอง",
        score: 998,
        content:
          "ให้สหกรณ์ที่เลิกตาม (1) (2) (3) หรือ (4) แจ้งให้นายทะเบียนสหกรณ์ทราบ ภายในสิบห้าวันนับแต่วันที่เลิก",
      },
      {
        id: 140,
        source: "tbl_laws",
        lawNumber: "มาตรา 70",
        reference: "มาตรา 70",
        title: "วรรคสาม",
        score: 998,
        content:
          "ให้นายทะเบียนสหกรณ์ปิดประกาศการเลิกสหกรณ์ไว้ที่สำนักงานของสหกรณ์ ที่ทำการสหกรณ์อำเภอหรือหน่วยส่งเสริมสหกรณ์",
      },
      {
        id: 141,
        source: "tbl_laws",
        lawNumber: "มาตรา 71",
        reference: "มาตรา 71",
        title: "วรรคแรก",
        score: 900,
        content:
          "นายทะเบียนสหกรณ์มีอำนาจสั่งเลิกสหกรณ์ได้เมื่อปรากฏว่าสหกรณ์ไม่เริ่มดำเนินกิจการ",
      },
    ],
    {
      message: "การเลิกสหกรณ์",
      questionIntent: "law_section",
      maxPrimarySections: 1,
    },
  );

  assert.equal(result.selectedSources.length, 3);
  assert.deepEqual(
    result.selectedSources.map((item) => item.id),
    [138, 139, 140],
  );
  assert.match(result.answer, /สหกรณ์ย่อมเลิกด้วยเหตุหนึ่งเหตุใด/);
  assert.match(result.answer, /แจ้งให้นายทะเบียนสหกรณ์ทราบ ภายในสิบห้าวัน/);
  assert.match(result.answer, /ปิดประกาศการเลิกสหกรณ์/);
  assert.doesNotMatch(result.answer, /ไม่เริ่มดำเนินกิจการ/);
});
