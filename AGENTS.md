# AGENTS.md

คู่มือนี้เป็นแผนที่สำหรับ agent หรือผู้ดูแลที่เข้ามาทำงานต่อใน `coopbot` ระบบค่อนข้างนิ่งแล้ว ดังนั้นหลักสำคัญคือแก้แบบระวัง regression, รักษาพฤติกรรมที่ผู้ใช้คุ้นเคย, และทดสอบเฉพาะจุดให้พอมั่นใจก่อนส่งงาน

## ภาพรวมระบบ

`coopbot` เป็นเว็บแอป Node.js/Express 5 + EJS + MySQL สำหรับแชตบอทกฎหมายสหกรณ์ มีส่วนหลักคือ

- `law-chatbot`: หน้าผู้ใช้สำหรับถามตอบกฎหมาย, ต่อบทสนทนา, ส่ง feedback, ขออัปเกรดแพ็กเกจ และอัปโหลดเอกสารโดย admin
- `admin`: จัดการผู้ใช้, คำถามแนะนำ, knowledge base, workflow, payment request, search miss และข้อมูลประกอบอื่น
- `import`: นำเข้า Q&A/ความรู้เข้าระบบ
- `services`: business logic ส่วนใหญ่ของระบบ โดยเฉพาะ retrieval, answer formatting, plan/payment, ingestion และ AI/runtime controls
- `models`: ชั้นเข้าถึง MySQL ด้วย `mysql2/promise`

จุดเริ่มต้นแอปคือ `app.js` และ route หลักถูก mount ดังนี้

- `/law-chatbot` -> `routes/lawChatbot.js`
- `/admin` -> `routes/admin.js`, `routes/adminImport.js`, `routes/adminKnowledgeWorkflow.js`, `routes/adminSearchMisses.js`
- `/user` -> `routes/user.js`
- `/import` และ route import อื่น -> `routes/importRoutes.js`

## คำสั่งที่ใช้บ่อย

ติดตั้ง dependency:

```bash
npm install
```

รัน local server:

```bash
npm run dev
```

รัน production-like local server:

```bash
npm start
```

รันเทสต์ทั้งหมด:

```bash
npm test
```

รันเทสต์ retrieval/search สำคัญ:

```bash
npm run test:search
```

ตรวจ route/UI แบบ smoke:

```bash
npm run verify:ui
```

เตรียมรายการตรวจ responsive:

```bash
npm run review:responsive
```

เปิดชุดหน้า responsive review:

```bash
npm run review:responsive:open
```

ใช้ repo agent แบบอ่านอย่างเดียว:

```bash
npm run agent:repo -- "ไฟล์ไหนเป็นจุดเริ่มต้นของ law chatbot?"
```

## Environment และฐานข้อมูล

ดูตัวอย่างค่าที่ต้องมีใน `.env.example` ก่อนเริ่มงาน ค่า local หลัก ๆ คือ

