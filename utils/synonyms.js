const { normalizeThai } = require("./thaiNormalizer");

const SYNONYM_DICTIONARY = {
  เลิก: ["ยกเลิก", "ยุบ", "สิ้นสุด"],
  สหกรณ์: ["สหกรณ", "coop"],
  คพช: ["คณะกรรมการพัฒนาการสหกรณ์แห่งชาติ"],
  ชำระบัญชี: ["สะสางบัญชี", "ปิดบัญชี"],
  นายทะเบียน: ["นายทะเบียนสหกรณ์", "นายทะเบยน"],
};

function expandKeywords(keyword) {
  const normalizedKeyword = normalizeThai(keyword);
  if (!normalizedKeyword) {
    return [];
  }

  const expanded = new Set([normalizedKeyword]);
  const dictionaryEntries = Object.entries(SYNONYM_DICTIONARY);

  dictionaryEntries.forEach(([baseTerm, synonyms]) => {
    const normalizedBase = normalizeThai(baseTerm);
    const normalizedSynonyms = synonyms.map((term) => normalizeThai(term)).filter(Boolean);
    const allTerms = [normalizedBase, ...normalizedSynonyms];
    const matchesTerm = allTerms.some(
      (term) =>
        term &&
        (normalizedKeyword === term || normalizedKeyword.includes(term)),
    );

    if (!matchesTerm) {
      return;
    }

    allTerms.forEach((term) => {
      if (term) {
        expanded.add(term);
      }
    });
  });

  return Array.from(expanded);
}

module.exports = {
  SYNONYM_DICTIONARY,
  expandKeywords,
};
