const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveMessageWithContext } = require("../services/contextService");
const { buildQueryRewriteCandidates } = require("../services/queryRewriteService");

test("explicit law section follow-up stays a fresh query without previous section anchors", async () => {
  const session = {
    lawChatbotContext: [
      {
        target: "coop",
        topicHints: ["มาตรา 17"],
        focusSources: [
          {
            reference: "มาตรา 17",
            title: "มาตรา 17",
            lawNumber: "มาตรา 17",
          },
        ],
      },
    ],
  };
  const contextualCandidate = resolveMessageWithContext("มาตรา 18", "coop", session);
  const rewrite = await buildQueryRewriteCandidates("มาตรา 18", "coop", session, contextualCandidate, {
    timeoutMs: 10,
  });

  assert.equal(contextualCandidate.usedContext, false);
  assert.equal(rewrite.ambiguousFollowUp, false);
  assert.equal(rewrite.candidates.length, 1);
  assert.equal(rewrite.candidates[0].type, "original");
  assert.doesNotMatch(rewrite.candidates[0].retrievalQuery, /มาตรา\s*17/);
  assert.match(rewrite.candidates[0].retrievalQuery, /มาตรา\s*18/);
});

test("rewrite keeps noisy managed Q&A queries short and focused", async () => {
  const rewrite = await buildQueryRewriteCandidates(
    "สมาชิกลาออกต้องทำอย่างไร สมาชิกลาออกต้อง q a ผู้ดูแลระบบ ออก สมาชิก สมาชิกสามัญ สมาชิกสามัญ สมาชิก",
    "coop",
    {},
    { usedContext: false, topicHints: [] },
    { timeoutMs: 10 },
  );
  const query = rewrite.candidates[0]?.retrievalQuery || "";

  assert.ok(query.length <= 180);
  assert.doesNotMatch(query, /q\s*a|ผู้ดูแลระบบ|ผู้ดูแล/i);
  assert.match(query, /สมาชิกลาออก/);
  assert.ok((query.match(/สมาชิกสามัญ/g) || []).length <= 1);
});

test("rewrite does not let expansion swamp short formation query", async () => {
  const rewrite = await buildQueryRewriteCandidates(
    "ตั้งสหกรณ์",
    "coop",
    {},
    { usedContext: false, topicHints: [] },
    { timeoutMs: 10 },
  );
  const query = rewrite.candidates[0]?.retrievalQuery || "";

  assert.ok(query.length <= 180);
  assert.match(query, /^ตั้งสหกรณ์/);
  assert.doesNotMatch(query, /แก้ไขเพิ่มเติมข้อบังคับสหกรณ์/);
});
