'use strict';
/**
 * Wazzup Messenger - server.js
 * Env vars (Render -> Environment):
 *   DATABASE_URL     Neon connection string
 *   JWT_SECRET       long random string
 *   LEADER_EMAIL     developer/admin email
 *   LEADER_PASSWORD  developer/admin password
 */
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) console.warn('[warn] JWT_SECRET is not set - logins will reset on every restart.');
const LEADER_EMAIL = (process.env.LEADER_EMAIL || '').trim().toLowerCase();
const LEADER_PASSWORD = process.env.LEADER_PASSWORD || '';
const OPERA_API = process.env.OPERA_API || 'https://betadash-api-swordslush-production.up.railway.app/opera';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : false,
  max: 10
});

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '12mb' }));
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'same-origin' });
  next();
});

/* ------------------------------------------------------------------ helpers */
const q = async (t, p = []) => (await pool.query(t, p)).rows;
const q1 = async (t, p = []) => (await q(t, p))[0];
const h = fn => (req, res) => fn(req, res).catch(e => {
  console.error(e);
  if (!res.headersSent) res.status(500).json({ error: 'Something went wrong. Please try again.' });
});
const REACTS = ['👍', '😆', '😢', '😲', '❤️', '😡'];
const sign = id => jwt.sign({ id }, JWT_SECRET, { expiresIn: '30d' });
const okImg = s => typeof s === 'string' && /^data:image\/(png|jpe?g|webp|gif);base64,/.test(s) && s.length < 4500000;
const safeEq = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest());
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

const UJ = a => `json_build_object('id',${a}.id,'uid',${a}.uid,'first_name',${a}.first_name,'last_name',${a}.last_name,'has_avatar',${a}.avatar IS NOT NULL,'avatar_v',${a}.avatar_v,'active',${a}.last_seen > now() - interval '45 seconds','is_admin',${a}.is_admin,'is_bot',${a}.is_bot)`;
const fu = u => u ? {
  id: u.id, uid: u.uid, first_name: u.first_name, last_name: u.last_name,
  name: (u.first_name + ' ' + (u.last_name || '')).trim(),
  avatar: u.has_avatar ? `/api/avatar/${u.id}?v=${u.avatar_v}` : null,
  active: !!u.active, is_admin: !!u.is_admin, bot: !!u.is_bot
} : null;

function sendImg(res, data, cache = 'private') {
  const m = data && /^data:(image\/[\w+.-]+);base64,([\s\S]*)$/.exec(data);
  if (!m) return res.status(404).end();
  res.set({ 'Content-Type': m[1], 'Cache-Control': `${cache}, max-age=86400` });
  res.send(Buffer.from(m[2], 'base64'));
}

const hits = new Map();
function limiter(req, res, next) {
  const now = Date.now();
  const arr = (hits.get(req.ip) || []).filter(t => now - t < 15 * 60 * 1000);
  if (arr.length >= 40) return bad(res, 'Too many attempts. Please try again in a few minutes.', 429);
  arr.push(now); hits.set(req.ip, arr); next();
}

async function newUid() {
  for (;;) {
    const uid = String(Math.floor(10000000 + Math.random() * 90000000));
    if (!(await q1('SELECT 1 FROM users WHERE uid=$1', [uid]))) return uid;
  }
}

async function auth(req, res, next) {
  try {
    const tok = (req.headers.authorization || '').replace('Bearer ', '') || req.query.t || '';
    const d = jwt.verify(tok, JWT_SECRET);
    const u = await q1(`SELECT id,uid,email,first_name,last_name,to_char(birthday,'YYYY-MM-DD') AS birthday,is_admin,banned,avatar_v,(avatar IS NOT NULL) AS has_avatar,bio,CASE WHEN note_at > now() - interval '24 hours' THEN note END AS note FROM users WHERE id=$1`, [d.id]);
    if (!u) return bad(res, 'Unauthorized', 401);
    if (u.banned) return bad(res, 'Your account has been banned.', 403);
    req.user = u; next();
  } catch (e) { bad(res, 'Unauthorized', 401); }
}
const adminOnly = (req, res, next) => req.user.is_admin ? next() : bad(res, 'Admins only.', 403);

const areFriends = async (a, b) => !!(await q1(`SELECT 1 FROM friendships WHERE status='accepted' AND ((requester=$1 AND addressee=$2) OR (requester=$2 AND addressee=$1))`, [a, b]));
const isBlocked = async (a, b) => !!(await q1(`SELECT 1 FROM blocks WHERE (blocker=$1 AND blocked=$2) OR (blocker=$2 AND blocked=$1)`, [a, b]));

async function notify(user, actor, type, postId = null, dedupe = false) {
  if (user === actor) return;
  if (dedupe) await q('DELETE FROM notifications WHERE user_id=$1 AND actor_id=$2 AND type=$3 AND post_id IS NOT DISTINCT FROM $4', [user, actor, type, postId]);
  await q('INSERT INTO notifications(user_id,actor_id,type,post_id) VALUES($1,$2,$3,$4)', [user, actor, type, postId]);
}

/* ------------------------------------------------------------------ typing indicator + Opera AI */
const typing = new Map(); // chatId -> Map(userId -> {ts,name,bot})
const setTyping = (chat, user, name, bot = false) => { let m = typing.get(chat); if (!m) typing.set(chat, m = new Map()); m.set(user, { ts: Date.now(), name, bot }); };
const clearTyping = (chat, user) => { const m = typing.get(chat); if (m) { m.delete(user); if (!m.size) typing.delete(chat); } };
setInterval(() => { const now = Date.now(); typing.forEach((m, c) => { m.forEach((v, u) => { if (now - v.ts > 90000) m.delete(u); }); if (!m.size) typing.delete(c); }); }, 60000).unref();

let OPERA_ID = 0;
const OPERA_RE = /@opera(?:\s?ai)?\b/i;
const OPERA_SVG = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#18181b"/><g fill="#a3e635"><circle cx="50" cy="29" r="15"/><circle cx="71" cy="50" r="15"/><circle cx="50" cy="71" r="15"/><circle cx="29" cy="50" r="15"/></g><circle cx="50" cy="50" r="10" fill="#18181b"/></svg>').toString('base64');
const operaLast = new Map();

function getJson(url, ms = 30000, depth = 0) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'WazzupMessenger/1.0', Accept: 'application/json' } }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && depth < 3) { r.resume(); return getJson(new URL(r.headers.location, url).href, ms, depth + 1).then(resolve, reject); }
      if (r.statusCode >= 400) { r.resume(); return reject(new Error('HTTP ' + r.statusCode)); }
      let b = ''; r.setEncoding('utf8');
      r.on('data', c => { b += c; if (b.length > 2e6) req.destroy(new Error('response too large')); });
      r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('bad json')); } });
    });
    req.setTimeout(ms, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function ensureOpera() {
  let u = await q1(`SELECT id FROM users WHERE email='opera@wazzup.bot'`);
  if (!u) u = await q1(`INSERT INTO users(uid,email,password_hash,first_name,last_name,birthday,avatar,is_bot) VALUES($1,'opera@wazzup.bot',$2,'Opera','AI','2000-01-01',$3,true) RETURNING id`,
    [await newUid(), await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10), OPERA_SVG]);
  else await q(`UPDATE users SET is_bot=true,banned=false,first_name='Opera',last_name='AI',avatar=$2,bio='AI assistant. Mention @opera in a group chat and ask me anything.' WHERE id=$1`, [u.id, OPERA_SVG]);
  OPERA_ID = u.id;
}

async function askOpera(chatId, msgId, raw) {
  const question = raw.replace(OPERA_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, 500) || 'hi';
  setTyping(chatId, OPERA_ID, 'Opera', true);
  let reply;
  try {
    const d = await getJson(`${OPERA_API}?ask=${encodeURIComponent(question)}`);
    reply = String((d && (d.message || d.response || d.answer)) || '').trim();
    if (!reply) throw new Error('empty reply');
  } catch (e) {
    console.error('[opera]', e.message);
    reply = "Sorry, I couldn't reach my brain right now. Please try again in a moment.";
  }
  clearTyping(chatId, OPERA_ID);
  if (!(await q1('SELECT 1 FROM chats WHERE id=$1', [chatId]))) return;
  await q('INSERT INTO messages(chat_id,sender_id,content,reply_to) VALUES($1,$2,$3,$4)', [chatId, OPERA_ID, reply.slice(0, 4000), msgId]);
}

