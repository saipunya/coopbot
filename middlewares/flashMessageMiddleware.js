const FLASH_SESSION_KEY = "__flashMessages";
const VALID_FLASH_TYPES = new Set(["success", "error", "info"]);

function normalizeFlashType(value, fallback = "info") {
  const normalized = String(value || "").trim().toLowerCase();
  return VALID_FLASH_TYPES.has(normalized) ? normalized : fallback;
}

function normalizeFlashMessage(value) {
  return String(value || "").trim().slice(0, 1000);
}

function readFlashMessages(req) {
  const rawMessages = req?.session?.[FLASH_SESSION_KEY];
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return [];
  }

  return rawMessages
    .map((item) => ({
      type: normalizeFlashType(item?.type, "info"),
      message: normalizeFlashMessage(item?.message),
    }))
    .filter((item) => item.message);
}

function clearFlashMessages(req) {
  if (req?.session && Object.prototype.hasOwnProperty.call(req.session, FLASH_SESSION_KEY)) {
    delete req.session[FLASH_SESSION_KEY];
  }
}

function pushFlashMessage(req, type, message) {
  if (!req?.session) {
    return;
  }

  const normalizedMessage = normalizeFlashMessage(message);
  if (!normalizedMessage) {
    return;
  }

  const normalizedType = normalizeFlashType(type, "info");
  const currentMessages = Array.isArray(req.session[FLASH_SESSION_KEY])
    ? req.session[FLASH_SESSION_KEY].slice()
    : [];

  currentMessages.push({
    type: normalizedType,
    message: normalizedMessage,
  });

  req.session[FLASH_SESSION_KEY] = currentMessages;
}

function flashMessageMiddleware(req, res, next) {
  const flashMessages = readFlashMessages(req);
  clearFlashMessages(req);
  res.locals.flashMessages = flashMessages;
  next();
}

module.exports = {
  clearFlashMessages,
  flashMessageMiddleware,
  pushFlashMessage,
  readFlashMessages,
};
