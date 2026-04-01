require("dotenv").config();

const express = require("express");
const session = require("express-session");
const path = require("path");

const { connectDb } = require("./config/db");
const adminController = require("./controllers/adminController");
const adminRoutes = require("./routes/admin");
const lawChatbotRoutes = require("./routes/lawChatbot");
const { attachCurrentUser, redirectIfAuthenticated } = require("./middlewares/authMiddleware");

const app = express();
const port = process.env.PORT || 3000;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.set("trust proxy", 1);

app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || "change-this-session-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: "auto",
      maxAge: 1000 * 60 * 60 * 8,
    },
  })
);
app.use(attachCurrentUser);

app.get("/", (req, res) => {
  res.redirect("/law-chatbot");

});

app.get("/auth/google", redirectIfAuthenticated, adminController.redirectToGoogleLogin);
app.get("/auth/google/callback", redirectIfAuthenticated, adminController.handleGoogleCallback);

app.use("/admin", adminRoutes);
app.use("/law-chatbot", lawChatbotRoutes);

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
  console.log("GOOGLE_REDIRECT_URI =", process.env.GOOGLE_REDIRECT_URI);
  console.log("GOOGLE_CLIENT_ID =", process.env.GOOGLE_CLIENT_ID);
  app.listen(port, () => {
    console.log(`coopbot is running at http://localhost:${port}`);
  });
}

startServer().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
