const assert = require("node:assert/strict");

const { buildFreeAiPreviewPlanContext } = require("../services/answerStateService");
const {
  resolveChatPlanContext,
  shouldSearchInternetForPlan,
} = require("../services/chatOrchestrationService");
const { getPlanConfig } = require("../services/planService");

function runCheck(name, fn) {
  try {
    fn();
    console.log(`OK: ${name}`);
  } catch (error) {
    console.error(`FAIL: ${name}`);
    console.error(`  ${error.message || error}`);
    process.exitCode = 1;
  }
}

function main() {
  const currentQuestion = "ข่าวสหกรณ์ล่าสุดวันนี้มีอะไรอัปเดตบ้าง";
  const freeConfig = getPlanConfig("free");
  const proConfig = getPlanConfig("pro");
  const premiumConfig = getPlanConfig("premium");
  const freeBaseContext = resolveChatPlanContext(
    {
      user: {
        plan: "free",
      },
    },
    {
      aiAvailable: true,
    },
  );
  const standardPreviewContext = buildFreeAiPreviewPlanContext(freeBaseContext, false);
  const premiumPreviewContext = buildFreeAiPreviewPlanContext(freeBaseContext, true);

  runCheck("free plan stays offline by default", () => {
    assert.equal(freeConfig.useInternet, false);
    assert.equal(freeConfig.internetMode, "none");
    assert.equal(freeConfig.maxInternetSources, 0);
    assert.equal(freeBaseContext.useInternet, false);
  });

  runCheck("professional plan exposes limited internet fallback", () => {
    assert.equal(proConfig.useInternet, true);
    assert.equal(proConfig.internetMode, "limited");
    assert.equal(proConfig.maxInternetSources, 2);
  });

  runCheck("premium plan still keeps broader internet fallback", () => {
    assert.equal(premiumConfig.useInternet, true);
    assert.equal(premiumConfig.internetMode, "full");
    assert.ok(Number(premiumConfig.maxInternetSources) >= Number(proConfig.maxInternetSources));
  });

  runCheck("free preview enables limited internet fallback", () => {
    assert.equal(standardPreviewContext.useAI, true);
    assert.equal(standardPreviewContext.useInternet, true);
    assert.equal(standardPreviewContext.internetMode, "limited");
    assert.equal(standardPreviewContext.maxInternetSources, 1);
  });

  runCheck("premium free preview can widen internet limit but stays bounded", () => {
    assert.equal(premiumPreviewContext.useInternet, true);
    assert.equal(premiumPreviewContext.internetMode, "limited");
    assert.equal(premiumPreviewContext.maxInternetSources, 2);
    assert.ok(premiumPreviewContext.maxInternetSources <= proConfig.maxInternetSources);
  });

  runCheck("internet search policy differs between free and preview/pro", () => {
    assert.equal(shouldSearchInternetForPlan("free", currentQuestion, [], "general"), false);
    assert.equal(shouldSearchInternetForPlan("pro", currentQuestion, [], "general"), true);
    assert.equal(shouldSearchInternetForPlan("premium", currentQuestion, [], "general"), true);
  });

  runCheck("law-section questions still avoid internet fallback even in preview", () => {
    assert.equal(shouldSearchInternetForPlan("pro", "มาตรา 5 ระบุว่าอย่างไร", [], "law_section"), false);
    assert.equal(shouldSearchInternetForPlan("premium", "มาตรา 5 ระบุว่าอย่างไร", [], "law_section"), false);
  });

  if (process.exitCode && process.exitCode !== 0) {
    throw new Error("free-preview verification failed");
  }

  console.log("Free-preview verification passed.");
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}