const crypto = require("crypto");
const UserModel = require("../models/userModel");

const GOOGLE_OAUTH_BASE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_TOKEN_INFO_URL = "https://oauth2.googleapis.com/tokeninfo";

function getGoogleConfig() {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || "").trim();

  return {
    clientId,
    clientSecret,
    enabled: Boolean(clientId && clientSecret),
  };
}

function debugGoogleAuth(...args) {
  if (process.env.GOOGLE_AUTH_DEBUG === "1") {
    console.log("[google-auth]", ...args);
  }
}

function isLoopbackHost(hostname) {
  const normalizedHost = String(hostname || "").trim().toLowerCase();
  return (
    normalizedHost === "localhost" ||
    normalizedHost === "127.0.0.1" ||
    normalizedHost === "::1" ||
    normalizedHost === "[::1]"
  );
}

function buildRequestOrigin(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = forwardedProto || req.protocol || "http";
  const host = req.get("host");
  return `${protocol}://${host}`;
}

function buildGoogleRedirectUri() {
  const redirectUri = String(process.env.GOOGLE_REDIRECT_URI || "").trim();

  if (!redirectUri) {
    throw new Error("GOOGLE_REDIRECT_URI is not configured");
  }

  return redirectUri;
}

function createGoogleAuthUrl(req) {
  const config = getGoogleConfig();
  if (!config.enabled) {
    throw new Error("Google OAuth is not configured.");
  }

  const state = crypto.randomBytes(24).toString("hex");
  if (req.session) {
    req.session.googleOAuthState = state;
  }

  const url = new URL(GOOGLE_OAUTH_BASE_URL);
  const redirectUri = buildGoogleRedirectUri(req);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "online");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("prompt", "select_account");
  debugGoogleAuth("create-auth-url", {
    host: req.get("host"),
    redirectUri,
    state,
  });
  return url.toString();
}

async function exchangeCodeForTokens(code, redirectUri) {
  const config = getGoogleConfig();
  if (!config.enabled) {
    throw new Error("Google OAuth is not configured.");
  }

  debugGoogleAuth("exchange-code-start", {
    redirectUri,
    codeLength: String(code || "").length,
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      code: String(code || ""),
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  const payload = await response.json();
  debugGoogleAuth("exchange-code-result", {
    ok: response.ok,
    status: response.status,
    error: payload.error || "",
    errorDescription: payload.error_description || "",
  });
  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || "Google token exchange failed.");
  }

  return payload;
}

async function fetchGoogleProfile(idToken) {
  debugGoogleAuth("fetch-profile-start", {
    idTokenLength: String(idToken || "").length,
  });
  const response = await fetch(`${GOOGLE_TOKEN_INFO_URL}?id_token=${encodeURIComponent(String(idToken || ""))}`);
  const payload = await response.json();
  debugGoogleAuth("fetch-profile-result", {
    ok: response.ok,
    status: response.status,
    email: payload.email || "",
    emailVerified: payload.email_verified || "",
    error: payload.error || "",
    errorDescription: payload.error_description || "",
  });

  if (!response.ok || payload.error_description || payload.error) {
    throw new Error(payload.error_description || payload.error || "Unable to verify Google token.");
  }

  return payload;
}

async function loginWithGoogleCallback(req) {
  const state = String(req.query.state || "");
  const code = String(req.query.code || "");
  const sessionState = req.session?.googleOAuthState || "";

  debugGoogleAuth("callback-received", {
    host: req.get("host"),
    queryState: state,
    sessionState,
    hasCode: Boolean(code),
    queryError: String(req.query.error || ""),
  });

  if (!state || !sessionState || state !== sessionState) {
    throw new Error("สถานะการเข้าสู่ระบบ Google ไม่ถูกต้อง กรุณาลองใหม่อีกครั้ง");
  }

  if (req.session) {
    delete req.session.googleOAuthState;
  }

  if (!code) {
    throw new Error("ไม่พบรหัสยืนยันจาก Google");
  }

  const redirectUri = buildGoogleRedirectUri(req);
  const tokens = await exchangeCodeForTokens(code, redirectUri);
  const profile = await fetchGoogleProfile(tokens.id_token);

  if (!profile.email || profile.email_verified !== "true") {
    throw new Error("บัญชี Google นี้ยังไม่ได้ยืนยันอีเมล");
  }

  const persistedUser = await UserModel.upsertGoogleUser({
    googleId: profile.sub,
    email: profile.email,
    name: profile.name || profile.email,
    avatarUrl: profile.picture || "",
    plan: "free",
    status: "active",
  });

  return {
    ok: true,
    user: {
      id: persistedUser?.id || profile.sub,
      username: persistedUser?.email || profile.email,
      group: "google-admin",
      name: persistedUser?.name || profile.name || profile.email,
      position: "Google Account",
      status: persistedUser?.status || "active",
      email: persistedUser?.email || profile.email,
      authProvider: "google",
      picture: persistedUser?.avatar_url || profile.picture || "",
      googleId: persistedUser?.google_id || profile.sub,
      plan: persistedUser?.plan || "free",
      userId: persistedUser?.id || null,
    },
  };
}

module.exports = {
  getGoogleConfig,
  createGoogleAuthUrl,
  loginWithGoogleCallback,
};