- `PORT=3000`
- `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` หรือ `DATABASE_URL`
- `SESSION_SECRET`
- `OPENAI_API_KEY`, `GEMINI_API_KEY` ถ้าจะใช้ AI จริง
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` สำหรับ login
- `DISABLE_AI=true` และ `DISABLE_INTERNET=true` สำหรับโหมด DB-only/local-safe
- `ENABLE_EMBEDDING=false` เป็นค่า default ที่ระบบยังค้นด้วย keyword/hybrid logic ได้

การ migrate schema ส่วนใหญ่เก็บใน `scripts/sql/` และ `config/db.js` มี `ensureSchema()` สำหรับสร้าง/เติม schema พื้นฐานบางส่วน แต่ไม่ควรถือว่าแทน migration ทั้งหมดได้ ถ้าทำงานเกี่ยวกับ column/index ใหม่ ให้เพิ่ม SQL migration ใน `scripts/sql/` ด้วย

อย่า commit ค่า secret จาก `.env`

## โครงสร้างสำคัญ

### Routing และ Controller

- `app.js`: ตั้งค่า Express, session, static files, auth routes, `/version`, และ start server
- `routes/lawChatbot.js`: route หลักของ chatbot, payment request, upload, feedback และ debug decision
- `controllers/lawChatbotController.js`: รับ request/response ของ chatbot, บังคับ main chat เป็น DB-only, จัดการ upload/payment/feedback
- `controllers/adminController.js`: dashboard/admin/user/payment/knowledge entry points
- `controllers/knowledgeWorkflowController.js`: workflow ของ knowledge drafts/sources
- `controllers/importController.js` และ `controllers/adminImportController.js`: import Q&A/ข้อมูล

### Services

- `services/lawChatbotService.js`: facade ใหญ่ของระบบ chatbot รวม dashboard, chat reply, knowledge admin, payment และ history
- `services/chatOrchestrationService.js`: orchestration ของ retrieval, follow-up, cache, plan context และ fallback
- `services/chatAnswerService.js`: สร้างคำตอบ DB-only, tone, formatting และ source labels
- `services/sourceSelectionService.js`: เลือกแหล่งข้อมูล, intent, score และ search target
- `services/hybridSearchService.js`: ค้นเอกสาร/chunks แบบ hybrid
- `services/queryRewriteService.js` และ `services/contextService.js`: rewrite คำถามและจัดการ follow-up context
- `services/planService.js` และ `config/planConfig.js`: plan/entitlement/limit logic
- `services/userAdminPaymentService.js`: user dashboard, usage, payment request และ admin approval/rejection
- `services/uploadIngestionService.js`, `services/documentTextExtractor.js`, `services/wordImportService.js`: ingestion ของ PDF/DOC/DOCX
- `services/runtimeSettingsService.js`: runtime AI settings
- `services/searchLogService.js`, `services/retrievalEvaluationService.js`, `services/lawChatbotTrainingDataService.js`: logging/evaluation/training data

### Models

Models อยู่ใน `models/` และควรรักษารูปแบบ query ที่มีอยู่: ใช้ parameterized queries เสมอ, คืน object/array ที่ controller/service คาดหวัง, และอย่าโยน shape ใหม่เข้าไปโดยไม่ปรับ tests

ตารางที่เกี่ยวข้องบ่อย:

- `users`
- `user_monthly_usage`
- `guest_monthly_usage`
- `payment_requests`
- `chatbot_knowledge`
- `chatbot_knowledge_suggestions`
- `chatbot_suggested_questions`
- `knowledge_sources`
- `knowledge_drafts`
- `law_chatbot_pdf_chunks`
- `law_chatbot_answer_cache`
- `user_search_history`
- `tbl_laws`, `tbl_glaws`, `tbl_vinichai`

## Guardrails สำคัญของระบบ

### Main Chat ตอนนี้เป็น DB-only

`controllers/lawChatbotController.js` บังคับ `/law-chatbot/chat` ด้วยค่า:

- `useAI: false`
- `useInternet: false`
- `databaseOnlyMode: true`
- `answerMode: "db_only_main_chat"`

ถ้าจะเปลี่ยนพฤติกรรมนี้ ต้องถือว่าเป็น product decision ใหญ่ เพราะกระทบค่าใช้จ่าย AI, latency, ความแม่นยำ, fallback และข้อความที่ผู้ใช้เห็น

### แพ็กเกจมี 3 ระดับเท่านั้น

แพ็กเกจปัจจุบันคือ

- `free`
- `pro` แสดงผลเป็น `Professional`
- `premium`

`standard` เป็น legacy alias ของ `pro` เท่านั้น ห้ามทำให้ `standard` กลับมาเป็นแพ็กเกจที่เลือกซื้อได้ใน UI

ค่าหลักอยู่ที่ `config/planConfig.js` ถ้าแก้ limit/ราคา/สิทธิ์ ให้ตรวจ payment request, user dashboard, usage limit และ manual regression checklist ด้วย

### Guest/Login/Notice flow

ระบบใช้ Google login และ session ใน MySQL ผ่าน `services/mysqlSessionStore.js`

หน้า `/law-chatbot` redirect ผู้ใช้ที่ยังไม่ login ไป `/auth/google` ในสถานะปัจจุบัน route chat ต้องผ่าน:

- `attachCurrentUser`
- `requireLawChatbotNoticeAccepted`
- `requireSignedInUser`
- `enforceLawChatbotMonthlyUsageLimit`

อย่า bypass middleware เหล่านี้โดยไม่จำเป็น

### Ingestion ไม่ re-index เอง

หลังแก้ logic การอ่านข้อความ, chunking, quality score, normalizer หรือ embeddings เอกสารเก่าจะไม่ถูก re-index อัตโนมัติ ต้อง upload ใหม่หรือเขียน migration/backfill แยก

ค่าที่เกี่ยวข้อง:

- `MAX_UPLOAD_BYTES`
- `CHUNK_SIZE`
- `PDF_CHUNK_ACCEPTED_QUALITY_SCORE`
- `PDF_CHUNK_LOW_QUALITY_SCORE`
- `DOCUMENT_CHUNK_ACCEPTED_QUALITY_SCORE`
- `DOCUMENT_CHUNK_LOW_QUALITY_SCORE`
- `PDF_TEXT_MIN_LENGTH`
- `PDF_OCR_SCALE`
- `PDF_OCR_MAX_PAGES`
- `ENABLE_EMBEDDING`

ดู `docs/document-ingestion-troubleshooting.md` ก่อนแก้ ingestion

### Thai legal retrieval ต้องระวังมาก

ระบบพึ่งพา normalization ภาษาไทย, การจับมาตรา/ข้อ, target `coop/group/all/general`, และ source priority หลายชั้น ถ้าแก้ retrieval ให้รันเทสต์ที่เกี่ยวกับ search และ law section เสมอ

ไฟล์ที่เกี่ยวข้องบ่อย:

- `services/thaiTextUtils.js`
- `services/thaiNumberNormalizer.js`
- `services/thaiPdfTextNormalizer.js`
- `services/sourceSelectionService.js`
- `services/queryRewriteService.js`
- `services/contextService.js`
- `models/lawChatbotPdfChunkModel.js`
- `models/lawSearchModel.js`

## Testing Guidance

ก่อนส่งงาน ให้เลือกเทสต์ตามพื้นที่ที่แตะ

- แก้ logic ทั่วไป: `npm test`
- แก้ search/retrieval: `npm run test:search` และ `node --test tests/searchDatabaseStageOrder.test.js tests/lawSectionSelection.test.js tests/groupScopeRetrieval.test.js`
- แก้ query rewrite/context: `node --test tests/queryRewriteService.test.js tests/lawChatbotMainChatContinuation.test.js`
- แก้ answer formatting/tone/frontend JS: `node --test tests/lawChatbotFormatter.test.js tests/markdownRenderer.test.js tests/lawChatbotToneRendering.test.js tests/chatAnswerServiceTone.test.js`
- แก้ ingestion/chunking: `node --test tests/ingestionQuality.test.js tests/chunkSplitter.test.js tests/lawChatbotPdfChunkModel.search.test.js`
- แก้ plan/payment/usage: `node --test tests/aiUsageStatsService.test.js tests/aiUsageControls.test.js` และตรวจ `docs/manual-regression-checklist.md`
- แก้ route หรือ UI หลัก: `npm run verify:ui` ถ้ามี DB/session test accounts พร้อม

ถ้ารันเทสต์ไม่ได้เพราะขาด DB/env ให้บอกให้ชัดในสรุปงานว่าขาดอะไร และรันเทสต์ย่อยที่ไม่ต้องพึ่ง DB แทน

## Manual Regression ที่ไม่ควรมองข้าม

ดูรายละเอียดเต็มใน `docs/manual-regression-checklist.md` โดยเฉพาะ:

- Google login แล้ว user ใหม่ต้องเป็น `plan=free`
- free monthly quota ต้อง block หลังครบ limit
- UI แพ็กเกจต้องมีแค่ Free, Professional, Premium
- payment request ต้อง derive amount จาก backend ไม่ใช่ user input
- admin approve ต้องตั้ง plan 30 วัน
- admin reject ต้องไม่เปลี่ยน plan เดิม
- route payment review ต้องอยู่หลัง admin auth
- mobile viewport หลักต้องไม่ overflow ที่ `320 x 568`, `390 x 844`, `768 x 1024`

## Coding Conventions

- Project ใช้ CommonJS (`require`, `module.exports`)
- ใช้ `node:test` และ `node:assert/strict` สำหรับ tests
- รักษา ASCII ใน code/comment เว้นแต่ข้อความ UI/ข้อความไทยที่มีอยู่แล้ว
- ใช้ parameterized SQL เสมอ ห้าม concat user input เข้า query
- เก็บ business logic ใน `services/` มากกว่า controller
- Controller ควรรับ input, sanitize เบื้องต้น, เรียก service, แล้วตอบ response
- View เป็น EJS ใน `views/`; JS ฝั่ง client หลักอยู่ใน `public/js/`
- อย่าเปลี่ยนข้อความไทยที่ผู้ใช้เห็นโดยไม่จำเป็น เพราะ tests/manual checklist อาจพึ่ง keyword และผู้ใช้คุ้นกับ wording เดิม
- อย่าเพิ่ม dependency ใหม่ถ้าแก้ด้วย dependency เดิมได้

## ข้อห้ามและการสื่อสารก่อนแก้ไข

- ห้ามแก้ไขไฟล์, logic, route, schema, UI, copywriting หรือ config ที่ไม่เกี่ยวข้องกับงานที่ได้รับมอบหมาย
- ถ้าพบว่าจำเป็นต้องแก้ไฟล์หรือ logic นอก scope เพื่อให้งานสำเร็จ ต้องแจ้งเจ้าของโปรเจกต์ก่อน และรอการยืนยันก่อนลงมือ
- ห้าม refactor โครงสร้างใหญ่, เปลี่ยนพฤติกรรมหลัก, เปลี่ยน flow ผู้ใช้, เปลี่ยน business rule หรือเปลี่ยนค่า default โดยถือโอกาสจากงานเล็ก
- ถ้าเห็นปัญหาหรือ technical debt นอก scope ให้บันทึกเป็นข้อเสนอแนะท้ายงาน แทนการแก้ทันที
- ก่อนสรุปงาน ต้องแจ้งรายการไฟล์ที่แก้ และอธิบายสั้น ๆ ว่าแต่ละรายการแก้อะไร
- ทุกครั้งที่ส่งมอบงาน ควรมีข้อแนะนำเพื่อพัฒนาระบบให้ดีขึ้นต่อไปอย่างน้อย 1 ข้อ ยกเว้นงานเล็กมากที่ไม่มีข้อเสนอแนะจริง ๆ

## Workflow ที่แนะนำสำหรับ Agent

1. เริ่มด้วย `git status --short` เพื่อดู worktree และอย่าทับงานคนอื่น
2. อ่านไฟล์ route/controller/service ที่เกี่ยวข้องก่อนแก้
3. กำหนด scope ให้ชัดว่าไฟล์/logic ใดเกี่ยวข้องกับงานนี้ และอย่าออกนอก scope โดยไม่แจ้งก่อน
4. ถ้าแตะ DB schema ให้เพิ่มไฟล์ SQL ใน `scripts/sql/` และอัปเดตเอกสาร/notes ที่เกี่ยวข้อง
5. แก้แบบเล็กและเฉพาะจุดก่อน อย่า refactor ใหญ่ถ้า task ไม่ได้ขอ
6. รันเทสต์ย่อยที่ตรงกับพื้นที่แก้ แล้วค่อยรันกว้างขึ้นถ้าเหมาะสม
7. สรุปผลพร้อมรายการไฟล์ที่แก้, สิ่งที่แก้ในแต่ละไฟล์, คำสั่งที่รัน, สิ่งที่ยังไม่ได้ verify และข้อแนะนำเพื่อพัฒนาต่อ

## จุดที่ควรระวังเป็นพิเศษ

- `app.js` เรียก `connectDb()` และ `refreshAiSetting()` ตอน start ถ้า DB/env ไม่พร้อม app จะ start ไม่สำเร็จ
- `npm run dev` และ `npm start` จะ kill port 3000 ก่อนเสมอ
- `/version` ตั้ง no-store headers และแสดง version/commit ใช้สำหรับ smoke/debug deployment
- Upload payment slip อยู่ใต้ `uploads/paymentRequests` และถูก expose แบบ static ผ่าน app
- `logs/*.jsonl` เป็นข้อมูล runtime/training/search logs อย่าแก้หรือ commit เพิ่มโดยไม่ตั้งใจ
- `tmp/`, `tmp_test_upload/`, `uploads/` เป็นพื้นที่ runtime/test artifacts ให้ระวังไม่ผูก logic production กับไฟล์ตัวอย่างในนั้น
- `tha.traineddata` และ `eng.traineddata` ใช้กับ OCR/Tesseract อย่าลบถ้าไม่ได้ยืนยัน flow OCR แล้ว

## Useful Docs

- `docs/manual-regression-checklist.md`: checklist หลังแก้ guest/login/plan/payment/UI
- `docs/document-ingestion-troubleshooting.md`: แนวทางแก้ปัญหา upload Word/PDF แล้วค้นหาไม่เจอ
- `docs/repo-agent.md`: วิธีใช้ read-only repo agent
