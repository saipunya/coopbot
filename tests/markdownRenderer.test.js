const test = require("node:test");
const assert = require("node:assert/strict");

const { renderInlineMarkdownHtml, renderMarkdownHtml } = require("../public/js/markdown-renderer");

test("renders bold markdown as strong text", () => {
  const html = renderInlineMarkdownHtml("นี่คือ **ข้อความ** ทดสอบ");

  assert.equal(html, "นี่คือ <strong>ข้อความ</strong> ทดสอบ");
});

test("escapes raw html before rendering markdown", () => {
  const html = renderInlineMarkdownHtml('ใช้ <script>alert("x")</script> และ **ปลอดภัย**');

  assert.equal(
    html,
    "ใช้ &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; และ <strong>ปลอดภัย</strong>"
  );
});

test("renders markdown links and inline code", () => {
  const html = renderMarkdownHtml("ดู [เอกสาร](https://example.com)\nใช้ `npm install`");

  assert.equal(
    html,
    'ดู <a href="https://example.com" target="_blank" rel="noopener noreferrer">เอกสาร</a><br>ใช้ <code>npm install</code>'
  );
});
