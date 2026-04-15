function normalizeThai(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^0-9a-z\u0E00-\u0E7F\s]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

module.exports = {
  normalizeThai,
};
