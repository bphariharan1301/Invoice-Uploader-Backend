# Invoice Uploader Backend

Backend API for the Invoice Uploader application built with Node.js, Express, and PostgreSQL.

## Features

- 📤 File upload handling (PDF, PNG, JPEG)
- 💾 PostgreSQL database integration
- 📝 Invoice management (CRUD operations)
- 📊 Line items tracking
- 🔒 Rate limiting
- 🛡️ Error handling and validation

## Prerequisites

- Node.js (v16 or higher)
- PostgreSQL (v12 or higher)
- npm or yarn

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Create a `.env` file in the root directory:

```env
PORT=4000
UPLOAD_DIR=uploads
DATABASE_URL=postgresql://postgres:password@localhost:5432/invoice_app
FRONTEND_URL=http://localhost:3000
NODE_ENV=development
```

### 3. Setup Database

Create the database:

```bash
psql -U postgres
CREATE DATABASE invoice_app;
\q
```

Run the schema:

```bash
psql -U postgres -d invoice_app -f db/schema.sql
```

### 4. Start the Server

Development mode (with auto-reload):

```bash
npm run dev
```

Production mode:

```bash
npm start
```

The server will start on `http://localhost:4000`

## API Endpoints

### Invoices

- `GET /api/invoices` - List all invoices
- `GET /api/invoices/:id` - Get single invoice with line items
- `POST /api/invoices/upload` - Upload invoice file
- `PUT /api/invoices/:id` - Update invoice and line items
- `DELETE /api/invoices/:id` - Delete invoice
- `POST /api/invoices/:id/extract` - Trigger AI extraction (placeholder)

### Health

- `GET /health` - Health check endpoint
- `GET /` - API information

## File Upload

Supports:

- PDF files
- PNG images
- JPEG images
- Maximum size: 10MB

## Database Schema

### invoices table

- `id` - Primary key
- `file_path` - Path to uploaded file
- `supplier_name` - Supplier name
- `invoice_number` - Invoice number
- `invoice_date` - Invoice date
- `confidence` - Confidence score
- `currency` - Currency code (default: USD)
- `subtotal` - Subtotal amount
- `total` - Total amount
- `status` - Invoice status (UPLOADED, EXTRACTED, NEEDS_REVIEW, SAVED)
- `created_at` - Creation timestamp
- `updated_at` - Last update timestamp

### line_items table

- `id` - Primary key
- `invoice_id` - Foreign key to invoices
- `description` - Item description
- `quantity` - Item quantity
- `unit_price` - Price per unit
- `line_total` - Line total amount
- `created_at` - Creation timestamp

## Status Codes

- `UPLOADED` - File uploaded, awaiting extraction
- `EXTRACTED` - Data extracted successfully
- `NEEDS_REVIEW` - Extraction complete, needs review
- `SAVED` - Invoice reviewed and saved

## Error Handling

All endpoints return consistent error responses:

```json
{
	"error": "Error message",
	"details": "Detailed error information"
}
```

## Development

The project uses:

- Express.js for the web framework
- Multer for file uploads
- PostgreSQL with pg driver
- CORS for cross-origin requests
- Rate limiting for API protection
