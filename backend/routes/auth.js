const express = require("express");
const router  = express.Router();
const bcrypt  = require("bcryptjs");
const jwt     = require("jsonwebtoken");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const JWT_SECRET = process.env.JWT_SECRET;

router.post("/login", async (req, res) => {
  const { email, password, role } = req.body;

  if (!email || !password) {
    return res.status(400).json({
      success: false,
      message: "Email and password are required.",
    });
  }

  try {
    const { data: user, error } = await supabase
      .from("users")
      .select("*, hotels(name)")
      .eq("email", email.toLowerCase().trim())
      .single();

    if (error || !user) {
      return res.status(401).json({
        success: false,
        message: "No account found with that email address.",
      });
    }

    if (role === "admin" && user.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "This account does not have admin access.",
      });
    }

    if (role === "hotel" && user.role !== "hotel_staff") {
      return res.status(403).json({
        success: false,
        message: "Please use the admin login for this account.",
      });
    }

    const passwordMatch = await bcrypt.compare(password, user.password_hash);

    if (!passwordMatch) {
      return res.status(401).json({
        success: false,
        message: "Incorrect password. Please try again.",
      });
    }

    const token = jwt.sign(
      {
        id:       user.id,
        email:    user.email,
        role:     user.role,
        hotel_id: user.hotel_id || null,
      },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.status(200).json({
      success: true,
      message: "Login successful",
      token,
      user: {
        id:         user.id,
        name:       user.name,
        email:      user.email,
        role:       user.role,
        hotel_id:   user.hotel_id   || null,
        hotel_name: user.hotels?.name || null,
      },
    });

  } catch (err) {
    console.error("Login error:", err.message);
    return res.status(500).json({ success: false, message: "Server error." });
  }
});

router.get("/verify", (req, res) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, message: "No token provided." });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return res.status(200).json({ success: true, user: decoded });
  } catch {
    return res.status(401).json({ success: false, message: "Token expired or invalid. Please log in again." });
  }
});

router.post("/logout", (req, res) => {
  return res.status(200).json({ success: true, message: "Logged out successfully." });
});

router.post("/register", async (req, res) => {
  const { name, email, password, role, hotel_id } = req.body;

  if (role === "admin") {
    return res.status(403).json({
      success: false,
      message: "Admin accounts cannot be created through this endpoint.",
    });
  }

  if (!name || !email || !password || !role) {
    return res.status(400).json({
      success: false,
      message: "Name, email, password, and role are required.",
    });
  }

  if (role === "hotel_staff" && !hotel_id) {
    return res.status(400).json({
      success: false,
      message: "Hotel staff must be assigned to a hotel.",
    });
  }

  try {
    const { data: existing } = await supabase
      .from("users")
      .select("id")
      .eq("email", email.toLowerCase().trim())
      .single();

    if (existing) {
      return res.status(409).json({
        success: false,
        message: "An account with this email already exists.",
      });
    }

    const password_hash = await bcrypt.hash(password, 12);

    const { data: newUser, error } = await supabase
      .from("users")
      .insert({
        name,
        email:         email.toLowerCase().trim(),
        password_hash,
        role,
        hotel_id:      hotel_id || null,
        created_at:    new Date().toISOString(),
      })
      .select("id, name, email, role, hotel_id")
      .single();

    if (error) {
      console.error("Register error:", error.message);
      return res.status(500).json({ success: false, message: "Failed to create account." });
    }

    return res.status(201).json({
      success: true,
      message: `Account created for ${name}.`,
      user:    newUser,
    });

  } catch (err) {
    console.error("Register error:", err.message);
    return res.status(500).json({ success: false, message: "Server error." });
  }
});


module.exports = router;