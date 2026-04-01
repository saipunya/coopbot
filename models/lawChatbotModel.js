const conversations = [];
const { hasExclusiveMeaningMismatch, segmentWords } = require("../services/thaiTextUtils");

const knowledgeBase = [
  {
    id: 1,
    target: "coop",
    title: "การประชุมใหญ่ของสหกรณ์",
    lawNumber: "หมวดการประชุมใหญ่",
    content:
      "การประชุมใหญ่เป็นองค์กรสูงสุดของสหกรณ์ ใช้พิจารณางบการเงิน เลือกตั้งคณะกรรมการ และกำหนดนโยบายสำคัญของสหกรณ์ สมาชิกควรได้รับหนังสือนัดประชุมล่วงหน้าตามข้อบังคับ",
  },
  {
    id: 2,
    target: "coop",
    title: "อำนาจหน้าที่คณะกรรมการดำเนินการ",
    lawNumber: "หมวดคณะกรรมการดำเนินการ",
    content:
      "คณะกรรมการดำเนินการมีหน้าที่บริหารกิจการสหกรณ์ตามกฎหมาย ข้อบังคับ และมติที่ประชุมใหญ่ รวมถึงควบคุมดูแลการเงิน การบัญชี และการดำเนินงานให้เป็นไปโดยสุจริต",
  },
  {
    id: 3,
    target: "coop",
    title: "การรับสมาชิกสหกรณ์",
    lawNumber: "หมวดสมาชิก",
    content:
      "ผู้สมัครเป็นสมาชิกต้องมีคุณสมบัติตามข้อบังคับของสหกรณ์ ยื่นใบสมัคร และได้รับความเห็นชอบจากคณะกรรมการหรือที่ประชุมตามที่ข้อบังคับกำหนด",
  },
  {
    id: 4,
    target: "group",
    title: "การจัดตั้งกลุ่มเกษตรกร",
    lawNumber: "หมวดการจัดตั้ง",
    content:
      "การจัดตั้งกลุ่มเกษตรกรต้องมีสมาชิกผู้ร่วมก่อตั้งตามจำนวนที่กฎหมายกำหนด มีวัตถุประสงค์ร่วมกัน และจัดทำระเบียบหรือข้อบังคับเบื้องต้นเพื่อการดำเนินงาน",
  },
  {
    id: 5,
    target: "group",
    title: "คณะกรรมการของกลุ่มเกษตรกร",
    lawNumber: "หมวดการบริหาร",
    content:
      "คณะกรรมการของกลุ่มเกษตรกรทำหน้าที่บริหารงานตามมติสมาชิก ดูแลทรัพย์สินของกลุ่ม และรับผิดชอบการจัดทำรายงานผลการดำเนินงานเสนอต่อที่ประชุม",
  },
];

class LawChatbotModel {
  static create(entry) {
    const record = {
      id: conversations.length + 1,
      createdAt: new Date().toISOString(),
      ...entry,
    };

    conversations.unshift(record);
    return record;
  }

  static count() {
    return conversations.length;
  }

  static listRecent(limit = 10) {
    return conversations.slice(0, limit);
  }

  static searchKnowledge(message, target = "all") {
    const terms = segmentWords(message);

    if (terms.length === 0) {
      return [];
    }

    return knowledgeBase
      .filter((item) => (target === "all" ? true : item.target === target))
      .map((item) => {
        const haystack = segmentWords(`${item.title} ${item.lawNumber} ${item.content}`);
        const baseScore = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
        const score = hasExclusiveMeaningMismatch(
          message,
          `${item.title || ""} ${item.lawNumber || ""} ${item.content || ""}`,
        )
          ? baseScore - 20
          : baseScore;
        return { ...item, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
  }
}

module.exports = LawChatbotModel;
