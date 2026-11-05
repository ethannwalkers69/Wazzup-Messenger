import pg from "pg";
const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

export const pool = new Pool({
  connectionString,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ssl: connectionString.includes("sslmode=require") ? { rejectUnauthorized: false } : undefined
});

pool.on("error", (err) => console.error("Unexpected PostgreSQL pool error:", err));

export async function query(text, params = []) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await pool.query(text, params);
    } catch (err) {
      lastError = err;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  throw lastError;
}

export async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
