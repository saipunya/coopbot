const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createContinuationSessionState,
  paginateContinuationState,
  resolveContinuationState,
  signContinuationToken,
  verifyContinuationToken,
} = require("../services/lawChatbotMainChatContinuation");

test("signs and verifies a compact continuation token", () => {
  const state = createContinuationSessionState({
    target: "all",
    originalMessage: "การเลิกสหกรณ์",
    effectiveMessage: "การเลิกสหกรณ์",
    sources: [
      {
        source: "custom",
        id: "source-1",
        content: "ข้อความทดสอบสำหรับ continuation",
      },
    ],
  });

  const token = signContinuationToken(state);
  const verified = verifyContinuationToken(token, "all");

  assert.equal(verified.answerInstanceId, state.answerInstanceId);
  assert.equal(verified.target, "all");
  assert.equal(verified.activeSourceIndex, 0);
  assert.equal(verified.sources.length, 1);
  assert.equal(verified.sources[0].source, "custom");
  assert.equal(verified.sources[0].id, "source-1");
});

test("rejects tampered continuation tokens", () => {
  const state = createContinuationSessionState({
    target: "all",
    originalMessage: "การเลิกสหกรณ์",
    effectiveMessage: "การเลิกสหกรณ์",
    sources: [
      {
        source: "custom",
        id: "source-1",
        content: "ข้อความทดสอบสำหรับ continuation",
      },
    ],
  });

  const token = signContinuationToken(state);
  const tampered = `${token}x`;

  assert.throws(
    () => verifyContinuationToken(tampered, "all"),
    /invalid continuation token signature|invalid continuation token format/,
  );
});

test("rejects expired continuation tokens", () => {
  const realNow = Date.now;
  const state = createContinuationSessionState({
    target: "all",
    originalMessage: "การเลิกสหกรณ์",
    effectiveMessage: "การเลิกสหกรณ์",
    sources: [
      {
        source: "custom",
        id: "source-1",
        content: "ข้อความทดสอบสำหรับ continuation",
      },
    ],
  });

  const token = signContinuationToken(state);

  try {
    Date.now = () => realNow() + (61 * 60 * 1000);
    assert.throws(() => verifyContinuationToken(token, "all"), /expired continuation token/);
  } finally {
    Date.now = realNow;
  }
});

test("allows all-target continuation requests to resume a scoped token", () => {
  const tokenState = createContinuationSessionState({
    target: "coop",
    originalMessage: "แก้ไขเพิ่มเติมข้อบังคับสหกรณ์",
    effectiveMessage: "แก้ไขเพิ่มเติมข้อบังคับสหกรณ์",
    sources: [
      {
        source: "custom",
        id: "source-1",
        content: "คำตอบต่อของสหกรณ์",
      },
    ],
  });

  const resolved = resolveContinuationState({
    continuationToken: signContinuationToken(tokenState),
    target: "all",
    sessionState: null,
  });

  assert.equal(resolved.source, "token");
  assert.equal(resolved.state.target, "coop");
  assert.equal(resolved.state.sources[0].id, "source-1");
});

test("rejects continuation tokens for a different explicit target", () => {
  const tokenState = createContinuationSessionState({
    target: "coop",
    originalMessage: "แก้ไขเพิ่มเติมข้อบังคับสหกรณ์",
    effectiveMessage: "แก้ไขเพิ่มเติมข้อบังคับสหกรณ์",
    sources: [
      {
        source: "custom",
        id: "source-1",
        content: "คำตอบต่อของสหกรณ์",
      },
    ],
  });

  assert.throws(
    () => verifyContinuationToken(signContinuationToken(tokenState), "group"),
    /continuation token target mismatch/,
  );
});

test("token continuation takes precedence over session continuation state", () => {
  const tokenState = createContinuationSessionState({
    target: "all",
    originalMessage: "คำถามเก่า",
    effectiveMessage: "คำถามเก่า",
    sources: [
      {
        source: "custom",
        id: "token-source",
        content: "คำตอบเก่า",
      },
    ],
  });
  const sessionState = createContinuationSessionState({
    target: "all",
    originalMessage: "คำถามใหม่",
    effectiveMessage: "คำถามใหม่",
    sources: [
      {
        source: "custom",
        id: "session-source",
        content: "คำตอบใหม่",
      },
    ],
  });

  const resolved = resolveContinuationState({
    continuationToken: signContinuationToken(tokenState),
    target: "all",
    sessionState,
  });

  assert.equal(resolved.source, "token");
  assert.equal(resolved.state.answerInstanceId, tokenState.answerInstanceId);
  assert.equal(resolved.state.sources[0].id, "token-source");
});

test("paginates continuation responses with both character and chunk limits", async () => {
  const state = createContinuationSessionState({
    target: "all",
    originalMessage: "การเลิกสหกรณ์",
    effectiveMessage: "การเลิกสหกรณ์",
    sources: [
      {
        source: "custom",
        id: "source-1",
        content: "ก".repeat(700),
      },
      {
        source: "custom",
        id: "source-2",
        content: "ข".repeat(700),
      },
      {
        source: "custom",
        id: "source-3",
        content: "ค".repeat(200),
      },
    ],
  });

  const paginated = await paginateContinuationState(state, {
    maxCharacters: 1200,
    maxSourceChunks: 2,
  });

  assert.equal(paginated.renderSources.length, 2);
  assert.equal(paginated.renderSources[0].content.length, 700);
  assert.equal(paginated.renderSources[1].content.length, 500);
  assert.equal(paginated.nextState.activeSourceIndex, 1);
  assert.equal(paginated.nextState.sources[0].continuationHasMore, false);
  assert.equal(paginated.nextState.sources[1].continuationNextOffset, 500);
  assert.equal(paginated.hasMore, true);
});
