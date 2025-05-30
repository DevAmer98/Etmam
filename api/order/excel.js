import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import ExcelJS from 'exceljs';
import pg from 'pg';
const { Pool } = pg;

// Derive __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create a connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * Generates an Excel file from order data.
 * @param {Object} orderData - The order data including products.
 * @returns {Promise<Buffer>} - Returns the Excel buffer.
 */
async function generateExcel(orderData) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Quotation');

  // Header Information
  sheet.addRow(['Order ID', orderData.custom_id || orderData.id]);
  sheet.addRow(['Client Name', orderData.client_name]);
  sheet.addRow(['Company Name', orderData.company_name]);
  sheet.addRow(['Order Date', orderData.created_at]);
  sheet.addRow([]);

  // Product Table Headers
  sheet.columns = [
    { header: 'Product #', key: 'productNumber', width: 12 },
    { header: 'Product Name', key: 'product_name', width: 30 },
    { header: 'Quantity', key: 'quantity', width: 12 },
    { header: 'Unit Price', key: 'unit_price', width: 15 },
    { header: 'Total Price', key: 'total_price', width: 15 }
  ];

  // Add Product Rows
  orderData.products.forEach(product => {
    sheet.addRow({
      productNumber: product.productNumber,
      product_name: product.product_name,
      quantity: product.quantity,
      unit_price: product.unit_price,
      total_price: product.unit_price * product.quantity
    });
  });

  // Buffer output
  return await workbook.xlsx.writeBuffer();
}

/**
 * Fetches order data from the database.
 * @param {string} quotationId - The ID of the order.
 * @returns {Promise<Object>} - The order data.
 */
async function fetchOrderDataFromDatabase(quotationId) {
  try {
    console.log(`Fetching data for quotation ID: ${quotationId}`);

    const orderQuery = `
      SELECT q.*, c.company_name, c.client_name, c.phone_number, 
             c.tax_number, c.branch_number, c.latitude, c.longitude, 
             c.street, c.city, c.region, q.storekeeper_notes,
             s.name AS supervisor_name
      FROM quotations q
      JOIN clients c ON q.client_id = c.id
      LEFT JOIN supervisors s ON q.supervisor_id = s.id
      WHERE q.id = $1
    `;
    const orderResult = await pool.query(orderQuery, [quotationId]);

    if (orderResult.rows.length === 0) {
      throw new Error('Quotation not found');
    }

    const productsQuery = `
      SELECT * FROM quotation_products
      WHERE quotation_id = $1
    `;
    const productsResult = await pool.query(productsQuery, [quotationId]);

    const productsWithNumbers = productsResult.rows.map((product, index) => ({
      ...product,
      productNumber: String(index + 1).padStart(3, '0'),
    }));

    const salesRepQuery = `
      SELECT name, email, phone FROM salesreps
      WHERE id = $1
    `;
    const salesRepResult = await pool.query(salesRepQuery, [orderResult.rows[0].sales_rep_id]);

    const formattedCreatedAt = new Date(orderResult.rows[0].created_at).toISOString().split('T')[0];

    const orderData = {
      ...orderResult.rows[0],
      created_at: formattedCreatedAt,
      products: productsWithNumbers,
      name: salesRepResult.rows[0]?.name || 'N/A',
      email: salesRepResult.rows[0]?.email || 'N/A',
      phone: salesRepResult.rows[0]?.phone || 'N/A',
      supervisor_name: orderResult.rows[0]?.supervisor_name || 'No Supervisor Assigned',
    };

    return orderData;
  } catch (error) {
    console.error('Error fetching quotation data:', error);
    throw new Error('Failed to fetch quotation data');
  }
}

/**
 * Serves the Excel file for a given order ID.
 * @param {string} quotationId - The ID of the order.
 * @param {Object} res - The Express response object.
 */
export async function serveExcel(quotationId, res) {
  try {
    const orderData = await fetchOrderDataFromDatabase(quotationId);
    const excelBuffer = await generateExcel(orderData);

    const customId = orderData.custom_id || `quotation_${quotationId}`;
    const fileName = `quotation_${customId}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);
    res.setHeader('Content-Length', excelBuffer.length);

    res.send(excelBuffer);
  } catch (error) {
    console.error('Error serving Excel:', error);
    res.status(500).json({ error: 'Failed to generate Excel. Please try again later.' });
  }
}
