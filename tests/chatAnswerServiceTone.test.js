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
