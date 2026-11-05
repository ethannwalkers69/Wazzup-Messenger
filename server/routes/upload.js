import { Router } from "express";
import multer from "multer";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fail } from "../middleware/errors.js";

const router=Router();
const here=path.dirname(fileURLToPath(import.meta.url));
const uploadDir=path.resolve(here,"../../public/uploads");
await fs.mkdir(uploadDir,{recursive:true});
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:10*1024*1024,files:1}});
function detect(buffer){
  if(buffer.subarray(0,3).toString("hex")==="ffd8ff") return "jpg";
  if(buffer.subarray(0,8).toString("hex")==="89504e470d0a1a0a") return "png";
  if(buffer.subarray(0,6).toString()==="GIF87a"||buffer.subarray(0,6).toString()==="GIF89a") return "gif";
  if(buffer.subarray(0,4).toString()==="RIFF"&&buffer.subarray(8,12).toString()==="WEBP") return "webp";
  return null;
}
router.post("/",(req,res,next)=>{
  upload.single("image")(req,res,async err=>{
    try{
      if(err){
        if(err.code==="LIMIT_FILE_SIZE") return fail(res,413,"FILE_TOO_LARGE","Image exceeds the upload limit.");
        return next(err);
      }
      if(!req.file) return fail(res,400,"NO_FILE","Choose an image first.");
      const ext=detect(req.file.buffer);
      const mimeMap={jpg:"image/jpeg",png:"image/png",gif:"image/gif",webp:"image/webp"};
      if(!ext||mimeMap[ext]!==req.file.mimetype) return fail(res,415,"INVALID_IMAGE","Only valid JPG, PNG, GIF, or WebP images are accepted.");
      const max=req.user.is_premium?10:2;
      if(req.file.size>max*1024*1024) return fail(res,413,"UPLOAD_LIMIT",`Your upload limit is ${max} MB.`);
      const name=`${crypto.randomUUID()}.${ext}`;
      await fs.writeFile(path.join(uploadDir,name),req.file.buffer,{flag:"wx"});
      res.status(201).json({data:{url:`/uploads/${name}`}});
    }catch(e){next(e);}
  });
});
export default router;
