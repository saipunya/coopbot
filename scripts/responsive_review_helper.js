require("dotenv").config();

const baseUrl = process.env.COOPBOT_VERIFY_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;

const viewports = [
  { size: "320 x 568", note: "small phone / legacy iPhone size" },
  { size: "390 x 844", note: "modern phone baseline" },
  { size: "768 x 1024", note: "portrait tablet" },
];

const pages = [
  { path: "/law-chatbot", focus: "chat header, plan ribbon, composer, floating actions" },
  { path: "/law-chatbot/payment-request", focus: "plan comparison cards, form, recent requests" },
  { path: "/law-chatbot/upload", focus: "hero collapse, upload form, stat cards, accepted types" },
  { path: "/law-chatbot/feedback", focus: "feedback form, metrics, feedback list" },
  { path: "/admin/login", focus: "login card, Google button, back link" },
  { path: "/admin", focus: "metric cards, quick links, admin action forms" },
  { path: "/admin/users", focus: "search form, user cards, plan controls" },
  { path: "/admin/payment-requests", focus: "status chips, plan chips, update-plan controls" },
  { path: "/admin/payment-requests/:id", focus: "detail panels, approve/reject actions" },
  { path: "/user", focus: "profile hero, plan spotlight, action buttons, stat cards" },
  { path: "/user/search-history", focus: "history hero, item cards, action buttons" },
];

const expectations = [
  "No horizontal scrolling on core content",
  "Primary buttons remain visible and tappable",
  "Cards stack or wrap cleanly without text collision",
  "Form controls remain full-width and readable",
  "Package chips and status badges do not overflow containers",
];

function printResponsiveReviewGuide() {
  console.log("Responsive review helper");
  console.log("");
  console.log(`Base URL: ${baseUrl}`);
  console.log("");
  console.log("Viewport matrix:");
  for (const viewport of viewports) {
    console.log(`- ${viewport.size}  ${viewport.note}`);
  }

  console.log("");
  console.log("Global expectations:");
  for (const item of expectations) {
    console.log(`- ${item}`);
  }

  console.log("");
  console.log("Pages to review:");
  for (const page of pages) {
    console.log(`- ${baseUrl}${page.path}  ${page.focus}`);
  }
}

if (require.main === module) {
  printResponsiveReviewGuide();
}

module.exports = {
  baseUrl,
  viewports,
  pages,
  expectations,
  printResponsiveReviewGuide,
};
