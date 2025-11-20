// backend/llm.js
// PDF-text-only extractor + Gemini (Google GenAI SDK) caller
// Returns: { ok, parsed, raw, model, error? }

const fs = require("fs");
const path = require("path");
const he = require("he");
const { PDFParse } = require("pdf-parse");
const { GoogleGenAI } = require("@google/genai");

const GENAI_API_KEY = process.env.GENAI_API_KEY || process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "models/gemini-2.0-flash-lite";

if (!GENAI_API_KEY) {
	console.warn("GENAI_API_KEY not set; Gemini calls will fail until set.");
}

const genAI = new GoogleGenAI({ apiKey: GENAI_API_KEY });

/**
 * Normalize text for LLM prompts:
 * - remove weird control chars
 * - collapse blank lines
 * - trim and limit length
 */
function normalizeTextForLLM(raw) {
	if (!raw) return "";
	let s = String(raw).replace(/\r/g, "\n");
	// strip non-printable except newline/tab
	s = s.replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\u00FF]/g, " ");
	s = s.replace(/\n{3,}/g, "\n\n");
	s = s
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.join("\n");
	// limit length (tune for token limits)
	const maxLen = 30000; // characters
	if (s.length > maxLen) s = s.slice(0, maxLen) + "\n\n...[TRUNCATED]";
	return s;
}

/**
 * Robust text extraction from a PDF buffer using pdf-parse
 */
async function extractTextFromPdfBuffer(buffer) {
	try {
		const pdfParser = new PDFParse({
			data: buffer,
		});
		const data = await pdfParser.getText();
		// prefer data.text; fallback to empty
		const txt = data && data.text ? String(data.text) : "";
		return normalizeTextForLLM(txt);
	} catch (err) {
		console.warn("pdf-parse failed:", err?.message || err);
		return "";
	}
}

/**
 * Extract textual content from filePath. Only PDF handled here.
 * Returns { text, mime }
 */
async function extractTextFromFilePath(filePath) {
	const ext = path.extname(filePath || "").toLowerCase();
	const buffer = fs.readFileSync(filePath);

	if (ext === ".pdf") {
		const txt = await extractTextFromPdfBuffer(buffer);
		return { text: txt, mime: "application/pdf" };
	}

	// For non-PDFs we simply return stringified buffer (not used per your request)
	try {
		return {
			text: normalizeTextForLLM(buffer.toString("utf8")),
			mime: "text/plain",
		};
	} catch (e) {
		return { text: "", mime: "application/octet-stream" };
	}
}

/**
 * Robustly extract textual output from GenAI SDK responses.
 * SDK response shapes vary; this tries a few common ones.
 */
function extractTextFromGenAIResponse(res) {
	try {
		// candidates => candidate.content.parts[].text
		if (res?.candidates && Array.isArray(res.candidates) && res.candidates[0]) {
			const cand = res.candidates[0];
			const parts = (cand.content && cand.content.parts) || cand.content;
			if (Array.isArray(parts)) {
				return parts.map((p) => p.text ?? JSON.stringify(p)).join("\n");
			}
			return JSON.stringify(cand);
		}

		// direct output array
		if (Array.isArray(res?.output)) {
			return res.output
				.map((o) => (typeof o === "string" ? o : JSON.stringify(o)))
				.join("\n");
		}

		// output_text convenience property (SDK)
		if (typeof res?.output_text === "string" && res.output_text.trim()) {
			return res.output_text;
		}

		// content.parts top-level
		if (res?.content && Array.isArray(res.content)) {
			return res.content
				.map((c) => (c.text ? c.text : JSON.stringify(c)))
				.join("\n");
		}

		// fallback stringify
		if (typeof res === "string") return res;
		return JSON.stringify(res);
	} catch (e) {
		return JSON.stringify(res);
	}
}

/**
 * Main: extractInvoiceFromFile(filePath)
 * - extracts PDF text
 * - prompts Gemini with the extracted text and a strict JSON schema instruction
 * - returns parsed object or error/debug info
 */
