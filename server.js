const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const rateLimit = require("express-rate-limit");
const path = require("path");
const fs = require("fs");

dotenv.config();

const app = express();

// CORS configuration
app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:3000",
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 4000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || "uploads";

// Create upload directory if it doesn't exist
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  console.log(`✓ Created upload directory: ${UPLOAD_DIR}`);
}

// Serve static files from uploads directory
app.use("/uploads", express.static(path.join(__dirname, UPLOAD_DIR)));

// Rate limiting for upload endpoint
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // limit each IP to 50 requests per windowMs
  message: "Too many upload requests, please try again later"
});

// Routes
const invoicesRoute = require("./routes/invoices");
app.use("/api/invoices", invoicesRoute);

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ 
    ok: true, 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Root endpoint
app.get("/", (req, res) => {
  res.json({
    message: "Invoice Uploader Backend API",
    version: "1.0.0",
    endpoints: {
      health: "/health",
      invoices: "/api/invoices",
      upload: "/api/invoices/upload"
    }
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error("Global error:", err);
  res.status(err.status || 500).json({
    error: err.message || "Internal server error",
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

app.listen(PORT, () => {
  console.log(`
  ┌─────────────────────────────────────────┐
  │  Invoice Uploader Backend API           │
  │  Server running on port ${PORT}           │
  │  Environment: ${process.env.NODE_ENV || 'development'}              │
  │  Upload dir: ${UPLOAD_DIR}                 │
  └─────────────────────────────────────────┘
  `);
});
