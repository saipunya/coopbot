require("dotenv").config();

const {
  getTelegramConfig,
  hasTelegramConfig,
  sendTelegramTestMessage,
} = require("../services/telegramService");

async function main() {
  const label = process.argv[2] || "cli";
  const config = getTelegramConfig();

  if (!hasTelegramConfig()) {
    console.error("Telegram config is missing.");
    console.error(`BOT token present: ${Boolean(config.botToken)}`);
    console.error(`CHAT ID present: ${Boolean(config.chatId)}`);
    process.exit(1);
  }

  const result = await sendTelegramTestMessage(label);
  console.log("Telegram test sent successfully.");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error("Telegram test failed:", error.message || error);
  process.exit(1);
});
