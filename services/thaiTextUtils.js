const SEARCH_CONCEPT_EXPANSIONS = [
  {
    triggers: ["เลิกกลุ่มเกษตรกร", "การเลิกกลุ่มเกษตรกร", "ยุบเลิกกลุ่มเกษตรกร"],
    additions: [
      "เลิกกลุ่มเกษตรกร",
      "การเลิกกลุ่มเกษตรกร",
      "กลุ่มเกษตรกรย่อมเลิก",
      "สั่งเลิกกลุ่มเกษตรกร",
    ],
  },
  {
    triggers: ["ชำระบัญชีกลุ่มเกษตรกร", "การชำระบัญชีกลุ่มเกษตรกร"],
    additions: [
      "ชำระบัญชีกลุ่มเกษตรกร",
      "การชำระบัญชีกลุ่มเกษตรกร",
      "ผู้ชำระบัญชีกลุ่มเกษตรกร",
    ],
  },
  {
    triggers: ["จัดตั้งกลุ่มเกษตรกร", "การจัดตั้งกลุ่มเกษตรกร", "จดทะเบียนจัดตั้งกลุ่มเกษตรกร"],
    additions: [
      "จัดตั้งกลุ่มเกษตรกร",
      "การจัดตั้งกลุ่มเกษตรกร",
      "จดทะเบียนจัดตั้งกลุ่มเกษตรกร",
    ],
  },
  {
    triggers: ["ประชุมใหญ่สามัญประจำปี"],
    additions: ["ประชุมใหญ่", "ประชุมใหญ่สามัญประจำปี"],
  },
  {
    triggers: ["ประชุมใหญ่วิสามัญ"],
    additions: ["ประชุมใหญ่", "ประชุมใหญ่วิสามัญ"],
  },
  {
    triggers: ["ประชุมใหญ่"],
    unless: ["ประชุมใหญ่สามัญประจำปี", "ประชุมใหญ่วิสามัญ"],
    additions: ["ประชุมใหญ่", "ประชุมใหญ่สามัญประจำปี", "ประชุมใหญ่วิสามัญ"],
  },
  {
    triggers: ["ประชุมกรรมการ", "ประชุมคณะกรรมการ", "ประชุมคณะกรรมการดำเนินการ"],
    additions: ["ประชุมกรรมการ", "ประชุมคณะกรรมการ", "ประชุมคณะกรรมการดำเนินการ"],
  },
];
const EXCLUSIVE_MEANING_RULES = [
  {
    primary: "นายทะเบียนสหกรณ์",
    conflicts: ["รองนายทะเบียนสหกรณ์"],
  },
  {
    primary: "รองนายทะเบียนสหกรณ์",
    conflicts: ["นายทะเบียนสหกรณ์"],
  },
  {
    primary: "สมาชิก",
    conflicts: ["สมาชิกสมทบ"],
  },
  {
    primary: "สมาชิกสมทบ",
    conflicts: ["สมาชิก"],
  },
  {
    primary: "ผู้ตรวจสอบกิจการ",
    conflicts: ["ผู้สอบบัญชี", "ผู้ตรวจการสหกรณ์"],
  },
  {
    primary: "ผู้ตรวจการสหกรณ์",
    conflicts: ["ผู้ตรวจสอบกิจการ", "ผู้สอบบัญชี"],
  },
  {
    primary: "ผู้สอบบัญชี",
    conflicts: ["ผู้ตรวจสอบกิจการ", "ผู้ตรวจการสหกรณ์"],
  },
];
const QUERY_TOPIC_RULES = [
  {
    primary: "ประชุมใหญ่",
    aliases: ["ประชุมใหญ่สามัญประจำปี", "ประชุมใหญ่วิสามัญ"],
    conflicts: ["ประชุมคณะกรรมการ", "ประชุมกรรมการ", "ประชุมคณะกรรมการดำเนินการ"],
    contextSignals: [
      "150 วัน",
      "วันสิ้นปีทางบัญชี",
      "องค์ประชุม",
      "ผู้แทนสมาชิก",
      "นัดประชุมใหญ่",
      "วาระการประชุม",
      "มาตรา 54",
      "มาตรา 56",
      "มาตรา 57",
      "มาตรา 58",
    ],
  },
  {
    primary: "องค์ประชุม",
    aliases: ["องค์ประชุมใหญ่"],
    conflicts: [],
    contextSignals: [
      "ประชุมใหญ่",
      "สมาชิกเข้าร่วม",
      "ผู้แทนเข้าร่วม",
      "100 คน",
      "กึ่งหนึ่ง",
      "นัดครั้งที่ 2",
      "ไม่ครบองค์ประชุม",
      "มาตรา 57",
      "มาตรา 58",
    ],
  },
  {
    primary: "ผู้แทนสมาชิก",
    aliases: ["โดยผู้แทนสมาชิก", "ประชุมใหญ่โดยผู้แทนสมาชิก", "ประชุมโดยผู้แทนสมาชิก"],
    conflicts: [],
    contextSignals: [
      "ประชุมใหญ่",
      "สมาชิก",
      "ข้อบังคับ",
      "คณะกรรมการเห็นสมควร",
      "มาตรา 56",
      "สหกรณ์ขนาดใหญ่",
    ],
  },
  {
    primary: "ทุนสำรอง",
    aliases: ["การจัดสรรทุนสำรอง", "กันทุนสำรอง"],
    conflicts: [],
    contextSignals: [
      "จัดสรร",
      "กันไว้",
      "กำไรสุทธิ",
      "ร้อยละสิบ",
      "10",
      "ไม่น้อยกว่า",
      "มาตรา 60",
      "มาตรา 11",
    ],
  },
  {
    primary: "เงินปันผล",
    aliases: ["ปันผล", "อัตราเงินปันผล"],
    conflicts: [],
    contextSignals: [
      "หุ้นที่ชำระแล้ว",
      "อัตรา",
      "กฎกระทรวง",
      "นายทะเบียนสหกรณ์กำหนด",
      "กำไรสุทธิ",
      "จัดสรร",
      "มาตรา 60",
      "มาตรา 21",
    ],
  },
  {
    primary: "ค่าบำรุงสันนิบาต",
    aliases: [
      "ค่าบำรุงสันนิบาตสหกรณ์",
      "อัตราค่าบำรุงสันนิบาต",
      "ค่าบำรุงสันนิบาตสหกรณ์แห่งประเทศไทย",
    ],
    conflicts: [],
    contextSignals: [
      "อัตรา",
      "ร้อยละ",
      "เปอร์เซ็นต์",
      "กำไรสุทธิ",
      "สามหมื่นบาท",
      "กฎกระทรวง",
      "จัดสรร",
      "ชำระ",
      "จ่าย",
      "คำนวณ",
      "สหกรณ์แห่งประเทศไทย",
    ],
  },
  {
    primary: "เบี้ยประชุม",
    aliases: [
      "จ่ายเบี้ยประชุม",
      "ค่าตอบแทนในการประชุมใหญ่",
      "เบี้ยประชุมในการประชุมใหญ่",
      "เบี้ยประชุมผู้จัดการ",
      "เบี้ยประชุมเจ้าหน้าที่",
      "ค่าใช้จ่ายประชุม",
      "ค่าใช้จ่ายในการประชุม",
      "ประชุมสัมมนา",
      "ค่าใช้จ่ายสัมมนา",
    ],
    conflicts: [],
    contextSignals: [
      "ค่าตอบแทน",
      "ผู้จัดการ",
      "เจ้าหน้าที่",
      "ประชุมใหญ่",
      "เข้าร่วมประชุม",
      "จ่ายให้",
      "ได้รับ",
      "ได้หรือไม่",
      "เบิกจ่าย",
    ],
  },
  {
    primary: "ค่าตอบแทน",
    aliases: [
      "ค่าตอบแทนกรรมการ",
      "ค่าตอบแทนเจ้าหน้าที่",
      "ค่าตอบแทนกรรมการและเจ้าหน้าที่",
    ],
    conflicts: [],
    contextSignals: [
      "กรรมการ",
      "เจ้าหน้าที่",
      "แผนงาน",
      "งบประมาณ",
      "มติที่ประชุมใหญ่",
      "ส่วนได้ส่วนเสีย",
      "พิจารณาค่าตอบแทน",
      "ให้ตนเอง",
    ],
  },
  {
    primary: "โบนัส",
    aliases: [
      "เงินโบนัส",
      "โบนัสกรรมการ",
      "โบนัสเจ้าหน้าที่",
      "โบนัสกรรมการและเจ้าหน้าที่",
    ],
    conflicts: [],
    contextSignals: [
      "กรรมการ",
      "เจ้าหน้าที่",
      "ข้อบังคับ",
      "การจัดสรรกำไรสุทธิ",
      "กำไรสุทธิประจำปี",
      "ร้อยละ",
      "ไม่ต่ำกว่า",
    ],
  },
  {
    primary: "การชำระบัญชี",
    aliases: ["ชำระบัญชี", "ผู้ชำระบัญชี"],
    conflicts: ["สอบบัญชี", "ผู้สอบบัญชี"],
    contextSignals: [
      "เลิกสหกรณ์",
      "เลิก",
      "ล้มละลาย",
      "หมวด 4",
      "ชำระหนี้",
      "จำหน่ายทรัพย์สิน",
      "ผู้ชำระบัญชี",
      "รายงานการชำระบัญชี",
      "ถอนชื่อสหกรณ์ออกจากทะเบียน",
      "มอบบรรดาสมุดบัญชีและเอกสาร",
      "มาตรา 73",
      "มาตรา 74",
      "มาตรา 75",
      "มาตรา 77",
      "มาตรา 81",
      "มาตรา 87",
    ],
  },
  {
    primary: "การเลิกสหกรณ์",
    aliases: ["เลิกสหกรณ์", "สหกรณ์ต้องเลิก", "สหกรณ์ย่อมเลิก", "สหกรณ์เลิก", "สั่งเลิกสหกรณ์"],
    conflicts: [],
    contextSignals: [
      "มีเหตุตามที่กำหนดในข้อบังคับ",
      "สมาชิกน้อยกว่าสิบคน",
      "ที่ประชุมใหญ่ลงมติให้เลิก",
      "ล้มละลาย",
      "นายทะเบียนสหกรณ์สั่งให้เลิก",
      "ไม่เริ่มดำเนินกิจการภายในหนึ่งปี",
      "หยุดดำเนินกิจการติดต่อกันเป็นเวลาสองปี",
      "ไม่ส่งสำเนารายงานประจำปี",
      "งบการเงินประจำปี",
      "สามปีติดต่อกัน",
      "ดำเนินกิจการให้เป็นผลดี",
      "ก่อให้เกิดความเสียหาย",
      "มาตรา 70",
      "มาตรา 71",
      "มาตรา 89/3",
    ],
  },
  {
    primary: "การเลิกกลุ่มเกษตรกร",
    aliases: [
      "เลิกกลุ่มเกษตรกร",
      "กลุ่มเกษตรกรย่อมเลิก",
      "กลุ่มเกษตรกรเลิก",
      "สั่งเลิกกลุ่มเกษตรกร",
      "ยุบเลิกกลุ่มเกษตรกร",
    ],
    conflicts: [],
    contextSignals: [
      "มีเหตุตามที่กำหนดในข้อบังคับ",
      "สมาชิกน้อยกว่าสามสิบคน",
      "ที่ประชุมใหญ่ลงมติให้เลิก",
      "นายทะเบียนสหกรณ์มีอำนาจสั่งเลิกกลุ่มเกษตรกร",
      "ไม่เริ่มดำเนินกิจการภายในหนึ่งปี",
      "หยุดดำเนินกิจการติดต่อกันเป็นเวลาสองปี",
      "กลุ่มเกษตรกรที่เลิก",
      "มาตรา 32",
      "มาตรา 33",
      "มาตรา 34",
    ],
  },
  {
    primary: "การชำระบัญชีกลุ่มเกษตรกร",
    aliases: [
      "ชำระบัญชีกลุ่มเกษตรกร",
      "การชำระบัญชีกลุ่มเกษตรกร",
      "ผู้ชำระบัญชีกลุ่มเกษตรกร",
    ],
    conflicts: ["สอบบัญชี", "ผู้สอบบัญชี"],
    contextSignals: [
      "ผู้ชำระบัญชี",
      "รายงานการชำระบัญชี",
      "ชำระหนี้",
      "จำหน่ายทรัพย์สิน",
      "ถอนชื่อออกจากทะเบียน",
      "มอบบรรดาสมุดบัญชีและเอกสาร",
    ],
  },
  {
    primary: "การจัดตั้งกลุ่มเกษตรกร",
    aliases: [
      "จัดตั้งกลุ่มเกษตรกร",
      "การจัดตั้งกลุ่มเกษตรกร",
      "จดทะเบียนจัดตั้งกลุ่มเกษตรกร",
    ],
    conflicts: [],
    contextSignals: [
      "รับจดทะเบียน",
      "นายทะเบียนสหกรณ์",
      "ใบทะเบียนจัดตั้งกลุ่มเกษตรกร",
      "สมาชิกผู้เริ่มจัดตั้ง",
      "ข้อบังคับ",
    ],
  },
  {
    primary: "การแก้ไขข้อบกพร่อง",
    aliases: [
      "แก้ไขข้อบกพร่อง",
      "ข้อสังเกตข้อบกพร่อง",
      "การแก้ไขข้อสังเกตข้อบกพร่อง",
      "แนวทางการแก้ไขข้อบกพร่อง",
    ],
    conflicts: [],
    contextSignals: [
      "ตรวจการ",
      "ข้อสังเกต",
      "ข้อบกพร่อง",
      "แนวทาง",
      "แก้ไข",
      "รายงานผล",
      "กำหนดระยะเวลา",
      "ปรับปรุง",
      "ติดตามผล",
      "ดำเนินการแก้ไข",
      "เสนอรายงาน",
      "ผู้ตรวจการสหกรณ์",
    ],
  },
  {
    primary: "ผู้ตรวจสอบกิจการ",
    aliases: ["ผู้ตรวจสอบกิจการสหกรณ์"],
    conflicts: ["ผู้ตรวจการสหกรณ์", "ผู้สอบบัญชี"],
    contextSignals: [
      "คุณสมบัติ",
      "ลักษณะต้องห้าม",
      "วิธีการรับสมัคร",
      "ขาดจากการเป็น",
      "อำนาจหน้าที่",
      "รายงานเสนอต่อที่ประชุมใหญ่",
      "เลือกตั้ง",
      "บุคคลภายนอก",
      "ตรวจสอบกิจการของสหกรณ์",
    ],
  },
  {
    primary: "ผู้ตรวจการสหกรณ์",
    aliases: [],
    conflicts: ["ผู้ตรวจสอบกิจการ", "ผู้สอบบัญชี"],
    contextSignals: ["ออกคำสั่ง", "มอบหมาย", "ตรวจการสหกรณ์", "พนักงานเจ้าหน้าที่"],
  },
  {
    primary: "ผู้สอบบัญชี",
    aliases: [],
    conflicts: ["ผู้ตรวจสอบกิจการ", "ผู้ตรวจการสหกรณ์"],
    contextSignals: [
      "สอบบัญชี",
      "ตรวจสอบงบการเงิน",
      "แสดงความเห็น",
      "รับรองบัญชี",
      "กรมตรวจบัญชีสหกรณ์",
      "เป็นผู้สอบบัญชีของสหกรณ์",
      "รายงานการสอบบัญชี",
    ],
  },
  {
    primary: "นายทะเบียนสหกรณ์",
    aliases: ["นายทะเบียน"],
    conflicts: ["รองนายทะเบียนสหกรณ์"],
    contextSignals: [
      "จดทะเบียน",
      "รับจดทะเบียน",
      "เพิกถอนทะเบียน",
      "สั่งเลิก",
      "มีอำนาจ",
      "คำสั่ง",
      "อนุญาต",
      "แต่งตั้ง",
      "ยับยั้งหรือเพิกถอนมติ",
      "ร้องทุกข์หรือฟ้องคดีแทน",
      "ออกคำสั่งเป็นหนังสือ",
      "มอบอำนาจ",
      "วินิจฉัย",
      "นายทะเบียนสหกรณ์",
    ],
  },
  {
    primary: "รองนายทะเบียนสหกรณ์",
    aliases: ["รองนายทะเบียน"],
    conflicts: ["นายทะเบียนสหกรณ์"],
    contextSignals: [
      "รองนายทะเบียนสหกรณ์",
      "ได้รับมอบหมาย",
      "ปฏิบัติการแทน",
      "ทำการแทน",
      "คำสั่งมอบหมาย",
    ],
  },
  {
    primary: "สมาชิก",
    aliases: [],
    conflicts: ["สมาชิกสมทบ"],
    contextSignals: [
      "รับสมาชิก",
      "สมัครเข้าเป็นสมาชิก",
      "คุณสมบัติสมาชิก",
      "สมาชิกมีสิทธิ",
      "สมาชิกมีหน้าที่",
      "สมาชิกของสหกรณ์",
      "ขาดจากการเป็นสมาชิก",
    ],
  },
  {
    primary: "สมาชิกสมทบ",
    aliases: ["สมาชิกประเภทสมทบ"],
    conflicts: ["สมาชิก"],
    contextSignals: [
      "สมาชิกสมทบ",
      "สมาชิกประเภทสมทบ",
      "สิทธิออกเสียง",
      "องค์ประชุม",
      "เป็นกรรมการ",
      "กู้ยืมเงิน",
      "สิทธิของสมาชิกสมทบ",
      "สิทธิและหน้าที่ของสมาชิกสมทบ",
      "ถือหุ้นได้",
      "รับเลือกตั้ง",
      "คุณสมบัติสมาชิกสมทบ",
    ],
  },
];
const QUALIFICATION_INTENT_PATTERNS = [
  "คุณสมบัติ",
  "ลักษณะต้องห้าม",
  "ไม่มีสิทธิ",
  "ขาดจากการเป็น",
  "ขาดคุณสมบัติ",
  "วิธีการรับสมัคร",
];
const DUTY_INTENT_PATTERNS = [
  "อำนาจหน้าที่",
  "มีหน้าที่",
  "หน้าที่ของ",
  "หน้าที่ในการ",
  "บทบาท",
];
const RIGHTS_INTENT_PATTERNS = [
  "สิทธิ",
  "สิทธิของ",
  "สิทธิออกเสียง",
  "องค์ประชุม",
  "เป็นกรรมการ",
  "กู้ยืมเงิน",
];

