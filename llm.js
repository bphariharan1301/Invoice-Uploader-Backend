// backend/llm.js
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch"); // or use global fetch on Node 18+
const he = require("he");

const OPENAI_URL = "https://api.openai.com/v1/responses";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini"; // change if needed

/**
 * Call the LLM with a file (base64) and a JSON-schema-guided prompt,
 * asking the model to return a strict JSON object that matches the schema.
 *
 * Returns: { parsed: object|null, raw: string, ok: boolean, error?: string }
 */
async function extractInvoiceFromFile(filePath) {
	try {
		const ext = path.extname(filePath).toLowerCase();
		const buf = fs.readFileSync(filePath);
		const b64 = buf.toString("base64");

		// Basic mime detection
		let mime = "application/octet-stream";
		if (ext === ".png") mime = "image/png";
		else if (ext === ".jpg" || ext === ".jpeg") mime = "image/jpeg";
		else if (ext === ".pdf") mime = "application/pdf";

		// JSON schema we expect the model to return
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

		// Instruction prompt. Be strict: ask for ONLY JSON.
		const prompt = `
You are an invoice extraction engine. I will provide a file encoded in base64.
Return ONLY a JSON object (no prose) that strictly matches the schema described below.
If a field is not present, return null. Provide numeric values as numbers, date in YYYY-MM-DD.
Provide a "confidence" (0.0-1.0) for the overall extraction, and optional confidences for each line item.

Schema:
${JSON.stringify(schema, null, 2)}

Now, the file MIME type is: ${mime}
The file content is base64: (BEGIN_BASE64)${b64}(END_BASE64)

Produce the JSON output now.
`;

		const body = {
			model: MODEL,
			// Simple text input. If your model supports image attachments natively, replace accordingly.
			input: prompt,
			// limit tokens to protect cost if you like:
			// max_tokens: 2000
		};

		const res = await fetch(OPENAI_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
			},
			body: JSON.stringify(body),
		});

		if (!res.ok) {
			const text = await res.text();
			return {
				ok: false,
				error: `LLM call failed: ${res.status} ${text}`,
				raw: text,
			};
		}

		const json = await res.json();
		// response format may vary by API; try to extract text from the model output
		// For the Responses API, 'output' may have array items; we'll robustly search.
		let rawOutput = "";

		if (json.output) {
			// collect textual parts
			const gather = (arr) =>
				arr
					.map((it) => {
						if (typeof it === "string") return it;
						if (it && typeof it === "object" && it.content) return it.content;
						return JSON.stringify(it);
					})
					.join("\n");
			rawOutput = Array.isArray(json.output)
				? gather(json.output)
				: JSON.stringify(json.output);
		} else if (
			json.choices &&
			Array.isArray(json.choices) &&
			json.choices[0].message
		) {
			rawOutput =
				json.choices[0].message.content ||
				JSON.stringify(json.choices[0].message);
		} else {
			rawOutput = JSON.stringify(json);
		}

		// decode HTML entities just in case
		rawOutput = he.decode(rawOutput);

		// Extract JSON from rawOutput: try to find the first {...} block
		const firstJsonMatch = rawOutput.match(/{[\s\S]*}/);
		let parsed = null;
		if (firstJsonMatch) {
			try {
				parsed = JSON.parse(firstJsonMatch[0]);
			} catch (parseErr) {
				// not valid JSON; leave parsed null
				return {
					ok: false,
					error: "LLM returned non-JSON or malformed JSON",
					raw: rawOutput,
				};
			}
		} else {
			return {
				ok: false,
				error: "No JSON found in LLM output",
				raw: rawOutput,
			};
		}

		// Basic sanitization / coercion
		if (parsed) {
			// ensure numeric conversion
			if (parsed.subtotal !== null && parsed.subtotal !== undefined)
				parsed.subtotal = Number(parsed.subtotal) || 0;
			if (parsed.total !== null && parsed.total !== undefined)
				parsed.total = Number(parsed.total) || 0;
			if (!Array.isArray(parsed.line_items)) parsed.line_items = [];
			parsed.line_items = parsed.line_items.map((li) => ({
				description: li.description || "",
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
		return { ok: false, error: err.message || String(err), raw: "" };
	}
}

module.exports = { extractInvoiceFromFile };
