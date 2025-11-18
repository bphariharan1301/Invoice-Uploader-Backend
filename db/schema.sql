-- Invoice Uploader Database Schema

-- Drop tables if they exist
DROP TABLE IF EXISTS line_items CASCADE;
DROP TABLE IF EXISTS invoices CASCADE;

-- Create invoices table
CREATE TABLE invoices (
  id SERIAL PRIMARY KEY,
  file_path VARCHAR(500),
  supplier_name VARCHAR(255),
  invoice_number VARCHAR(100),
  invoice_date DATE,
  currency VARCHAR(10) DEFAULT 'USD',
  subtotal DECIMAL(12, 2) DEFAULT 0.00,
  total DECIMAL(12, 2) DEFAULT 0.00,
  status VARCHAR(50) DEFAULT 'UPLOADED',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Create line_items table
CREATE TABLE line_items (
  id SERIAL PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description TEXT,
  quantity DECIMAL(10, 2) DEFAULT 1,
  unit_price DECIMAL(12, 2) DEFAULT 0.00,
  line_total DECIMAL(12, 2) DEFAULT 0.00,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes for better query performance
CREATE INDEX idx_invoices_status ON invoices(status);
CREATE INDEX idx_invoices_created_at ON invoices(created_at DESC);
CREATE INDEX idx_line_items_invoice_id ON line_items(invoice_id);

-- Insert sample data for testing
INSERT INTO invoices (supplier_name, invoice_number, invoice_date, subtotal, total, status) 
VALUES 
  ('Acme Inc.', 'INV-1001', '2025-11-01', 1000.00, 1200.00, 'EXTRACTED'),
  ('Globex Corporation', '2025-204', '2025-11-10', 380.00, 450.50, 'NEEDS_REVIEW');

INSERT INTO line_items (invoice_id, description, quantity, unit_price, line_total)
VALUES
  (1, 'Consulting Services', 10, 100.00, 1000.00),
  (2, 'Product A', 5, 50.00, 250.00),
  (2, 'Product B', 2, 65.00, 130.00);
