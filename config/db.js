function connectDb() {
  const dbUrl = process.env.DATABASE_URL || "not-configured";
  const status = dbUrl === "not-configured" || dbUrl === "" ? "stub mode" : "configured";

  console.log(`Database status: ${status}`);
}

module.exports = { connectDb };