function normalizeForSearch(text) {
  return String(text || "")
    .replace(/\u0000/g, " ")
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function expandSearchConcepts(text) {
  const normalized = normalizeForSearch(text).toLowerCase();
  if (!normalized) {
    return "";
  }

  const phrases = [normalized];

  for (const rule of SEARCH_CONCEPT_EXPANSIONS) {
    const triggers = Array.isArray(rule.triggers) ? rule.triggers : [];
    const unless = Array.isArray(rule.unless) ? rule.unless : [];
    const matched = triggers.some((trigger) => normalized.includes(String(trigger || "").trim().toLowerCase()));

    if (!matched) {
      continue;
    }

    const blocked = unless.some((trigger) => normalized.includes(String(trigger || "").trim().toLowerCase()));
    if (blocked) {
      continue;
    }

    const additions = Array.isArray(rule.additions) ? rule.additions : [];
    additions.forEach((phrase) => {
      const cleaned = normalizeForSearch(phrase).toLowerCase();
      if (cleaned) {
        phrases.push(cleaned);
      }
    });
  }

  return [...new Set(phrases)].join(" ");
}

function getQueryFocusProfile(query) {
  const normalizedQuery = normalizeForSearch(query).toLowerCase();
  const matchedTopics = QUERY_TOPIC_RULES.filter((rule) => {
    const primary = normalizeForSearch(rule.primary).toLowerCase();
    const aliases = Array.isArray(rule.aliases)
      ? rule.aliases.map((phrase) => normalizeForSearch(phrase).toLowerCase()).filter(Boolean)
      : [];
    return [primary, ...aliases].some((phrase) => phrase && normalizedQuery.includes(phrase));
  }).map((rule) => ({
    primary: normalizeForSearch(rule.primary).toLowerCase(),
    aliases: Array.isArray(rule.aliases)
      ? rule.aliases.map((phrase) => normalizeForSearch(phrase).toLowerCase()).filter(Boolean)
      : [],
    conflicts: Array.isArray(rule.conflicts)
      ? rule.conflicts.map((phrase) => normalizeForSearch(phrase).toLowerCase()).filter(Boolean)
      : [],
    contextSignals: Array.isArray(rule.contextSignals)
      ? rule.contextSignals.map((phrase) => normalizeForSearch(phrase).toLowerCase()).filter(Boolean)
      : [],
  }));

  let intent = "general";
  if (QUALIFICATION_INTENT_PATTERNS.some((phrase) => normalizedQuery.includes(normalizeForSearch(phrase).toLowerCase()))) {
    intent = "qualification";
  } else if (DUTY_INTENT_PATTERNS.some((phrase) => normalizedQuery.includes(normalizeForSearch(phrase).toLowerCase()))) {
    intent = "duty";
  } else if (RIGHTS_INTENT_PATTERNS.some((phrase) => normalizedQuery.includes(normalizeForSearch(phrase).toLowerCase()))) {
    intent = "rights";
  }

  return {
    normalizedQuery,
    intent,
    topics: matchedTopics,
  };
}

function extractExplicitTopicHints(query) {
  return getQueryFocusProfile(query).topics.map((item) => item.primary);
}

function scoreQueryFocusAlignment(query, text) {
  const profile = getQueryFocusProfile(query);
  const normalizedText = normalizeForSearch(text).toLowerCase();
  if (!profile.normalizedQuery || !normalizedText || !profile.topics.length) {
    return 0;
  }

  let score = 0;

  for (const topic of profile.topics) {
    const topicPhrases = [topic.primary, ...(topic.aliases || [])].filter(Boolean);
    const hasPrimary = topicPhrases.some((phrase) => normalizedText.includes(phrase));
    const conflictHits = (topic.conflicts || []).filter((phrase) => normalizedText.includes(phrase));
    const queryHasConflict = conflictHits.some((phrase) => profile.normalizedQuery.includes(phrase));

    if (hasPrimary) {
      score += 22;
    }

    if (!hasPrimary && conflictHits.length > 0 && !queryHasConflict) {
      score -= 60;
      continue;
    }

    if (hasPrimary && conflictHits.length > 0 && !queryHasConflict) {
      score -= conflictHits.length * 18;
    }

    const contextSignals = Array.isArray(topic.contextSignals) ? topic.contextSignals : [];
    const contextHitCount = contextSignals.filter((phrase) => normalizedText.includes(phrase)).length;

    if (hasPrimary && contextSignals.length > 0) {
      if (contextHitCount > 0) {
        score += Math.min(20, contextHitCount * 8);
      } else {
        score -= profile.intent === "general" ? 10 : 22;
      }
    }

    if (profile.intent === "qualification") {
      if (hasPrimary && /(คุณสมบัติ|ลักษณะต้องห้าม|ขาดจากการเป็น|ขาดคุณสมบัติ|วิธีการรับสมัคร|ไม่มีสิทธิ)/.test(normalizedText)) {
        score += 40;
      } else if (hasPrimary) {
        score -= 18;
      }
    }

    if (profile.intent === "duty") {
      if (
        hasPrimary &&
        /(อำนาจหน้าที่|มีหน้าที่|หน้าที่ของ|หน้าที่ในการ|บทบาท|ตรวจสอบกิจการของสหกรณ์|รายงานเสนอต่อที่ประชุมใหญ่|ทำรายงานเสนอต่อที่ประชุมใหญ่)/.test(
          normalizedText,
        )
      ) {
        score += 32;
      } else if (hasPrimary) {
        score -= 20;
      }
    }

    if (profile.intent === "rights") {
      if (
        hasPrimary &&
        /(สิทธิ|สิทธิออกเสียง|องค์ประชุม|เป็นกรรมการ|กู้ยืมเงิน|สิทธิและหน้าที่|ถือหุ้นได้|รับเลือกตั้ง)/.test(
          normalizedText,
        )
      ) {
        score += 34;
      } else if (hasPrimary) {
        score -= 18;
      }
    }
  }

  return score;
}

function hasExclusiveMeaningMismatch(query, text) {
  const normalizedQuery = normalizeForSearch(query).toLowerCase();
  const normalizedText = normalizeForSearch(text).toLowerCase();
  if (!normalizedQuery || !normalizedText) {
    return false;
  }

  return EXCLUSIVE_MEANING_RULES.some((rule) => {
    const primary = normalizeForSearch(rule.primary).toLowerCase();
    const conflicts = Array.isArray(rule.conflicts)
      ? rule.conflicts
          .map((phrase) => normalizeForSearch(phrase).toLowerCase())
          .filter(Boolean)
      : [];
    if (!primary || !normalizedQuery.includes(primary)) {
      return false;
    }

    const queryWithoutPrimary = normalizedQuery.split(primary).join(" ");
    const queryContainsExplicitConflict = conflicts.some((phrase) => {
      if (!normalizedQuery.includes(phrase)) {
        return false;
      }

      if (!primary.includes(phrase)) {
        return true;
      }

      return queryWithoutPrimary.includes(phrase);
    });
    if (queryContainsExplicitConflict) {
      return false;
    }

    const conflictsContainingPrimary = conflicts.filter((phrase) => phrase.includes(primary));
    let textContainsPrimary = normalizedText.includes(primary);
    if (textContainsPrimary && conflictsContainingPrimary.some((phrase) => normalizedText.includes(phrase))) {
      const textWithoutOverlappingConflicts = conflictsContainingPrimary.reduce((buffer, phrase) => {
        return buffer.split(phrase).join(" ");
      }, normalizedText);
      textContainsPrimary = textWithoutOverlappingConflicts.includes(primary);
    }

    if (textContainsPrimary) {
      return false;
    }

    return conflicts.some((phrase) => normalizedText.includes(phrase));
  });
}

function segmentWords(text) {
  const normalized = expandSearchConcepts(text);

  if (!normalized) {
    return [];
  }

  const segmenter = new Intl.Segmenter("th", { granularity: "word" });
  const tokens = [];

  for (const segment of segmenter.segment(normalized)) {
    const token = String(segment.segment || "").trim().toLowerCase();
    if (!token) {
      continue;
    }
    if (/^[^\p{L}\p{M}\p{N}]+$/u.test(token)) {
      continue;
    }
    tokens.push(token);
  }

  return tokens;
}

function uniqueTokens(tokens) {
  return [...new Set((tokens || []).filter(Boolean))];
}

function makeBigrams(tokens) {
  const bigrams = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    bigrams.push(`${tokens[index]} ${tokens[index + 1]}`);
  }
  return bigrams;
}

module.exports = {
  expandSearchConcepts,
  extractExplicitTopicHints,
  getQueryFocusProfile,
  hasExclusiveMeaningMismatch,
  makeBigrams,
  normalizeForSearch,
  scoreQueryFocusAlignment,
  segmentWords,
  uniqueTokens,
  RIGHTS_INTENT_PATTERNS,
};
