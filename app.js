require("dotenv").config();

const express = require("express");
const path = require("path");

const { connectDb } = require("./config/db");
const lawChatbotRoutes = require("./routes/lawChatbot");

const app = express();
const port = process.env.PORT || 3000;

connectDb();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get("/", (req, res) => {
  res.redirect("/law-chatbot");
});

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

app.listen(port, () => {
  console.log(`coopbot is running at http://localhost:${port}`);
});
