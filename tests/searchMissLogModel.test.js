const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const SearchMissLogModel = require("../models/searchMissLogModel");

test("groups search miss JSONL records and skips invalid lines", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "search-misses-"));
  const filePath = path.join(dir, "search-misses.jsonl");

  await fs.writeFile(
    filePath,
    [
      JSON.stringify({ timestamp: "2026-04-01T00:00:00.000Z", originalQuery: "กี่คน", reason: "no_results", topResultScore: 0 }),
      "not-json",
      JSON.stringify({ timestamp: "2026-04-02T00:00:00.000Z", originalQuery: "กี่คน", reason: "low_top_score", topResultScore: 20 }),
      JSON.stringify({ timestamp: "2026-04-03T00:00:00.000Z", originalQuery: "เลิกสหกรณ์", reason: "no_results", topResultScore: 0 }),
      "",
    ].join("\n"),
    "utf8",
  );

  const grouped = await SearchMissLogModel.listGrouped({ filePath });

  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].query, "กี่คน");
  assert.equal(grouped[0].count, 2);
  assert.equal(grouped[0].latestReason, "low_top_score");
  assert.equal(grouped[0].latestConfidence, 20);
  assert.equal(grouped[1].query, "เลิกสหกรณ์");
});

test("returns empty grouped list when search miss file is missing", async () => {
  const grouped = await SearchMissLogModel.listGrouped({
    filePath: path.join(os.tmpdir(), `missing-search-misses-${Date.now()}.jsonl`),
  });

  assert.deepEqual(grouped, []);
});

test("removes all JSONL records for a query while keeping other lines", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "search-misses-remove-"));
  const filePath = path.join(dir, "search-misses.jsonl");

  await fs.writeFile(
    filePath,
    [
      JSON.stringify({ originalQuery: "กี่คน", reason: "no_results" }),
      "not-json",
      JSON.stringify({ originalQuery: "เลิกสหกรณ์", reason: "low_top_score" }),
      JSON.stringify({ originalQuery: "กี่คน", reason: "thin_result_set" }),
    ].join("\n"),
    "utf8",
  );

  const result = await SearchMissLogModel.removeQuery("กี่คน", { filePath });
  const raw = await fs.readFile(filePath, "utf8");

  assert.equal(result.removedCount, 2);
  assert.match(raw, /not-json/);
  assert.match(raw, /เลิกสหกรณ์/);
  assert.doesNotMatch(raw, /กี่คน/);
});
