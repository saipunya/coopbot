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
  assert.doesNotMatch(prepared[0].content, /\.\.\.$/);
  assert.ok(Array.from(prepared[0].content).length <= 280);
  assert.equal(sources[0].content.endsWith("..."), false);
});

test("no-answer queue creates one pending suggestion and reports duplicate repeats", async () => {
  const { __private } = require("../services/lawChatbotService");
  const message = `คำถามทดสอบไม่พบคำตอบ ${Date.now()}`;
  const retrievalEvaluation = {
    shouldReturnNoAnswer: true,
    trace: {
      humanReadableDecision: "confidence below threshold",
      reasonCodes: ["semantic_mismatch"],
    },
  };

  const firstResult = await __private.queueNoAnswerKnowledgeSuggestion(
    message,
    "coop",
    retrievalEvaluation,
    {
      selectionDiagnostics: {
        selected: [{ source: "tbl_laws" }],
      },
    },
  );
  const duplicateResult = await __private.queueNoAnswerKnowledgeSuggestion(
    message,
    "coop",
    retrievalEvaluation,
  );

  assert.equal(firstResult.queued, true);
  assert.equal(firstResult.duplicate, false);
  assert.equal(duplicateResult.queued, false);
  assert.equal(duplicateResult.duplicate, true);
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
  assert.doesNotMatch(capturedContents, /\.\.\./);
});

test("reasoned why-board-meeting questions avoid summarizing unrelated committee structure evidence", async (t) => {
  const chatAnswerPath = require.resolve("../services/chatAnswerService");
  const openAiPath = require.resolve("../services/openAiService");
  const runtimeSettingsPath = require.resolve("../services/runtimeSettingsService");
  const restoreCallbacks = [];
  let aiCalled = false;

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
      generateOpenAiCompletion: async () => {
        aiCalled = true;
        return "ข้อ 66 สรุปง่าย ๆ คือ คณะกรรมการดำเนินการมีจำนวนตามที่ที่ประชุมใหญ่เลือกตั้ง";
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
  const answer = await generateChatSummary(
    "ทำไมต้องมีการประชุมคณะกรรมการดำเนินการ",
    [
      {
        source: "tbl_glaws",
        id: 66,
        title: "วรรคแรก",
        reference: "ข้อ 66",
        content:
          "คณะกรรมการดำเนินการ ให้กลุ่มเกษตรกรมีคณะกรรมการจำนวน..............คน ซึ่งที่ประชุมใหญ่เลือกตั้งจากสมาชิก ให้คณะกรรมการดำเนินการเลือกตั้งในระหว่างกันเองขึ้นดำรงตำแหน่งประธานกรรมการ รองประธานกรรมการ เลขานุการ และ/หรือเหรัญญิก",
        score: 120,
      },
    ],
    {
      databaseOnlyMode: false,
      answerDiagnostics,
      promptProfile: {
        code: "detailed",
        aiSourceLimit: 3,
        aiSourceContextCharLimit: 700,
        aiMaxOutputTokens: 256,
      },
    },
  );

  assert.equal(aiCalled, false);
  assert.equal(answerDiagnostics.usedAI, false);
  assert.equal(answerDiagnostics.answerMode, "reasoned_explanation");
  assert.match(answer, /ยังไม่พบคำตอบที่อธิบายเหตุผลของการประชุมคณะกรรมการดำเนินการโดยตรง/);
  assert.match(answer, /พิจารณา ตัดสินใจ และติดตามการดำเนินงาน/);
  assert.doesNotMatch(answer, /ข้อ 66 สรุปง่าย ๆ/);
});

test("AI detail section removes lines that repeat the summary section", async (t) => {
  const chatAnswerPath = require.resolve("../services/chatAnswerService");
  const openAiPath = require.resolve("../services/openAiService");
  const runtimeSettingsPath = require.resolve("../services/runtimeSettingsService");
  const restoreCallbacks = [];

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
      generateOpenAiCompletion: async () => [
        "สรุปสาระสำคัญ:",
        "การประชุมมีไว้เพื่อให้คณะกรรมการร่วมกันพิจารณา ตัดสินใจ และติดตามการดำเนินงาน",
        "รายละเอียดเพิ่มเติม:",
        "การประชุมมีไว้เพื่อให้คณะกรรมการร่วมกันพิจารณา ตัดสินใจ และติดตามการดำเนินงาน",
        "การทำมติไว้เป็นหลักฐานช่วยให้ตรวจสอบย้อนหลังได้",
      ].join("\n"),
    }),
  );
  restoreCallbacks.push(
    setMockedModule(runtimeSettingsPath, {
      isAiEnabled: async () => true,
      isAiEnabledSync: () => true,
    }),
  );

  const { generateChatSummary } = require(chatAnswerPath);
  const answer = await generateChatSummary(
    "อธิบายการประชุมคณะกรรมการดำเนินการ",
    [
      {
        source: "admin_knowledge",
        id: 1,
        title: "การประชุมคณะกรรมการดำเนินการ",
        reference: "Q&A",
        content:
          "การประชุมคณะกรรมการดำเนินการมีไว้เพื่อให้คณะกรรมการพิจารณา ตัดสินใจ ติดตามการดำเนินงาน และจัดทำมติไว้เป็นหลักฐาน",
        score: 130,
      },
    ],
    {
      databaseOnlyMode: false,
      promptProfile: {
        code: "detailed",
        aiSourceLimit: 3,
        aiSourceContextCharLimit: 700,
        aiMaxOutputTokens: 256,
      },
    },
  );

  assert.equal(
    (answer.match(/การประชุมมีไว้เพื่อให้คณะกรรมการร่วมกันพิจารณา ตัดสินใจ และติดตามการดำเนินงาน/g) || []).length,
    1,
  );
  assert.match(answer, /รายละเอียดเพิ่มเติม:\nการทำมติไว้เป็นหลักฐานช่วยให้ตรวจสอบย้อนหลังได้/);
});
