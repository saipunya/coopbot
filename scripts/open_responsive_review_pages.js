require("dotenv").config();

const { spawn } = require("child_process");
const { baseUrl, pages, viewports, printResponsiveReviewGuide } = require("./responsive_review_helper");

function getOpenCommand() {
  switch (process.platform) {
    case "darwin":
      return { command: "open", args: [] };
    case "win32":
      return { command: "cmd", args: ["/c", "start", ""] };
    default:
      return { command: "xdg-open", args: [] };
  }
}

function openUrl(url) {
  const opener = getOpenCommand();
  const child = spawn(opener.command, [...opener.args, url], {
    stdio: "ignore",
    detached: true,
  });

  child.unref();
}

function main() {
  const printOnly = process.argv.includes("--print-only");

  printResponsiveReviewGuide();
  console.log("");
  console.log(`Open mode: ${printOnly ? "print only" : "launch browser tabs"}`);
  console.log(`Recommended device review order: ${viewports.map((item) => item.size).join(" -> ")}`);

  if (printOnly) {
    return;
  }

  for (const page of pages) {
    openUrl(`${baseUrl}${page.path}`);
  }

  console.log("");
  console.log(`Opened ${pages.length} responsive review pages in the default browser.`);
}

main();