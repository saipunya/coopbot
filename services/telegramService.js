const runtimeFlags = require("../config/runtimeFlags");
const { getPlanLabel, normalizePlanCode } = require("./planService");

function getTelegramConfig() {
  return {
    botToken: String(process.env.TELEGRAM_BOT_TOKEN || "").trim(),
    chatId: String(process.env.TELEGRAM_CHAT_ID || "").trim(),
  };
}

function hasTelegramConfig() {
  const config = getTelegramConfig();
  return Boolean(config.botToken && config.chatId);
}

async function sendTelegramMessage(text) {
  const messageText = String(text || "").trim();
  if (!messageText) {
    throw new Error("Telegram message text is required.");
  }

  if (runtimeFlags.useMockTelegram) {
    console.log("[MOCK TELEGRAM]", messageText);
    return {
      ok: true,
      skipped: true,
      reason: "mock_mode",
      messageId: null,
      chatId: null,
    };
  }

  const { botToken, chatId } = getTelegramConfig();
  if (!botToken || !chatId) {
    return {
      ok: false,
      skipped: true,
      reason: "missing_config",
    };
  }

  if (typeof fetch !== "function") {
    throw new Error("fetch is not available in this runtime");
  }

  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      chat_id: chatId,
      text: messageText,
    }),
  });

  const data = await response.json().catch(() => null);

  if (!response.ok || !data?.ok) {
    throw new Error(data?.description || `Telegram API request failed with HTTP ${response.status}`);
  }

  return {
    ok: true,
    skipped: false,
    messageId: data.result?.message_id || null,
    chatId,
  };
}

function buildTelegramPaymentRequestMessage(paymentRequest = {}, user = {}) {
  const planCode = normalizePlanCode(paymentRequest.planName || paymentRequest.plan_name || "");
  const planLabel = getPlanLabel(planCode);
  const lines = [
    "New payment request",
    `Request ID: ${paymentRequest.id || "-"}`,
    `User ID: ${user.userId || user.id || paymentRequest.userId || "-"}`,
    `Name: ${user.name || user.username || "-"}`,
    `Email: ${user.email || "-"}`,
    `Plan: ${planLabel} (${planCode || "-"})`,
    `Amount: ${paymentRequest.amount || "-"}`,
    `Slip: ${paymentRequest.slipImage || "-"}`,
    `CTA Source: ${paymentRequest.ctaSourceLabel || paymentRequest.ctaSource || "payment-request-direct"}`,
    `Note: ${paymentRequest.note || "-"}`,
    `Status: ${paymentRequest.status || "pending"}`,
    `Time: ${new Date().toISOString()}`,
  ];

  return lines.join("\n");
}

async function sendPaymentRequestNotification(paymentRequest, user) {
  return sendTelegramMessage(buildTelegramPaymentRequestMessage(paymentRequest, user));
}

async function sendTelegramTestMessage(label = "manual") {
  const timestamp = new Date().toISOString();
  return sendTelegramMessage(`Coopbot Telegram test (${label})\nTime: ${timestamp}`);
}

module.exports = {
  getTelegramConfig,
  hasTelegramConfig,
  sendTelegramMessage,
  sendPaymentRequestNotification,
  sendTelegramTestMessage,
  buildTelegramPaymentRequestMessage,
};
