import "dotenv/config";
import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { pool } from "./db.js";
import { seedLeader } from "./seed.js";
import { requireAuth, requireCsrf } from "./middleware/auth.js";
import { notFound, errorHandler } from "./middleware/errors.js";
import authRoutes from "./routes/auth.js";
import profileRoutes from "./routes/profile.js";
import groupRoutes from "./routes/groups.js";
import directRoutes from "./routes/direct.js";
import messageRoutes from "./routes/messages.js";
import adminRoutes from "./routes/admin.js";
import uploadRoutes from "./routes/upload.js";

const app=express();
const port=process.env.PORT||3000;
const here=path.dirname(fileURLToPath(import.meta.url));
const publicDir=path.resolve(here,"../public");

app.disable("x-powered-by");
app.set("trust proxy",1);
app.use(helmet({contentSecurityPolicy:{
  directives:{
    defaultSrc:["'self'"],
    scriptSrc:["'self'","https://cdn.tailwindcss.com"],
    styleSrc:["'self'","'unsafe-inline'","https://fonts.googleapis.com","https://cdn.jsdelivr.net"],
    fontSrc:["'self'","https://fonts.gstatic.com","https://cdn.jsdelivr.net"],
    imgSrc:["'self'","data:","blob:"],
    connectSrc:["'self'"],
    objectSrc:["'none'"],
    upgradeInsecureRequests: process.env.NODE_ENV==="production"?[]:null
  }
}}));
app.use(express.json({limit:"1mb"}));
app.use(cookieParser());
app.get("/health",(req,res)=>res.json({data:{status:"ok"}}));

const authLimiter=rateLimit({windowMs:60*1000,limit:10,standardHeaders:true,legacyHeaders:false,message:{error:{code:"RATE_LIMITED",message:"Too many attempts. Try again in a minute."}}});
app.use("/api/auth",authLimiter);
app.use("/api/auth",authRoutes);

app.use("/api",requireAuth,requireCsrf);
app.use("/api/me",profileRoutes);
app.use("/api/groups",groupRoutes);
app.use("/api",directRoutes);
app.use("/api",messageRoutes);
app.use("/api/admin",adminRoutes);
app.use("/api/upload",uploadRoutes);

app.get("/",(req,res)=>res.sendFile(path.join(publicDir,"index.html")));
app.get("/app",(req,res)=>res.sendFile(path.join(publicDir,"app.html")));
app.use(express.static(publicDir,{maxAge:process.env.NODE_ENV==="production"?"1d":0,etag:true}));
app.use(notFound);
app.use(errorHandler);

await seedLeader();
app.listen(port,()=>console.log(`Wazzup Messenger listening on ${port}`));

process.on("SIGTERM",async()=>{await pool.end();process.exit(0);});
