import { Router } from "express";
import { query, transaction } from "../db.js";
import { fail } from "../middleware/errors.js";
const router = Router();

async function membership(groupId, userId) {
  const r = await query("SELECT gm.role,u.role AS account_role FROM group_members gm JOIN users u ON u.id=gm.user_id WHERE gm.group_id=$1 AND gm.user_id=$2", [groupId,userId]);
  return r.rows[0];
}
async function canManage(groupId, user) {
  if (user.role === "leader") return true;
  return (await membership(groupId,user.id))?.role === "admin";
}
router.post("/", async (req,res,next) => {
  try {
    const name = String(req.body.name || "").trim();
    if (!name) return fail(res,400,"INVALID_NAME","Group name is required.");
    const result = await transaction(async c => {
      const g = await c.query("INSERT INTO groups(name,created_by) VALUES($1,$2) RETURNING *",[name,req.user.id]);
      await c.query("INSERT INTO group_members(group_id,user_id,role) VALUES($1,$2,'admin')",[g.rows[0].id,req.user.id]);
      return g.rows[0];
    });
    res.status(201).json({data:{group:result}});
  } catch(err){next(err);}
});
router.get("/", async(req,res,next)=>{
  try{
    const r=await query(
      `SELECT g.*,gm.role AS my_role,
       (SELECT count(*)::int FROM group_members x WHERE x.group_id=g.id) AS member_count,
       (SELECT m.body FROM messages m WHERE m.group_id=g.id AND m.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT 1) AS last_message
       FROM groups g JOIN group_members gm ON gm.group_id=g.id
       WHERE gm.user_id=$1 ORDER BY g.updated_at DESC`,[req.user.id]);
    res.json({data:{groups:r.rows}});
  }catch(err){next(err);}
});
router.patch("/:id",async(req,res,next)=>{
  try{
    if(!(await canManage(req.params.id,req.user))) return fail(res,403,"FORBIDDEN","Group admin access required.");
    const fields=["name","image_url"].filter(k=>req.body[k]!==undefined);
    if(!fields.length) return fail(res,400,"NO_CHANGES","No group changes supplied.");
    const vals=fields.map(k=>req.body[k]); vals.push(req.params.id);
    const sets=fields.map((k,i)=>`${k}=$${i+1}`);
    const r=await query(`UPDATE groups SET ${sets.join(",")},updated_at=now() WHERE id=$${vals.length} RETURNING *`,vals);
    res.json({data:{group:r.rows[0]}});
  }catch(err){next(err);}
});
router.post("/:id/members",async(req,res,next)=>{
  try{
    if(!(await canManage(req.params.id,req.user))) return fail(res,403,"FORBIDDEN","Group admin access required.");
    const email=String(req.body.email||"").trim().toLowerCase();
    const u=await query("SELECT id,role FROM users WHERE email=$1 AND deleted_at IS NULL",[email]);
    if(!u.rowCount) return fail(res,404,"USER_NOT_FOUND","No active account found for that email.");
    await query("INSERT INTO group_members(group_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[req.params.id,u.rows[0].id]);
    res.json({data:{success:true}});
  }catch(err){next(err);}
});
router.delete("/:id/members/:userId",async(req,res,next)=>{
  try{
    if(!(await canManage(req.params.id,req.user))) return fail(res,403,"FORBIDDEN","Group admin access required.");
    const target=await membership(req.params.id,req.params.userId);
    if(!target) return fail(res,404,"NOT_MEMBER","User is not a group member.");
    if(target.account_role==="leader") return fail(res,403,"LEADER_PROTECTED","The Leader cannot be removed.");
    if(target.role==="admin"){
      const count=await query("SELECT count(*)::int AS n FROM group_members WHERE group_id=$1 AND role='admin'",[req.params.id]);
      if(count.rows[0].n<=1) return fail(res,409,"LAST_ADMIN","Promote another admin before removing this admin.");
    }
    await query("DELETE FROM group_members WHERE group_id=$1 AND user_id=$2",[req.params.id,req.params.userId]);
    res.json({data:{success:true}});
  }catch(err){next(err);}
});
router.post("/:id/leave",async(req,res,next)=>{
  try{
    const m=await membership(req.params.id,req.user.id);
    if(!m) return fail(res,404,"NOT_MEMBER","You are not in this group.");
    if(req.user.role==="leader") return fail(res,403,"LEADER_PROTECTED","The Leader cannot leave a group.");
    if(m.role==="admin"){
      const count=await query("SELECT count(*)::int AS n FROM group_members WHERE group_id=$1 AND role='admin'",[req.params.id]);
      if(count.rows[0].n<=1) return fail(res,409,"LAST_ADMIN","Promote another admin before leaving.");
    }
    await query("DELETE FROM group_members WHERE group_id=$1 AND user_id=$2",[req.params.id,req.user.id]);
    res.json({data:{success:true}});
  }catch(err){next(err);}
});
router.patch("/:id/members/me",async(req,res,next)=>{
  try{
    const nickname=String(req.body.nickname||"").trim();
    if(nickname.length>40) return fail(res,400,"INVALID_NICKNAME","Nickname must be 40 characters or fewer.");
    const r=await query("UPDATE group_members SET nickname=$1 WHERE group_id=$2 AND user_id=$3 RETURNING nickname",[nickname||null,req.params.id,req.user.id]);
    if(!r.rowCount) return fail(res,404,"NOT_MEMBER","You are not in this group.");
    res.json({data:{nickname:r.rows[0].nickname}});
  }catch(err){next(err);}
});
router.patch("/:id/members/:userId",async(req,res,next)=>{
  try{
    if(req.user.role!=="leader") return fail(res,403,"LEADER_ONLY","Only the Leader can promote admins.");
    if(req.body.role!=="admin") return fail(res,400,"INVALID_ROLE","Only promotion to admin is supported.");
    const r=await query("UPDATE group_members SET role='admin' WHERE group_id=$1 AND user_id=$2 RETURNING *",[req.params.id,req.params.userId]);
    if(!r.rowCount) return fail(res,404,"NOT_MEMBER","User is not a group member.");
    res.json({data:{member:r.rows[0]}});
  }catch(err){next(err);}
});
router.get("/:id/members",async(req,res,next)=>{
  try{
    if(!(await membership(req.params.id,req.user.id)) && req.user.role!=="leader") return fail(res,403,"NOT_MEMBER","You are not in this group.");
    const r=await query(
      `SELECT u.id,u.email,u.display_name,u.first_name,u.last_name,u.avatar_url,u.is_premium,gm.role,gm.nickname,gm.joined_at
       FROM group_members gm JOIN users u ON u.id=gm.user_id WHERE gm.group_id=$1 ORDER BY gm.joined_at`,[req.params.id]);
    res.json({data:{members:r.rows}});
  }catch(err){next(err);}
});
export default router;
