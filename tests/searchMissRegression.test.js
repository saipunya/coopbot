const test = require("node:test");
const assert = require("node:assert/strict");

const { buildQueryRewriteCandidates } = require("../services/queryRewriteService");

async function getFirstRetrievalQuery(message, target = "coop") {
  const rewrite = await buildQueryRewriteCandidates(
    message,
    target,
    {},
    { usedContext: false, topicHints: [] },
    { timeoutMs: 10 },
  );

  return rewrite.candidates[0]?.retrievalQuery || "";
}

test("search miss regression queries stay compact and do not carry admin/debug noise", async () => {
  const queries = [
    "สมาชิกลาออกต้องทำอย่างไร สมาชิกลาออกต้อง q a ผู้ดูแลระบบ ออก สมาชิก สมาชิกสามัญ สมาชิกสามัญ สมาชิก",
    "การแก้ไขข้อบังคับบางข้อ แก้ไขเพิ่มเติมข้อบังคับสหกรณ์ แก้ไขข้อบังคับสหกรณ์ แก้ไขข้อบังคับ การแก้ไขข้อบังคับ แก้ไขข้อบังคับบางข้อ ข้อบังคับสหกรณ์ ที่ประชุมใหญ่ มติสองในสาม นายทะเบียนสหกรณ์ จดทะเบียน ภายในสามสิบวัน มาตรา 44 การแก้ไขข้อบังคับบางข้อ ประชุมใหญ่ นายทะเบียนสหกรณ์ แก้ไขเพิ่มเติมข้อบังคับสหกรณ์ แก้ไขข้อบังคับสหกรณ์ แก้ไขเพิ่มเติมข้อบังคับสหกรณ์ แก้ไขข้อบังคับสหกรณ์ แก้ไขข้อบังคับ การแก้ไขข้อบังคับ แก้ไขข้อบังคับบางข้อ การแก้ไขข้อบังคับบางข้อ ข้อบังคับสหกรณ์ ที่ประชุมใหญ่ มติสองในสาม นายทะเบียนสหกรณ์ จดทะเบียน ภายในสามสิบวัน มาตรา 44 นายทะเบียน นายทะเบยน สหกรณ์ สหกรณ coop ประชุมใหญ่ ประชุมใหญ่3ัญประจำปี ประชุมใหญ่วิ3ัญ",
    "องค์ประชุมใหญ่ หมายถึง ประชุมใหญ่ ประชุมใหญ่3ัญประจำปี ประชุมใหญ่วิ3ัญ ความรู้โดยทั่วไปเกี่ยวกับสหกรณ์ องค์ ประชุม ประชุมใหญ่ ประชุมใหญ่3ัญประจำปี สหกรณ์ สหกรณ coop ประชุมใหญ่ ประชุมใหญ่3ัญประจำปี ประชุมใหญ่วิ3ัญ",
    "ตั้งสหกรณ์ สหกรณ์ สหกรณ coop การตั้งสหกรณ์ จัดตั้งสหกรณ์ การจัดตั้งสหกรณ์ จดทะเบียนจัดตั้งสหกรณ์ ผู้เริ่มก่อการ สมาชิกผู้ก่อการ คำขอจดทะเบียน ประชุมจัดตั้ง ข้อบังคับ",
  ];

  for (const query of queries) {
    const retrievalQuery = await getFirstRetrievalQuery(query);

    assert.ok(retrievalQuery.length <= 180, retrievalQuery);
    assert.doesNotMatch(retrievalQuery, /q\s*a|ผู้ดูแลระบบ|ผู้ดูแล|\bcoop\b/i);
    assert.doesNotMatch(retrievalQuery, /ประชุมใหญ่3ัญประจำปี|ประชุมใหญ่วิ3ัญ/i);
  }
});

test("liquidator appointment miss does not drift to meeting aliases", async () => {
  const retrievalQuery = await getFirstRetrievalQuery(
    "ใครเป็นผู้มีอำนาจแต่งตั้งผู้ชำระบัญชี ใคร เป็น ผู้ การชำระบัญชี ชำระบัญชี",
  );

  assert.match(retrievalQuery, /ผู้ชำระบัญชี|ชำระบัญชี/);
  assert.doesNotMatch(retrievalQuery, /ประชุมใหญ่|องค์ประชุม|วาระการประชุม/);
});

