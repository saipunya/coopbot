const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function extractFunction(source, functionName, nextFunctionName) {
  const startPattern = `\nfunction ${functionName}`;
  const start = source.indexOf(startPattern) >= 0
    ? source.indexOf(startPattern) + 1
    : source.indexOf(`function ${functionName}`);
  if (start < 0) {
    throw new Error(`Missing ${functionName}`);
  }

  const end = source.indexOf(`function ${nextFunctionName}`, start);
  if (end < 0) {
    throw new Error(`Missing ${nextFunctionName}`);
  }

  return source.slice(start, end);
}

function loadBuildToneWrappedResponseHtml() {
  const viewPath = path.join(__dirname, "..", "views", "lawChatbot", "index.ejs");
  const source = fs.readFileSync(viewPath, "utf8");
  const functionText = extractFunction(source, "buildToneWrappedResponseHtml", "resolvePreparedQaTitle");

  return new Function(
    "escapeHtml",
    `
${functionText}
return buildToneWrappedResponseHtml;
    `,
  )((value) => String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[ch]));
}

test("friendly intro is inserted after the Coopbot summary title", () => {
  const buildToneWrappedResponseHtml = loadBuildToneWrappedResponseHtml();
  const intro = 'สำหรับเรื่อง "คพช" ผมจะช่วยอธิบายจากข้อมูลที่มีในระบบนะครับ';
  const html = `
    <div class="bot-answer-main">
      <div class="bot-answer-summary">
        <div class="bot-answer-section">
          <div class="bot-answer-section-title bot-answer-section-title-assistant"><i class="bi bi-robot"></i>Coopbot ขอสรุปข้อมูล ดังนี้</div>
          <div class="bot-answer-bullets"><ul><li>เนื้อหาคำตอบ</li></ul></div>
        </div>
      </div>
    </div>
  `;

  const rendered = buildToneWrappedResponseHtml(html, [], { responseIntro: intro });

  assert.match(rendered, /Coopbot ขอสรุปข้อมูล ดังนี้/);
  assert.match(rendered, /สำหรับเรื่อง &quot;คพช&quot; ผมจะช่วยอธิบายจากข้อมูลที่มีในระบบนะครับ/);
  assert.ok(
    rendered.indexOf("Coopbot ขอสรุปข้อมูล ดังนี้") < rendered.indexOf("สำหรับเรื่อง &quot;คพช&quot; ผมจะช่วยอธิบายจากข้อมูลที่มีในระบบนะครับ"),
  );
  assert.ok(
    rendered.indexOf("สำหรับเรื่อง &quot;คพช&quot; ผมจะช่วยอธิบายจากข้อมูลที่มีในระบบนะครับ") <
      rendered.indexOf("เนื้อหาคำตอบ"),
  );
});

test("friendly intro still prepends plain responses without the summary title", () => {
  const buildToneWrappedResponseHtml = loadBuildToneWrappedResponseHtml();
  const intro = 'สำหรับเรื่อง "คพช" ผมจะช่วยอธิบายจากข้อมูลที่มีในระบบนะครับ';

  const rendered = buildToneWrappedResponseHtml("<div>คำตอบล้วน ๆ</div>", [], { responseIntro: intro });

  assert.match(rendered, /^<div class="chat-response">/);
  assert.ok(rendered.indexOf("สำหรับเรื่อง &quot;คพช&quot; ผมจะช่วยอธิบายจากข้อมูลที่มีในระบบนะครับ") < rendered.indexOf("คำตอบล้วน ๆ"));
});
