const test = require("node:test");
const assert = require("node:assert/strict");
const { createLawChatbotFormatter } = require("../public/js/lawChatbotFormatter");

function escapeHtml(text) {
  return String(text || "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[ch]);
}

function renderInlineMarkdownHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\*\*([\s\S]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__([\s\S]+?)__/g, "<strong>$1</strong>")
    .replace(/\*([\s\S]+?)\*/g, "<em>$1</em>")
    .replace(/_([\s\S]+?)_/g, "<em>$1</em>");
}

function loadFormatterFunctions() {
  return createLawChatbotFormatter({
    escapeHtml,
    renderAnswerInlineMarkdownHtml: renderInlineMarkdownHtml,
    formatFollowUpPromptHtml: () => "",
    applyHighlightHtml: (text) => renderInlineMarkdownHtml(text),
  });
}

test("bold markdown stays bold and raw markdown markers are removed", () => {
  const { formatBotDisplayLineHtml } = loadFormatterFunctions();

  const html = formatBotDisplayLineHtml("นี่คือ **ข้อความสำคัญ**", []);

  assert.match(html, /<strong>ข้อความสำคัญ<\/strong>/);
  assert.doesNotMatch(html, /\*\*ข้อความสำคัญ\*\*/);
  assert.equal(html, '<div class="answer-item">นี่คือ <strong>ข้อความสำคัญ</strong></div>');
});

test("answer labels are bolded but only for supported prefixes", () => {
  const { formatAnswerLabelLineHtml } = loadFormatterFunctions();

  assert.equal(
    formatAnswerLabelLineHtml("คำตอบจากฐานข้อมูล: ใช้ข้อมูลจากมาตรา 70"),
    "<strong>คำตอบจากฐานข้อมูล:</strong> ใช้ข้อมูลจากมาตรา 70",
  );
  assert.equal(
    formatAnswerLabelLineHtml("แหล่งอ้างอิง: มาตรา 70"),
    "แหล่งอ้างอิง: มาตรา 70",
  );
});

test("numbered list lines remain separate answer items", () => {
  const { formatBotDisplayLineHtml } = loadFormatterFunctions();

  const html = formatBotDisplayLineHtml("1. ข้อแรก\n2. ข้อสอง\n3. ข้อสาม", []);

  assert.equal((html.match(/class="answer-item"/g) || []).length, 3);
  assert.match(html, />1\. ข้อแรก</);
  assert.match(html, />2\. ข้อสอง</);
  assert.match(html, />3\. ข้อสาม</);
});

test("parenthesized list items keep their order and content", () => {
  const { formatBotDisplayLineHtml } = loadFormatterFunctions();

  const html = formatBotDisplayLineHtml("(1) เหตุแรก\n(2) เหตุที่สอง\n(3) เหตุที่สาม", []);

  assert.equal((html.match(/class="answer-item"/g) || []).length, 3);
  assert.ok(html.indexOf("(1) เหตุแรก") < html.indexOf("(2) เหตุที่สอง"));
  assert.ok(html.indexOf("(2) เหตุที่สอง") < html.indexOf("(3) เหตุที่สาม"));
});

test("lines containing มาตรา receive the highlight class", () => {
  const { formatBotDisplayLineHtml } = loadFormatterFunctions();

  const html = formatBotDisplayLineHtml("อ้างถึงมาตรา 70", []);

  assert.match(html, /answer-item-highlight/);
});

test("lines containing ข้อ with a number receive the highlight class", () => {
  const { formatBotDisplayLineHtml } = loadFormatterFunctions();

  const html = formatBotDisplayLineHtml("อ้างถึงข้อ 26", []);

  assert.match(html, /answer-item-highlight/);
});

test("raw html is escaped before rendering", () => {
  const { formatBotDisplayLineHtml } = loadFormatterFunctions();

  const html = formatBotDisplayLineHtml('ใช้ <script>alert("x")</script> ได้ไหม', []);

  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\("x"\)<\/script>/);
});

test("markdown links and inline code survive through the formatter", () => {
  const { formatBotDisplayLineHtml } = loadFormatterFunctions();

  const html = formatBotDisplayLineHtml("ดู [เอกสาร](https://example.com) และ `npm install`", []);

  assert.match(html, /<a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer">เอกสาร<\/a>/);
  assert.match(html, /<code>npm install<\/code>/);
});
