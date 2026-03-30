const bcrypt = require("bcryptjs");

const MemberModel = require("../models/memberModel");

async function loginAdmin(username, password) {
  const member = await MemberModel.findByUsername(username);

  if (!member) {
    return { ok: false, message: "ไม่พบชื่อผู้ใช้นี้ในระบบ" };
  }

  if (member.m_status !== "active") {
    return { ok: false, message: "บัญชีนี้ไม่สามารถใช้งานได้" };
  }

  const isPasswordValid = await bcrypt.compare(String(password || ""), member.m_pass);
  if (!isPasswordValid) {
    return { ok: false, message: "รหัสผ่านไม่ถูกต้อง" };
  }

  return {
    ok: true,
    user: {
      id: member.m_id,
      username: member.m_user,
      group: member.m_group,
      name: member.m_name,
      position: member.m_position,
      status: member.m_status,
    },
  };
}

module.exports = {
  loginAdmin,
};
