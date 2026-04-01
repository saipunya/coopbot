const runtimeFlags = require("../config/runtimeFlags");
const RuntimeSettingModel = require("../models/runtimeSettingModel");

const AI_ENABLED_KEY = "ai_enabled";
const CACHE_TTL_MS = Number(process.env.RUNTIME_SETTINGS_CACHE_TTL_MS || 15000);

const cache = {
  aiEnabled: true,
  updatedBy: "",
  updatedAt: null,
  loaded: false,
  lastLoadedAt: 0,
};

function parseBoolean(value, fallback = true) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function setCacheFromRow(row) {
  cache.aiEnabled = row ? parseBoolean(row.setting_value, true) : true;
  cache.updatedBy = row?.updated_by || "";
  cache.updatedAt = row?.updated_at || null;
  cache.loaded = true;
  cache.lastLoadedAt = Date.now();
}

async function refreshAiSetting(options = {}) {
  const force = Boolean(options.force);
  if (!force && cache.loaded && Date.now() - cache.lastLoadedAt < CACHE_TTL_MS) {
    return cache.aiEnabled;
  }

  try {
    const row = await RuntimeSettingModel.findByKey(AI_ENABLED_KEY);
    setCacheFromRow(row);
  } catch (error) {
    if (!cache.loaded) {
      setCacheFromRow(null);
    } else {
      cache.lastLoadedAt = Date.now();
    }
    console.error("[runtime-settings] Failed to refresh ai_enabled:", error.message || error);
  }

  return cache.aiEnabled;
}

function isAiEnabledSync() {
  return cache.loaded ? cache.aiEnabled : true;
}

async function isAiEnabled() {
  return refreshAiSetting();
}

async function setAiEnabled(enabled, updatedBy = "") {
  const row = await RuntimeSettingModel.upsert(
    AI_ENABLED_KEY,
    enabled ? "true" : "false",
    updatedBy,
  );
  setCacheFromRow(row);
  return getAiAdminState();
}

async function getAiAdminState() {
  const configuredEnabled = await refreshAiSetting();
  const envMockAi = Boolean(runtimeFlags.useMockAI);

  return {
    configuredEnabled,
    effectiveEnabled: configuredEnabled && !envMockAi,
    envMockAi,
    updatedBy: cache.updatedBy,
    updatedAt: cache.updatedAt,
  };
}

module.exports = {
  getAiAdminState,
  isAiEnabled,
  isAiEnabledSync,
  refreshAiSetting,
  setAiEnabled,
};
