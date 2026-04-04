require("dotenv").config();
const mysql = require("mysql2/promise");
const signature = require("cookie-signature");
const crypto = require("crypto");

const baseUrl = process.env.COOPBOT_VERIFY_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;
const sessionTtlMs = 1000 * 60 * 60 * 8;

function isLocalHostname(value) {
  return ["127.0.0.1", "localhost", "::1"].includes(String(value || "").trim().toLowerCase());
}

function getDatabaseHost() {
  if (process.env.DATABASE_URL) {
    try {
      return new URL(process.env.DATABASE_URL).hostname;
    } catch (_) {
      return "";
    }
  }

  return process.env.DB_HOST || "";
}

function assertSafeExecution() {
  const nodeEnv = String(process.env.NODE_ENV || "").trim().toLowerCase();
  const explicitOverride = String(process.env.COOPBOT_VERIFY_ALLOW_SESSION_WRITE || "").trim().toLowerCase() === "true";
  const baseHost = (() => {
    try {
      return new URL(baseUrl).hostname;
    } catch (_) {
      return "";
    }
  })();
  const databaseHost = getDatabaseHost();
  const localOnlyTarget = isLocalHostname(baseHost) && isLocalHostname(databaseHost);

  if (nodeEnv === "production" && !explicitOverride && !localOnlyTarget) {
    throw new Error("Refusing to forge verification sessions against a non-local production-like environment");
  }
}

function getDatabaseConfig() {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  return {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME,
    charset: "utf8mb4",
  };
}

