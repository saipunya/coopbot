const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 20000);
const { isAiEnabled, isAiEnabledSync } = require("./runtimeSettingsService");

function getOpenAiConfig() {
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) {
    return null;
  }

  return {
    apiKey,
    model: String(process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL).trim() || DEFAULT_OPENAI_MODEL,
  };
}

async function generateOpenAiCompletion(options = {}) {
  if (!(await isAiEnabled())) {
    return "";
  }

  const config = getOpenAiConfig();
  if (!config) {
    return "";
  }

  const timeoutMs = Math.max(1000, Number(options.timeoutMs || OPENAI_TIMEOUT_MS));

  const body = {
    model: options.model || config.model,
    temperature: typeof options.temperature === "number" ? options.temperature : 0.2,
    messages: [
      {
        role: "system",
        content: String(options.systemInstruction || options?.config?.systemInstruction || "").trim(),
      },
      {
        role: "user",
        content: String(options.userContent || options.contents || "").trim(),
      },
    ],
  };

  if (options.responseFormat === "json_object") {
    body.response_format = { type: "json_object" };
  }

  if (typeof options.maxTokens === "number" && options.maxTokens > 0) {
    body.max_tokens = options.maxTokens;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`OpenAI chat completion failed with status ${response.status}`);
    }

    const payload = await response.json();
    return String(payload?.choices?.[0]?.message?.content || "").trim();
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`OpenAI chat completion timed out after ${timeoutMs}ms`);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function getOpenAiClient() {
  const config = getOpenAiConfig();
  if (!config || !isAiEnabledSync()) {
    return null;
  }

  return {
    models: {
      async generateContent(options = {}) {
        const responseMimeType = String(options?.config?.responseMimeType || "").trim().toLowerCase();
        const responseSchemaType = String(options?.config?.responseSchema?.type || "").trim().toUpperCase();
        const text = await generateOpenAiCompletion({
          model: options.model || config.model,
          systemInstruction:
            options?.config?.systemInstruction || options.systemInstruction || "",
          userContent: options.contents || options.userContent || "",
          responseFormat: responseMimeType === "application/json" ? "json_object" : undefined,
          temperature: responseMimeType === "application/json" ? 0 : 0.2,
        });

        if (responseMimeType === "application/json" && responseSchemaType === "ARRAY") {
          try {
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed)) {
              return { text: JSON.stringify(parsed) };
            }

            const firstArrayValue = Object.values(parsed || {}).find((value) => Array.isArray(value));
            if (Array.isArray(firstArrayValue)) {
              return { text: JSON.stringify(firstArrayValue) };
            }
          } catch (_) {
            return { text };
          }
        }

        return { text };
      },
    },
  };
}

module.exports = {
  DEFAULT_OPENAI_MODEL,
  getOpenAiConfig,
  getOpenAiClient,
  generateOpenAiCompletion,
};
