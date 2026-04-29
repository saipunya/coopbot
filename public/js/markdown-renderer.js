(function (root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.CoopbotMarkdownRenderer = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function () {
  function escapeHtml(text) {
    return String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function sanitizeUrl(url) {
    const raw = String(url || "").trim();
    if (!raw) {
      return "";
    }

    if (/^(?:https?:|mailto:)/i.test(raw)) {
      return raw;
    }

    if (/^\//.test(raw)) {
      return raw;
    }

    return "";
  }

  function renderInlineMarkdownHtml(text) {
    const raw = String(text || "");
    if (!raw) {
      return "";
    }

    const codeTokens = [];
    let html = escapeHtml(raw).replace(/`([^`\n]+)`/g, (_, code) => {
      const token = `\u0000CODE_${codeTokens.length}\u0000`;
      codeTokens.push(`<code>${escapeHtml(code)}</code>`);
      return token;
    });

    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, url) => {
      const safeUrl = sanitizeUrl(url);
      if (!safeUrl) {
        return match;
      }

      return `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    });

    html = html.replace(/\*\*([\s\S]+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/__([\s\S]+?)__/g, "<strong>$1</strong>");
    html = html.replace(/\*([\s\S]+?)\*/g, "<em>$1</em>");
    html = html.replace(/_([\s\S]+?)_/g, "<em>$1</em>");

    codeTokens.forEach((snippet, index) => {
      const token = `\u0000CODE_${index}\u0000`;
      html = html.replace(token, snippet);
    });

    return html;
  }

  function renderMarkdownHtml(text) {
    return String(text || "")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => renderInlineMarkdownHtml(line))
      .join("<br>");
  }

  return {
    escapeHtml,
    renderInlineMarkdownHtml,
    renderMarkdownHtml,
  };
});
