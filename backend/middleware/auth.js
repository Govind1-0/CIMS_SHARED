const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET;

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, message: "Please log in to access this resource." });
  }
  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ success: false, message: "Session expired. Please log in again." });
  }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== "admin") {
      return res.status(403).json({ success: false, message: "Admin access required." });
    }
    next();
  });
}

function requireHotelStaff(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== "hotel_staff") {
      return res.status(403).json({ success: false, message: "Hotel staff access required." });
    }
    next();
  });
}

module.exports = { requireAuth, requireAdmin, requireHotelStaff };