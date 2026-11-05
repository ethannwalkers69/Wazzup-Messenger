import jwt from "jsonwebtoken";
import { query } from "../db.js";

export async function requireAuth(req, res, next) {
  try {
    const token = req.cookies.wazzup_session;
    if (!token) return res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Please log in." } });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const result = await query(
      "SELECT id,email,first_name,last_name,display_name,avatar_url,role,is_premium FROM users WHERE id=$1 AND deleted_at IS NULL",
      [decoded.sub]
    );
    if (!result.rowCount) return res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Account not found." } });
    req.user = result.rows[0];
    next();
  } catch {
    return res.status(401).json({ error: { code: "INVALID_SESSION", message: "Your session has expired." } });
  }
}

export function requireLeader(req, res, next) {
  if (req.user?.role !== "leader") return res.status(403).json({ error: { code: "FORBIDDEN", message: "Leader access required." } });
  next();
}

export function requireCsrf(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const cookie = req.cookies.csrfToken;
  const header = req.get("X-CSRF-Token");
  if (!cookie || !header || cookie !== header) {
    return res.status(403).json({ error: { code: "CSRF_INVALID", message: "Security token missing or invalid. Refresh and try again." } });
  }
  next();
}
