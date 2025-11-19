const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const db = require("../db/index");
const router = express.Router();
const { extractInvoiceFromFile } = require("../llm");

const uploadFolder = process.env.UPLOAD_DIR || "uploads";
const uploadBaseUrl = process.env.UPLOAD_BASE_URL || "/uploads"; // used by frontend to preview

if (!fs.existsSync(uploadFolder))
	fs.mkdirSync(uploadFolder, { recursive: true });

// Multer storage (filename sanitized)
const storage = multer.diskStorage({
	destination: (req, file, cb) => cb(null, uploadFolder),
	filename: (req, file, cb) => {
		const uniqueName = `${Date.now()}-${uuidv4()}${path.extname(
			file.originalname
		)}`;
		cb(null, uniqueName);
	},
});

const upload = multer({
	storage,
	limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
	fileFilter: (req, file, cb) => {
		const allowed = ["application/pdf", "image/png", "image/jpeg"];
		if (allowed.includes(file.mimetype)) cb(null, true);
		else cb(new Error("Only PDF, PNG, and JPEG files are allowed"), false);
	},
});

// POST /api/invoices/upload
router.post("/upload", upload.single("file"), async (req, res) => {
	try {
		if (!req.file) return res.status(400).json({ error: "File is required" });

		// Store record
		const result = await db.query(
			`INSERT INTO invoices (file_path, status, created_at, updated_at)
       VALUES ($1, 'UPLOADED', NOW(), NOW())
       RETURNING id, file_path, status, created_at`,
			[
				req.file.filename
					? path.join(uploadFolder, req.file.filename)
					: req.file.path,
			]
		);

		const invoice = result.rows[0];

		// Build a preview URL for frontend
		const file_url = `${uploadBaseUrl}/${req.file.filename}`;

		// Optionally enqueue extraction job here (background worker)
		res.status(201).json({
			id: invoice.id,
			file_path: invoice.file_path,
			file_url,
			status: invoice.status,
			message: "File uploaded successfully",
		});
	} catch (error) {
		console.error("Upload error:", error);
		res
			.status(500)
			.json({ error: "Failed to upload file", details: error.message });
	}
});

// GET /api/invoices - List with pagination
router.get("/", async (req, res) => {
	try {
		const page = Math.max(1, parseInt(req.query.page || "1", 10));
		const limit = Math.min(100, parseInt(req.query.limit || "25", 10));
		const offset = (page - 1) * limit;

		const result = await db.query(
			`
      SELECT 
        id, supplier_name, invoice_number, invoice_date, currency,
        subtotal, total, status, created_at, updated_at
      FROM invoices
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
    `,
			[limit, offset]
		);

		// total count for frontend pagination (optional)
		const countRes = await db.query(
			`SELECT COUNT(*)::int AS total FROM invoices`
		);
		const total = countRes.rows[0].total || 0;

		res.json({ page, limit, total, invoices: result.rows });
	} catch (error) {
		console.error("List invoices error:", error);
		res
			.status(500)
			.json({ error: "Failed to fetch invoices", details: error.message });
	}
});

// GET /api/invoices/:id - detail with line items
router.get("/:id", async (req, res) => {
	try {
		const { id } = req.params;

		const invoiceResult = await db.query(
			`SELECT * FROM invoices WHERE id = $1`,
			[id]
		);
		if (invoiceResult.rows.length === 0)
			return res.status(404).json({ error: "Invoice not found" });

		const itemsResult = await db.query(
			`SELECT id, description, quantity, unit_price, line_total 
       FROM line_items WHERE invoice_id = $1 ORDER BY id ASC`,
			[id]
		);

		const invoiceRow = invoiceResult.rows[0];

		// Provide a file_url if possible (frontend-friendly)
		const filename = path.basename(invoiceRow.file_path || "");
		const file_url = filename ? `${uploadBaseUrl}/${filename}` : null;

		const invoice = { ...invoiceRow, file_url, line_items: itemsResult.rows };

		res.json(invoice);
	} catch (error) {
		console.error("Get invoice error:", error);
		res
			.status(500)
			.json({ error: "Failed to fetch invoice", details: error.message });
	}
});

// PUT /api/invoices/:id - Update invoice + replace line items (transactional)
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
			status,
		} = req.body;

		// Basic validation
		if (line_items && !Array.isArray(line_items)) {
			return res.status(400).json({ error: "line_items must be an array" });
		}

		await client.query("BEGIN");

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
				currency || "USD",
				subtotal || 0,
				total || 0,
				status || null,
				id,
			]
		);

		if (updateResult.rows.length === 0) {
			await client.query("ROLLBACK");
			return res.status(404).json({ error: "Invoice not found" });
		}

		// Replace line items
		await client.query(`DELETE FROM line_items WHERE invoice_id = $1`, [id]);

		const insertedItems = [];
		if (Array.isArray(line_items)) {
			for (const item of line_items) {
				// coerce numbers safely
				const qty = parseFloat(item.quantity) || 0;
				const unit = parseFloat(item.unit_price) || 0;
				const line_total = parseFloat(item.line_total) || qty * unit;

				const itemResult = await client.query(
					`INSERT INTO line_items (invoice_id, description, quantity, unit_price, line_total)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, description, quantity, unit_price, line_total`,
					[id, item.description || "", qty, unit, line_total]
				);
				insertedItems.push(itemResult.rows[0]);
			}
		}

		await client.query("COMMIT");

		const response = { ...updateResult.rows[0], line_items: insertedItems };
		res.json(response);
	} catch (error) {
		// Rollback safely
		try {
			await client.query("ROLLBACK");
		} catch (e) {
			/* ignore */
		}
		console.error("Update invoice error:", error);
		res
			.status(500)
			.json({ error: "Failed to update invoice", details: error.message });
	} finally {
		client.release();
	}
});

