const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildTonePresentation,
  __resetFriendlyIntroState,
} = require("../services/chatAnswerService");

test("friendly tone presentation rotates through intro bank without short-cycle repeats", () => {
  const originalRandom = Math.random;
  try {
    __resetFriendlyIntroState();
    Math.random = () => 0;
    const intros = [
      buildTonePresentation("ก".repeat(160), "friendly", "คพช").intro,
      buildTonePresentation("ก".repeat(160), "friendly", "คพช").intro,
      buildTonePresentation("ก".repeat(160), "friendly", "คพช").intro,
      buildTonePresentation("ก".repeat(160), "friendly", "คพช").intro,
    ];

    assert.equal(new Set(intros).size, intros.length);
    intros.forEach((intro) => {
      assert.match(intro, /คพช/);
      assert.match(intro, /เดี๋ยวผม|ผมขอ|ผมจะ|ผมสรุป|ผมช่วย/);
    });
  } finally {
    __resetFriendlyIntroState();
    Math.random = originalRandom;
  }
});

test("friendly tone presentation keeps fallback empty for short answers", () => {
  __resetFriendlyIntroState();
  const presentation = buildTonePresentation("สั้นมาก", "friendly", "คพช");
  assert.equal(presentation.intro, "");
  assert.equal(presentation.closing, "");
});

test("tone presentation shows short question topics in full", () => {
  const question = "วงเงินกู้ของกลุ่มเกษตรกรทั่วไป กำหนดเท่าไร";
  const presentation = buildTonePresentation("ก".repeat(160), "semi_formal", question);

  assert.match(presentation.intro, new RegExp(question));
  assert.doesNotMatch(presentation.intro, /"\.\.\."/);
});

test("tone presentation truncates long question topics with ellipsis", () => {
  const question = "หลักเกณฑ์ทั่วไปในการพิจารณาวงเงินกู้ยืมกลุ่มเกษตรกรตามประกาศล่าสุดพร้อมกรณีที่มีผลขาดทุนสะสมและต้องเสนอแผนฟื้นฟู";
  const presentation = buildTonePresentation("ก".repeat(160), "formal", question);
  const topic = presentation.intro.match(/"([^"]+)"/)?.[1] || "";

  assert.ok(topic.endsWith("..."));
  assert.ok(Array.from(topic).length <= 80);
  assert.match(topic, /หลักเกณฑ์ทั่วไป/);
});

test("tone presentation replaces blank ellipsis topic with fallback text", () => {
  const presentation = buildTonePresentation("ก".repeat(160), "semi_formal", "...");

  assert.match(presentation.intro, /"คำถามนี้"/);
  assert.doesNotMatch(presentation.intro, /"\.\.\."/);
});
