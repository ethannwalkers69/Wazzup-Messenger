import bcrypt from "bcrypt";
import { query } from "./db.js";

export async function seedLeader() {
  const email = process.env.LEADER_EMAIL?.trim().toLowerCase();
  const password = process.env.LEADER_PASSWORD;
  if (!email || !password) throw new Error("LEADER_EMAIL and LEADER_PASSWORD are required");
  const existing = await query("SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL", [email]);
  if (existing.rowCount) {
    await query("UPDATE users SET role='leader', updated_at=now() WHERE email=$1", [email]);
    return;
  }
  const password_hash = await bcrypt.hash(password, 12);
  await query(
    `INSERT INTO users(email,password_hash,first_name,last_name,display_name,role)
     VALUES($1,$2,'Wazzup','Leader','Wazzup Leader','leader')`,
    [email, password_hash]
  );
}
