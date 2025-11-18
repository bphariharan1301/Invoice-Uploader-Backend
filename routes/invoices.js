const express = require("express");
const multer = require("multer");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const db = require("../db/index");
const router = express.Router();

const uploadFolder = process.env.UPLOAD_DIR || "uploads";

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadFolder);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = ["application/pdf", "image/png", "image/jpeg"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF, PNG, and JPEG files are allowed"), false);
    }
  }
});

// POST /api/invoices/upload
router.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "File is required" });
    }

    // Insert invoice with initial status
    const result = await db.query(
      `INSERT INTO invoices (file_path, status, created_at, updated_at)
       VALUES ($1, 'UPLOADED', NOW(), NOW()) 
       RETURNING id, file_path, status, created_at`,
      [req.file.path]
    );

    const invoice = result.rows[0];

    // TODO: Trigger AI/LLM extraction here (placeholder for now)
    // You can add extraction logic that updates the invoice with extracted data

    res.status(201).json({
      id: invoice.id,
      file_path: invoice.file_path,
      status: invoice.status,
      message: "File uploaded successfully"
    });
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({ error: "Failed to upload file", details: error.message });
  }
});

// GET /api/invoices - List all invoices
router.get("/", async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        id, 
        supplier_name, 
        invoice_number, 
        invoice_date,
        currency,
        subtotal,
        total, 
        status, 
        created_at,
        updated_at
      FROM invoices 
      ORDER BY created_at DESC
    `);
    
    res.json(result.rows);
  } catch (error) {
    console.error("List invoices error:", error);
    res.status(500).json({ error: "Failed to fetch invoices", details: error.message });
  }
});

// GET /api/invoices/:id - Get single invoice with line items
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Fetch invoice
    const invoiceResult = await db.query(
      `SELECT * FROM invoices WHERE id = $1`,
      [id]
    );

    if (invoiceResult.rows.length === 0) {
      return res.status(404).json({ error: "Invoice not found" });
    }

    // Fetch line items
    const itemsResult = await db.query(
      `SELECT id, description, quantity, unit_price, line_total 
       FROM line_items 
       WHERE invoice_id = $1 
       ORDER BY id ASC`,
      [id]
    );

    const invoice = {
      ...invoiceResult.rows[0],
      line_items: itemsResult.rows
    };

    res.json(invoice);
  } catch (error) {
    console.error("Get invoice error:", error);
    res.status(500).json({ error: "Failed to fetch invoice", details: error.message });
  }
});

// PUT /api/invoices/:id - Update invoice and line items
router.put("/:id", async (req, res) => {
  const client = await db.connect();
  
  try {
    const { id } = req.params;
    const {
      supplier_name,
      invoice_number,
      invoice_date,
      currency,
      subtotal,
      total,
      line_items,
      status
    } = req.body;

    await client.query('BEGIN');

    // Update invoice
    const updateResult = await client.query(
      `UPDATE invoices SET
        supplier_name = $1,
        invoice_number = $2,
        invoice_date = $3,
        currency = $4,
        subtotal = $5,
        total = $6,
        status = COALESCE($7, status),
        updated_at = NOW()
      WHERE id = $8
      RETURNING *`,
      [
        supplier_name || null,
        invoice_number || null,
        invoice_date || null,
        currency || 'USD',
        subtotal || 0,
        total || 0,
        status,
        id
      ]
    );

    if (updateResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: "Invoice not found" });
    }

    // Delete existing line items
    await client.query(
      `DELETE FROM line_items WHERE invoice_id = $1`,
      [id]
    );

    // Insert new line items
    const insertedItems = [];
    if (line_items && Array.isArray(line_items)) {
      for (const item of line_items) {
        const itemResult = await client.query(
          `INSERT INTO line_items (invoice_id, description, quantity, unit_price, line_total)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
          [
            id,
            item.description || '',
            item.quantity || 0,
            item.unit_price || 0,
            item.line_total || 0
          ]
        );
        insertedItems.push(itemResult.rows[0]);
      }
    }

    await client.query('COMMIT');

    const response = {
      ...updateResult.rows[0],
      line_items: insertedItems
    };

    res.json(response);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Update invoice error:", error);
    res.status(500).json({ error: "Failed to update invoice", details: error.message });
  } finally {
    client.release();
  }
});

// DELETE /api/invoices/:id - Delete invoice
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.query(
      `DELETE FROM invoices WHERE id = $1 RETURNING id`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Invoice not found" });
    }

    res.json({ message: "Invoice deleted successfully", id: result.rows[0].id });
  } catch (error) {
    console.error("Delete invoice error:", error);
    res.status(500).json({ error: "Failed to delete invoice", details: error.message });
  }
});

// POST /api/invoices/:id/extract - Trigger AI extraction (placeholder)
router.post("/:id/extract", async (req, res) => {
  try {
    const { id } = req.params;

    // TODO: Add AI/LLM extraction logic here
    // For now, just update status to indicate extraction is needed
    const result = await db.query(
      `UPDATE invoices 
       SET status = 'NEEDS_REVIEW', updated_at = NOW() 
       WHERE id = $1 
       RETURNING *`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Invoice not found" });
    }

    res.json({
      message: "Extraction triggered (placeholder)",
      invoice: result.rows[0]
    });
  } catch (error) {
    console.error("Extract invoice error:", error);
    res.status(500).json({ error: "Failed to extract invoice", details: error.message });
  }
});

module.exports = router;
