// backend/llm.js
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");
const he = require("he");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

if (!OPENAI_API_KEY) {
	console.warn(
		"Warning: OPENAI_API_KEY not set. OpenAI calls will fail until set."
	);
}

const client = new OpenAI({ apiKey: OPENAI_API_KEY });

/**
 * Defensive extractor for possible response shapes from Responses API.
 * Prefer response.output_text when present (SDK convenience).
 */
function extractTextFromResponsesApi(resp) {
	try {
		// SDK provides output_text convenience property in many versions
		if (typeof resp.output_text === "string" && resp.output_text.trim()) {
			return resp.output_text;
		}

		// Common shape: resp.output is an array of items with content.parts[].text
		if (Array.isArray(resp.output)) {
			const parts = resp.output
				.map((o) => {
					if (typeof o === "string") return o;
					if (o?.content && Array.isArray(o.content)) {
						// join each content part
						return o.content
							.map((c) => c?.text ?? JSON.stringify(c))
							.join("\n");
					}
					return JSON.stringify(o);
				})
				.join("\n");
			if (parts) return parts;
		}

		// Some responses embed candidates or other shapes: check common properties
		if (
			resp?.candidates &&
			Array.isArray(resp.candidates) &&
			resp.candidates[0]
		) {
			const cand = resp.candidates[0];
			if (cand?.content && Array.isArray(cand.content.parts)) {
				return cand.content.parts
					.map((p) => p.text ?? JSON.stringify(p))
					.join("\n");
			}
			return JSON.stringify(cand);
		}

		// fallback: stringify entire response
		return JSON.stringify(resp);
	} catch (e) {
		return JSON.stringify(resp);
	}
}

/**
 * extractInvoiceFromFile(filePath)
 * - Reads file, encodes base64
 * - Sends prompt to OpenAI Responses API
 * - Tries to parse first JSON object returned
 * - Coerces numeric/date fields and normalizes line items
 *
 * Returns { ok: boolean, parsed: object|null, raw: string|null, error?: string }
 */
async function extractInvoiceFromFile(filePath) {
	try {
		if (!OPENAI_API_KEY) {
			throw new Error("OPENAI_API_KEY environment variable not set");
		}

		const ext = path.extname(filePath).toLowerCase();
		const buf = fs.readFileSync(filePath);
		const b64 = buf.toString("base64");

		// mime detection
		let mime = "application/octet-stream";
		if (ext === ".png") mime = "image/png";
		else if (ext === ".jpg" || ext === ".jpeg") mime = "image/jpeg";
		else if (ext === ".pdf") mime = "application/pdf";

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

		const promptText = `
You are an invoice extraction engine. I will provide a file encoded in base64.
Return ONLY a JSON object (no prose) that strictly matches the schema described below.
If a field is not present, return null. Numeric values must be numbers, date in YYYY-MM-DD.
Provide a "confidence" (0.0-1.0) for the overall extraction, and optional confidences for each line item.

Schema:
${JSON.stringify(schema, null, 2)}

File MIME type: ${mime}
File content (base64): (BEGIN_BASE64)${b64}(END_BASE64)

Return the JSON now.
`.trim();

		// Call OpenAI Responses API (official SDK). See docs. :contentReference[oaicite:2]{index=2}
		const resp = await client.responses.create({
			model: OPENAI_MODEL,
			input: promptText,
			// you can add temperature, max_output_tokens, or structured output options here
			// e.g. temperature: 0, top_p: 1
		});

		// Extract raw textual output
		const rawOutput = he.decode(extractTextFromResponsesApi(resp));

		// find JSON object in response
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

		// sanitize/coerce numeric and item fields
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

		return { ok: true, parsed, raw: rawOutput };
	} catch (err) {
		console.error("extractInvoiceFromFile error:", err);
		return { ok: false, error: err?.message ?? String(err), raw: "" };
	}
}

module.exports = { extractInvoiceFromFile };
