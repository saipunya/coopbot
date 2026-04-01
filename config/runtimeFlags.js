function parseBooleanEnv(name) {
  return String(process.env[name] || "")
    .trim()
    .toLowerCase() === "true";
}

module.exports = {
  useMockAI: parseBooleanEnv("USE_MOCK_AI"),
  useMockTelegram: parseBooleanEnv("USE_MOCK_TELEGRAM"),
  useMockPayment: parseBooleanEnv("USE_MOCK_PAYMENT"),
};
