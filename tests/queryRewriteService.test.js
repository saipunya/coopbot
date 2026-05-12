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
