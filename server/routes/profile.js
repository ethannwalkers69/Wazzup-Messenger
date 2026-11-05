import { Router } from "express";
import { query } from "../db.js";
import { fail } from "../middleware/errors.js";
const router = Router();

router.patch("/", async (req, res, next) => {
  try {
    const allowed = ["first_name","last_name","display_name","avatar_url"];
    const updates = Object.entries(req.body).filter(([key, value]) => allowed.includes(key) && value !== undefined);
    if (!updates.length) return fail(res, 400, "NO_CHANGES", "Provide at least one profile field.");
    const values = updates.map(([,v]) => v);
    const sets = updates.map(([k],i) => `${k}=$${i+1}`);
    values.push(req.user.id);
    const result = await query(
      `UPDATE users SET ${sets.join(",")},updated_at=now() WHERE id=$${values.length}
       RETURNING id,email,first_name,last_name,display_name,avatar_url,role,is_premium`, values
    );
    res.json({ data: { user: result.rows[0] } });
  } catch (err) { next(err); }
});
export default router;