async function extractInvoiceFromFile(filePath) {
	try {
		if (!GENAI_API_KEY) {
			throw new Error("GENAI_API_KEY environment variable not set");
		}

		if (!filePath || !fs.existsSync(filePath)) {
			return { ok: false, error: "filePath missing or not found", raw: null };
		}

		const { text: extractedText, mime } = await extractTextFromFilePath(
			filePath
		);

		if (!extractedText || extractedText.trim().length === 0) {
			return {
				ok: false,
				error: "No usable text extracted from PDF",
				raw: null,
			};
		}

		// Schema we want back
		const schema = {
			invoice_number: "string|null",
			invoice_date: "YYYY-MM-DD|null",
			supplier_name: "string|null",
			currency: "string|null",
			subtotal: "number|null",
			total: "number|null",
			confidence: "number|null (0.0-1.0 overall confidence estimate)",
			line_items: [
				{
					description: "string",
					quantity: "number",
					unit_price: "number",
					line_total: "number",
					confidence: "number|null",
				},
			],
		};

		// Build strict prompt: ONLY JSON
		const promptText = `
You are an invoice extraction engine. I will provide the extracted text content from an invoice (PDF text).
Return ONLY a JSON object (no prose) that strictly matches the schema described below.
If a field is not present, return null. Numeric values must be numbers, date in YYYY-MM-DD.
Provide a "confidence" (0.0-1.0) for the overall extraction, and optional confidences for each line item. Also, look for Invoice Number patterns in the text as well as Invoice Date patterns. The supplier name should be extracted from the header or footer if possible

Schema:
${JSON.stringify(schema, null, 2)}

MIME type of original file: ${mime}

BEGIN_EXTRACTED_TEXT:
${extractedText}
END_EXTRACTED_TEXT

Return only the JSON now (no explanation).
`.trim();

		// Build GenAI payload
		const payload = {
			model: GEMINI_MODEL,
			contents: [
				{
					parts: [
						{
							text: promptText,
						},
					],
				},
			],
			// Optionally add parameters like temperature, safetySettings, maxOutputTokens etc.
		};

		// Call Gemini via SDK
		const res = await genAI.models.generateContent(payload);

		// Get text
		const rawOutput = he.decode(extractTextFromGenAIResponse(res));

		// Search for first JSON object
		const firstJsonMatch = rawOutput.match(/{[\s\S]*}/);
		if (!firstJsonMatch) {
			return {
				ok: false,
				error: "No JSON found in model output",
				raw: rawOutput,
			};
		}

		let parsed = null;
		try {
			parsed = JSON.parse(firstJsonMatch[0]);
		} catch (parseErr) {
			return {
				ok: false,
				error: "Model returned malformed JSON",
				raw: rawOutput,
			};
		}

		// Coerce numbers and normalize line items
		if (parsed) {
			if (parsed.subtotal !== null && parsed.subtotal !== undefined)
				parsed.subtotal = Number(parsed.subtotal) || 0;
			if (parsed.total !== null && parsed.total !== undefined)
				parsed.total = Number(parsed.total) || 0;

			if (!Array.isArray(parsed.line_items)) parsed.line_items = [];
			parsed.line_items = parsed.line_items.map((li) => ({
				description: li.description ?? "",
				quantity: Number(li.quantity) || 0,
				unit_price: Number(li.unit_price) || 0,
				line_total:
					Number(li.line_total) ||
					Number(li.quantity || 0) * Number(li.unit_price || 0),
				confidence: li.confidence !== undefined ? Number(li.confidence) : null,
			}));
		}

		return { ok: true, parsed, raw: rawOutput, model: GEMINI_MODEL };
	} catch (err) {
		console.error("extractInvoiceFromFile error:", err);
		return { ok: false, error: err?.message ?? String(err), raw: "" };
	}
}

module.exports = { extractInvoiceFromFile };
