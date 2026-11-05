import fs from "node:fs/promises";
import { pool } from "./db.js";

for (const file of ["001_init.sql", "002_direct_messages.sql"]) {
  const sql = await fs.readFile(new URL(`./migrations/${file}`, import.meta.url), "utf8");
  await pool.query(sql);
}
console.log("Database migration complete.");
await pool.end();
