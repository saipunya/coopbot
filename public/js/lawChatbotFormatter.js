(function (root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.CoopbotLawChatbotFormatter = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function () {
  function isDisplayListLine(line) {
    return /^(?:\([0-9๐-๙]{1,3}\)|[0-9๐-๙]{1,3}[.)]|ข้อ\s*[0-9๐-๙]{1,3}[.)]?|[-•])\s+/u.test(String(line || "").trim());
  }

  function createLawChatbotFormatter(deps = {}) {
    const escapeHtml = typeof deps.escapeHtml === "function"
      ? deps.escapeHtml
      : function escapeHtmlFallback(text) {
          return String(text || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
        };

    const renderAnswerInlineMarkdownHtml = typeof deps.renderAnswerInlineMarkdownHtml === "function"
      ? deps.renderAnswerInlineMarkdownHtml
      : (text) => escapeHtml(text);

    const formatFollowUpPromptHtml = typeof deps.formatFollowUpPromptHtml === "function"
      ? deps.formatFollowUpPromptHtml
      : () => "";

    const applyHighlightHtml = typeof deps.applyHighlightHtml === "function"
      ? deps.applyHighlightHtml
      : (text) => renderAnswerInlineMarkdownHtml(text);

    function formatAnswerLabelLineHtml(line) {
      const text = String(line || "").trim();

      if (!/^(?:คำตอบแบบเข้าใจง่าย|คำตอบจากฐานข้อมูล|สรุปใจความสำคัญ|ข้อมูลเพิ่มเติม|เพิ่มเติมจากข้อมูลอื่น)\s*:/u.test(text)) {
        return text;
      }

      return text.replace(/^([^:]+:)/u, "<strong>$1</strong>");
    }

    function formatBotDisplayLineHtml(text, terms, options = {}) {
      const html =
        formatFollowUpPromptHtml(text, terms) ||
        applyHighlightHtml(text, terms);

      const normalizedHtml = String(html || "").replace(/\n/g, "<br>");

      const lines = normalizedHtml
        .split(/<br\s*\/?>/gi)
        .map((line) => line.trim())
        .filter(Boolean);

      return lines
        .map((line) => {
          const formattedLine = formatAnswerLabelLineHtml(line);
          const aiClass = options.useAi ? "ai-answer-item" : "";
          const highlightClass = /(?:มาตรา|ข้อ)\s*[0-9๐-๙]{1,3}(?:\/[0-9๐-๙]+)?/u.test(line)
            ? " answer-item-highlight"
            : "";
          return `<div class="answer-item${aiClass}${highlightClass}">${formattedLine}</div>`;
        })
        .join("");
    }

    return {
      isDisplayListLine,
      formatAnswerLabelLineHtml,
      formatBotDisplayLineHtml,
    };
  }

  return {
    createLawChatbotFormatter,
    isDisplayListLine,
  };
});
