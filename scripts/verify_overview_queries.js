/* eslint-disable no-console */
require("dotenv").config();

const { connectDb } = require("../config/db");
const {
  classifyQuestionIntent,
  searchDatabaseSources,
  selectTieredSources,
} = require("../services/sourceSelectionService");

function isLegalish(text = "") {
  return /(มาตรา\s*\d+|มาตรา|วรรค|อนุมาตรา|พระราชบัญญัติ|กฎกระทรวง|ระเบียบ|ข้อบังคับ|นายทะเบียน|อำนาจหน้าที่)/.test(
    String(text || ""),
  );
}

function groupBySource(matches = []) {
  const groups = {
    structured_laws: [],
    admin_knowledge: [],
    knowledge_suggestion: [],
    vinichai: [],
    documents: [],
    pdf_chunks: [],
    knowledge_base: [],
    internet: [],
  };

  for (const item of matches) {
    const src = String(item?.source || "").trim().toLowerCase();
    if (src === "tbl_laws" || src === "tbl_glaws") {
      groups.structured_laws.push(item);
    } else if (src === "admin_knowledge") {
      groups.admin_knowledge.push(item);
    } else if (src === "knowledge_suggestion") {
      groups.knowledge_suggestion.push(item);
    } else if (src === "tbl_vinichai") {
      groups.vinichai.push(item);
    } else if (src === "documents") {
      groups.documents.push(item);
    } else if (src === "pdf_chunks") {
      groups.pdf_chunks.push(item);
    } else if (src === "knowledge_base") {
      groups.knowledge_base.push(item);
    } else if (src === "internet_search") {
      groups.internet.push(item);
    }
  }

  return groups;
}

async function run() {
  await connectDb();

  const queries = [
    "ความรู้ทั่วไปเกี่ยวกับสหกรณ์",
    "สหกรณ์คืออะไร",
    "ประโยชน์ของสหกรณ์",
    "นายทะเบียนสหกรณ์มีอำนาจหน้าที่อะไร",
    "มาตรา 16 ว่าด้วยอะไร",
  ];

  for (const query of queries) {
    const intent = classifyQuestionIntent(query);
    const matches = await searchDatabaseSources(query, "all", {
      originalMessage: query,
      planCode: "free",
      hybridTimeoutMs: 2500,
    });

    const grouped = groupBySource(matches);
    const selection = selectTieredSources(grouped, intent, {
      originalMessage: query,
      message: query,
      planCode: "free",
    });

    console.log("\n==============================");
    console.log("Q:", query);
    console.log("intent:", intent);
    console.log("top matches:", matches.slice(0, 6).map((m) => ({
      source: m.source,
      score: m.score,
      title: String(m.title || m.reference || "").slice(0, 60),
      legalish: isLegalish(`${m.title || ""} ${m.reference || ""} ${m.keyword || ""} ${m.content || ""} ${m.chunk_text || ""}`),
    })));
    console.log("selected sources:", (selection.selectedSources || []).map((s) => ({
      source: s.source,
      score: s.score,
      title: String(s.title || s.reference || "").slice(0, 60),
      legalish: isLegalish(`${s.title || ""} ${s.reference || ""} ${s.keyword || ""} ${s.content || ""} ${s.chunk_text || ""}`),
    })));
  }

  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
