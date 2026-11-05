import { Router } from "express";
import bcrypt from "bcrypt";
import crypto from "node:crypto";
import { query } from "../db.js";
import { setSession, clearSession, setCsrf } from "../auth.js";
import { requireAuth } from "../middleware/auth.js";
import { fail } from "../middleware/errors.js";

const router = Router();

router.post("/signup", async (req, res, next) => {
  try {
    const { email, first_name, last_name, password } = req.body;
    if (!email || !first_name || !last_name || !password) return fail(res, 400, "MISSING_FIELDS", "Complete all required fields.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res, 400, "INVALID_EMAIL", "Enter a valid email.");
    if (String(password).length < 10) return fail(res, 400, "WEAK_PASSWORD", "Password must be at least 10 characters.");
    const normalized = email.trim().toLowerCase();
    if (normalized === process.env.LEADER_EMAIL?.trim().toLowerCase()) return fail(res, 409, "RESERVED_EMAIL", "This email is reserved.");
    const hash = await bcrypt.hash(password, 12);
    const result = await query(
      `INSERT INTO users(email,password_hash,first_name,last_name,display_name)
       VALUES($1,$2,$3,$4,$5)
       RETURNING id,email,first_name,last_name,display_name,avatar_url,role,is_premium`,
      [normalized, hash, first_name.trim(), last_name.trim(), `${first_name.trim()} ${last_name.trim()}`]
    );
    setSession(res, result.rows[0]);
    setCsrf(res, crypto.randomBytes(24).toString("hex"));
    res.status(201).json({ data: { user: result.rows[0] } });
  } catch (err) {
    if (err.code === "23505") return fail(res, 409, "EMAIL_EXISTS", "An account with this email already exists.");
    next(err);
  }
});

router.post("/login", async (req, res, next) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const result = await query("SELECT * FROM users WHERE email=$1 AND deleted_at IS NULL", [email]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) return fail(res, 401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
    const safeUser = { id:user.id,email:user.email,first_name:user.first_name,last_name:user.last_name,display_name:user.display_name,avatar_url:user.avatar_url,role:user.role,is_premium:user.is_premium };
    setSession(res, safeUser);
    setCsrf(res, crypto.randomBytes(24).toString("hex"));
    res.json({ data: { user: safeUser } });
  } catch (err) { next(err); }
});

router.post("/logout", (req, res) => {
  const csrfCookie = req.cookies.csrfToken;
  const csrfHeader = req.get("X-CSRF-Token");
  if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) {
    return fail(res, 403, "CSRF_INVALID", "Security token missing or invalid. Refresh and try again.");
  }
  clearSession(res);
  res.clearCookie("csrfToken", { path: "/" });
  res.json({ data: { success: true } });
});

router.get("/me", requireAuth, (req, res) => res.json({ data: { user: req.user } }));
export default router;
