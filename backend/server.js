require("dotenv").config();
const express   = require("express");
const cors      = require("cors");
const helmet    = require("helmet");
const rateLimit = require("express-rate-limit");
const morgan    = require("morgan");
const hpp       = require("hpp");

const authRoutes      = require("./routes/auth");
const inventoryRoutes = require("./routes/inventory");
const barcodeRoutes   = require("./routes/barcode");
const dashboardRoutes = require("./routes/dashboard");
const { requireAdmin }    = require("./middleware/auth");

const app  = express();
const PORT = process.env.PORT || 5000;

app.use(helmet());

app.use(cors({
  origin: [
    "http://127.0.0.1:5500",
    "http://localhost:5500",
    "http://localhost",
    "https://localhost",
    "capacitor://localhost",
    "https://cims-j5ymndxri-cims3.vercel.app",
    "https://cimsshared.vercel.app"
  ],
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

// product photo upload: admin only, larger body limit just for this one path
app.use("/api/products/upload", requireAdmin, express.json({ limit: "1mb" }));

app.use(express.json({ limit: "10kb" }));
app.use(morgan("combined"));
app.use(hpp());

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { success: false, message: "Too many requests. Try again later." },
}));

app.use("/api/auth/login", rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, message: "Too many login attempts. Try again in 15 minutes." },
}));

app.use("/api/auth",      authRoutes);
app.use("/api/inventory", inventoryRoutes);
app.use("/api/barcode",   barcodeRoutes);
app.use("/api",           dashboardRoutes);

app.get("/", (req, res) => {
  res.json({ message: "CIMS backend running" });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.use((err, req, res, next) => {
  const isProd = process.env.NODE_ENV === "production";
  console.error(`[${new Date().toISOString()}] Error:`, err.message);
  return res.status(500).json({
    success: false,
    message: isProd ? "Something went wrong." : err.message,
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`);
});