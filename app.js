require("dotenv").config();

const express = require("express");
const session = require("express-session");
const path = require("path");

const { connectDb } = require("./config/db");
const adminController = require("./controllers/adminController");
const adminRoutes = require("./routes/admin");
const lawChatbotRoutes = require("./routes/lawChatbot");
const userRoutes = require("./routes/user");
const { attachCurrentUser, redirectIfAuthenticated } = require("./middlewares/authMiddleware");
const { createSessionStore } = require("./services/mysqlSessionStore");
const { refreshAiSetting } = require("./services/runtimeSettingsService");

const app = express();
const port = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === "production";
const useAutoSecureSessionCookie = (() => {
  const redirectUri = String(process.env.GOOGLE_REDIRECT_URI || "").trim();
  if (!redirectUri) {
    return !isProduction;
  }

  try {
    const parsedRedirectUri = new URL(redirectUri);
    const hostname = String(parsedRedirectUri.hostname || "").trim().toLowerCase();
    const isLoopbackHost =
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]";

    return parsedRedirectUri.protocol !== "https:" && isLoopbackHost;
  } catch (error) {
    return !isProduction;
  }
})();
const sessionTtlMs = 1000 * 60 * 60 * 8;
const sessionStore = createSessionStore({
  defaultTtlMs: sessionTtlMs,
});

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.set("trust proxy", 1);

app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads/paymentRequests", express.static(path.join(__dirname, "uploads", "paymentRequests")));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || "change-this-session-secret",
    resave: false,
    saveUninitialized: false,
    proxy: true,
    store: sessionStore,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: useAutoSecureSessionCookie ? "auto" : isProduction,
      maxAge: sessionTtlMs,
    },
  })
);
app.use(attachCurrentUser);

app.get("/", (req, res) => {
  res.redirect("/law-chatbot");

});

app.get("/auth/test", (req, res) => {
  res.send("AUTH TEST OK");
});

app.get("/google-callback-test", (req, res) => {
  res.json({
    ok: true,
    query: req.query,
  });
});

app.get("/auth/google", redirectIfAuthenticated, adminController.redirectToGoogleLogin);
app.get("/auth/google/callback", adminController.handleGoogleCallback);

app.use("/admin", adminRoutes);
app.use("/law-chatbot", lawChatbotRoutes);
app.use("/user", userRoutes);

app.use((req, res) => {
  res.status(404).render("lawChatbot/index", {
    title: "Page Not Found",
    themeColor: "#2f5f7a",
    manifestPath: "/manifest-law-chatbot.json",
    data: {
      appName: "Coopbot Law Chatbot",
      description: "The page you requested could not be found.",
      status: "404",
      conversationCount: 0,
      uploadedPdfCount: 0,
    },
  });
});

async function startServer() {
  await connectDb();
  await refreshAiSetting({ force: true });
  // console.log("GOOGLE_REDIRECT_URI =", process.env.GOOGLE_REDIRECT_URI);
  // console.log("GOOGLE_CLIENT_ID =", process.env.GOOGLE_CLIENT_ID);
  console.log(
    "SESSION_STORE =",
    sessionStore.getActiveStoreType ? sessionStore.getActiveStoreType() : sessionStore.storeType || "memory"
  );
  app.listen(port, () => {
    console.log(`coopbot is running at http://localhost:${port}`);
  });
}

startServer().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
