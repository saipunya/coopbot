const test = require("node:test");
const assert = require("node:assert/strict");

function setMockedModule(modulePath, exportsValue) {
  const previous = require.cache[modulePath];
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports: exportsValue,
  };

  return () => {
    if (previous) {
      require.cache[modulePath] = previous;
      return;
    }

    delete require.cache[modulePath];
  };
}

test("searchStructuredLaws resolves direct coop law sections from tbl_laws before law_search keywords", async (t) => {
  const dbPath = require.resolve("../config/db");
  const modelPath = require.resolve("../models/lawSearchModel");
  const queries = [];

  const restoreDb = setMockedModule(dbPath, {
    getDbPool: () => ({
      query: async (sql, params = []) => {
        queries.push({ sql, params });

        if (/SHOW COLUMNS FROM tbl_laws LIKE/i.test(sql)) {
          return [[{ Field: "law_search" }]];
        }

        if (/SHOW COLUMNS FROM tbl_glaws LIKE/i.test(sql)) {
          return [[{ Field: "glaw_search" }]];
        }

        if (/FROM tbl_laws/i.test(sql) && /TRIM\(law_number\)/i.test(sql)) {
          return [
            [
              {
                id: 17,
                law_number: "มาตรา 17",
                law_part: "มาตรา 17",
                law_detail: "รายละเอียดมาตรา 17 จากพระราชบัญญัติสหกรณ์",
                law_comment: "",
                law_search: "มาตรา 17 พรบ สหกรณ์",
              },
            ],
          ];
        }

        if (/LOWER\(law_search\) LIKE/i.test(sql)) {
          return [
            [
              {
                id: 99,
                law_number: "มาตรา 99",
                law_part: "มาตรา 99",
                law_detail: "ผลลัพธ์ keyword ที่ไม่ควรแซงมาตราโดยตรง",
                law_comment: "",
                law_search: "มาตรา 17 พรบ สหกรณ์",
              },
            ],
          ];
        }

        return [[]];
      },
    }),
  });

  t.after(() => {
    delete require.cache[modelPath];
    restoreDb();
  });

  delete require.cache[modelPath];
  const LawSearchModel = require(modelPath);
  const results = await LawSearchModel.searchStructuredLaws("มาตรา 17 พรบ สหกรณ์", "all", 5);

  assert.equal(results[0]?.source, "tbl_laws");
  assert.equal(results[0]?.lawNumber, "มาตรา 17");
  assert.equal(results[0]?.id, 17);
  assert.ok(
    queries.every(({ sql }) => !/LOWER\(law_search\) LIKE/i.test(sql)),
    "direct section lookup should return before law_search keyword queries",
  );
});

test("searchStructuredLaws expands liquidator appointment query to section 75 before keyword-only matches", async (t) => {
  const dbPath = require.resolve("../config/db");
  const modelPath = require.resolve("../models/lawSearchModel");

  const restoreDb = setMockedModule(dbPath, {
    getDbPool: () => ({
      query: async (sql, params = []) => {
        if (/SHOW COLUMNS FROM tbl_laws LIKE/i.test(sql)) {
          return [[{ Field: "law_search" }]];
        }

        if (/SHOW COLUMNS FROM tbl_glaws LIKE/i.test(sql)) {
          return [[{ Field: "glaw_search" }]];
        }

        if (/TRIM\(law_number\) IN/i.test(sql) && params.includes("มาตรา 75")) {
          return [
            [
              {
                id: 75,
                law_number: "มาตรา 75",
                law_part: "วรรคแรก",
                law_detail:
                  "ในกรณีสหกรณ์เลิกด้วยเหตุอื่นนอกจากล้มละลาย ให้ที่ประชุมใหญ่เลือกตั้งผู้ชำระบัญชี และต้องได้รับความเห็นชอบจากนายทะเบียนสหกรณ์",
                law_comment: "",
                law_search: "ผู้ชำระบัญชี แต่งตั้ง เลือกตั้ง นายทะเบียนสหกรณ์",
              },
            ],
          ];
        }

        if (/LOWER\(law_search\) LIKE/i.test(sql)) {
          return [
            [
              {
                id: 71,
                law_number: "มาตรา 71",
                law_part: "วรรคแรก",
                law_detail: "นายทะเบียนสหกรณ์มีอำนาจสั่งเลิกสหกรณ์ได้",
                law_comment: "",
                law_search: "ผู้ชำระบัญชี แต่งตั้ง นายทะเบียนสหกรณ์",
              },
            ],
          ];
        }

        return [[]];
      },
    }),
  });

  t.after(() => {
    delete require.cache[modelPath];
    restoreDb();
  });

  delete require.cache[modelPath];
  const LawSearchModel = require(modelPath);
  const results = await LawSearchModel.searchStructuredLaws("ใครแต่งตั้งผู้ชำระบัญชี", "all", 5);

  assert.equal(results[0]?.source, "tbl_laws");
  assert.equal(results[0]?.lawNumber, "มาตรา 75");
  assert.equal(results[0]?.id, 75);
});
