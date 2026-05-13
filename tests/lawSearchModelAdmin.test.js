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

test("admin search listing and counting work for tbl_laws", async (t) => {
  const dbPath = require.resolve("../config/db");
  const modelPath = require.resolve("../models/lawSearchModel");
  const queries = [];

  const restoreDb = setMockedModule(dbPath, {
    getDbPool: () => ({
      query: async (sql, params = []) => {
        queries.push({ sql, params });

        if (/FROM tbl_laws/i.test(sql) && /COUNT\(\*\) AS total/i.test(sql)) {
          return [[{ total: 2 }]];
        }

        if (/FROM tbl_laws/i.test(sql) && /SELECT law_id AS id/i.test(sql)) {
          return [
            [
              {
                id: 7,
                law_number: "มาตรา 75",
                law_part: "วรรคแรก",
                law_detail: "เนื้อหามาตรา 75",
                law_comment: "หมายเหตุ",
                law_search: "ผู้ชำระบัญชี แต่งตั้ง",
                law_saveby: "admin",
                law_savedate: "2026-05-13",
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
  const total = await LawSearchModel.countAdminSearchRows("tbl_laws", "ผู้ชำระบัญชี");
  const rows = await LawSearchModel.listAdminSearchRows("tbl_laws", "ผู้ชำระบัญชี", 10, 0);

  assert.equal(total, 2);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 7);
  assert.equal(rows[0].lawNumber, "มาตรา 75");
  assert.equal(rows[0].lawSearch, "ผู้ชำระบัญชี แต่งตั้ง");
  assert.equal(rows[0].lawSaveBy, "admin");
  assert.equal(rows[0].lawSavedate, "2026-05-13");
  assert.ok(queries.some(({ sql }) => /COALESCE\(law_search, ''\)/i.test(sql)));
});

test("admin search updates glaw_search and audit columns", async (t) => {
  const dbPath = require.resolve("../config/db");
  const modelPath = require.resolve("../models/lawSearchModel");
  const queries = [];

  const restoreDb = setMockedModule(dbPath, {
    getDbPool: () => ({
      query: async (sql, params = []) => {
        queries.push({ sql, params });

        if (/UPDATE tbl_glaws/i.test(sql)) {
          return [{ affectedRows: 1 }];
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
  const updated = await LawSearchModel.updateAdminSearchRow(
    "tbl_glaws",
    12,
    { lawSearch: "คำค้นใหม่" },
    { saveBy: "coordinator@example.com" },
  );

  assert.equal(updated, true);
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /UPDATE tbl_glaws/i);
  assert.equal(queries[0].params[0], "คำค้นใหม่");
  assert.equal(queries[0].params[1], "coordinator@example.com");
  assert.match(String(queries[0].params[2] || ""), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(queries[0].params[3], 12);
});
