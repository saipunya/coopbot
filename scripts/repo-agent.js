#!/usr/bin/env node

require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { generateOpenAiCompletion, getOpenAiConfig } = require("../services/openAiService");
const { isAiEnabledSync } = require("../services/runtimeSettingsService");

const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_MAX_STEPS = 6;
const DEFAULT_SEARCH_LIMIT = 12;
const DEFAULT_FILE_LIMIT = 24;
const MAX_TOOL_OUTPUT_CHARS = 5000;

const RG_IGNORE_GLOBS = [
  "node_modules/**",
  ".git/**",
  "logs/**",
  "tmp/**",
  "tmp_test_upload/**",
  "coverage/**",
  "package-lock.json",
];

function buildRgArgs(baseArgs) {
  const globArgs = RG_IGNORE_GLOBS.flatMap((pattern) => ["--glob", `!${pattern}`]);
  return [...baseArgs, ...globArgs];
}

function parseArgs(argv) {
  const args = {
    maxSteps: DEFAULT_MAX_STEPS,
    help: false,
    questionParts: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--max-steps" && argv[index + 1]) {
      args.maxSteps = Math.max(1, Number(argv[index + 1]) || DEFAULT_MAX_STEPS);
      index += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }

    args.questionParts.push(arg);
  }

  return args;
}

function printUsage() {
  console.log("Usage: node scripts/repo-agent.js [--max-steps 6] \"your question\"");
  console.log("");
  console.log("Examples:");
  console.log('  node scripts/repo-agent.js "ไฟล์ไหนเป็นจุดเริ่มต้นของ law chatbot?"');
  console.log('  npm run agent:repo -- "ช่วยหา flow login ให้หน่อย"');
}

function ensureAiReady() {
  const config = getOpenAiConfig();
  if (!config) {
    throw new Error("Missing OPENAI_API_KEY. Set it in .env before running the agent.");
  }

  if (!isAiEnabledSync()) {
    throw new Error("AI is disabled by runtime settings. Enable AI before running the agent.");
  }
}

function runCommand(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd || REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
}

function normalizeToolText(text) {
  const value = String(text || "").trim();
  if (!value) {
    return "(empty)";
  }

  if (value.length <= MAX_TOOL_OUTPUT_CHARS) {
    return value;
  }

  return `${value.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n...<truncated>`;
}

function resolveRepoPath(inputPath) {
  const relativePath = String(inputPath || "").trim();
  if (!relativePath) {
    throw new Error("Path is required");
  }

  const resolved = path.resolve(REPO_ROOT, relativePath);
  const repoRootWithSep = `${REPO_ROOT}${path.sep}`;
  if (resolved !== REPO_ROOT && !resolved.startsWith(repoRootWithSep)) {
    throw new Error(`Path escapes repository root: ${relativePath}`);
  }

  return resolved;
}

function formatFileLines(lines, startLine) {
  const width = String(startLine + Math.max(0, lines.length - 1)).length;
  return lines
    .map((line, index) => `${String(startLine + index).padStart(width, " ")} | ${line}`)
    .join("\n");
}

function listFiles(prefix = "", limit = DEFAULT_FILE_LIMIT) {
  const result = runCommand("rg", buildRgArgs(["--files", "--hidden"]));
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(result.stderr || "Failed to list files");
  }

  const needle = String(prefix || "").trim().toLowerCase();
  const files = String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => !needle || file.toLowerCase().includes(needle))
    .slice(0, Math.max(1, limit));

  return files.length ? files.join("\n") : "(no matching files)";
}

function searchRepo(query, limit = DEFAULT_SEARCH_LIMIT) {
  const term = String(query || "").trim();
  if (!term) {
    throw new Error("Search query is required");
  }

  const result = runCommand("rg", buildRgArgs(["-n", "-F", "--hidden", term, "."]));
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(result.stderr || "Search failed");
  }

  const lines = String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(0, Math.max(1, limit));

  return lines.length ? lines.join("\n") : "(no matches)";
}