test("member resignation miss does not drift to admission aliases", async () => {
  const retrievalQuery = await getFirstRetrievalQuery(
    "สมาชิกลาออกต้องทำอย่างไร สมาชิกลาออกต้อง q a ผู้ดูแลระบบ ออก สมาชิก สมาชิกสามัญ สมาชิกสามัญ สมาชิก",
  );

  assert.match(retrievalQuery, /ลาออก/);
  assert.doesNotMatch(retrievalQuery, /รับสมาชิก|สมัครสมาชิก|สมัครเข้าเป็นสมาชิก/);
});

test("group shareholding miss keeps group and shareholding signals", async () => {
  const retrievalQuery = await getFirstRetrievalQuery(
    "การถือหุ้นของสมาชิกกลุ่มเกษตรกร",
    "group",
  );

  assert.match(retrievalQuery, /ถือหุ้น/);
  assert.match(retrievalQuery, /กลุ่มเกษตรกร/);
  assert.doesNotMatch(retrievalQuery, /รับสมาชิก|สมัครสมาชิก|สมัครเข้าเป็นสมาชิก/);
});

test("additional real search misses keep their core legal topic", async () => {
  const cases = [
    {
      message:
        "ผู้ตรวจสอบกิจการมีวาระกี่ปี ผู้ ตรวจ สอบ ผู้ตรวจสอบกิจการ ผู้ตรวจสอบกิจการสหกรณ์ สหกรณ์ สหกรณ coop",
      mustInclude: [/ผู้ตรวจสอบกิจการ/, /วาระ|กี่ปี/],
      mustExclude: [/คณะกรรมการพัฒนาสหกรณ์แห่งชาติ/, /\bcoop\b/i],
    },
    {
      message:
        "การจ่ายคืนค่าหุ้น กรณีขาดทุนสะสม ทำยังไง การจ่ายคืนค่าหุ้น กรณีขาดทุนสะสม ทำ การ จ่าย",
      mustInclude: [/จ่ายคืนค่าหุ้น/, /ขาดทุนสะสม/],
      mustExclude: [/รับสมาชิก|สมัครสมาชิก|ประชุมใหญ่/],
    },
    {
      message:
        "คณะกรรมการพัฒนาสหกรณ์แห่งชาติ สหกรณ์ สหกรณ coop คณะกรรมการพัฒนาสหกรณ์แห่งชาติ คณะ กรรมการ สหกรณ์ สหกรณ coop",
      mustInclude: [/คณะกรรมการพัฒนาสหกรณ์แห่งชาติ/],
      mustExclude: [/ผู้ชำระบัญชี|การชำระบัญชี|\bcoop\b/i],
    },
    {
      message:
        "วาระการดำรงตำแหน่งของคณะกรรมการพัฒนาสหกรณ์แห่งชาติ สหกรณ์ สหกรณ coop วาระการดำรงตำแหน่งของคณะกรรมการพัฒนาสหกรณ์แห่งชาติ วาระ การ สหกรณ์ สหกรณ coop",
      mustInclude: [/วาระการดำรงตำแหน่ง/, /คณะกรรมการพัฒนาสหกรณ์แห่งชาติ/],
      mustExclude: [/ผู้ตรวจสอบกิจการ|ผู้ชำระบัญชี|\bcoop\b/i],
    },
    {
      message:
        "คพช คณะกรรมการพัฒนาการสหกรณ์แห่งชาติ คพช คพช คณะ คพช คณะกรรมการพัฒนาการสหกรณ์แห่งชาติ สหกรณ์ สหกรณ coop",
      mustInclude: [/คพช/, /คณะกรรมการพัฒนาการสหกรณ์แห่งชาติ/],
      mustExclude: [/ผู้ชำระบัญชี|ประชุมใหญ่|\bcoop\b/i],
    },
    {
      message:
        "การชำระบัญชี ปิดสหกรณ์ เลิกสหกรณ์ เลิกกิจการสหกรณ์ ชำระบัญชี ผู้ชำระบัญชี สหกรณ์ย่อมเลิก นายทะเบียนสหกรณ์ ยกเลิก ยุบ สิ้นสุด สะสางบัญชี ปิดบัญชี",
      mustInclude: [/ชำระบัญชี/, /เลิกสหกรณ์|ผู้ชำระบัญชี/],
      mustExclude: [/รับสมาชิก|สมัครสมาชิก|ผู้ตรวจสอบกิจการ/],
    },
  ];

  for (const item of cases) {
    const retrievalQuery = await getFirstRetrievalQuery(item.message);

    assert.ok(retrievalQuery.length <= 180, retrievalQuery);
    item.mustInclude.forEach((pattern) => assert.match(retrievalQuery, pattern));
    item.mustExclude.forEach((pattern) => assert.doesNotMatch(retrievalQuery, pattern));
  }
});