// DELETE /api/invoices/:id - Delete invoice and optionally delete file on disk
router.delete("/:id", async (req, res) => {
	try {
		const { id } = req.params;

		// Fetch file_path to remove file from disk if you want
		const fetch = await db.query(
			`SELECT file_path FROM invoices WHERE id = $1`,
			[id]
		);
		if (!fetch.rows.length)
			return res.status(404).json({ error: "Invoice not found" });

		const filePath = fetch.rows[0].file_path;

		const result = await db.query(
			`DELETE FROM invoices WHERE id = $1 RETURNING id`,
			[id]
		);

		if (result.rows.length === 0)
			return res.status(404).json({ error: "Invoice not found" });

		// delete file from disk if exists
		try {
			if (filePath) {
				const fullPath = path.isAbsolute(filePath)
					? filePath
					: path.join(process.cwd(), filePath);
				if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
			}
		} catch (e) {
			console.warn("Failed to delete file from disk:", e.message);
		}

		res.json({
			message: "Invoice deleted successfully",
			id: result.rows[0].id,
		});
	} catch (error) {
		console.error("Delete invoice error:", error);
		res
			.status(500)
			.json({ error: "Failed to delete invoice", details: error.message });
	}
});

// POST /api/invoices/:id/extract - Trigger AI extraction (now calling LLM)
router.post("/:id/extract", async (req, res) => {
	const client = await db.connect();
	try {
		const { id } = req.params;

		// 1) fetch invoice row to get file_path
		const invRes = await client.query(`SELECT * FROM invoices WHERE id = $1`, [
			id,
		]);
		if (!invRes.rows.length) {
			client.release();
			return res.status(404).json({ error: "Invoice not found" });
		}
		const invoiceRow = invRes.rows[0];
		const filePath = invoiceRow.file_path;
		if (!filePath) {
			client.release();
			return res.status(400).json({ error: "No file associated with invoice" });
		}

		// 2) call LLM helper (filePath may be relative)
		const absolutePath = path.isAbsolute(filePath)
			? filePath
			: path.join(process.cwd(), filePath);
		const llmResult = await extractInvoiceFromFile(absolutePath);

		// Save raw output to DB and set appropriate status
		if (!llmResult.ok) {
			// Save raw LLM output if available, mark NEEDS_REVIEW
			await client.query(
				`UPDATE invoices SET raw_llm_json = $1, status = 'NEEDS_REVIEW', updated_at = NOW() WHERE id = $2`,
				[llmResult.raw || JSON.stringify({ error: llmResult.error }), id]
			);
			client.release();
			return res
				.status(200)
				.json({
					ok: false,
					message: "Extraction returned invalid JSON",
					details: llmResult.error,
					raw: llmResult.raw,
				});
		}

		const parsed = llmResult.parsed;

		// 3) Persist extracted fields transactionally
		await client.query("BEGIN");

		// Update invoice main fields and raw_llm_json
		await client.query(
			`UPDATE invoices SET
         supplier_name = $1,
         invoice_number = $2,
         invoice_date = $3,
         currency = $4,
         subtotal = $5,
         total = $6,
         raw_llm_json = $7,
         status = 'EXTRACTED',
         updated_at = NOW()
       WHERE id = $8`,
			[
				parsed.supplier_name || null,
				parsed.invoice_number || null,
				parsed.invoice_date || null,
				parsed.currency || "USD",
				parsed.subtotal || 0,
				parsed.total || 0,
				parsed.raw_llm_json ? parsed.raw_llm_json : llmResult.raw, // redundant but safe
				id,
			]
		);

		// Replace line items
		await client.query(`DELETE FROM line_items WHERE invoice_id = $1`, [id]);
		for (const li of parsed.line_items || []) {
			await client.query(
				`INSERT INTO line_items (invoice_id, description, quantity, unit_price, line_total)
         VALUES ($1, $2, $3, $4, $5)`,
				[
					id,
					li.description || "",
					li.quantity || 0,
					li.unit_price || 0,
					li.line_total || 0,
				]
			);
		}

		await client.query("COMMIT");

		// refetch updated invoice
		const updated = await client.query(`SELECT * FROM invoices WHERE id = $1`, [
			id,
		]);
		const items = await client.query(
			`SELECT id, description, quantity, unit_price, line_total FROM line_items WHERE invoice_id = $1`,
			[id]
		);

		client.release();

		return res.json({
			ok: true,
			message: "Extraction complete",
			invoice: updated.rows[0],
			line_items: items.rows,
		});
	} catch (err) {
		try {
			await client.query("ROLLBACK");
		} catch (e) {
			/* ignore */
		}
		client.release();
		console.error("LLM extract error:", err);
		return res
			.status(500)
			.json({
				error: "Extraction failed",
				details: err.message || String(err),
			});
	}
});

module.exports = router;
