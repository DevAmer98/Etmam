import express from 'express';
import pkg from 'pg'; 
const { Pool } = pkg; 

const router = express.Router();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

router.use(express.json());

const executeWithRetry = async (fn, retries = 3, delay = 1000) => {
  try {
    return await fn();
  } catch (error) {
    if (retries > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
      return executeWithRetry(fn, retries - 1, delay * 2);
    }
    throw error;
  }
};

const withTimeout = (promise, timeout) => {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Database query timed out')), timeout)
  );
  return Promise.race([promise, timeoutPromise]);
};

router.get('/orders/storekeeperaccept', async (req, res) => {
  const client = await pool.connect();
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const limit = parseInt(url.searchParams.get('limit') || '10', 10);
    const page = parseInt(url.searchParams.get('page') || '1', 10);
    const query = `%${url.searchParams.get('query') || ''}%`;
    const offset = (page - 1) * limit;

    const countQuery = `
      SELECT COUNT(*) AS count
      FROM orders
      JOIN clients ON orders.client_id = clients.id
      WHERE (clients.client_name ILIKE $1 OR clients.company_name ILIKE $1)
      AND orders.storekeeperaccept = 'accepted'
    `;
    const countParams = [query];

    const countResult = await executeWithRetry(() =>
      client.query(countQuery, countParams)
    );
    const totalCount = parseInt(countResult.rows[0].count, 10);

    const baseQuery = `
      SELECT 
        orders.*, 
        clients.client_name AS client_name,
        clients.phone_number AS client_phone,
        clients.company_name AS client_company,
        clients.branch_number AS client_branch,
        clients.tax_number AS client_tax,
        clients.latitude AS client_latitude,
        clients.longitude AS client_longitude,
        clients.street AS client_street,
        clients.city AS client_city,
        clients.region AS client_region,
        orders.status,
        orders.storekeeperaccept,
        orders.supervisorAccept,
        orders.actual_delivery_date,
        orders.order_number,
        orders.total_price 
      FROM orders
      JOIN clients ON orders.client_id = clients.id
      WHERE (clients.client_name ILIKE $3 OR clients.company_name ILIKE $3)
      AND orders.storekeeperaccept = 'accepted'
      ORDER BY orders.created_at DESC
      LIMIT $1 OFFSET $2
    `;
    const baseParams = [limit, offset, query];

    const ordersResult = await executeWithRetry(() =>
      client.query(baseQuery, baseParams)
    );

    const orders = ordersResult.rows;

    const orderIds = orders.map(order => order.id);
    let locationMap = {};

    if (orderIds.length > 0) {
      const locationQuery = `
        SELECT order_id, name, url
        FROM order_locations
        WHERE order_id = ANY($1)
      `;
      const locationResult = await client.query(locationQuery, [orderIds]);

      locationResult.rows.forEach(loc => {
        if (!locationMap[loc.order_id]) {
          locationMap[loc.order_id] = [];
        }
        locationMap[loc.order_id].push({ name: loc.name, url: loc.url });
      });
    }

    orders.forEach(order => {
      order.deliveryLocations = locationMap[order.id] || [];
    });

    res.status(200).json({
      orders,
      totalCount,
      currentPage: page,
      totalPages: Math.ceil(totalCount / limit),
      hasMore: page < Math.ceil(totalCount / limit),
    });
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({
      error: error.message || 'Error fetching orders',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  } finally {
    client.release();
  }
});

export default router;
