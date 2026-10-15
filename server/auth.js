// 账号与登录：密码哈希 (scrypt)、会话 (随机令牌，库里只存它的哈希)、权限判断。
import { createHash, randomBytes, scrypt as _scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { all, get, ins, run } from './db.js';
import { localIso, now } from './engine.js';

const scrypt = promisify(_scrypt);
export const COOKIE = 'mise_sid';
export const SESSION_DAYS = 30;

// ── 密码 ── 存成 scrypt$盐$哈希
export async function hashPassword(pw) {
  const salt = randomBytes(16).toString('hex');
  const h = await scrypt(String(pw), salt, 64);
  return `scrypt$${salt}$${h.toString('hex')}`;
}
export async function checkPassword(pw, stored) {
  const [kind, salt, hex] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hex) return false;
  const h = await scrypt(String(pw), salt, 64);
  const want = Buffer.from(hex, 'hex');
  return want.length === h.length && timingSafeEqual(want, h);
}
export const validPassword = (pw) => typeof pw === 'string' && pw.length >= 8;

// ── 会话 ──
const sha = (s) => createHash('sha256').update(s).digest('hex');
export async function createSession(userId) {
  const token = randomBytes(32).toString('base64url');
  const exp = localIso(new Date(Date.now() + SESSION_DAYS * 864e5));
  await run('INSERT INTO sessions (token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)', sha(token), userId, now(), exp);
  await run('UPDATE users SET last_login_at=? WHERE id=?', now(), userId);
  await run('DELETE FROM sessions WHERE expires_at < ?', now());   // 顺手清理过期会话
  return token;
}
export const endSession = (token) => run('DELETE FROM sessions WHERE token_hash=?', sha(token || ''));
export async function sessionUser(token) {
  if (!token) return null;
  const u = await get(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
                       WHERE s.token_hash=? AND s.expires_at > ? AND u.active=1`, sha(token), now());
  return u ? decorate(u) : null;
}

// 用户对象：去掉密码哈希，解析门店范围。allowed = null 表示所有门店
export function decorate(u) {
  const outlets = JSON.parse(u.outlets || '[]').map(Number);
  const admin = u.role === 'admin';
  return { id: u.id, username: u.username, display_name: u.display_name || u.username, role: u.role, outlets, active: !!u.active,
    can_approve: admin || !!u.can_approve, can_edit_master: admin || !!u.can_edit_master,
    allowed: admin || !outlets.length ? null : outlets, created_at: u.created_at, last_login_at: u.last_login_at };
}
export const canOutlet = (u, id) => !u.allowed || u.allowed.includes(+id);

export const listUsers = async () => (await all('SELECT * FROM users ORDER BY id')).map(decorate);

// 第一次启动、还没有任何账号时，建一个管理员。
// 用户名/密码取环境变量 ADMIN_USER/ADMIN_PASSWORD (兼容旧的 BASIC_USER/BASIC_PASS)；都没有就随机生成并打印到日志。
export async function bootstrapAdmin() {
  if ((await get('SELECT COUNT(*) n FROM users')).n > 0) return null;
  const username = process.env.ADMIN_USER || process.env.BASIC_USER || 'admin';
  let password = process.env.ADMIN_PASSWORD || process.env.BASIC_PASS;
  const generated = !password;
  if (generated) password = randomBytes(9).toString('base64url');
  await ins("INSERT INTO users (username,display_name,role,password_hash,created_at) VALUES (?,?,'admin',?,?)",
    username, '管理员', await hashPassword(password), now());
  console.log(generated
    ? `已创建管理员账号 admin created → 用户名 ${username} / 临时密码 ${password} (登录后请修改)`
    : `已创建管理员账号 admin created → 用户名 ${username} (密码来自环境变量)`);
  return username;
}

// 登录失败限速：同一 IP+用户名 15 分钟内最多错 8 次
const fails = new Map();
export function tooManyFailures(key) {
  const f = fails.get(key);
  if (!f) return false;
  if (Date.now() - f.first > 15 * 60e3) { fails.delete(key); return false; }
  return f.n >= 8;
}
export function noteFailure(key) {
  const f = fails.get(key);
  if (!f || Date.now() - f.first > 15 * 60e3) fails.set(key, { first: Date.now(), n: 1 });
  else f.n++;
}
export const clearFailures = (key) => fails.delete(key);
