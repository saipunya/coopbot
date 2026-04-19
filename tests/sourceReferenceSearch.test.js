const test = require("node:test");
const assert = require("node:assert/strict");

function loadFresh(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return require(modulePath);
}

test("managed suggested question matches queries that include source references", async () => {
  const LawChatbotSuggestedQuestionModel = loadFresh("../models/lawChatbotSuggestedQuestionModel");

  await LawChatbotSuggestedQuestionModel.create({
    target: "coop",
    questionText: "การจัดตั้งสหกรณ์ต้องมีผู้เริ่มก่อการกี่คน",
    answerText: "ต้องมีผู้ซึ่งประสงค์จะเป็นสมาชิกเข้าชื่อกันไม่น้อยกว่า 10 คน",
    sourceReference: "พระราชบัญญัติสหกรณ์ พ.ศ. 2542 มาตรา 33",
    isActive: true,
  });

  const match = await LawChatbotSuggestedQuestionModel.findAnswerMatch(
    "มาตรา 33 การจัดตั้งสหกรณ์ต้องมีผู้เริ่มก่อการกี่คน",
    "coop",
  );

  assert.ok(match, "expected a suggested-question match");
  assert.match(match?.questionText || "", /ผู้เริ่มก่อการกี่คน/);
  assert.match(match?.sourceReference || "", /มาตรา 33/);
});

test("managed suggested question matches shorter exact phrases inside the stored question", async () => {
  const LawChatbotSuggestedQuestionModel = loadFresh("../models/lawChatbotSuggestedQuestionModel");

  await LawChatbotSuggestedQuestionModel.create({
    target: "coop",
    questionText: "การทำบัญชี การบันทึกบัญชี เก็บรักษาบัญชีและเอกสารประกอบการลงบัญชี",
    answerText:
      "ให้บันทึกรายการในบัญชีเกี่ยวกับกระแสเงินสดของสหกรณ์ในวันที่เกิดเหตุ และรายการที่ไม่เกี่ยวกับกระแสเงินสดให้บันทึกภายในสามวัน",
    sourceReference: "ร่างข้อบังคับสหกรณ์ ข้อ 20 การบัญชีของสหกรณ์",
    isActive: true,
  });

  const match = await LawChatbotSuggestedQuestionModel.findAnswerMatch("บันทึกบัญชี", "coop");

  assert.ok(match, "expected a suggested-question match for a shorter phrase");
  assert.match(match?.questionText || "", /บันทึกบัญชี/);
  assert.match(match?.sourceReference || "", /ข้อ 20/);
});

test("managed suggested question matches time-oriented questions from answer text", async () => {
  const LawChatbotSuggestedQuestionModel = loadFresh("../models/lawChatbotSuggestedQuestionModel");

  await LawChatbotSuggestedQuestionModel.create({
    target: "coop",
    questionText: "การทำบัญชี การบันทึกบัญชี เก็บรักษาบัญชีและเอกสารประกอบการลงบัญชี",
    answerText:
      "ให้บันทึกรายการในบัญชีเกี่ยวกับกระแสเงินสดของสหกรณ์ในวันที่เกิดเหตุ และรายการที่ไม่เกี่ยวกับกระแสเงินสดให้บันทึกภายในสามวัน",
    sourceReference: "ร่างข้อบังคับสหกรณ์ ข้อ 20 การบัญชีของสหกรณ์",
    isActive: true,
  });

  const match = await LawChatbotSuggestedQuestionModel.findAnswerMatch(
    "การบันทึกบัญชี ต้องทำภายในกี่วัน",
    "coop",
  );

  assert.ok(match, "expected a suggested-question match for a time-oriented question");
  assert.match(match?.questionText || "", /บันทึกบัญชี/);
  assert.match(match?.sourceReference || "", /ข้อ 20/);
});

