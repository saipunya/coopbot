const test = require("node:test");
const assert = require("node:assert/strict");

const {
  limitRewriteInput,
  shouldRewriteAnswer,
  splitAnswerReferenceSection,
  stripReferenceSection,
} = require("../services/aiRewriteService");

test("limits AI rewrite input to 600 characters", () => {
  const input = "ก".repeat(700);
  assert.equal(limitRewriteInput(input).length, 600);
});

test("rewrites only long non-explicit-section answers", () => {
  const longAnswer = "ข้อความกฎหมาย".repeat(30);

  assert.equal(shouldRewriteAnswer("สั้น"), false);
  assert.equal(shouldRewriteAnswer(longAnswer, { explicitLawSectionQuery: true }), false);
  assert.equal(shouldRewriteAnswer(longAnswer, { explicitLawSectionQuery: false }), true);
});

test("splits reference section away from answer body before rewrite", () => {
  const answer = [
    "สรุปสาระสำคัญ:",
    "การชำระบัญชีเป็นกระบวนการสะสางทรัพย์สินและหนี้สินหลังสหกรณ์เลิก",
    "",
    "แหล่งอ้างอิง:",
    "- พรบ.สหกรณ์ พ.ศ. 2542: มาตรา 75",
  ].join("\n");

  const result = splitAnswerReferenceSection(answer);

  assert.equal(
    result.mainText,
    "สรุปสาระสำคัญ:\nการชำระบัญชีเป็นกระบวนการสะสางทรัพย์สินและหนี้สินหลังสหกรณ์เลิก",
  );
  assert.equal(result.referenceText, "แหล่งอ้างอิง:\n- พรบ.สหกรณ์ พ.ศ. 2542: มาตรา 75");
  assert.doesNotMatch(stripReferenceSection(answer), /แหล่งอ้างอิง/);
});

test("splits db-only reference section away from answer body before rewrite", () => {
  const answer = [
    "ถ้าสหกรณ์ล้มละลาย การชำระบัญชีให้เป็นไปตามกฎหมายว่าด้วยล้มละลาย",
    "",
    "อ้างอิง:",
    "- มาตรา 74",
  ].join("\n");

  const result = splitAnswerReferenceSection(answer);

  assert.equal(
    result.mainText,
    "ถ้าสหกรณ์ล้มละลาย การชำระบัญชีให้เป็นไปตามกฎหมายว่าด้วยล้มละลาย",
  );
  assert.equal(result.referenceText, "อ้างอิง:\n- มาตรา 74");
  assert.doesNotMatch(stripReferenceSection(answer), /อ้างอิง/);
});

test("splits inline reference marker away from rewritten answer text", () => {
  const answer = [
    "การชำระบัญชีเป็นกระบวนการสะสางกิจการหลังสหกรณ์เลิก",
    "แหล่งอ้างอิง: - พรบ.สหกรณ์ พ.ศ. 2542: มาตรา 75",
  ].join("\n");

  const result = splitAnswerReferenceSection(answer);

  assert.equal(result.mainText, "การชำระบัญชีเป็นกระบวนการสะสางกิจการหลังสหกรณ์เลิก");
  assert.equal(result.referenceText, "แหล่งอ้างอิง: - พรบ.สหกรณ์ พ.ศ. 2542: มาตรา 75");
});
