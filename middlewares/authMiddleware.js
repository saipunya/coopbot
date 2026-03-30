function attachCurrentUser(req, res, next) {
  req.user = req.session?.adminUser || null;
  res.locals.currentUser = req.user;
  next();
}

function requireAdminAuth(req, res, next) {
  if (req.session?.adminUser) {
    req.user = req.session.adminUser;
    res.locals.currentUser = req.user;
    return next();
  }

  return res.redirect(
    "/admin/login?error=" + encodeURIComponent("กรุณาเข้าสู่ระบบผู้ดูแลก่อนใช้งาน")
  );
}

function redirectIfAuthenticated(req, res, next) {
  if (req.session?.adminUser) {
    return res.redirect("/admin");
  }

  next();
}

module.exports = {
  attachCurrentUser,
  requireAdminAuth,
  redirectIfAuthenticated,
};