function assertEnv(name) {
  if (!process.env[name]) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

function buildCookieValue(sessionId) {
  const signed = `s:${signature.sign(sessionId, process.env.SESSION_SECRET)}`;
  return `connect.sid=${encodeURIComponent(signed)}`;
}

function buildSessionPayload(extra) {
  return {
    cookie: {
      originalMaxAge: sessionTtlMs,
      expires: new Date(Date.now() + sessionTtlMs).toISOString(),
      secure: false,
      httpOnly: true,
      path: "/",
      sameSite: "lax",
    },
    ...extra,
  };
}

async function createSession(connection, payload) {
  const sessionId = crypto.randomBytes(16).toString("hex");
  const sessionJson = JSON.stringify(buildSessionPayload(payload));
  const expiresAt = Date.now() + sessionTtlMs;

  await connection.query(
    `INSERT INTO sessions (sid, sess, expires_at)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE
       sess = VALUES(sess),
       expires_at = VALUES(expires_at),
       updated_at = CURRENT_TIMESTAMP()`,
    [sessionId, sessionJson, expiresAt]
  );

  return sessionId;
}

async function fetchCheck(path, options = {}) {
  const response = await fetch(baseUrl + path, {
    headers: options.cookie ? { Cookie: options.cookie } : {},
    redirect: "manual",
  });

  const html = await response.text();
  const phrases = (options.expectedPhrases || []).map((phrase) => ({
    phrase,
    ok: html.includes(phrase),
  }));
  const forbiddenPhrases = (options.forbiddenPhrases || []).map((phrase) => ({
    phrase,
    ok: !html.includes(phrase),
  }));

  return {
    path,
    status: response.status,
    location: response.headers.get("location"),
    phrases,
    forbiddenPhrases,
  };
}

function summarizeChecks(checks) {
  let hasFailure = false;

  console.log("Verification results:");
  for (const check of checks) {
    const statusOk = check.status >= 200 && check.status < 400;
    if (!statusOk) {
      hasFailure = true;
    }

    const phraseSummary = [
      ...check.phrases.map((item) => `${item.ok ? "OK" : "MISS"}:${item.phrase}`),
      ...check.forbiddenPhrases.map((item) => `${item.ok ? "ABSENT" : "UNEXPECTED"}:${item.phrase}`),
    ].join(" | ");

    if (check.phrases.some((item) => !item.ok) || check.forbiddenPhrases.some((item) => !item.ok)) {
      hasFailure = true;
    }

    console.log(
      `${check.path} -> status=${check.status}${check.location ? ` location=${check.location}` : ""}${phraseSummary ? ` | ${phraseSummary}` : ""}`
    );
  }

  return hasFailure;
}

async function main() {
  assertSafeExecution();
  assertEnv("SESSION_SECRET");

  const connection = await mysql.createConnection(getDatabaseConfig());
  const createdSessionIds = [];

  try {
    const [admins] = await connection.query(
      `SELECT m_id, m_user, m_group, m_name, m_position, m_status
       FROM member
       WHERE m_status = 'active'
       ORDER BY m_id ASC
       LIMIT 1`
    );
    const [users] = await connection.query(
      `SELECT id, email, name, avatar_url, google_id, plan, plan_started_at, plan_expires_at, premium_expires_at, status
       FROM users
       WHERE status = 'active'
       ORDER BY id ASC
       LIMIT 1`
    );

    const admin = admins[0] || null;
    const user = users[0] || null;

    if (!admin) {
      throw new Error("No active admin account found for verify:ui");
    }

    if (!user) {
      throw new Error("No active signed-in user found for verify:ui");
    }

    let adminCookie = "";
    let userCookie = "";

    if (admin) {
      const sessionId = await createSession(connection, {
        adminUser: {
          id: admin.m_id,
          username: admin.m_user,
          group: admin.m_group,
          name: admin.m_name,
          position: admin.m_position,
          status: admin.m_status,
        },
      });
      createdSessionIds.push(sessionId);
      adminCookie = buildCookieValue(sessionId);
    }

    if (user) {
      const sessionId = await createSession(connection, {
        user: {
          id: user.id,
          userId: user.id,
          username: user.email,
          email: user.email,
          name: user.name || user.email,
          picture: user.avatar_url || "",
          avatarUrl: user.avatar_url || "",
          googleId: user.google_id || "",
          plan: user.plan || "free",
          planStartedAt: user.plan_started_at || null,
          planExpiresAt: user.plan_expires_at || null,
          premiumExpiresAt: user.premium_expires_at || null,
          status: user.status || "active",
          authProvider: "google",
          group: "google-user",
          position: "Google User",
        },
      });
      createdSessionIds.push(sessionId);
      userCookie = buildCookieValue(sessionId);
    }

    const checks = [];

    checks.push(await fetchCheck("/law-chatbot", {
      expectedPhrases: ["แชทบอทกฎหมายสหกรณ์และกลุ่มเกษตรกร"],
    }));
    checks.push(await fetchCheck("/admin/login", {
      expectedPhrases: ["เข้าสู่ระบบผู้ดูแล"],
    }));

    checks.push(await fetchCheck("/admin", {
      cookie: adminCookie,
      expectedPhrases: ["คำขอชำระเงินที่รอพิจารณา"],
    }));
    checks.push(await fetchCheck("/admin/users", {
      cookie: adminCookie,
      expectedPhrases: ["จัดการผู้ใช้งาน", "แพ็กเกจชำระเงิน", "แพ็กเกจฟรี"],
    }));
    checks.push(await fetchCheck("/admin/payment-requests", {
      cookie: adminCookie,
      expectedPhrases: ["คำขอชำระเงิน"],
    }));

    checks.push(await fetchCheck("/user", {
      cookie: userCookie,
      expectedPhrases: ["แพ็กเกจปัจจุบัน", "สิทธิ์ลอง AI ฟรี"],
    }));
    checks.push(await fetchCheck("/user/search-history", {
      cookie: userCookie,
      expectedPhrases: ["ประวัติการค้นหาของฉัน"],
    }));
    checks.push(await fetchCheck("/law-chatbot/payment-request", {
      cookie: userCookie,
      expectedPhrases: ["คำขออัปเกรดแพ็กเกจ", "เปรียบเทียบแพ็กเกจ", "Professional"],
      forbiddenPhrases: ["Standard"],
    }));

    const hasFailure = summarizeChecks(checks);
    if (hasFailure) {
      process.exitCode = 1;
    }
  } finally {
    if (createdSessionIds.length > 0) {
      await connection.query(
        `DELETE FROM sessions WHERE sid IN (${createdSessionIds.map(() => "?").join(",")})`,
        createdSessionIds
      );
    }

    await connection.end();
  }
}

main().catch((error) => {
  console.error("Verification failed:", error.message);
  process.exitCode = 1;
});