test("managed suggested question prioritizes the exact draft bylaw clause reference", async () => {
  const LawChatbotSuggestedQuestionModel = loadFresh("../models/lawChatbotSuggestedQuestionModel");

  await LawChatbotSuggestedQuestionModel.create({
    target: "coop",
    questionText: "การให้เงินกู้ของสหกรณ์",
    answerText: "ข้อ 13 การให้เงินกู้ สหกรณ์อาจให้เงินกู้ได้แก่สมาชิกของสหกรณ์",
    sourceReference: "ร่างข้อบังคับสหกรณ์ ข้อ 13 การให้เงินกู้",
    isActive: true,
  });

  for (let clauseNumber = 100; clauseNumber <= 181; clauseNumber += 1) {
    await LawChatbotSuggestedQuestionModel.create({
      target: "coop",
      questionText: `ข้อบังคับหมวดพิเศษ ${clauseNumber}`,
      answerText: `เนื้อหาข้อบังคับลำดับ ${clauseNumber}`,
      sourceReference: `ร่างข้อบังคับสหกรณ์ ข้อ ${clauseNumber} เรื่องตัวอย่าง`,
      isActive: true,
    });
  }

  const match = await LawChatbotSuggestedQuestionModel.findAnswerMatch("ร่างข้อบังคับสหกรณ์ ข้อ 13", "all");

  assert.ok(match, "expected a suggested-question match for the requested draft bylaw clause");
  assert.match(match?.sourceReference || "", /ข้อ 13/);
  assert.match(match?.questionText || "", /การให้เงินกู้/);
});

test("managed suggested question prefers exact duty phrase over officer-only mentions", async () => {
  const LawChatbotSuggestedQuestionModel = loadFresh("../models/lawChatbotSuggestedQuestionModel");

  await LawChatbotSuggestedQuestionModel.create({
    target: "coop",
    questionText: "การจัดจ้างเจ้าหน้าที่",
    answerText: "เจ้าหน้าที่ต้องไม่มีลักษณะต้องห้าม หรือเป็นที่ปรึกษาสหกรณ์หรือผู้ตรวจสอบกิจการสหกรณ์",
    sourceReference: "ร่างข้อบังคับสหกรณ์ ข้อ 95 เจ้าหน้าที่สหกรณ์",
    isActive: true,
  });

  await LawChatbotSuggestedQuestionModel.create({
    target: "coop",
    questionText: "อำนาจหน้าที่ผู้ตรวจสอบกิจการ",
    answerText: "ผู้ตรวจสอบกิจการมีอำนาจหน้าที่ตรวจสอบและรายงานผลตามข้อบังคับ",
    sourceReference: "ร่างข้อบังคับสหกรณ์ ข้อ 101 อำนาจหน้าที่ของผู้ตรวจสอบกิจการ",
    isActive: true,
  });

  const match = await LawChatbotSuggestedQuestionModel.findAnswerMatch("อำนาจหน้าที่ของผู้ตรวจสอบกิจการ", "all");

  assert.ok(match, "expected an exact duty phrase match");
  assert.match(match?.sourceReference || "", /ข้อ 101/);
  assert.match(match?.questionText || "", /อำนาจหน้าที่ผู้ตรวจสอบกิจการ/);
});

test("approved FAQ-style knowledge suggestions are searchable by source reference", async () => {
  const LawChatbotKnowledgeSuggestionModel = loadFresh("../models/lawChatbotKnowledgeSuggestionModel");

  await LawChatbotKnowledgeSuggestionModel.create({
    target: "coop",
    title: "องค์ประชุมคณะกรรมการดำเนินการ",
    content: "การประชุมคณะกรรมการดำเนินการต้องมีกรรมการมาประชุมไม่น้อยกว่ากึ่งหนึ่ง",
    sourceReference: "ร่างข้อบังคับสหกรณ์ออมทรัพย์ตัวอย่าง ข้อ 26",
    sourceType: "text",
    status: "approved",
  });

  const results = await LawChatbotKnowledgeSuggestionModel.searchApproved(
    "ร่างข้อบังคับสหกรณ์ออมทรัพย์ตัวอย่าง ข้อ 26",
    "all",
    5,
  );

  assert.ok(results.length > 0, "expected approved suggestion search results");
  assert.match(results[0]?.reference || "", /ข้อ 26/);
  assert.match(results[0]?.title || "", /องค์ประชุมคณะกรรมการ/);
});
