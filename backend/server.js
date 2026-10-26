require("dotenv").config();

const requiredEnv = ["SUPABASE_URL", "SUPABASE_SERVICE_KEY", "JWT_SECRET"];
const missingEnv = requiredEnv.filter(name => !process.env[name]?.trim());

if (missingEnv.length > 0) {
    console.error(`Missing required environment variables: ${missingEnv.join(", ")}`);
    process.exit(1);
}

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

const app  = express();
const PORT = process.env.PORT || 5000;

app.use(helmet());

const allowedOrigins = [
    "http://127.0.0.1:5500",
    "http://localhost:5500",
    "https://localhost",
    "https://cimsshared.vercel.app"
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }

        console.error("CORS blocked origin:", origin);
        return callback(new Error("Origin not allowed by CORS"));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
}));

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

app.use((err, req, res, next) => {
  const isProd = process.env.NODE_ENV === "production";
  console.error(`[${new Date().toISOString()}] Error:`, err.message);
  return res.status(500).json({
    success: false,
    message: isProd ? "Something went wrong." : err.message,
  });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});