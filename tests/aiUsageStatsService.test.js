const test = require("node:test");
const assert = require("node:assert/strict");

const { estimateRewriteCost } = require("../services/aiUsageStatsService");

test("estimates AI rewrite cost in USD and THB from call count", () => {
  const estimate = estimateRewriteCost(1000);

  assert.equal(estimate.estimatedInputTokens, 700000);
  assert.equal(estimate.estimatedOutputTokens, 250000);
  assert.equal(estimate.estimatedUsd, 1.65);
  assert.equal(estimate.estimatedThb, 53.94);
});
