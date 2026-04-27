const test = require("node:test");
const assert = require("node:assert/strict");

const {
  limitRewriteInput,
  shouldRewriteAnswer,
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
