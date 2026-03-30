function authMiddleware(req, res, next) {
  req.user = {
    id: 1,
    name: "Demo User",
    role: "admin",
  };

  next();
}

module.exports = authMiddleware;