function readFileSection(filePath, startLine = 1, endLine = null) {
  const resolvedPath = resolveRepoPath(filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const raw = fs.readFileSync(resolvedPath, "utf8");
  const lines = raw.split(/\r?\n/);
  const safeStart = Math.max(1, Number(startLine) || 1);
  const safeEnd = endLine === null || endLine === undefined
    ? lines.length
    : Math.max(safeStart, Number(endLine) || lines.length);
  const slice = lines.slice(safeStart - 1, safeEnd);

  return [
    `File: ${path.relative(REPO_ROOT, resolvedPath)}`,
    `Lines: ${safeStart}-${safeEnd} of ${lines.length}`,
    "",
    slice.length ? formatFileLines(slice, safeStart) : "(empty range)",
  ].join("\n");
}

function gitStatus() {
  const result = runCommand("git", ["status", "--short", "--branch"]);
  if (result.status !== 0) {
    throw new Error(result.stderr || "git status failed");
  }

  return String(result.stdout || "").trim() || "(clean working tree)";
}

function buildSystemInstruction() {
  return [
    "You are Coopbot Repo Agent, a read-only coding assistant for this repository.",
    "Use the tools to inspect the actual codebase before answering.",
    "Prefer small, evidence-based steps.",
    "Do not invent file contents. Only rely on tool output.",
    "When you are ready to answer, return JSON with:",
    '{ "action": "final", "answer": "..." }',
    "If more inspection is needed, return JSON with:",
    '{ "action": "tool", "tool": "read_file|search_repo|list_files|git_status", "arguments": { ... } }',
    "Available tools:",
    "- list_files { prefix?: string, limit?: number }",
    "- search_repo { query: string, limit?: number }",
    "- read_file { path: string, startLine?: number, endLine?: number }",
    "- git_status {}",
    "Keep answers concise and practical.",
  ].join("\n");
}

function safeJsonParse(text) {
  try {
    return JSON.parse(String(text || "").trim());
  } catch (error) {
    const match = String(text || "").match(/\{[\s\S]*\}/);
    if (!match) {
      throw error;
    }
    return JSON.parse(match[0]);
  }
}

function buildToolResult(toolName, output) {
  return [
    `TOOL RESULT: ${toolName}`,
    normalizeToolText(output),
  ].join("\n");
}

function executeTool(toolName, args = {}) {
  if (toolName === "list_files") {
    return listFiles(args.prefix || "", args.limit || DEFAULT_FILE_LIMIT);
  }

  if (toolName === "search_repo") {
    return searchRepo(args.query || "", args.limit || DEFAULT_SEARCH_LIMIT);
  }

  if (toolName === "read_file") {
    return readFileSection(args.path || "", args.startLine, args.endLine);
  }

  if (toolName === "git_status") {
    return gitStatus();
  }

  throw new Error(`Unknown tool: ${toolName}`);
}

async function runAgent(question, maxSteps) {
  const history = [];
  const initialPrompt = [
    "User request:",
    question,
    "",
    "Repository root:",
    REPO_ROOT,
    "",
    "Working tree status:",
    gitStatus(),
    "",
    "Decide the next best tool call or answer now.",
  ].join("\n");

  let userPrompt = initialPrompt;

  for (let step = 1; step <= maxSteps; step += 1) {
    const response = await generateOpenAiCompletion({
      systemInstruction: buildSystemInstruction(),
      conversationHistory: history,
      userContent: userPrompt,
      responseFormat: "json_object",
      temperature: 0,
      maxTokens: 900,
    });

    if (!response) {
      throw new Error("Model returned an empty response. Check AI settings and model access.");
    }

    history.push({ role: "assistant", content: response });

    const decision = safeJsonParse(response);
    if (decision.action === "final") {
      return String(decision.answer || "").trim();
    }

    if (decision.action !== "tool") {
      throw new Error(`Unexpected action from model: ${String(decision.action || "")}`);
    }

    const toolName = String(decision.tool || "").trim();
    if (!toolName) {
      throw new Error("Tool name is required when action is tool");
    }

    const toolOutput = executeTool(toolName, decision.arguments || {});
    const nextUserPrompt = buildToolResult(toolName, toolOutput);
    history.push({ role: "user", content: nextUserPrompt });
    userPrompt = "Continue from the latest tool result. If enough evidence exists, answer now.";

    if (step === maxSteps) {
      return "Reached the maximum number of tool steps before the model produced a final answer.";
    }
  }

  return "Reached the maximum number of tool steps before the model produced a final answer.";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.questionParts.length === 0) {
    printUsage();
    return;
  }

  const question = args.questionParts.join(" ").trim();
  if (!question) {
    printUsage();
    return;
  }

  try {
    ensureAiReady();
    const answer = await runAgent(question, args.maxSteps);
    console.log(answer);
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  buildSystemInstruction,
  executeTool,
  listFiles,
  readFileSection,
  resolveRepoPath,
  runAgent,
  searchRepo,
};
