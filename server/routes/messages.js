import { Router } from "express";
import { query } from "../db.js";
import { fail } from "../middleware/errors.js";
const router = Router();
const allowedEmoji = ["👍","😆","😢","😲","❤️","😡"];
async function isMember(groupId,userId){
  const r=await query("SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2",[groupId,userId]);
  return !!r.rowCount;
}
router.get("/groups/:id/messages",async(req,res,next)=>{
  try{
    if(!(await isMember(req.params.id,req.user.id)) && req.user.role!=="leader") return fail(res,403,"NOT_MEMBER","You are not in this group.");
    const limit=Math.min(Math.max(parseInt(req.query.limit||"50",10)||50,1),100);
    const before=req.query.before;
    const vals=[req.params.id]; let where="";
    if(before){vals.push(before);where="AND m.created_at < $2";}
    vals.push(limit);
    const r=await query(
      `SELECT m.*,u.display_name,u.avatar_url,
       (SELECT json_agg(json_build_object('emoji',x.emoji,'count',x.n,'mine',x.mine))
        FROM (SELECT emoji,count(*)::int AS n,bool_or(user_id=$${vals.length+1}) AS mine FROM reactions WHERE message_id=m.id GROUP BY emoji) x) AS reactions
       FROM messages m JOIN users u ON u.id=m.sender_id
       WHERE m.group_id=$1 ${where} AND m.deleted_at IS NULL
       ORDER BY m.created_at DESC LIMIT $${vals.length}`, [...vals,req.user.id]
    );
    res.json({data:{messages:r.rows.reverse()}});
  }catch(err){next(err);}
});
router.post("/groups/:id/messages",async(req,res,next)=>{
  try{
    if(!(await isMember(req.params.id,req.user.id)) && req.user.role!=="leader") return fail(res,403,"NOT_MEMBER","You are not in this group.");
    const body=String(req.body.body||"").trim()||null;
    const image_url=req.body.image_url||null;
    if(!body&&!image_url) return fail(res,400,"EMPTY_MESSAGE","Write a message or attach an image.");
    if(body&&body.length>5000) return fail(res,400,"MESSAGE_TOO_LONG","Messages are limited to 5,000 characters.");
    if(req.body.reply_to_id){
      const reply=await query("SELECT id FROM messages WHERE id=$1 AND group_id=$2 AND deleted_at IS NULL",[req.body.reply_to_id,req.params.id]);
      if(!reply.rowCount) return fail(res,400,"INVALID_REPLY","Reply target is unavailable.");
    }
    const r=await query(
      `INSERT INTO messages(group_id,sender_id,body,image_url,reply_to_id)
       VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.id,req.user.id,body,image_url,req.body.reply_to_id||null]);
    await query("UPDATE groups SET updated_at=now() WHERE id=$1",[req.params.id]);
    res.status(201).json({data:{message:{...r.rows[0],display_name:req.user.display_name,avatar_url:req.user.avatar_url,reactions:[]}}});
  }catch(err){next(err);}
});
router.delete("/messages/:id",async(req,res,next)=>{
  try{
    const r=await query(
      `UPDATE messages m SET deleted_at=now()
       WHERE m.id=$1 AND m.deleted_at IS NULL AND
       (m.sender_id=$2 OR EXISTS(
         SELECT 1 FROM group_members gm WHERE gm.group_id=m.group_id AND gm.user_id=$2 AND gm.role='admin'
       ) OR EXISTS(SELECT 1 FROM users u WHERE u.id=$2 AND u.role='leader'))
       RETURNING m.id`,[req.params.id,req.user.id]);
    if(!r.rowCount) return fail(res,404,"NOT_FOUND_OR_FORBIDDEN","Message not found or you cannot delete it.");
    res.json({data:{success:true}});
  }catch(err){next(err);}
});
router.put("/messages/:id/reactions",async(req,res,next)=>{
  try{
    const emoji=req.body.emoji;
    if(!allowedEmoji.includes(emoji)) return fail(res,400,"INVALID_EMOJI","Reaction is not supported.");
    const m=await query("SELECT group_id FROM messages WHERE id=$1 AND deleted_at IS NULL",[req.params.id]);
    if(!m.rowCount || (!(await isMember(m.rows[0].group_id,req.user.id)) && req.user.role!=="leader")) return fail(res,404,"MESSAGE_NOT_FOUND","Message not found.");
    await query("INSERT INTO reactions(message_id,user_id,emoji) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",[req.params.id,req.user.id,emoji]);
    res.json({data:{success:true}});
  }catch(err){next(err);}
});
router.delete("/messages/:id/reactions/:emoji",async(req,res,next)=>{
  try{
    const emoji=decodeURIComponent(req.params.emoji);
    if(!allowedEmoji.includes(emoji)) return fail(res,400,"INVALID_EMOJI","Reaction is not supported.");
    await query("DELETE FROM reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3",[req.params.id,req.user.id,emoji]);
    res.json({data:{success:true}});
  }catch(err){next(err);}
});
export default router;