/* ------------------------------------------------------------------ schema */
async function init() {
  await pool.query(`
  CREATE TABLE IF NOT EXISTS users(
    id SERIAL PRIMARY KEY, uid TEXT UNIQUE NOT NULL, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
    first_name TEXT NOT NULL, last_name TEXT NOT NULL, birthday DATE, avatar TEXT, cover TEXT,
    avatar_v INT DEFAULT 0, cover_v INT DEFAULT 0, is_admin BOOLEAN DEFAULT false, banned BOOLEAN DEFAULT false,
    last_seen TIMESTAMPTZ DEFAULT now(), created_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE IF NOT EXISTS friendships(
    id SERIAL PRIMARY KEY, requester INT REFERENCES users(id) ON DELETE CASCADE, addressee INT REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT now(), UNIQUE(requester,addressee));
  CREATE TABLE IF NOT EXISTS blocks(
    blocker INT REFERENCES users(id) ON DELETE CASCADE, blocked INT REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY(blocker,blocked));
  CREATE TABLE IF NOT EXISTS posts(
    id SERIAL PRIMARY KEY, user_id INT REFERENCES users(id) ON DELETE CASCADE, content TEXT DEFAULT '', image TEXT,
    privacy TEXT DEFAULT 'public', shared_post_id INT REFERENCES posts(id) ON DELETE SET NULL, created_at TIMESTAMPTZ DEFAULT now());
  CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id);
  CREATE TABLE IF NOT EXISTS post_tags(post_id INT REFERENCES posts(id) ON DELETE CASCADE, user_id INT REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY(post_id,user_id));
  CREATE TABLE IF NOT EXISTS post_reactions(post_id INT REFERENCES posts(id) ON DELETE CASCADE, user_id INT REFERENCES users(id) ON DELETE CASCADE, type TEXT NOT NULL, PRIMARY KEY(post_id,user_id));
  CREATE TABLE IF NOT EXISTS comments(
    id SERIAL PRIMARY KEY, post_id INT REFERENCES posts(id) ON DELETE CASCADE, user_id INT REFERENCES users(id) ON DELETE CASCADE,
    parent_id INT REFERENCES comments(id) ON DELETE CASCADE, content TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now());
  CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
  CREATE TABLE IF NOT EXISTS comment_reactions(comment_id INT REFERENCES comments(id) ON DELETE CASCADE, user_id INT REFERENCES users(id) ON DELETE CASCADE, type TEXT NOT NULL, PRIMARY KEY(comment_id,user_id));
  CREATE TABLE IF NOT EXISTS notifications(
    id SERIAL PRIMARY KEY, user_id INT REFERENCES users(id) ON DELETE CASCADE, actor_id INT REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL, post_id INT REFERENCES posts(id) ON DELETE CASCADE, read BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT now());
  CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id);
  CREATE TABLE IF NOT EXISTS chats(
    id SERIAL PRIMARY KEY, type TEXT NOT NULL, name TEXT, picture TEXT, pic_v INT DEFAULT 0, dm_key TEXT UNIQUE,
    created_by INT REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE IF NOT EXISTS chat_members(
    chat_id INT REFERENCES chats(id) ON DELETE CASCADE, user_id INT REFERENCES users(id) ON DELETE CASCADE,
    role TEXT DEFAULT 'member', nickname TEXT, last_read INT DEFAULT 0, joined_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY(chat_id,user_id));
  CREATE TABLE IF NOT EXISTS messages(
    id SERIAL PRIMARY KEY, chat_id INT REFERENCES chats(id) ON DELETE CASCADE, sender_id INT REFERENCES users(id) ON DELETE CASCADE,
    content TEXT DEFAULT '', image TEXT, reply_to INT REFERENCES messages(id) ON DELETE SET NULL,
    unsent BOOLEAN DEFAULT false, system BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT now());
  CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id,id);
  CREATE TABLE IF NOT EXISTS message_reactions(message_id INT REFERENCES messages(id) ON DELETE CASCADE, user_id INT REFERENCES users(id) ON DELETE CASCADE, type TEXT NOT NULL, PRIMARY KEY(message_id,user_id));
  CREATE TABLE IF NOT EXISTS message_reports(
    id SERIAL PRIMARY KEY, message_id INT, reporter_id INT REFERENCES users(id) ON DELETE CASCADE, sender_id INT REFERENCES users(id) ON DELETE CASCADE,
    content TEXT, had_image BOOLEAN DEFAULT false, reason TEXT, created_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE IF NOT EXISTS announcements(id SERIAL PRIMARY KEY, text TEXT NOT NULL, active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT now());
  `);
  await pool.query(`
  ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT DEFAULT '';
  ALTER TABLE users ADD COLUMN IF NOT EXISTS note TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS note_at TIMESTAMPTZ;
  ALTER TABLE posts ADD COLUMN IF NOT EXISTS trashed_at TIMESTAMPTZ;
  ALTER TABLE posts ADD COLUMN IF NOT EXISTS edited BOOLEAN DEFAULT false;
  ALTER TABLE chat_members ADD COLUMN IF NOT EXISTS cleared INT DEFAULT 0;
  ALTER TABLE message_reports ADD COLUMN IF NOT EXISTS kind TEXT DEFAULT 'message';
  ALTER TABLE message_reports ADD COLUMN IF NOT EXISTS post_id INT;
  CREATE TABLE IF NOT EXISTS saved_posts(
    user_id INT REFERENCES users(id) ON DELETE CASCADE, post_id INT REFERENCES posts(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY(user_id,post_id));
  `);
  await pool.query(`
  ALTER TABLE users ADD COLUMN IF NOT EXISTS is_bot BOOLEAN DEFAULT false;
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS suggest TEXT;
  CREATE TABLE IF NOT EXISTS post_images(
    id SERIAL PRIMARY KEY, post_id INT REFERENCES posts(id) ON DELETE CASCADE, idx INT DEFAULT 0, image TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_post_images ON post_images(post_id,idx);
  CREATE TABLE IF NOT EXISTS message_hidden(
    message_id INT REFERENCES messages(id) ON DELETE CASCADE, user_id INT REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY(message_id,user_id));
  CREATE TABLE IF NOT EXISTS comment_hidden(
    comment_id INT REFERENCES comments(id) ON DELETE CASCADE, user_id INT REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY(comment_id,user_id));
  `);
  await pool.query(`
  CREATE TABLE IF NOT EXISTS groups(
    id SERIAL PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', privacy TEXT NOT NULL DEFAULT 'public',
    cover TEXT, cover_v INT DEFAULT 0, created_by INT REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE IF NOT EXISTS group_members(
    group_id INT REFERENCES groups(id) ON DELETE CASCADE, user_id INT REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member', status TEXT NOT NULL DEFAULT 'member', joined_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY(group_id,user_id));
  CREATE INDEX IF NOT EXISTS idx_gm_user ON group_members(user_id);
  ALTER TABLE posts ADD COLUMN IF NOT EXISTS group_id INT REFERENCES groups(id) ON DELETE CASCADE;
  CREATE INDEX IF NOT EXISTS idx_posts_group ON posts(group_id);
  ALTER TABLE chat_members ADD COLUMN IF NOT EXISTS muted BOOLEAN DEFAULT false;
  CREATE TABLE IF NOT EXISTS warnings(id SERIAL PRIMARY KEY, user_id INT REFERENCES users(id) ON DELETE CASCADE, message TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now(), seen_at TIMESTAMPTZ);
  CREATE TABLE IF NOT EXISTS user_follows(follower_id INT REFERENCES users(id) ON DELETE CASCADE, target_id INT REFERENCES users(id) ON DELETE CASCADE, created_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY(follower_id,target_id));
  `);
  await ensureOpera();
  for (const f of await q(`SELECT requester,addressee FROM friendships WHERE status='accepted'`)) await ensureDm(f.requester, f.addressee).catch(() => {});
  console.log('[db] schema ready');
}

/* ------------------------------------------------------------------ auth */
app.get('/api/stats', h(async (req, res) => {
  const r = await q1(`SELECT (SELECT count(*) FROM users WHERE NOT banned AND NOT is_bot)::int AS users,(SELECT count(*) FROM posts)::int AS posts,(SELECT count(*) FROM messages WHERE NOT system)::int AS messages`);
  res.set('Cache-Control', 'public, max-age=60'); res.json(r);
}));

