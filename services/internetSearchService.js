const { normalizeForSearch, segmentWords, uniqueTokens } = require("./thaiTextUtils");

const WEB_SEARCH_LIMIT = Number(process.env.LAW_CHATBOT_WEB_SEARCH_LIMIT || 3);
const WEB_SEARCH_TIMEOUT_MS = Number(process.env.LAW_CHATBOT_WEB_SEARCH_TIMEOUT_MS || 8000);
const WEB_SEARCH_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

// Trusted domains for government/legal sources
const TRUSTED_DOMAINS = [
  'cpd.go.th',      // คปท.
  'cad.go.th',      // คปช.
  'ratchakitcha.soc.go.th', // ราชกิจจานุเบกษา
  'law.go.th',      // ศูนย์บริการข้อมูลกฎหมาย
  'coop.go.th',     // กระทรวงเกษตรและสหกรณ์
  'moac.go.th',     // กระทรวงเกษตรและสหกรณ์
];

function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&nbsp;/gi, " ");
}

function stripHtml(text) {
  return decodeHtmlEntities(String(text || "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function normalizeSearchUrl(rawUrl) {
  const cleaned = decodeHtmlEntities(String(rawUrl || "").trim());
  if (!cleaned) {
    return "";
  }

  try {
    const parsed = new URL(cleaned, "https://duckduckgo.com");
    const redirectUrl = parsed.searchParams.get("uddg");
    if (redirectUrl) {
      return decodeURIComponent(redirectUrl);
    }
    return parsed.toString();
  } catch {
    return cleaned;
  }
}

function getUrlDomain(rawUrl) {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

async function fetchText(url, timeoutMs = WEB_SEARCH_TIMEOUT_MS) {
  if (typeof fetch !== "function") {
    throw new Error("fetch is not available in this runtime");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "th-TH,th;q=0.9,en;q=0.8",
        "user-agent": WEB_SEARCH_USER_AGENT,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeoutId);
  }
}

function scoreInternetSource(query, source) {
  const queryText = normalizeForSearch(query).toLowerCase();
  const sourceText = normalizeForSearch(`${source.title || ""} ${source.snippet || ""} ${source.domain || ""}`).toLowerCase();
  const queryTokens = uniqueTokens(segmentWords(query));
  const sourceTokens = new Set(uniqueTokens(segmentWords(sourceText)));

  let score = 8;

  if (queryText && sourceText.includes(queryText)) {
    score += 20;
  }

  const tokenHits = queryTokens.filter((token) => sourceTokens.has(token)).length;
  score += tokenHits * 6;

  const coverage = queryTokens.length > 0 ? tokenHits / queryTokens.length : 0;
  score += coverage * 18;

  if (source.domain) {
    score += 4;
  }

  if (source.snippet) {
    score += 4;
  }

  // Bonus for trusted government/legal domains
  if (source.domain && TRUSTED_DOMAINS.some(domain => source.domain.includes(domain))) {
    score += 15;
  }

  return score;
}

function extractWebSearchResults(html, limit = WEB_SEARCH_LIMIT) {
  const results = [];
  const titlePattern = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match = null;

  while ((match = titlePattern.exec(html)) && results.length < limit) {
    const url = normalizeSearchUrl(match[1]);
    const title = stripHtml(match[2]);

    if (!title) {
      continue;
    }

    const windowText = html.slice(match.index, titlePattern.lastIndex + 1200);
    const snippetMatch =
      windowText.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|span|div)>/i) ||
      windowText.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)$/i);
    const snippet = stripHtml(snippetMatch?.[1] || "");

    results.push({
      title,
      url,
      snippet,
      domain: getUrlDomain(url),
    });
  }

  return results;
}

async function searchInternetSources(message, target, options = {}) {
  const query = String(message || "").trim();
  if (!query) {
    return [];
  }

  const targetKeyword =
    target === "group" ? "กลุ่มเกษตรกร" : target === "coop" ? "สหกรณ์" : "สหกรณ์ กลุ่มเกษตรกร";
  const searchQuery = `${query} ${targetKeyword}`.trim();
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}&kl=th-th&ia=web`;
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || WEB_SEARCH_TIMEOUT_MS));
  const resultLimit = Math.max(1, Number(options.limit || WEB_SEARCH_LIMIT));

  try {
    const html = await fetchText(searchUrl, timeoutMs);
    if (process.env.DEBUG_INTERNET_SEARCH === "true") {
      console.log("[searchInternetSources] HTML length:", html?.length || 0);
      console.log("[searchInternetSources] Has result__a:", html?.includes("result__a"));
    }
    const rawResults = extractWebSearchResults(html, resultLimit);
    if (process.env.DEBUG_INTERNET_SEARCH === "true") {
      console.log("[searchInternetSources] Raw results:", rawResults?.length || 0);
    }
    const scoredResults = rawResults.map((result) => {
      const baseScore = scoreInternetSource(searchQuery, result);
      return {
        ...result,
        source: "internet_search",
        reference: result.title || result.domain || result.url || "ข้อมูลจากอินเทอร์เน็ต",
        content: result.snippet || "",
        score: baseScore,
      };
    });
    if (process.env.DEBUG_INTERNET_SEARCH === "true") {
      console.log("[searchInternetSources] Scores:", scoredResults.map((r) => r.score));
    }
    return scoredResults
      .filter((result) => result.score > 0)
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, resultLimit);
  } catch (err) {
    console.error("[searchInternetSources] Error:", err?.message || err);
    return [];
  }
}

module.exports = {
  searchInternetSources,
};
