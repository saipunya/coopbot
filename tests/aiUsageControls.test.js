const test = require("node:test");
const assert = require("node:assert/strict");

function setMockedModule(modulePath, exportsValue) {
  const previous = require.cache[modulePath];
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports: exportsValue,
  };

  return () => {
    if (previous) {
      require.cache[modulePath] = previous;
      return;
    }

    delete require.cache[modulePath];
  };
}

test("summary AI control blocks high and low confidence, allows medium only in summarize mode", () => {
  const { __private } = require("../services/lawChatbotService");
  const premiumAiPlan = { useAI: true };

  assert.equal(
    __private.resolveSummaryAiControl({ confidenceLevel: "high" }, premiumAiPlan, { summarizeMode: true }).allowAI,
    false,
  );
  assert.equal(
    __private.resolveSummaryAiControl({ confidenceLevel: "low" }, premiumAiPlan, { summarizeMode: true }).allowAI,
    false,
  );
  assert.equal(
    __private.resolveSummaryAiControl({ confidenceLevel: "medium" }, premiumAiPlan, { summarizeMode: true }).allowAI,
    true,
  );
  assert.equal(
    __private.resolveSummaryAiControl({ confidenceLevel: "medium" }, premiumAiPlan, {}).allowAI,
    false,
  );
  assert.equal(
    __private.resolveSummaryAiControl({ confidenceLevel: "medium" }, premiumAiPlan, { summaryMode: true }).allowAI,
    true,
  );
  assert.equal(
    __private.resolveSummaryAiControl({ confidenceLevel: "medium" }, premiumAiPlan, { summarizeMode: false }).allowAI,
    false,
  );
  assert.equal(
    __private.resolveSummaryAiControl({ confidenceLevel: "medium" }, { useAI: false }, { summarizeMode: true }).allowAI,
    false,
  );
});

test("AI guard logs violations outside confidence rules", () => {
  const { __private } = require("../services/lawChatbotService");
  const originalWarn = console.warn;
  const warnings = [];

  console.warn = (...args) => {
    warnings.push(args);
  };

  try {
    __private.logAiUsageGuardViolation(
      { allowAI: false, reason: "high_confidence", summarizeModeEnabled: true },
      { confidenceLevel: "high" },
      { query: "ทดสอบการเรียก AI" },
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /blocked AI usage rule violation/);
  assert.equal(warnings[0][1]?.confidenceLevel, "high");
});

test("AI summary sources are limited to top 3 and safely truncated", () => {
  const { __private } = require("../services/lawChatbotService");
  const sources = Array.from({ length: 5 }, (_, index) => ({
    source: "pdf_chunks",
    id: index + 1,
    title: `chunk ${index + 1}`,
    content: `${index + 1}${"ก".repeat(320)}`,
    chunk_text: `${index + 1}${"ข".repeat(320)}`,
    score: 100 - index,
  }));

  const prepared = __private.prepareAiSummarySources(sources, {
    limit: 3,
    textLimit: 280,
  });

  assert.equal(prepared.length, 3);
  assert.deepEqual(prepared.map((item) => item.id), [1, 2, 3]);
  assert.match(prepared[0].content, /\.\.\.$/);
  assert.ok(Array.from(prepared[0].content.replace(/\.\.\.$/, "")).length <= 280);
  assert.equal(sources[0].content.endsWith("..."), false);
});

test("generateChatSummary records usedAI and limits AI prompt context to 3 sources", async (t) => {
  const chatAnswerPath = require.resolve("../services/chatAnswerService");
  const openAiPath = require.resolve("../services/openAiService");
  const runtimeSettingsPath = require.resolve("../services/runtimeSettingsService");
  const restoreCallbacks = [];
  let capturedContents = "";

  t.after(() => {
    delete require.cache[chatAnswerPath];
    while (restoreCallbacks.length > 0) {
      const restore = restoreCallbacks.pop();
      restore();
    }
  });

  delete require.cache[chatAnswerPath];
  restoreCallbacks.push(
    setMockedModule(openAiPath, {
      getOpenAiConfig: () => ({ apiKey: "test" }),
      getOpenAiClient: () => ({}),
      generateOpenAiCompletion: async (options = {}) => {
        capturedContents = String(options.contents || "");
        return "สรุปสาระสำคัญ: พบข้อมูลตามแหล่งอ้างอิง";
      },
    }),
  );
  restoreCallbacks.push(
    setMockedModule(runtimeSettingsPath, {
      isAiEnabled: async () => true,
      isAiEnabledSync: () => true,
    }),
  );

  const { generateChatSummary } = require(chatAnswerPath);
  const answerDiagnostics = {};
  const longText = "ข้อมูลทดสอบ ".repeat(80);
  await generateChatSummary(
    "อธิบายข้อมูลทดสอบ",
    Array.from({ length: 4 }, (_, index) => ({
      source: "admin_knowledge",
      id: index + 1,
      title: `แหล่ง ${index + 1}`,
      reference: `อ้างอิง ${index + 1}`,
      content: `${longText}${index + 1}`,
      score: 120 - index,
    })),
    {
      databaseOnlyMode: false,
      answerDiagnostics,
      promptProfile: {
        code: "detailed",
        aiSourceLimit: 8,
        aiSourceContextCharLimit: 280,
        aiMaxOutputTokens: 128,
      },
    },
  );

  assert.equal(answerDiagnostics.usedAI, true);
  assert.ok(answerDiagnostics.aiSourceCount <= 3);
  assert.match(capturedContents, /แหล่งข้อมูลที่ 3/);
  assert.doesNotMatch(capturedContents, /แหล่งข้อมูลที่ 4/);
  assert.match(capturedContents, /\.\.\./);
});