app.post('/api/register', limiter, h(async (req, res) => {
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  const first = String(b.first_name || '').trim().slice(0, 40);
  const last = String(b.last_name || '').trim().slice(0, 40);
  const pw = String(b.password || '');
  if (!first) return bad(res, 'Enter your name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad(res, 'Enter a valid email address.');
  if (pw.length < 6) return bad(res, 'Password must be at least 6 characters.');
  const bd = b.birthday && !isNaN(Date.parse(b.birthday)) ? new Date(b.birthday) : null;
  if (!bd) return bad(res, 'Enter your birthday.');
  const age = (Date.now() - bd.getTime()) / 31557600000;
  if (age < 13 || age > 120) return bad(res, 'You must be at least 13 years old to join.');
  if (email === LEADER_EMAIL || (await q1('SELECT 1 FROM users WHERE email=$1', [email]))) return bad(res, 'That email is already registered.', 409);
  const hash = await bcrypt.hash(pw, 10);
  const av = okImg(b.avatar) ? b.avatar : null, cv = okImg(b.cover) ? b.cover : null;
  const u = await q1(`INSERT INTO users(uid,email,password_hash,first_name,last_name,birthday,avatar,cover) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [await newUid(), email, hash, first, last, String(b.birthday).slice(0, 10), av, cv]);
  res.json({ token: sign(u.id) });
}));

app.post('/api/login', limiter, h(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const pw = String(req.body.password || '');
  if (!email || !pw) return bad(res, 'Enter your email and password.');

  // Developer / leader account (from environment variables)
  if (LEADER_EMAIL && LEADER_PASSWORD && email === LEADER_EMAIL) {
    if (!safeEq(pw, LEADER_PASSWORD)) return bad(res, 'Incorrect email or password.', 401);
    const hash = await bcrypt.hash(pw, 10);
    let u = await q1('SELECT id FROM users WHERE email=$1', [email]);
    if (!u) {
      u = await q1(`INSERT INTO users(uid,email,password_hash,first_name,last_name,birthday,is_admin) VALUES($1,$2,$3,'Feivel','Heinrich','2000-01-01',true) RETURNING id`, [await newUid(), email, hash]);
    } else {
      await q(`UPDATE users SET is_admin=true,banned=false,first_name='Feivel',last_name='Heinrich',password_hash=$2 WHERE id=$1`, [u.id, hash]);
    }
    return res.json({ token: sign(u.id) });
  }

  const u = await q1('SELECT id,password_hash,banned FROM users WHERE email=$1', [email]);
  if (!u || !(await bcrypt.compare(pw, u.password_hash))) return bad(res, 'Incorrect email or password.', 401);
  if (u.banned) return bad(res, 'Your account has been banned.', 403);
  res.json({ token: sign(u.id) });
}));

const meJson = u => ({ ...fu(u), email: u.email, birthday: u.birthday, bio: u.bio || '', note: u.note || null });
app.get('/api/me', auth, h(async (req, res) => res.json(meJson(req.user))));

app.put('/api/me', auth, h(async (req, res) => {
  const b = req.body || {}, sets = [], vals = [];
  const add = (col, v) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
  if (b.first_name !== undefined) { const v = String(b.first_name).trim().slice(0, 40); if (!v) return bad(res, 'First name is required.'); add('first_name', v); }
  if (b.last_name !== undefined) add('last_name', String(b.last_name).trim().slice(0, 40));
  if (b.bio !== undefined) add('bio', String(b.bio).trim().slice(0, 160));
  if (b.birthday !== undefined) { if (isNaN(Date.parse(b.birthday))) return bad(res, 'Invalid birthday.'); add('birthday', String(b.birthday).slice(0, 10)); }
  if (b.avatar) { if (!okImg(b.avatar)) return bad(res, 'Invalid profile photo.'); add('avatar', b.avatar); sets.push('avatar_v=avatar_v+1'); }
  if (b.cover) { if (!okImg(b.cover)) return bad(res, 'Invalid cover photo.'); add('cover', b.cover); sets.push('cover_v=cover_v+1'); }
  if (b.remove_avatar && !b.avatar) { sets.push('avatar=NULL'); sets.push('avatar_v=avatar_v+1'); }
  if (b.remove_cover && !b.cover) { sets.push('cover=NULL'); sets.push('cover_v=cover_v+1'); }
  if (req.user.is_admin && (b.first_name !== undefined || b.last_name !== undefined)) { /* allowed */ }
  if (sets.length) { vals.push(req.user.id); await q(`UPDATE users SET ${sets.join(',')} WHERE id=$${vals.length}`, vals); }
  const u = await q1(`SELECT id,uid,email,first_name,last_name,to_char(birthday,'YYYY-MM-DD') AS birthday,is_admin,avatar_v,(avatar IS NOT NULL) AS has_avatar,bio,CASE WHEN note_at > now() - interval '24 hours' THEN note END AS note FROM users WHERE id=$1`, [req.user.id]);
  res.json(meJson(u));
}));

app.put('/api/me/note', auth, h(async (req, res) => {
  const note = String(req.body.note || '').trim().slice(0, 60);
  if (note) await q('UPDATE users SET note=$2,note_at=now() WHERE id=$1', [req.user.id, note]);
  else await q('UPDATE users SET note=NULL,note_at=NULL WHERE id=$1', [req.user.id]);
  res.json({ note: note || null });
}));

app.get('/api/avatar/:id', h(async (req, res) => {
  const u = await q1('SELECT avatar FROM users WHERE id=$1 AND NOT banned', [+req.params.id || 0]);
  sendImg(res, u && u.avatar, 'public');
}));
app.get('/api/cover/:id', h(async (req, res) => {
  const u = await q1('SELECT cover FROM users WHERE id=$1 AND NOT banned', [+req.params.id || 0]);
  sendImg(res, u && u.cover, 'public');
}));
app.get('/api/chatpic/:id', h(async (req, res) => {
  const c = await q1('SELECT picture FROM chats WHERE id=$1', [+req.params.id || 0]);
  sendImg(res, c && c.picture, 'public');
}));

/* heartbeat + counters + announcement */
app.get('/api/counts', auth, h(async (req, res) => {
  const me = req.user.id;
  await q('UPDATE users SET last_seen=now() WHERE id=$1', [me]);
  const r = await q1(`SELECT
    ((SELECT count(*) FROM notifications WHERE user_id=$1 AND NOT read)+(SELECT count(*) FROM warnings WHERE user_id=$1 AND seen_at IS NULL))::int AS notifs,
    (SELECT count(*) FROM friendships WHERE addressee=$1 AND status='pending')::int AS requests,
    (SELECT count(*) FROM messages m JOIN chat_members cm ON cm.chat_id=m.chat_id AND cm.user_id=$1 WHERE NOT cm.muted AND m.id>cm.last_read AND m.sender_id<>$1 AND NOT m.unsent AND NOT m.system)::int AS messages`, [me]);
  const a = await q1('SELECT id,text FROM announcements WHERE active ORDER BY id DESC LIMIT 1');
  res.json({ ...r, announcement: a || null });
}));

/* ------------------------------------------------------------------ users / profile */
app.get('/api/users/:id', auth, h(async (req, res) => {
  const me = req.user.id, id = +req.params.id || 0;
  const u = await q1(`SELECT u.is_bot,u.id,u.uid,u.first_name,u.last_name,to_char(u.birthday,'YYYY-MM-DD') AS birthday,u.created_at,(u.avatar IS NOT NULL) AS has_avatar,u.avatar_v,(u.cover IS NOT NULL) AS has_cover,u.cover_v,u.bio,CASE WHEN u.note_at > now() - interval '24 hours' THEN u.note END AS note,u.is_admin,u.banned,(u.last_seen > now() - interval '45 seconds') AS active FROM users u WHERE u.id=$1`, [id]);
  if (!u || u.banned) return bad(res, 'User not found.', 404);
  const blockedMe = await q1('SELECT 1 FROM blocks WHERE blocker=$1 AND blocked=$2', [id, me]);
  if (blockedMe) return bad(res, 'User not found.', 404);
  let relation = 'none';
  if (id === me) relation = 'self';
  else {
    const f = await q1('SELECT requester,addressee,status FROM friendships WHERE (requester=$1 AND addressee=$2) OR (requester=$2 AND addressee=$1)', [me, id]);
    if (f) relation = f.status === 'accepted' ? 'friends' : (f.requester === me ? 'outgoing' : 'incoming');
  }
  let followers = null;
  if (u.is_bot) {
    followers = (await q1('SELECT count(*)::int AS n FROM user_follows WHERE target_id=$1', [id])).n;
    relation = (await q1('SELECT 1 FROM user_follows WHERE follower_id=$1 AND target_id=$2', [me, id])) ? 'following' : 'follow';
  }
  const fc = await q1(`SELECT count(*)::int AS n FROM friendships WHERE status='accepted' AND (requester=$1 OR addressee=$1)`, [id]);
  const out = { ...fu(u), relation, bio: u.bio || '', note: u.note || null, friend_count: followers !== null ? followers : fc.n, joined: u.created_at, cover: u.has_cover ? `/api/cover/${u.id}?v=${u.cover_v}` : null };
  if (relation === 'self' || relation === 'friends') out.birthday = u.birthday;
  res.json(out);
}));

app.post('/api/users/:id/follow', auth, h(async (req, res) => {
  const me = req.user.id, id = +req.params.id || 0;
  const t = await q1('SELECT id FROM users WHERE id=$1 AND is_bot=true', [id]);
  if (!t) return bad(res, 'You can only follow Opera AI.', 400);
  const del = await q1('DELETE FROM user_follows WHERE follower_id=$1 AND target_id=$2 RETURNING 1', [me, id]);
  if (!del) await q('INSERT INTO user_follows(follower_id,target_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [me, id]);
  res.json({ following: !del });
}));

app.get('/api/notes', auth, h(async (req, res) => {
  const me = req.user.id;
  const rows = await q(`SELECT ${UJ('u')} AS "user",u.note,u.note_at FROM users u WHERE u.note IS NOT NULL AND u.note_at > now() - interval '24 hours' AND u.banned=false
    AND (u.id=$1 OR EXISTS(SELECT 1 FROM friendships f WHERE f.status='accepted' AND ((f.requester=$1 AND f.addressee=u.id) OR (f.requester=u.id AND f.addressee=$1))))
    AND NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.blocker=$1 AND b.blocked=u.id) OR (b.blocker=u.id AND b.blocked=$1)) ORDER BY u.note_at DESC LIMIT 30`, [me]);
  res.json({ notes: rows.map(r => ({ user: fu(r.user), note: r.note, created_at: r.note_at })) });
}));

app.get('/api/search', auth, h(async (req, res) => {
  const me = req.user.id, term = String(req.query.q || '').trim().replace(/[%_\\]/g, '').slice(0, 60);
  if (!term) return res.json({ users: [] });
  const rows = await q(`SELECT ${UJ('u')} AS "user" FROM users u WHERE u.banned=false AND NOT u.is_bot AND u.id<>$1 AND (btrim(u.first_name||' '||u.last_name) ILIKE $2 OR u.uid ILIKE $2)
    AND NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.blocker=$1 AND b.blocked=u.id) OR (b.blocker=u.id AND b.blocked=$1)) ORDER BY u.first_name LIMIT 25`, [me, '%' + term + '%']);
  res.json({ users: rows.map(r => fu(r.user)) });
}));

/* ------------------------------------------------------------------ friends */
app.get('/api/friends', auth, h(async (req, res) => {
  const me = req.user.id, search = String(req.query.q || '').trim();
  const rel = await q(`SELECT f.requester,f.addressee,f.status,${UJ('u')} AS "user" FROM friendships f JOIN users u ON u.id=CASE WHEN f.requester=$1 THEN f.addressee ELSE f.requester END WHERE (f.requester=$1 OR f.addressee=$1) AND u.banned=false`, [me]);
  const friends = [], incoming = [], outgoing = [];
  rel.forEach(r => {
    const u = fu(r.user);
    if (r.status === 'accepted') friends.push(u); else if (r.addressee === me) incoming.push(u); else outgoing.push(u);
  });
  friends.sort((a, b) => a.name.localeCompare(b.name));
  const params = [me];
  let where = `u.id<>$1 AND u.banned=false AND NOT u.is_bot AND NOT EXISTS(SELECT 1 FROM friendships f WHERE (f.requester=$1 AND f.addressee=u.id) OR (f.requester=u.id AND f.addressee=$1)) AND NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.blocker=$1 AND b.blocked=u.id) OR (b.blocker=u.id AND b.blocked=$1))`;
  if (search) { params.push('%' + search.replace(/[%_\\]/g, '') + '%'); where += ` AND (u.first_name||' '||u.last_name ILIKE $2 OR u.uid ILIKE $2)`; }
  const people = (await q(`SELECT ${UJ('u')} AS "user" FROM users u WHERE ${where} ORDER BY ${search ? 'u.first_name' : 'random()'} LIMIT 30`, params)).map(r => fu(r.user));
  res.json({ friends, incoming, outgoing, people });
}));

app.post('/api/friends/request', auth, h(async (req, res) => {
  const me = req.user.id, to = +req.body.user_id || 0;
  if (!to || to === me) return bad(res, 'Invalid user.');
  const t = await q1('SELECT id FROM users WHERE id=$1 AND NOT banned AND NOT is_bot', [to]);
  if (!t) return bad(res, 'User not found.', 404);
  if (await isBlocked(me, to)) return bad(res, "You can't send a request to this user.", 403);
  const ex = await q1('SELECT id,requester,status FROM friendships WHERE (requester=$1 AND addressee=$2) OR (requester=$2 AND addressee=$1)', [me, to]);
  if (ex) {
    if (ex.status === 'pending' && ex.requester === to) {
      await q(`UPDATE friendships SET status='accepted' WHERE id=$1`, [ex.id]);
      await ensureDm(me, to).catch(() => {});
      await notify(to, me, 'friend_accept', null, true);
      return res.json({ status: 'friends' });
    }
    return res.json({ status: ex.status === 'accepted' ? 'friends' : 'outgoing' });
  }
  await q('INSERT INTO friendships(requester,addressee) VALUES($1,$2)', [me, to]);
  await notify(to, me, 'friend_request', null, true);
  res.json({ status: 'outgoing' });
}));

app.post('/api/friends/accept', auth, h(async (req, res) => {
  const me = req.user.id, from = +req.body.user_id || 0;
  const r = await q1(`UPDATE friendships SET status='accepted' WHERE requester=$1 AND addressee=$2 AND status='pending' RETURNING id`, [from, me]);
  if (!r) return bad(res, 'Request not found.', 404);
  await q(`DELETE FROM notifications WHERE user_id=$1 AND actor_id=$2 AND type='friend_request'`, [me, from]);
  await ensureDm(from, me).catch(() => {});
  await notify(from, me, 'friend_accept', null, true);
  res.json({ ok: true });
}));

app.post('/api/friends/remove', auth, h(async (req, res) => {
  const me = req.user.id, other = +req.body.user_id || 0;
  await q('DELETE FROM friendships WHERE (requester=$1 AND addressee=$2) OR (requester=$2 AND addressee=$1)', [me, other]);
  await q(`DELETE FROM notifications WHERE type='friend_request' AND ((user_id=$1 AND actor_id=$2) OR (user_id=$2 AND actor_id=$1))`, [me, other]);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ blocks */
app.post('/api/blocks', auth, h(async (req, res) => {
  const other = +req.body.user_id || 0;
  if (!other || other === req.user.id) return bad(res, 'Invalid user.');
  await q('INSERT INTO blocks(blocker,blocked) VALUES($1,$2) ON CONFLICT DO NOTHING', [req.user.id, other]);
  res.json({ ok: true });
}));
app.delete('/api/blocks/:id', auth, h(async (req, res) => {
  await q('DELETE FROM blocks WHERE blocker=$1 AND blocked=$2', [req.user.id, +req.params.id || 0]);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ posts */
const GVIS = `(p.group_id IS NULL OR EXISTS(SELECT 1 FROM group_members gm WHERE gm.group_id=p.group_id AND gm.user_id=$1 AND gm.status='member') OR EXISTS(SELECT 1 FROM groups gg WHERE gg.id=p.group_id AND gg.privacy='public'))`;
const VIS = `(p.trashed_at IS NULL AND ${GVIS} AND ((p.user_id=$1 OR p.privacy='public' OR (p.privacy='friends' AND EXISTS(SELECT 1 FROM friendships f WHERE f.status='accepted' AND ((f.requester=$1 AND f.addressee=p.user_id) OR (f.requester=p.user_id AND f.addressee=$1))))) AND NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.blocker=$1 AND b.blocked=p.user_id) OR (b.blocker=p.user_id AND b.blocked=$1))))`;
const postImages = p => { const a = []; if (p.has_image) a.push(`/api/posts/${p.id}/image`); for (let i = 0; i < (p.image_count || 0); i++) a.push(`/api/posts/${p.id}/image/${i}`); return a; };
const fixPost = p => ({
  id: p.id, content: p.content, privacy: p.privacy, created_at: p.created_at, shared_post_id: p.shared_post_id, saved: !!p.saved, edited: !!p.edited,
  user: fu(p.user), tags: p.tags || [], reactions: p.reactions || {}, my_reaction: p.my_reaction || null,
  comment_count: p.comment_count, share_count: p.share_count, image: postImages(p)[0] || null, images: postImages(p), group: p.grp ? { id: p.grp.id, name: p.grp.name, cover: p.grp.cover ? `/api/groups/${p.grp.id}/cover?v=${p.grp.v}` : null, joined: p.grp.joined, pending: p.grp.pending } : null
});

async function loadPosts(me, where = 'TRUE', params = [], limit = 20) {
  const rows = await q(`SELECT p.id,p.content,p.privacy,p.created_at,p.shared_post_id,p.edited,(p.image IS NOT NULL) AS has_image,${UJ('u')} AS "user",
    (SELECT json_agg(json_build_object('id',t.id,'name',btrim(t.first_name||' '||t.last_name))) FROM post_tags pt JOIN users t ON t.id=pt.user_id WHERE pt.post_id=p.id) AS tags,
    (SELECT json_object_agg(type,n) FROM (SELECT type,count(*)::int AS n FROM post_reactions WHERE post_id=p.id GROUP BY type) x) AS reactions,
    (SELECT type FROM post_reactions WHERE post_id=p.id AND user_id=$1) AS my_reaction,
    EXISTS(SELECT 1 FROM saved_posts sp WHERE sp.post_id=p.id AND sp.user_id=$1) AS saved,
    (SELECT count(*) FROM comments WHERE post_id=p.id)::int AS comment_count,
    (SELECT count(*) FROM posts s WHERE s.shared_post_id=p.id)::int AS share_count,
    (SELECT count(*) FROM post_images WHERE post_id=p.id)::int AS image_count,
    (SELECT json_build_object('id',g.id,'name',g.name,'cover',(g.cover IS NOT NULL),'v',g.cover_v,'joined',EXISTS(SELECT 1 FROM group_members gm WHERE gm.group_id=g.id AND gm.user_id=$1 AND gm.status='member'),'pending',EXISTS(SELECT 1 FROM group_members gm WHERE gm.group_id=g.id AND gm.user_id=$1 AND gm.status='pending')) FROM groups g WHERE g.id=p.group_id) AS grp
    FROM posts p JOIN users u ON u.id=p.user_id
    WHERE u.banned=false AND ${VIS} AND ${where} ORDER BY p.id DESC LIMIT ${limit}`, [me, ...params]);
  const posts = rows.map(fixPost);
  const ids = [...new Set(posts.filter(p => p.shared_post_id).map(p => p.shared_post_id))];
  if (ids.length) {
    const orig = await loadPosts(me, 'p.id = ANY($2::int[])', [ids], ids.length);
    const map = new Map(orig.map(o => [o.id, o]));
    posts.forEach(p => { if (p.shared_post_id) p.shared = map.get(p.shared_post_id) || null; });
  }
  return posts;
}

app.get('/api/feed', auth, h(async (req, res) => {
  const params = []; let where = 'TRUE';
  if (req.query.group_id) { params.push(+req.query.group_id || 0); where += ` AND p.group_id=$${params.length + 1}`; } else if (req.query.user_id) where += ' AND p.group_id IS NULL';
  if (req.query.user_id) { params.push(+req.query.user_id || 0); where += ` AND p.user_id=$${params.length + 1}`; }
  if (req.query.before) { params.push(+req.query.before || 0); where += ` AND p.id<$${params.length + 1}`; }
  res.json({ posts: await loadPosts(req.user.id, where, params, 20) });
}));

app.get('/api/posts/:id', auth, h(async (req, res) => {
  const [post] = await loadPosts(req.user.id, 'p.id=$2', [+req.params.id || 0], 1);
  if (!post) return bad(res, 'This post is no longer available.', 404);
  res.json({ post });
}));

app.get('/api/posts/:id/image', auth, h(async (req, res) => {
  const r = await q1(`SELECT p.image FROM posts p JOIN users u ON u.id=p.user_id WHERE p.id=$2 AND u.banned=false AND ${VIS}`, [req.user.id, +req.params.id || 0]);
  sendImg(res, r && r.image);
}));

app.get('/api/posts/:id/image/:i', auth, h(async (req, res) => {
  const r = await q1(`SELECT pi.image FROM post_images pi JOIN posts p ON p.id=pi.post_id JOIN users u ON u.id=p.user_id WHERE p.id=$2 AND u.banned=false AND ${VIS} ORDER BY pi.idx,pi.id LIMIT 1 OFFSET $3`, [req.user.id, +req.params.id || 0, Math.max(0, +req.params.i || 0)]);
  sendImg(res, r && r.image);
}));

app.post('/api/posts', auth, h(async (req, res) => {
  const me = req.user.id, b = req.body || {};
  const content = String(b.content || '').trim().slice(0, 5000);
  let privacy = ['public', 'friends', 'me'].includes(b.privacy) ? b.privacy : 'public';
  let gid = null;
  if (b.group_id) {
    const gm = await gmem(+b.group_id || 0, me);
    if (!gm || gm.status !== 'member') return bad(res, 'Join this group to post in it.', 403);
    gid = +b.group_id; privacy = 'public';
  }
  const imgs = (Array.isArray(b.images) ? b.images : (b.image ? [b.image] : [])).filter(okImg).slice(0, 10);
  if (!content && !imgs.length) return bad(res, 'Write something or add a photo.');
  if (imgs.reduce((a, x) => a + x.length, 0) > 11e6) return bad(res, 'Those photos are too large. Try fewer photos.');
  const p = await q1('INSERT INTO posts(user_id,content,image,privacy,group_id) VALUES($1,$2,NULL,$3,$4) RETURNING id', [me, content, privacy, gid]);
  for (let i = 0; i < imgs.length; i++) await q('INSERT INTO post_images(post_id,idx,image) VALUES($1,$2,$3)', [p.id, i, imgs[i]]);
  const tags = [...new Set((Array.isArray(b.tags) ? b.tags : []).map(Number).filter(Boolean))].slice(0, 30);
  if (tags.length) {
    const ok = await q(`SELECT u.id FROM users u WHERE u.id=ANY($2::int[]) AND u.banned=false AND EXISTS(SELECT 1 FROM friendships f WHERE f.status='accepted' AND ((f.requester=$1 AND f.addressee=u.id) OR (f.requester=u.id AND f.addressee=$1)))`, [me, tags]);
    for (const t of ok) {
      await q('INSERT INTO post_tags(post_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [p.id, t.id]);
      if (privacy !== 'me') await notify(t.id, me, 'tag', p.id);
    }
  }
  const [post] = await loadPosts(me, 'p.id=$2', [p.id], 1);
  res.json({ post });
}));

app.delete('/api/posts/:id', auth, h(async (req, res) => {
  const id = +req.params.id || 0;
  const r = req.user.is_admin ? await q1('DELETE FROM posts WHERE id=$1 RETURNING id', [id]) : await q1('DELETE FROM posts WHERE id=$1 AND user_id=$2 RETURNING id', [id, req.user.id]);
  if (!r) return bad(res, 'Post not found.', 404);
  res.json({ ok: true });
}));

app.put('/api/posts/:id', auth, h(async (req, res) => {
  const me = req.user.id, id = +req.params.id || 0;
  const p = await q1('SELECT id,image,shared_post_id,(SELECT count(*) FROM post_images WHERE post_id=posts.id)::int AS n_img FROM posts WHERE id=$1 AND user_id=$2 AND trashed_at IS NULL', [id, me]);
  if (!p) return bad(res, 'You can only edit your own posts.', 403);
  const content = String(req.body.content || '').trim().slice(0, 5000);
  if (!content && !p.image && !p.n_img && !p.shared_post_id) return bad(res, 'Write something first.');
  const privacy = ['public', 'friends', 'me'].includes(req.body.privacy) ? req.body.privacy : null;
  await q('UPDATE posts SET content=$2,privacy=COALESCE($3,privacy),edited=true WHERE id=$1', [id, content, privacy]);
  const [post] = await loadPosts(me, 'p.id=$2', [id], 1);
  res.json({ post });
}));

app.post('/api/posts/:id/save', auth, h(async (req, res) => {
  const me = req.user.id, id = +req.params.id || 0;
  if (!(await canSee(me, id))) return bad(res, 'Post not found.', 404);
  const had = await q1('DELETE FROM saved_posts WHERE user_id=$1 AND post_id=$2 RETURNING post_id', [me, id]);
  if (!had) await q('INSERT INTO saved_posts(user_id,post_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [me, id]);
  res.json({ saved: !had });
}));

app.post('/api/posts/:id/trash', auth, h(async (req, res) => {
  const id = +req.params.id || 0;
  const r = req.user.is_admin ? await q1('UPDATE posts SET trashed_at=now() WHERE id=$1 RETURNING id', [id]) : await q1('UPDATE posts SET trashed_at=now() WHERE id=$1 AND user_id=$2 RETURNING id', [id, req.user.id]);
  if (!r) return bad(res, 'Post not found.', 404);
  res.json({ ok: true });
}));

app.post('/api/posts/:id/restore', auth, h(async (req, res) => {
  const r = await q1('UPDATE posts SET trashed_at=NULL WHERE id=$1 AND user_id=$2 RETURNING id', [+req.params.id || 0, req.user.id]);
  if (!r) return bad(res, 'Post not found.', 404);
  res.json({ ok: true });
}));

app.post('/api/posts/:id/report', auth, h(async (req, res) => {
  const me = req.user.id, id = +req.params.id || 0;
  const p = await canSee(me, id);
  if (!p) return bad(res, 'Post not found.', 404);
  if (p.user_id === me) return bad(res, "You can't report your own post.");
  const full = await q1('SELECT content,(image IS NOT NULL) AS had_image FROM posts WHERE id=$1', [id]);
  await q(`INSERT INTO message_reports(message_id,reporter_id,sender_id,content,had_image,reason,kind,post_id) VALUES(NULL,$1,$2,$3,$4,$5,'post',$6)`,
    [me, p.user_id, full.content, full.had_image, String(req.body.reason || '').trim().slice(0, 300), id]);
  res.json({ ok: true });
}));

app.get('/api/saved', auth, h(async (req, res) => {
  res.json({ posts: await loadPosts(req.user.id, 'p.id IN (SELECT post_id FROM saved_posts WHERE user_id=$1)', [], 50) });
}));

app.get('/api/trash', auth, h(async (req, res) => {
  res.json({ posts: await q('SELECT id,content,(image IS NOT NULL OR EXISTS(SELECT 1 FROM post_images pi WHERE pi.post_id=posts.id)) AS has_image,trashed_at,created_at FROM posts WHERE user_id=$1 AND trashed_at IS NOT NULL ORDER BY trashed_at DESC LIMIT 50', [req.user.id]) });
}));

app.post('/api/posts/:id/react', auth, h(async (req, res) => {
  const me = req.user.id, id = +req.params.id || 0, type = req.body.type;
  const p = await q1(`SELECT p.id,p.user_id FROM posts p JOIN users u ON u.id=p.user_id WHERE p.id=$2 AND u.banned=false AND ${VIS}`, [me, id]);
  if (!p) return bad(res, 'Post not found.', 404);
  if (!type) await q('DELETE FROM post_reactions WHERE post_id=$1 AND user_id=$2', [id, me]);
  else {
    if (!REACTS.includes(type)) return bad(res, 'Invalid reaction.');
    await q('INSERT INTO post_reactions(post_id,user_id,type) VALUES($1,$2,$3) ON CONFLICT (post_id,user_id) DO UPDATE SET type=$3', [id, me, type]);
    await notify(p.user_id, me, 'react', id, true);
  }
  res.json({ ok: true });
}));

app.post('/api/posts/:id/repost', auth, h(async (req, res) => {
  const me = req.user.id, id = +req.params.id || 0;
  const find = pid => q1(`SELECT p.id,p.user_id,p.privacy,p.shared_post_id,p.group_id FROM posts p JOIN users u ON u.id=p.user_id WHERE p.id=$2 AND u.banned=false AND ${VIS}`, [me, pid]);
  const o = await find(id);
  if (!o) return bad(res, 'Post not found.', 404);
  const root = o.shared_post_id ? await find(o.shared_post_id) : o;
  if (!root) return bad(res, 'The original post is no longer available.', 404);
  if (root.group_id || o.group_id) return bad(res, "Posts in groups can't be reposted.", 403);
  if (root.privacy !== 'public' && root.user_id !== me) return bad(res, 'Only public posts can be reposted.', 403);
  const rank = { public: 3, friends: 2, me: 1 }, want = ['public', 'friends', 'me'].includes(req.body.privacy) ? req.body.privacy : 'public';
  const privacy = rank[want] <= rank[root.privacy] ? want : root.privacy;
  const content = String(req.body.content || '').trim().slice(0, 5000);
  const p = await q1('INSERT INTO posts(user_id,content,privacy,shared_post_id) VALUES($1,$2,$3,$4) RETURNING id', [me, content, privacy, root.id]);
  await notify(root.user_id, me, 'repost', root.id);
  const [post] = await loadPosts(me, 'p.id=$2', [p.id], 1);
  res.json({ post });
}));

/* ------------------------------------------------------------------ comments */
async function loadComments(me, where, params) {
  const rows = await q(`SELECT c.id,c.post_id,c.parent_id,c.content,c.created_at,${UJ('u')} AS "user",
    (SELECT json_object_agg(type,n) FROM (SELECT type,count(*)::int AS n FROM comment_reactions WHERE comment_id=c.id GROUP BY type) x) AS reactions,
    (SELECT type FROM comment_reactions WHERE comment_id=c.id AND user_id=$1) AS my_reaction
    FROM comments c JOIN users u ON u.id=c.user_id WHERE u.banned=false AND ${where} ORDER BY c.id`, [me, ...params]);
  const hid = new Set((await q('SELECT comment_id FROM comment_hidden WHERE user_id=$1', [me])).map(r => r.comment_id));
  const by = new Map(rows.map(r => [r.id, r]));
  const isHid = r => { for (let n = r, i = 0; n && i < 50; n = by.get(n.parent_id), i++) if (hid.has(n.id)) return true; return false; };
  return rows.filter(r => !isHid(r)).map(c => ({ ...c, user: fu(c.user), reactions: c.reactions || {}, my_reaction: c.my_reaction || null }));
}
const canSee = (me, pid) => q1(`SELECT p.id,p.user_id FROM posts p JOIN users u ON u.id=p.user_id WHERE p.id=$2 AND u.banned=false AND ${VIS}`, [me, pid]);

app.get('/api/posts/:id/comments', auth, h(async (req, res) => {
  const pid = +req.params.id || 0;
  if (!(await canSee(req.user.id, pid))) return bad(res, 'Post not found.', 404);
  res.json({ comments: await loadComments(req.user.id, 'c.post_id=$2', [pid]) });
}));

app.post('/api/posts/:id/comments', auth, h(async (req, res) => {
  const me = req.user.id, pid = +req.params.id || 0;
  const p = await canSee(me, pid);
  if (!p) return bad(res, 'Post not found.', 404);
  const content = String(req.body.content || '').trim().slice(0, 2000);
  if (!content) return bad(res, 'Write a comment first.');
  let parent = null;
  if (req.body.parent_id) {
    parent = await q1('SELECT id,user_id FROM comments WHERE id=$1 AND post_id=$2', [+req.body.parent_id, pid]);
    if (!parent) return bad(res, 'Comment not found.', 404);
  }
  const c = await q1('INSERT INTO comments(post_id,user_id,parent_id,content) VALUES($1,$2,$3,$4) RETURNING id', [pid, me, parent ? parent.id : null, content]);
  if (parent) { await notify(parent.user_id, me, 'reply', pid); if (p.user_id !== parent.user_id) await notify(p.user_id, me, 'comment', pid); }
  else await notify(p.user_id, me, 'comment', pid);
  const [comment] = await loadComments(me, 'c.id=$2', [c.id]);
  res.json({ comment });
}));

app.post('/api/comments/:id/react', auth, h(async (req, res) => {
  const me = req.user.id, id = +req.params.id || 0, type = req.body.type;
  const c = await q1('SELECT id,post_id,user_id FROM comments WHERE id=$1', [id]);
  if (!c || !(await canSee(me, c.post_id))) return bad(res, 'Comment not found.', 404);
  if (!type) await q('DELETE FROM comment_reactions WHERE comment_id=$1 AND user_id=$2', [id, me]);
  else {
    if (!REACTS.includes(type)) return bad(res, 'Invalid reaction.');
    await q('INSERT INTO comment_reactions(comment_id,user_id,type) VALUES($1,$2,$3) ON CONFLICT (comment_id,user_id) DO UPDATE SET type=$3', [id, me, type]);
    await notify(c.user_id, me, 'comment_react', c.post_id, true);
  }
  res.json({ ok: true });
}));

app.delete('/api/comments/:id', auth, h(async (req, res) => {
  const c = await q1('SELECT c.id,c.user_id,p.user_id AS owner FROM comments c JOIN posts p ON p.id=c.post_id WHERE c.id=$1', [+req.params.id || 0]);
  if (!c) return bad(res, 'Comment not found.', 404);
  if (c.user_id !== req.user.id && c.owner !== req.user.id && !req.user.is_admin) return bad(res, 'Not allowed.', 403);
  await q('DELETE FROM comments WHERE id=$1', [c.id]);
  res.json({ ok: true });
}));

/* who reacted + comment hide/report */
app.get('/api/posts/:id/reactions', auth, h(async (req, res) => {
  const pid = +req.params.id || 0;
  if (!(await canSee(req.user.id, pid))) return bad(res, 'Post not found.', 404);
  const rows = await q(`SELECT pr.type,${UJ('u')} AS "user" FROM post_reactions pr JOIN users u ON u.id=pr.user_id WHERE pr.post_id=$1 AND u.banned=false ORDER BY u.first_name,u.id`, [pid]);
  res.json({ reactions: rows.map(r => ({ type: r.type, user: fu(r.user) })) });
}));
app.get('/api/comments/:id/reactions', auth, h(async (req, res) => {
  const c = await q1('SELECT id,post_id FROM comments WHERE id=$1', [+req.params.id || 0]);
  if (!c || !(await canSee(req.user.id, c.post_id))) return bad(res, 'Comment not found.', 404);
  const rows = await q(`SELECT cr.type,${UJ('u')} AS "user" FROM comment_reactions cr JOIN users u ON u.id=cr.user_id WHERE cr.comment_id=$1 AND u.banned=false ORDER BY u.first_name,u.id`, [c.id]);
  res.json({ reactions: rows.map(r => ({ type: r.type, user: fu(r.user) })) });
}));
app.post('/api/comments/:id/hide', auth, h(async (req, res) => {
  const c = await q1('SELECT id,post_id FROM comments WHERE id=$1', [+req.params.id || 0]);
  if (!c || !(await canSee(req.user.id, c.post_id))) return bad(res, 'Comment not found.', 404);
  await q('INSERT INTO comment_hidden(comment_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [c.id, req.user.id]);
  res.json({ ok: true });
}));
app.post('/api/comments/:id/report', auth, h(async (req, res) => {
  const c = await q1('SELECT id,post_id,user_id,content FROM comments WHERE id=$1', [+req.params.id || 0]);
  if (!c || !(await canSee(req.user.id, c.post_id))) return bad(res, 'Comment not found.', 404);
  if (c.user_id === req.user.id) return bad(res, "You can't report your own comment.");
  await q(`INSERT INTO message_reports(message_id,reporter_id,sender_id,content,had_image,reason,kind,post_id) VALUES(NULL,$1,$2,$3,false,$4,'comment',$5)`,
    [req.user.id, c.user_id, c.content, String(req.body.reason || '').trim().slice(0, 300), c.post_id]);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ notifications */
app.get('/api/notifications', auth, h(async (req, res) => {
  const rows = await q(`SELECT n.id,n.type,n.post_id,n.read,n.created_at,${UJ('a')} AS actor,left(p.content,90) AS snippet
    FROM notifications n JOIN users a ON a.id=n.actor_id LEFT JOIN posts p ON p.id=n.post_id WHERE n.user_id=$1 ORDER BY n.id DESC LIMIT 60`, [req.user.id]);
  const announcements = await q('SELECT id,text,created_at FROM announcements WHERE active ORDER BY id DESC LIMIT 10');
  res.json({ notifications: rows.map(n => ({ ...n, actor: fu(n.actor) })), announcements });
}));
app.delete('/api/notifications/:id', auth, h(async (req, res) => {
  await q('DELETE FROM notifications WHERE id=$1 AND user_id=$2', [+req.params.id || 0, req.user.id]);
  res.json({ ok: true });
}));
app.post('/api/notifications/:id/report', auth, h(async (req, res) => {
  const n = await q1(`SELECT n.id,n.type,n.post_id,n.actor_id,left(p.content,200) AS snippet FROM notifications n LEFT JOIN posts p ON p.id=n.post_id WHERE n.id=$1 AND n.user_id=$2`, [+req.params.id || 0, req.user.id]);
  if (!n) return bad(res, 'Notification not found.', 404);
  const text = `Notification (${n.type.replace(/_/g, ' ')})` + (n.snippet ? `: ${n.snippet}` : '');
  await q(`INSERT INTO message_reports(message_id,reporter_id,sender_id,content,had_image,reason,kind,post_id) VALUES(NULL,$1,$2,$3,false,$4,'notification',$5)`,
    [req.user.id, n.actor_id, text, String(req.body.reason || '').trim().slice(0, 300), n.post_id]);
  res.json({ ok: true });
}));
app.post('/api/notifications/read', auth, h(async (req, res) => {
  await q('UPDATE notifications SET read=true WHERE user_id=$1 AND NOT read', [req.user.id]);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ chats */
async function ensureDm(a, b) {
  const key = [a, b].sort((x, y) => x - y).join('-');
  if (await q1('SELECT id FROM chats WHERE dm_key=$1', [key])) return;
  const c = await q1(`INSERT INTO chats(type,dm_key,created_by) VALUES('dm',$1,$2) RETURNING id`, [key, a]);
  await q('INSERT INTO chat_members(chat_id,user_id) VALUES($1,$2),($1,$3)', [c.id, a, b]);
}
const memberOf = (chatId, uid) => q1('SELECT role,nickname,cleared,muted FROM chat_members WHERE chat_id=$1 AND user_id=$2', [chatId, uid]);
async function sysMsg(chatId, uid, text) {
  await q('INSERT INTO messages(chat_id,sender_id,content,system) VALUES($1,$2,$3,true)', [chatId, uid, text]);
}

app.get('/api/chats', auth, h(async (req, res) => {
  const me = req.user.id;
  const rows = await q(`SELECT c.id,c.type,c.name,(c.picture IS NOT NULL) AS has_pic,c.pic_v,c.created_at,
    (SELECT json_build_object('id',m.id,'sender_id',m.sender_id,'content',m.content,'has_image',m.image IS NOT NULL,'unsent',m.unsent,'system',m.system,'created_at',m.created_at) FROM messages m WHERE m.chat_id=c.id AND m.id>cm.cleared ORDER BY m.id DESC LIMIT 1) AS last,
    (SELECT count(*) FROM messages m WHERE m.chat_id=c.id AND m.id>cm.last_read AND m.sender_id<>$1 AND NOT m.unsent AND NOT m.system)::int AS unread,
    (SELECT json_agg(json_build_object('user',${UJ('u')},'nickname',cm2.nickname)) FROM chat_members cm2 JOIN users u ON u.id=cm2.user_id WHERE cm2.chat_id=c.id AND cm2.user_id<>$1) AS others,
    (SELECT count(*) FROM chat_members WHERE chat_id=c.id)::int AS member_count
    FROM chats c JOIN chat_members cm ON cm.chat_id=c.id AND cm.user_id=$1
    WHERE (cm.cleared=0 OR EXISTS(SELECT 1 FROM messages m2 WHERE m2.chat_id=c.id AND m2.id>cm.cleared))`, [me]);
  const chats = rows.map(c => {
    const others = (c.others || []).map(o => ({ ...fu(o.user), nickname: o.nickname }));
    const base = { id: c.id, type: c.type, last: c.last, unread: c.unread, member_count: c.member_count, created_at: c.created_at };
    if (c.type === 'dm') {
      const o = others[0];
      return { ...base, title: o ? (o.nickname || o.name) : 'Wazzup user', pic: o ? o.avatar : null, active: !!(o && o.active), verified: !!(o && o.is_admin), other_id: o ? o.id : null, avatar_id: o ? o.id : c.id };
    }
    return { ...base, title: c.name || others.map(o => o.first_name).slice(0, 3).join(', ') || 'Group chat', pic: c.has_pic ? `/api/chatpic/${c.id}?v=${c.pic_v}` : null, active: others.some(o => o.active), avatar_id: c.id };
  });
  chats.sort((a, b) => new Date((b.last && b.last.created_at) || b.created_at) - new Date((a.last && a.last.created_at) || a.created_at));
  res.json({ chats });
}));

app.post('/api/chats/dm', auth, h(async (req, res) => {
  const me = req.user.id, other = +req.body.user_id || 0;
  if (!other || other === me) return bad(res, 'Invalid user.');
  const key = [me, other].sort((a, b) => a - b).join('-');
  let c = await q1('SELECT id FROM chats WHERE dm_key=$1', [key]);
  if (!c) {
    if (!(await areFriends(me, other))) return bad(res, 'You can only message your friends.', 403);
    c = await q1(`INSERT INTO chats(type,dm_key,created_by) VALUES('dm',$1,$2) RETURNING id`, [key, me]);
    await q('INSERT INTO chat_members(chat_id,user_id) VALUES($1,$2),($1,$3)', [c.id, me, other]);
  }
  res.json({ id: c.id });
}));

app.post('/api/chats/group', auth, h(async (req, res) => {
  const me = req.user.id;
  const name = String(req.body.name || '').trim().slice(0, 60);
  const ids = [...new Set((Array.isArray(req.body.members) ? req.body.members : []).map(Number).filter(x => x && x !== me))].slice(0, 100);
  if (!ids.length) return bad(res, 'Pick at least one friend.');
  const ok = await q(`SELECT u.id FROM users u WHERE u.id=ANY($2::int[]) AND u.banned=false AND EXISTS(SELECT 1 FROM friendships f WHERE f.status='accepted' AND ((f.requester=$1 AND f.addressee=u.id) OR (f.requester=u.id AND f.addressee=$1)))`, [me, ids]);
  if (!ok.length) return bad(res, 'You can only add your friends.');
  const c = await q1(`INSERT INTO chats(type,name,created_by) VALUES('group',$1,$2) RETURNING id`, [name || null, me]);
  await q(`INSERT INTO chat_members(chat_id,user_id,role) VALUES($1,$2,'admin')`, [c.id, me]);
  for (const u of ok) await q('INSERT INTO chat_members(chat_id,user_id) VALUES($1,$2)', [c.id, u.id]);
  await sysMsg(c.id, me, `${req.user.first_name} created the group`);
  res.json({ id: c.id });
}));

app.get('/api/chats/:id', auth, h(async (req, res) => {
  const me = req.user.id, id = +req.params.id || 0;
  const mine = await memberOf(id, me);
  if (!mine) return bad(res, 'Conversation not found.', 404);
  const c = await q1('SELECT id,type,name,(picture IS NOT NULL) AS has_pic,pic_v FROM chats WHERE id=$1', [id]);
  const members = (await q(`SELECT cm.role,cm.nickname,${UJ('u')} AS "user" FROM chat_members cm JOIN users u ON u.id=cm.user_id WHERE cm.chat_id=$1 ORDER BY cm.joined_at,u.id`, [id]))
    .map(m => ({ role: m.role, nickname: m.nickname, user: fu(m.user) }));
  const others = members.filter(m => m.user.id !== me);
  const out = { id: c.id, type: c.type, name: c.name, members, my_role: mine.role, member_count: members.length, muted: !!mine.muted };
  if (c.type === 'dm') {
    const o = others[0];
    out.title = o ? (o.nickname || o.user.name) : 'Wazzup user';
    out.pic = o ? o.user.avatar : null; out.active = !!(o && o.user.active); out.verified = !!(o && o.user.is_admin); out.other_id = o ? o.user.id : null; out.avatar_id = o ? o.user.id : c.id;
    if (o) {
      out.blocked_by_me = !!(await q1('SELECT 1 FROM blocks WHERE blocker=$1 AND blocked=$2', [me, o.user.id]));
      out.blocked_me = !!(await q1('SELECT 1 FROM blocks WHERE blocker=$1 AND blocked=$2', [o.user.id, me]));
    }
  } else {
    out.title = c.name || others.map(o => o.user.first_name).slice(0, 3).join(', ') || 'Group chat';
    out.pic = c.has_pic ? `/api/chatpic/${c.id}?v=${c.pic_v}` : null;
    out.active = others.some(o => o.user.active); out.avatar_id = c.id;
  }
  res.json(out);
}));

app.get('/api/chats/:id/messages', auth, h(async (req, res) => {
  const me = req.user.id, id = +req.params.id || 0;
  const mm = await memberOf(id, me);
  if (!mm) return bad(res, 'Conversation not found.', 404);
  const limit = Math.min(Math.max(+req.query.limit || 60, 20), 500);
  const rows = await q(`SELECT * FROM (
    SELECT m.id,m.sender_id,m.content,(m.image IS NOT NULL) AS has_image,m.unsent,m.system,m.created_at,${UJ('s')} AS sender,
      (SELECT json_build_object('id',r.id,'content',r.content,'has_image',r.image IS NOT NULL,'unsent',r.unsent,'sender_id',r.sender_id) FROM messages r WHERE r.id=m.reply_to) AS reply,
      (SELECT json_object_agg(type,n) FROM (SELECT type,count(*)::int AS n FROM message_reactions WHERE message_id=m.id GROUP BY type) x) AS reactions,
      (SELECT type FROM message_reactions WHERE message_id=m.id AND user_id=$2) AS my_reaction,
      (SELECT json_agg(json_build_object('user_id',mr.user_id,'type',mr.type) ORDER BY mr.user_id) FROM message_reactions mr WHERE mr.message_id=m.id) AS reactors
    FROM messages m JOIN users s ON s.id=m.sender_id WHERE m.chat_id=$1 AND m.id>$4 AND NOT EXISTS(SELECT 1 FROM message_hidden mh WHERE mh.message_id=m.id AND mh.user_id=$2) ORDER BY m.id DESC LIMIT $3) t ORDER BY id`, [id, me, limit, mm.cleared || 0]);
  const messages = rows.map(m => ({
    id: m.id, sender_id: m.sender_id, sender: fu(m.sender), system: m.system, unsent: m.unsent, created_at: m.created_at,
    content: m.unsent ? '' : m.content, image: m.has_image && !m.unsent ? `/api/messages/${m.id}/image` : null,
    reply: m.reply || null, reactions: m.reactions || {}, my_reaction: m.my_reaction || null, reactors: m.reactors || []
  }));
  if (rows.length) await q('UPDATE chat_members SET last_read=GREATEST(last_read,$3) WHERE chat_id=$1 AND user_id=$2', [id, me, rows[rows.length - 1].id]);
  const reads = await q('SELECT user_id,last_read FROM chat_members WHERE chat_id=$1', [id]);
  res.json({ messages, reads });
}));

app.get('/api/messages/:id/image', auth, h(async (req, res) => {
  const r = await q1('SELECT m.image FROM messages m JOIN chat_members cm ON cm.chat_id=m.chat_id AND cm.user_id=$2 WHERE m.id=$1', [+req.params.id || 0, req.user.id]);
  sendImg(res, r && r.image);
}));

app.post('/api/chats/:id/messages', auth, h(async (req, res) => {
  const me = req.user.id, id = +req.params.id || 0;
  if (!(await memberOf(id, me))) return bad(res, 'Conversation not found.', 404);
  const c = await q1('SELECT type FROM chats WHERE id=$1', [id]);
  if (c.type === 'dm') {
    const o = await q1('SELECT user_id FROM chat_members WHERE chat_id=$1 AND user_id<>$2', [id, me]);
    if (!o || (await isBlocked(me, o.user_id))) return bad(res, "You can't send messages in this conversation.", 403);
  }
  const content = String(req.body.content || '').trim().slice(0, 4000);
  const image = okImg(req.body.image) ? req.body.image : null;
  if (!content && !image) return bad(res, 'Message is empty.');
  let reply = null;
  if (req.body.reply_to) { const r = await q1('SELECT id FROM messages WHERE id=$1 AND chat_id=$2', [+req.body.reply_to, id]); reply = r ? r.id : null; }
  const m = await q1('INSERT INTO messages(chat_id,sender_id,content,image,reply_to) VALUES($1,$2,$3,$4,$5) RETURNING id', [id, me, content, image, reply]);
  await q('UPDATE chat_members SET last_read=$3 WHERE chat_id=$1 AND user_id=$2', [id, me, m.id]);
  clearTyping(id, me);
  if (c.type === 'group' && OPERA_ID && content && OPERA_RE.test(content) && Date.now() - (operaLast.get(me) || 0) > 1500) {
    operaLast.set(me, Date.now());
    askOpera(id, m.id, content).catch(e => console.error('[opera]', e.message));
  }
  res.json({ id: m.id });
}));

app.post('/api/messages/:id/unsend', auth, h(async (req, res) => {
  const r = await q1(`UPDATE messages SET unsent=true,content='',image=NULL WHERE id=$1 AND sender_id=$2 AND NOT system RETURNING id`, [+req.params.id || 0, req.user.id]);
  if (!r) return bad(res, 'You can only unsend your own messages.', 403);
  res.json({ ok: true });
}));

app.post('/api/messages/:id/react', auth, h(async (req, res) => {
  const me = req.user.id, id = +req.params.id || 0, type = req.body.type;
  const m = await q1('SELECT m.id FROM messages m JOIN chat_members cm ON cm.chat_id=m.chat_id AND cm.user_id=$2 WHERE m.id=$1 AND NOT m.unsent AND NOT m.system', [id, me]);
  if (!m) return bad(res, 'Message not found.', 404);
  if (!type) await q('DELETE FROM message_reactions WHERE message_id=$1 AND user_id=$2', [id, me]);
  else {
    if (!REACTS.includes(type)) return bad(res, 'Invalid reaction.');
    await q('INSERT INTO message_reactions(message_id,user_id,type) VALUES($1,$2,$3) ON CONFLICT (message_id,user_id) DO UPDATE SET type=$3', [id, me, type]);
  }
  res.json({ ok: true });
}));

app.post('/api/messages/:id/report', auth, h(async (req, res) => {
  const me = req.user.id;
  const m = await q1('SELECT m.id,m.sender_id,m.content,(m.image IS NOT NULL) AS had_image FROM messages m JOIN chat_members cm ON cm.chat_id=m.chat_id AND cm.user_id=$2 WHERE m.id=$1 AND NOT m.system', [+req.params.id || 0, me]);
  if (!m) return bad(res, 'Message not found.', 404);
  if (m.sender_id === me) return bad(res, "You can't report your own message.");
  await q('INSERT INTO message_reports(message_id,reporter_id,sender_id,content,had_image,reason) VALUES($1,$2,$3,$4,$5,$6)',
    [m.id, me, m.sender_id, m.content, m.had_image, String(req.body.reason || '').trim().slice(0, 300)]);
  res.json({ ok: true });
}));

app.post('/api/messages/:id/hide', auth, h(async (req, res) => {
  const m = await q1('SELECT m.id FROM messages m JOIN chat_members cm ON cm.chat_id=m.chat_id AND cm.user_id=$2 WHERE m.id=$1', [+req.params.id || 0, req.user.id]);
  if (!m) return bad(res, 'Message not found.', 404);
  await q('INSERT INTO message_hidden(message_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [m.id, req.user.id]);
  res.json({ ok: true });
}));

app.put('/api/chats/:id/mute', auth, h(async (req, res) => {
  const id = +req.params.id || 0;
  if (!(await memberOf(id, req.user.id))) return bad(res, 'Conversation not found.', 404);
  await q('UPDATE chat_members SET muted=$3 WHERE chat_id=$1 AND user_id=$2', [id, req.user.id, !!req.body.muted]);
  res.json({ muted: !!req.body.muted });
}));
app.post('/api/chats/:id/unread', auth, h(async (req, res) => {
  const id = +req.params.id || 0, me = req.user.id;
  if (!(await memberOf(id, me))) return bad(res, 'Conversation not found.', 404);
  const l = await q1('SELECT max(id) AS id FROM messages WHERE chat_id=$1 AND sender_id<>$2 AND NOT unsent AND NOT system', [id, me]);
  if (!l || !l.id) return bad(res, 'There is nothing to mark as unread.');
  await q('UPDATE chat_members SET last_read=$3 WHERE chat_id=$1 AND user_id=$2', [id, me, l.id - 1]);
  res.json({ ok: true });
}));
app.post('/api/chats/:id/report', auth, h(async (req, res) => {
  const id = +req.params.id || 0, me = req.user.id;
  if (!(await memberOf(id, me))) return bad(res, 'Conversation not found.', 404);
  const c = await q1('SELECT name FROM chats WHERE id=$1', [id]);
  const t = await q1(`SELECT user_id FROM chat_members WHERE chat_id=$1 AND user_id<>$2 ORDER BY (role='admin') DESC,joined_at LIMIT 1`, [id, me]);
  await q(`INSERT INTO message_reports(message_id,reporter_id,sender_id,content,had_image,reason,kind) VALUES(NULL,$1,$2,$3,false,$4,'chat')`,
    [me, t ? t.user_id : me, 'Group chat: ' + ((c && c.name) || '#' + id), String((req.body || {}).reason || '').trim().slice(0, 300)]);
  res.json({ ok: true });
}));
app.post('/api/chats/:id/typing', auth, h(async (req, res) => {
  const id = +req.params.id || 0;
  if (!(await memberOf(id, req.user.id))) return bad(res, 'Conversation not found.', 404);
  setTyping(id, req.user.id, req.user.first_name);
  res.json({ ok: true });
}));
app.get('/api/chats/:id/typing', auth, h(async (req, res) => {
  const id = +req.params.id || 0;
  if (!(await memberOf(id, req.user.id))) return bad(res, 'Conversation not found.', 404);
  const now = Date.now(), out = [];
  (typing.get(id) || new Map()).forEach((v, uid) => { if (uid !== req.user.id && now - v.ts < (v.bot ? 45000 : 4500)) out.push({ id: uid, name: v.name, bot: v.bot }); });
  res.json({ typing: out });
}));

/* delete conversation (clears history for me only) */
app.post('/api/chats/:id/delete', auth, h(async (req, res) => {
  const me = req.user.id, id = +req.params.id || 0;
  if (!(await memberOf(id, me))) return bad(res, 'Conversation not found.', 404);
  const mx = (await q1('SELECT COALESCE(max(id),0)::int AS n FROM messages WHERE chat_id=$1', [id])).n;
  await q('UPDATE chat_members SET cleared=$3,last_read=GREATEST(last_read,$3) WHERE chat_id=$1 AND user_id=$2', [id, me, mx]);
  res.json({ ok: true });
}));

/* group settings */
app.put('/api/chats/:id', auth, h(async (req, res) => {
  const me = req.user.id, id = +req.params.id || 0;
  if (!(await memberOf(id, me))) return bad(res, 'Conversation not found.', 404);
  const c = await q1('SELECT type,name FROM chats WHERE id=$1', [id]);
  if (c.type !== 'group') return bad(res, 'Only group chats can be edited.');
  if (req.body.name !== undefined) {
    const name = String(req.body.name).trim().slice(0, 60);
    if (!name) return bad(res, 'Group name cannot be empty.');
    if (name !== c.name) { await q('UPDATE chats SET name=$2 WHERE id=$1', [id, name]); await sysMsg(id, me, `${req.user.first_name} renamed the group to "${name}"`); }
  }
  if (req.body.picture) {
    if (!okImg(req.body.picture)) return bad(res, 'Invalid image.');
    await q('UPDATE chats SET picture=$2,pic_v=pic_v+1 WHERE id=$1', [id, req.body.picture]);
    await sysMsg(id, me, `${req.user.first_name} changed the group photo`);
  }
  res.json({ ok: true });
}));

app.post('/api/chats/:id/members', auth, h(async (req, res) => {
  const me = req.user.id, id = +req.params.id || 0;
  if (!(await memberOf(id, me))) return bad(res, 'Conversation not found.', 404);
  const c = await q1('SELECT type FROM chats WHERE id=$1', [id]);
  if (c.type !== 'group') return bad(res, 'Not a group chat.');
  const ids = [...new Set((Array.isArray(req.body.user_ids) ? req.body.user_ids : []).map(Number).filter(Boolean))].slice(0, 100);
  const ok = await q(`SELECT u.id,u.first_name FROM users u WHERE u.id=ANY($2::int[]) AND u.banned=false AND NOT EXISTS(SELECT 1 FROM chat_members cm WHERE cm.chat_id=$3 AND cm.user_id=u.id) AND EXISTS(SELECT 1 FROM friendships f WHERE f.status='accepted' AND ((f.requester=$1 AND f.addressee=u.id) OR (f.requester=u.id AND f.addressee=$1)))`, [me, ids, id]);
  for (const u of ok) await q('INSERT INTO chat_members(chat_id,user_id) VALUES($1,$2)', [id, u.id]);
  if (ok.length) await sysMsg(id, me, `${req.user.first_name} added ${ok.map(u => u.first_name).join(', ')}`);
  res.json({ added: ok.length });
}));

app.put('/api/chats/:id/nickname', auth, h(async (req, res) => {
  const me = req.user.id, id = +req.params.id || 0, target = +req.body.user_id || 0;
  if (!(await memberOf(id, me)) || !(await memberOf(id, target))) return bad(res, 'Member not found.', 404);
  const nick = String(req.body.nickname || '').trim().slice(0, 40) || null;
  await q('UPDATE chat_members SET nickname=$3 WHERE chat_id=$1 AND user_id=$2', [id, target, nick]);
  res.json({ ok: true });
}));

app.post('/api/chats/:id/leave', auth, h(async (req, res) => {
  const me = req.user.id, id = +req.params.id || 0;
  const mine = await memberOf(id, me);
  if (!mine) return bad(res, 'Conversation not found.', 404);
  const c = await q1('SELECT type FROM chats WHERE id=$1', [id]);
  if (c.type !== 'group') return bad(res, "You can't leave a personal chat.");
  await q('DELETE FROM chat_members WHERE chat_id=$1 AND user_id=$2', [id, me]);
  const left = await q1('SELECT count(*)::int AS n FROM chat_members WHERE chat_id=$1', [id]);
  if (!left.n) await q('DELETE FROM chats WHERE id=$1', [id]);
  else {
    if (mine.role === 'admin') {
      const next = await q1(`SELECT user_id FROM chat_members WHERE chat_id=$1 ORDER BY (role='coadmin') DESC, joined_at LIMIT 1`, [id]);
      await q(`UPDATE chat_members SET role='admin' WHERE chat_id=$1 AND user_id=$2`, [id, next.user_id]);
    }
    await sysMsg(id, me, `${req.user.first_name} left the group`);
  }
  res.json({ ok: true });
}));

app.post('/api/chats/:id/coadmin', auth, h(async (req, res) => {
  const me = req.user.id, id = +req.params.id || 0, target = +req.body.user_id || 0;
  const mine = await memberOf(id, me);
  if (!mine || mine.role !== 'admin') return bad(res, 'Only the group admin can do that.', 403);
  const t = await memberOf(id, target);
  if (!t || t.role === 'admin') return bad(res, 'Member not found.', 404);
  const role = req.body.make ? 'coadmin' : 'member';
  await q('UPDATE chat_members SET role=$3 WHERE chat_id=$1 AND user_id=$2', [id, target, role]);
  const u = await q1('SELECT first_name FROM users WHERE id=$1', [target]);
  await sysMsg(id, me, role === 'coadmin' ? `${u.first_name} is now a co-admin` : `${u.first_name} is no longer a co-admin`);
  res.json({ ok: true });
}));

app.delete('/api/chats/:id/members/:uid', auth, h(async (req, res) => {
  const me = req.user.id, id = +req.params.id || 0, target = +req.params.uid || 0;
  const mine = await memberOf(id, me), t = await memberOf(id, target);
  if (!mine || !t || target === me) return bad(res, 'Member not found.', 404);
  const allowed = mine.role === 'admin' || (mine.role === 'coadmin' && t.role === 'member');
  if (!allowed || t.role === 'admin') return bad(res, "You don't have permission to remove this member.", 403);
  await q('DELETE FROM chat_members WHERE chat_id=$1 AND user_id=$2', [id, target]);
  const u = await q1('SELECT first_name FROM users WHERE id=$1', [target]);
  await sysMsg(id, me, `${req.user.first_name} removed ${u.first_name}`);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ groups */
const gmem = (gid, uid) => q1('SELECT role,status FROM group_members WHERE group_id=$1 AND user_id=$2', [gid, uid]);
const gstaff = async (gid, uid) => { const m = await gmem(gid, uid); return m && m.status === 'member' && (m.role === 'admin' || m.role === 'mod') ? m : null; };
const GCOLS = `g.id,g.name,g.description,g.privacy,(g.cover IS NOT NULL) AS has_cover,g.cover_v,g.created_at,(SELECT count(*) FROM group_members WHERE group_id=g.id AND status='member')::int AS member_count`;
const fg = g => ({ id: g.id, name: g.name, description: g.description || '', privacy: g.privacy, cover: g.has_cover ? `/api/groups/${g.id}/cover?v=${g.cover_v}` : null, member_count: g.member_count, created_at: g.created_at, my_role: g.my_role || null, my_status: g.my_status || null });

app.get('/api/groups', auth, h(async (req, res) => {
  const me = req.user.id, mine = req.query.tab !== 'discover', term = String(req.query.q || '').trim().replace(/[%_\\]/g, '').slice(0, 60);
  const params = [me]; let where = mine ? `gm.status='member'` : `(gm.status IS NULL OR gm.status='pending')`;
  if (term) { params.push('%' + term + '%'); where += ' AND g.name ILIKE $2'; }
  const rows = await q(`SELECT ${GCOLS},gm.role AS my_role,gm.status AS my_status FROM groups g LEFT JOIN group_members gm ON gm.group_id=g.id AND gm.user_id=$1 WHERE ${where} ORDER BY member_count DESC,g.id DESC LIMIT 50`, params);
  res.json({ groups: rows.map(fg) });
}));

app.post('/api/groups', auth, h(async (req, res) => {
  const me = req.user.id, b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 60), desc = String(b.description || '').trim().slice(0, 300);
  if (name.length < 2) return bad(res, 'Group name must be at least 2 characters.');
  const privacy = b.privacy === 'private' ? 'private' : 'public';
  const cover = okImg(b.cover) ? b.cover : null;
  const g = await q1('INSERT INTO groups(name,description,privacy,cover,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id', [name, desc, privacy, cover, me]);
  await q(`INSERT INTO group_members(group_id,user_id,role,status) VALUES($1,$2,'admin','member')`, [g.id, me]);
  res.json({ id: g.id });
}));

app.get('/api/groups/:id/cover', h(async (req, res) => {
  const g = await q1('SELECT cover FROM groups WHERE id=$1', [+req.params.id || 0]);
  sendImg(res, g && g.cover, 'public');
}));

app.get('/api/groups/:id', auth, h(async (req, res) => {
  const me = req.user.id, id = +req.params.id || 0;
  const g = await q1(`SELECT ${GCOLS},gm.role AS my_role,gm.status AS my_status,(SELECT count(*) FROM group_members WHERE group_id=g.id AND status='pending')::int AS pending_count FROM groups g LEFT JOIN group_members gm ON gm.group_id=g.id AND gm.user_id=$2 WHERE g.id=$1`, [id, me]);
  if (!g) return bad(res, 'Group not found.', 404);
  const isM = g.my_status === 'member', staff = isM && (g.my_role === 'admin' || g.my_role === 'mod');
  res.json({ ...fg(g), can_view: g.privacy === 'public' || isM, pending_count: staff ? g.pending_count : 0 });
}));

app.put('/api/groups/:id', auth, h(async (req, res) => {
  const id = +req.params.id || 0, m = await gmem(id, req.user.id), b = req.body || {};
  if (!m || m.status !== 'member' || m.role !== 'admin') return bad(res, 'Only the group admin can do that.', 403);
  const sets = [], vals = [];
  const add = (c, v) => { vals.push(v); sets.push(`${c}=$${vals.length}`); };
  if (b.name !== undefined) { const n = String(b.name).trim().slice(0, 60); if (n.length < 2) return bad(res, 'Group name must be at least 2 characters.'); add('name', n); }
  if (b.description !== undefined) add('description', String(b.description).trim().slice(0, 300));
  if (b.privacy !== undefined) add('privacy', b.privacy === 'private' ? 'private' : 'public');
  if (b.cover) { if (!okImg(b.cover)) return bad(res, 'Invalid cover photo.'); add('cover', b.cover); sets.push('cover_v=cover_v+1'); }
  if (sets.length) { vals.push(id); await q(`UPDATE groups SET ${sets.join(',')} WHERE id=$${vals.length}`, vals); }
  res.json({ ok: true });
}));

app.delete('/api/groups/:id', auth, h(async (req, res) => {
  const id = +req.params.id || 0, m = await gmem(id, req.user.id);
  if (!(m && m.status === 'member' && m.role === 'admin') && !req.user.is_admin) return bad(res, 'Only the group admin can do that.', 403);
  await q('DELETE FROM groups WHERE id=$1', [id]);
  res.json({ ok: true });
}));

app.post('/api/groups/:id/join', auth, h(async (req, res) => {
  const me = req.user.id, id = +req.params.id || 0;
  const g = await q1('SELECT id,privacy FROM groups WHERE id=$1', [id]);
  if (!g) return bad(res, 'Group not found.', 404);
  const ex = await gmem(id, me);
  if (ex) return res.json({ status: ex.status });
  const status = g.privacy === 'public' ? 'member' : 'pending';
  await q(`INSERT INTO group_members(group_id,user_id,role,status) VALUES($1,$2,'member',$3)`, [id, me, status]);
  res.json({ status });
}));

app.post('/api/groups/:id/leave', auth, h(async (req, res) => {
  const me = req.user.id, id = +req.params.id || 0, m = await gmem(id, me);
  if (!m) return res.json({ ok: true });
  await q('DELETE FROM group_members WHERE group_id=$1 AND user_id=$2', [id, me]);
  if (m.status === 'member' && m.role === 'admin') {
    const hasAdmin = await q1(`SELECT 1 FROM group_members WHERE group_id=$1 AND role='admin' AND status='member'`, [id]);
    if (!hasAdmin) {
      const next = await q1(`SELECT user_id FROM group_members WHERE group_id=$1 AND status='member' ORDER BY (role='mod') DESC,joined_at LIMIT 1`, [id]);
      if (next) await q(`UPDATE group_members SET role='admin' WHERE group_id=$1 AND user_id=$2`, [id, next.user_id]);
      else await q('DELETE FROM groups WHERE id=$1', [id]);
    }
  }
  res.json({ ok: true });
}));

app.get('/api/groups/:id/members', auth, h(async (req, res) => {
  const me = req.user.id, id = +req.params.id || 0;
  const g = await q1('SELECT privacy FROM groups WHERE id=$1', [id]);
  if (!g) return bad(res, 'Group not found.', 404);
  const m = await gmem(id, me), isM = !!m && m.status === 'member', staff = isM && (m.role === 'admin' || m.role === 'mod');
  if (g.privacy !== 'public' && !isM) return bad(res, 'Join this group to see its members.', 403);
  const rows = await q(`SELECT gm.role,gm.status,${UJ('u')} AS "user" FROM group_members gm JOIN users u ON u.id=gm.user_id WHERE gm.group_id=$1 AND u.banned=false AND (gm.status='member' OR $2::boolean) ORDER BY (gm.status='member') DESC,(gm.role='admin') DESC,(gm.role='mod') DESC,gm.joined_at`, [id, staff]);
  res.json({ members: rows.map(r => ({ role: r.role, status: r.status, user: fu(r.user) })), my_role: isM ? m.role : null });
}));

app.post('/api/groups/:id/members/:uid/approve', auth, h(async (req, res) => {
  const me = req.user.id, id = +req.params.id || 0, uid = +req.params.uid || 0;
  if (!(await gstaff(id, me))) return bad(res, 'Only group admins and moderators can do that.', 403);
  const r = await q1(`UPDATE group_members SET status='member' WHERE group_id=$1 AND user_id=$2 AND status='pending' RETURNING user_id`, [id, uid]);
  if (!r) return bad(res, 'Request not found.', 404);
  await notify(uid, me, 'group_approve', null, true);
  res.json({ ok: true });
}));

app.delete('/api/groups/:id/members/:uid', auth, h(async (req, res) => {
  const me = req.user.id, id = +req.params.id || 0, uid = +req.params.uid || 0;
  const mine = await gstaff(id, me), t = await gmem(id, uid);
  if (!mine || !t || uid === me) return bad(res, 'Member not found.', 404);
  if (t.role === 'admin' || (mine.role === 'mod' && t.role !== 'member')) return bad(res, "You don't have permission to remove this member.", 403);
  await q('DELETE FROM group_members WHERE group_id=$1 AND user_id=$2', [id, uid]);
  res.json({ ok: true });
}));

app.post('/api/groups/:id/members/:uid/role', auth, h(async (req, res) => {
  const me = req.user.id, id = +req.params.id || 0, uid = +req.params.uid || 0;
  const mine = await gmem(id, me), t = await gmem(id, uid);
  if (!mine || mine.status !== 'member' || mine.role !== 'admin') return bad(res, 'Only the group admin can do that.', 403);
  if (!t || t.status !== 'member' || t.role === 'admin') return bad(res, 'Member not found.', 404);
  await q('UPDATE group_members SET role=$3 WHERE group_id=$1 AND user_id=$2', [id, uid, req.body.make ? 'mod' : 'member']);
  res.json({ ok: true });
}));

app.post('/api/groups/:id/invite', auth, h(async (req, res) => {
  const me = req.user.id, id = +req.params.id || 0;
  const g = await q1('SELECT privacy FROM groups WHERE id=$1', [id]), m = await gmem(id, me);
  if (!g || !m || m.status !== 'member') return bad(res, 'Join this group first.', 403);
  if (g.privacy === 'private' && m.role === 'member') return bad(res, 'Only admins and moderators can invite to a private group.', 403);
  const ids = [...new Set((Array.isArray(req.body.user_ids) ? req.body.user_ids : []).map(Number).filter(Boolean))].slice(0, 100);
  const ok = await q(`SELECT u.id FROM users u WHERE u.id=ANY($2::int[]) AND u.banned=false AND EXISTS(SELECT 1 FROM friendships f WHERE f.status='accepted' AND ((f.requester=$1 AND f.addressee=u.id) OR (f.requester=u.id AND f.addressee=$1)))`, [me, ids]);
  let added = 0;
  for (const u of ok) { const r = await q1(`INSERT INTO group_members(group_id,user_id,role,status) VALUES($1,$2,'member','member') ON CONFLICT DO NOTHING RETURNING user_id`, [id, u.id]); if (r) added++; }
  res.json({ added });
}));

app.delete('/api/groups/:id/posts/:pid', auth, h(async (req, res) => {
  const id = +req.params.id || 0;
  if (!(await gstaff(id, req.user.id))) return bad(res, 'Only group admins and moderators can do that.', 403);
  const r = await q1('DELETE FROM posts WHERE id=$1 AND group_id=$2 RETURNING id', [+req.params.pid || 0, id]);
  if (!r) return bad(res, 'Post not found.', 404);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ admin / developer panel */
app.get('/api/admin/users', auth, adminOnly, h(async (req, res) => {
  const rows = await q(`SELECT ${UJ('u')} AS "user",u.email,u.banned,u.created_at FROM users u WHERE NOT u.is_bot ORDER BY u.id DESC LIMIT 500`);
  res.json({ users: rows.map(r => ({ ...fu(r.user), email: r.email, banned: r.banned, created_at: r.created_at })) });
}));
app.post('/api/admin/ban', auth, adminOnly, h(async (req, res) => {
  const id = +req.body.user_id || 0;
  const r = await q1('UPDATE users SET banned=$2 WHERE id=$1 AND NOT is_admin RETURNING id', [id, !!req.body.banned]);
  if (!r) return bad(res, 'Cannot change this account.', 400);
  res.json({ ok: true });
}));
app.delete('/api/admin/users/:id', auth, adminOnly, h(async (req, res) => {
  const r = await q1('DELETE FROM users WHERE id=$1 AND NOT is_admin RETURNING id', [+req.params.id || 0]);
  if (!r) return bad(res, 'Cannot delete this account.', 400);
  res.json({ ok: true });
}));
app.get('/api/admin/chats', auth, adminOnly, h(async (req, res) => {
  res.json({ chats: await q(`SELECT c.id,COALESCE(c.name,'Unnamed group') AS name,EXISTS(SELECT 1 FROM chat_members x WHERE x.chat_id=c.id AND x.user_id=$1) AS joined,(SELECT count(*) FROM chat_members WHERE chat_id=c.id)::int AS members,(SELECT count(*) FROM messages WHERE chat_id=c.id AND NOT system)::int AS messages,u.first_name||' '||u.last_name AS creator,c.created_at FROM chats c LEFT JOIN users u ON u.id=c.created_by WHERE c.type='group' ORDER BY c.id DESC LIMIT 300`, [req.user.id]) });
}));
app.post('/api/admin/chats/:id/join', auth, adminOnly, h(async (req, res) => {
  const me = req.user.id, id = +req.params.id || 0;
  const c = await q1(`SELECT id FROM chats WHERE id=$1 AND type='group'`, [id]);
  if (!c) return bad(res, 'Group not found.', 404);
  const ex = await memberOf(id, me);
  if (ex && ex.role === 'admin') return res.json({ id, already: true });
  await q(`INSERT INTO chat_members(chat_id,user_id,role) VALUES($1,$2,'admin') ON CONFLICT (chat_id,user_id) DO UPDATE SET role='admin'`, [id, me]);
  await sysMsg(id, me, `${req.user.first_name} joined as admin`);
  res.json({ id });
}));
app.delete('/api/admin/chats/:id', auth, adminOnly, h(async (req, res) => {
  await q(`DELETE FROM chats WHERE id=$1 AND type='group'`, [+req.params.id || 0]);
  res.json({ ok: true });
}));
app.get('/api/admin/announcement', auth, adminOnly, h(async (req, res) => {
  res.json({ announcement: (await q1('SELECT id,text,created_at FROM announcements WHERE active ORDER BY id DESC LIMIT 1')) || null });
}));
app.post('/api/admin/announcement', auth, adminOnly, h(async (req, res) => {
  const text = String(req.body.text || '').trim().slice(0, 500);
  if (!text) await q('UPDATE announcements SET active=false WHERE active');
  else await q('INSERT INTO announcements(text) VALUES($1)', [text]);
  res.json({ ok: true });
}));
app.get('/api/admin/reports', auth, adminOnly, h(async (req, res) => {
  const rows = await q(`SELECT r.id,r.message_id,r.kind,r.post_id,r.content,r.had_image,r.reason,r.created_at,${UJ('rp')} AS reporter,${UJ('sd')} AS sender FROM message_reports r JOIN users rp ON rp.id=r.reporter_id JOIN users sd ON sd.id=r.sender_id ORDER BY r.id DESC LIMIT 100`);
  res.json({ reports: rows.map(r => ({ ...r, reporter: fu(r.reporter), sender: fu(r.sender) })) });
}));
app.post('/api/admin/users/:id/warn', auth, adminOnly, h(async (req, res) => {
  const id = +req.params.id || 0, msg = String((req.body || {}).message || '').trim().slice(0, 300);
  if (!msg) return bad(res, 'Write a warning message.');
  const t = await q1('SELECT id FROM users WHERE id=$1 AND NOT is_bot', [id]);
  if (!t) return bad(res, 'User not found.', 404);
  await q('INSERT INTO warnings(user_id,message) VALUES($1,$2)', [id, msg]);
  res.json({ ok: true });
}));
app.get('/api/warnings', auth, h(async (req, res) => {
  res.json({ warnings: await q(req.query.all ? 'SELECT id,message,created_at,(seen_at IS NOT NULL) AS seen FROM warnings WHERE user_id=$1 ORDER BY id DESC LIMIT 20' : 'SELECT id,message,created_at FROM warnings WHERE user_id=$1 AND seen_at IS NULL ORDER BY id', [req.user.id]) });
}));
app.post('/api/warnings/seen', auth, h(async (req, res) => {
  await q('UPDATE warnings SET seen_at=now() WHERE user_id=$1 AND seen_at IS NULL', [req.user.id]);
  res.json({ ok: true });
}));
app.delete('/api/admin/reports/:id', auth, adminOnly, h(async (req, res) => {
  await q('DELETE FROM message_reports WHERE id=$1', [+req.params.id || 0]);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ static */
app.use('/api', (req, res) => bad(res, 'Not found', 404));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

init().then(() => app.listen(PORT, () => console.log(`Wazzup Messenger running on :${PORT}`)))
  .catch(e => { console.error('Failed to start:', e); process.exit(1); });
