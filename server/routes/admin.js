import { Router } from "express";
import { query } from "../db.js";
import { requireLeader } from "../middleware/auth.js";
const router=Router();
router.post("/premium/:userId",requireLeader,async(req,res,next)=>{
  try{
    const r=await query("UPDATE users SET is_premium=NOT is_premium,updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id,email,is_premium",[req.params.userId]);
    if(!r.rowCount) return res.status(404).json({error:{code:"USER_NOT_FOUND",message:"User not found."}});
    res.json({data:{user:r.rows[0]}});
  }catch(err){next(err);}
});
router.get("/users",requireLeader,async(req,res,next)=>{
  try{
    const r=await query("SELECT id,email,display_name,role,is_premium,created_at FROM users WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 200");
    res.json({data:{users:r.rows}});
  }catch(err){next(err);}
});
export default router;
