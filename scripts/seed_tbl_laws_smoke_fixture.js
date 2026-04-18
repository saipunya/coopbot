#!/usr/bin/env node

require("dotenv").config();

const { connectDb, getDbPool } = require("../config/db");

const FIXTURES = [
  {
    key: "SMOKE_FIXTURE_LAW_75_APPOINT_LIQUIDATOR",
    lawNumber: "มาตรา 75",
    lawPart: "SMOKE_FIXTURE_LAW_75_APPOINT_LIQUIDATOR",
    lawDetail:
      "ในกรณีสหกรณ์เลิกด้วยเหตุอื่นนอกจากล้มละลาย ให้ที่ประชุมใหญ่เลือกตั้งผู้ชำระบัญชีภายในสามสิบวันนับแต่วันที่เลิก และการตั้งผู้ชำระบัญชีต้องได้รับความเห็นชอบจากนายทะเบียนสหกรณ์ ถ้าที่ประชุมใหญ่ไม่เลือกตั้งหรือเลือกตั้งแล้วไม่ได้รับความเห็นชอบ ให้นายทะเบียนสหกรณ์มีอำนาจตั้งผู้ชำระบัญชี",
    lawComment:
      "คำสำคัญ: ผู้ชำระบัญชี, แต่งตั้งผู้ชำระบัญชี, ที่ประชุมใหญ่, นายทะเบียนสหกรณ์, อำนาจแต่งตั้ง",
    lawSearch:
      "มาตรา 75,ผู้ชำระบัญชี,แต่งตั้งผู้ชำระบัญชี,ที่ประชุมใหญ่,นายทะเบียนสหกรณ์,อำนาจแต่งตั้ง,ชำระบัญชี,ล้มละลาย",
  },
  {
    key: "SMOKE_FIXTURE_LAW_70_DISSOLUTION_REASONS",
    lawNumber: "มาตรา 70",
    lawPart: "SMOKE_FIXTURE_LAW_70_DISSOLUTION_REASONS",
    lawDetail:
      "สหกรณ์ย่อมเลิก เมื่อมีเหตุดังต่อไปนี้ (1) มีเหตุตามที่กำหนดในข้อบังคับ (2) สมาชิกเหลือน้อยกว่าสิบคน (3) ที่ประชุมใหญ่ลงมติให้เลิก (4) ล้มละลาย (5) นายทะเบียนสหกรณ์สั่งให้เลิก",
    lawComment:
      "คำสำคัญ: สหกรณ์ย่อมเลิก, เลิกสหกรณ์, ล้มละลาย, นายทะเบียนสหกรณ์สั่งให้เลิก",
    lawSearch:
      "มาตรา 70,สหกรณ์ย่อมเลิก,เลิกสหกรณ์,เมื่อใด,ล้มละลาย,นายทะเบียนสหกรณ์สั่งให้เลิก,(1),(2),(3),(4),(5)",
  },
];

async function upsertSmokeFixture(pool, fixture) {
  const [existingRows] = await pool.query(
    `
      SELECT law_id
      FROM tbl_laws
      WHERE law_part = ?
      ORDER BY law_id DESC
      LIMIT 1
    `,
    [fixture.lawPart],
  );

  if (Array.isArray(existingRows) && existingRows.length > 0) {
    const lawId = Number(existingRows[0].law_id || 0);
    await pool.query(
      `
        UPDATE tbl_laws
        SET law_number = ?,
            law_detail = ?,
            law_comment = ?,
            law_search = ?,
            law_saveby = ?,
            law_savedate = CURRENT_DATE()
        WHERE law_id = ?
      `,
      [
        fixture.lawNumber,
        fixture.lawDetail,
        fixture.lawComment,
        fixture.lawSearch,
        "smoke-seed",
        lawId,
      ],
    );

    return { action: "updated", lawId, key: fixture.key };
  }

  const [result] = await pool.query(
    `
      INSERT INTO tbl_laws (
        law_number,
        law_part,
        law_detail,
        law_comment,
        law_search,
        law_saveby,
        law_savedate
      ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_DATE())
    `,
    [
      fixture.lawNumber,
      fixture.lawPart,
      fixture.lawDetail,
      fixture.lawComment,
      fixture.lawSearch,
      "smoke-seed",
    ],
  );

  return {
    action: "inserted",
    lawId: Number(result?.insertId || 0),
    key: fixture.key,
  };
}

async function main() {
  const pool = await connectDb();
  if (!pool) {
    console.error("Database is unavailable. Cannot seed smoke fixtures.");
    process.exitCode = 1;
    return;
  }

  const dbPool = getDbPool();
  try {
    const results = [];

    for (const fixture of FIXTURES) {
      const row = await upsertSmokeFixture(dbPool, fixture);
      results.push(row);
    }

    results.forEach((row) => {
      console.log(`${row.action}: ${row.key} (law_id=${row.lawId})`);
    });
  } finally {
    if (dbPool && typeof dbPool.end === "function") {
      await dbPool.end();
    }
  }
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
