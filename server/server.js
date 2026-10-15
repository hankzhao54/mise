// HTTP 层：登录、权限、操作记录，然后把请求转给 engine。自己不含业务逻辑。
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { all, connect, dbKind, get, ins, run, truncateBusiness, tx, withContext } from './db.js';
import * as E from './engine.js';
import * as A from './auth.js';
import { seed } from './seed.js';

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const deny = (m = '没有权限 permission denied') => { throw new HttpError(403, m); };

const app = express();
app.set('trust proxy', 1);   // Render 等平台在前面有一层代理，用它判断是否 https
app.get('/healthz', (_q, res) => res.send('ok'));   // 健康检查，不需要登录
app.use(express.json({ limit: '2mb' }));
// 每个请求一个上下文 (事务、配方目录缓存都挂在上面)
app.use((_q, _res, next) => withContext(() => next()));

const api = express.Router();
const int = (v) => (v == null || v === '' ? undefined : parseInt(v, 10));
const nul = (v) => (v === '' || v == null ? null : +v);
const range = (q) => [q.from || E.dayAdd(E.today(), -6), q.to || E.today()];
// J(fn)：fn 的返回值作为 JSON 返回；没有返回值就回 { ok: true }
const J = (fn) => async (q, res) => { const r = await fn(q, res); res.json(r === undefined ? { ok: true } : r); };

// ══════════ 登录 ══════════
const cookies = (q) => Object.fromEntries((q.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
const setCookie = (q, res, token, maxAge) => res.append('Set-Cookie',
  `${A.COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${q.secure ? '; Secure' : ''}`);

async function audit(q, summary) {
  await ins('INSERT INTO audit_log (ts,user_id,username,method,path,summary) VALUES (?,?,?,?,?,?)',
    E.now(), q.user?.id ?? null, q.user?.username ?? '', q.method, q.originalUrl.slice(0, 200), String(summary).slice(0, 600));
}
const scrub = (b) => JSON.stringify(b ?? {}, (k, v) => (/password/i.test(k) ? '***' : v));

api.post('/login', async (q, res) => {
  const username = String(q.body?.username || '').trim().toLowerCase(), password = String(q.body?.password || '');
  const key = `${q.ip}|${username}`;
  if (A.tooManyFailures(key)) throw new HttpError(429, '尝试次数太多，请 15 分钟后再试 too many attempts, try again in 15 minutes');
  const u = await get('SELECT * FROM users WHERE lower(username)=? AND active=1', username);
  if (!u || !(await A.checkPassword(password, u.password_hash))) {
    A.noteFailure(key);
    throw new HttpError(401, '用户名或密码不对 wrong username or password');
  }
  A.clearFailures(key);
  setCookie(q, res, await A.createSession(u.id), A.SESSION_DAYS * 86400);
  q.user = A.decorate(u);
  await audit(q, '登录 login');
  res.json(q.user);
});
api.post('/logout', async (q, res) => {
  await A.endSession(cookies(q)[A.COOKIE]);
  setCookie(q, res, '', 0);
  res.json({ ok: true });
});

// 之后的接口都要登录
api.use(async (q, _res, next) => {
  q.user = await A.sessionUser(cookies(q)[A.COOKIE]);
  if (!q.user) throw new HttpError(401, '请先登录 please sign in');
  next();
});

api.get('/me', (q, res) => res.json(q.user));
api.post('/me/password', J(async (q) => {
  const u = await get('SELECT * FROM users WHERE id=?', q.user.id);
  if (!(await A.checkPassword(q.body.old_password, u.password_hash))) throw new HttpError(400, '原密码不对 current password is wrong');
  if (!A.validPassword(q.body.new_password)) throw new HttpError(400, '新密码至少 8 位 new password needs at least 8 characters');
  await run('UPDATE users SET password_hash=? WHERE id=?', await A.hashPassword(q.body.new_password), q.user.id);
  // 其他设备上的登录全部失效，只保留当前这个
  await run('DELETE FROM sessions WHERE user_id=?', q.user.id);
  setCookie(q, q.res, await A.createSession(q.user.id), A.SESSION_DAYS * 86400);
}));

// ══════════ 权限 ══════════
// 1) 门店范围：请求里出现的门店 (查询参数 outlet、请求体 outlet_id / from_outlet) 必须在自己的范围内
const needOutlet = (q, id) => { if (id != null && id !== '' && !A.canOutlet(q.user, id)) deny('你没有这个门店的权限 no access to this outlet'); };
api.use((q, _res, next) => {
  needOutlet(q, q.query.outlet);
  if (q.body && typeof q.body === 'object') { needOutlet(q, q.body.outlet_id); needOutlet(q, q.body.from_outlet); }
  next();
});
// 2) 主数据 (供应商、原料与价格、配方、菜单、HACCP 控制点) 只有"可改主数据"的人能写
const MASTER = /^\/(suppliers|ingredients|recipes|menus|ccps)(\/|$)/;
api.use((q, _res, next) => {
  if (q.method !== 'GET' && MASTER.test(q.path) && !q.user.can_edit_master) deny('你没有修改主数据的权限 you cannot edit master data');
  next();
});
const approver = (q, _res, next) => { if (!q.user.can_approve) deny('你没有审批权限 you cannot approve orders'); next(); };
const adminOnly = (q, _res, next) => { if (q.user.role !== 'admin') deny('只有管理员可以 admins only'); next(); };
// 3) 按 id 操作的单据：先查它属于哪个门店
const own = (sql) => async (q, _res, next) => {
  const r = await get(sql, int(q.params.id));
  if (r && ![r.a, r.b].some((o) => o != null && A.canOutlet(q.user, o))) deny('你没有这个门店的权限 no access to this outlet');
  next();
};
const ownPO = own('SELECT outlet_id a FROM purchase_orders WHERE id=?');
const ownIO = own('SELECT outlet_id a, supplier_outlet_id b FROM internal_orders WHERE id=?');
const ownPlan = own('SELECT outlet_id a FROM production_plans WHERE id=?');
const ownCount = own('SELECT outlet_id a FROM stock_counts WHERE id=?');
const ownTask = own('SELECT outlet_id a FROM tasks WHERE id=?');
const ownPos = own('SELECT outlet_id a FROM pos_items WHERE id=?');
const ownPlanTask = own('SELECT p.outlet_id a FROM production_tasks t JOIN production_plans p ON p.id=t.plan_id WHERE t.id=?');
// 修改已有单据时 (请求体里带 id) 也要检查原单据的门店
const ownBody = (mw) => (q, res, next) => (q.body?.id ? mw({ ...q, params: { id: q.body.id } }, res, next) : next());

// 4) 操作记录：所有成功的写操作
api.use((q, res, next) => {
  if (q.method !== 'GET') res.on('finish', () => { if (res.statusCode < 400) audit(q, scrub(q.body)).catch((e) => console.error('audit', e.message)); });
  next();
});

// ══════════ 基础数据 ══════════
api.get('/meta', J(async (q) => {
  await E.ready();
  const [outlets, ingItems, recItems, ingComp, recComp, dishes] = [
    await all('SELECT * FROM outlets ORDER BY id'),
    await all("SELECT 'ingredient' item_type, id item_id, name_zh, name_en, base_unit unit FROM ingredients ORDER BY name_en"),
    await all("SELECT 'recipe' item_type, id item_id, name_zh, name_en, yield_unit unit FROM recipes WHERE kind='prep' AND stockable=1 ORDER BY name_en"),
    await all("SELECT 'ingredient' item_type, id item_id, name_zh, name_en, base_unit unit, waste_pct FROM ingredients ORDER BY name_en"),
    await all("SELECT 'recipe' item_type, id item_id, name_zh, name_en, yield_unit unit, stockable FROM recipes WHERE kind='prep' ORDER BY name_en"),
    await all("SELECT id, name_zh, name_en, sell_price FROM recipes WHERE kind='dish' ORDER BY id"),
  ];
  return {
    outlets,                                                         // 全部门店 (内部订货要选供应门店)
    my_outlets: outlets.filter((o) => A.canOutlet(q.user, o.id)).map((o) => o.id),   // 自己能操作的
    me: q.user, db: dbKind(),
    settings: E.settings(), units: E.UNIT_LIST,
    allergens: ['gluten', 'crustacean', 'egg', 'fish', 'peanut', 'soy', 'milk', 'nuts', 'celery', 'mustard', 'sesame', 'sulphite', 'lupin', 'mollusc'],
    items: [...ingItems, ...recItems],          // 库存品：原料 + 可入库的半成品
    components: [...ingComp, ...recComp],       // 配方里能用的：原料 + 所有半成品
    dishes, ccp_types: E.CCP_TYPES, task_types: E.TASK_TYPES,
  };
}));
api.put('/settings', adminOnly, J((q) => E.saveSettings(q.body)));

// ── 供应商
api.get('/suppliers', J(() => all('SELECT * FROM suppliers ORDER BY id')));
const supArgs = (b) => [b.name, b.contact || '', +b.lead_days || 0, +b.min_order || 0, +b.delivery_fee || 0, nul(b.approval_limit)];
api.post('/suppliers', J(async (q) => ({ id: await ins('INSERT INTO suppliers (name,contact,lead_days,min_order,delivery_fee,approval_limit) VALUES (?,?,?,?,?,?)', ...supArgs(q.body)) })));
api.put('/suppliers/:id', J(async (q) => { await run('UPDATE suppliers SET name=?, contact=?, lead_days=?, min_order=?, delivery_fee=?, approval_limit=? WHERE id=?', ...supArgs(q.body), int(q.params.id)); }));
api.delete('/suppliers/:id', J(async (q) => { await run('DELETE FROM suppliers WHERE id=?', int(q.params.id)); }));

// ── 原料 + 包装
api.get('/ingredients', J(async () => {
  await E.ready();
  const pk = await all('SELECT p.*, s.name supplier_name FROM packages p JOIN suppliers s ON s.id=p.supplier_id ORDER BY p.price/p.pack_qty, p.id');
  return (await all('SELECT * FROM ingredients ORDER BY category, name_en')).map((i) => ({
    ...i, allergens: JSON.parse(i.allergens), unit_cost: E.ingredientUnitCost(i.id), costing_package_id: E.costingPackage(i.id)?.id,
    packages: pk.filter((p) => p.ingredient_id === i.id) }));
}));
api.get('/ingredients/:id/prices', J((q) => all(
  `SELECT h.*, p.label, s.name supplier_name FROM package_prices h JOIN packages p ON p.id=h.package_id JOIN suppliers s ON s.id=p.supplier_id
   WHERE p.ingredient_id=? ORDER BY h.ts DESC LIMIT 100`, int(q.params.id))));
function saveIngredient(id, b) {
  return tx(async () => {
    const args = [b.name_zh, b.name_en || b.name_zh, b.category || '', b.base_unit, JSON.stringify(b.allergens || []), nul(b.waste_pct)];
    if (id) await run('UPDATE ingredients SET name_zh=?, name_en=?, category=?, base_unit=?, allergens=?, waste_pct=? WHERE id=?', ...args, id);
    else id = await ins('INSERT INTO ingredients (name_zh,name_en,category,base_unit,allergens,waste_pct) VALUES (?,?,?,?,?,?)', ...args);
    const pk = b.packages || [];
    const keep = pk.filter((p) => p.id).map((p) => p.id);
    for (const old of await all('SELECT id FROM packages WHERE ingredient_id=?', id))
      if (!keep.includes(old.id)) await run('DELETE FROM packages WHERE id=?', old.id);
    for (const p of pk) {
      if (!(+p.pack_qty > 0)) E.fail('包装含量必须大于 0 pack size must be > 0');
      const a = [p.supplier_id, p.label || '', p.article_no || '', +p.pack_qty, +p.price || 0, p.orderable === false || p.orderable === 0 ? 0 : 1];
      let pid = p.id;
      const before = pid ? (await get('SELECT price FROM packages WHERE id=?', pid))?.price : null;
      if (pid) await run('UPDATE packages SET supplier_id=?, label=?, article_no=?, pack_qty=?, price=?, orderable=? WHERE id=?', ...a, pid);
      else pid = await ins('INSERT INTO packages (supplier_id,label,article_no,pack_qty,price,orderable,ingredient_id) VALUES (?,?,?,?,?,?,?)', ...a, id);
      if (before !== (+p.price || 0)) await ins('INSERT INTO package_prices (package_id,ts,price,source) VALUES (?,?,?,?)', pid, E.now(), +p.price || 0, before == null ? '初始' : '手工改价');
    }
    await E.refresh();
    return id;
  });
}
api.post('/ingredients', J(async (q) => ({ id: await saveIngredient(null, q.body) })));
api.put('/ingredients/:id', J(async (q) => ({ id: await saveIngredient(int(q.params.id), q.body) })));
api.delete('/ingredients/:id', J(async (q) => { await run('DELETE FROM ingredients WHERE id=?', int(q.params.id)); }));

// ── 配方
api.get('/recipes', J(async () => {
  await E.ready();
  const memo = new Map();
  return (await all('SELECT id FROM recipes ORDER BY kind DESC, id')).map((r) => {
    const { lines, method, ...c } = E.recipeCost(r.id, memo);
    return { ...c, line_count: lines.length };
  });
}));
api.get('/recipes/:id', J(async (q) => {
  await E.ready();
  const id = int(q.params.id);
  return { ...E.recipeCost(id), used_in: await all('SELECT DISTINCT r.id, r.name_zh, r.name_en FROM recipe_lines l JOIN recipes r ON r.id=l.recipe_id WHERE l.sub_recipe_id=?', id) };
}));
api.get('/recipes/:id/bom', J((q) => { needOutlet(q, q.query.outlet); return E.bom(int(q.query.outlet), int(q.params.id), +q.query.portions || 0); }));
function saveRecipe(id, b) {
  return tx(async () => {
    const dish = b.kind === 'dish';
    if (!(+b.yield_qty > 0)) E.fail('产出量必须大于 0 yield must be > 0');
    const args = [b.name_zh, b.name_en || b.name_zh, b.kind, dish ? 0 : b.stockable ? 1 : 0, b.category || '', +b.yield_qty, dish ? 'portion' : b.yield_unit,
      +b.sell_price || 0, nul(b.vat_pct), nul(b.target_margin), +b.prep_min || 0, +b.cook_min || 0, +b.plate_min || 0, nul(b.shelf_life_days), b.method || ''];
    if (id) await run('UPDATE recipes SET name_zh=?, name_en=?, kind=?, stockable=?, category=?, yield_qty=?, yield_unit=?, sell_price=?, vat_pct=?, target_margin=?, prep_min=?, cook_min=?, plate_min=?, shelf_life_days=?, method=? WHERE id=?', ...args, id);
    else id = await ins('INSERT INTO recipes (name_zh,name_en,kind,stockable,category,yield_qty,yield_unit,sell_price,vat_pct,target_margin,prep_min,cook_min,plate_min,shelf_life_days,method) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', ...args);
    await run('DELETE FROM recipe_lines WHERE recipe_id=?', id);
    for (const l of b.lines || [])
      await ins('INSERT INTO recipe_lines (recipe_id,ingredient_id,sub_recipe_id,qty,unit,waste_pct) VALUES (?,?,?,?,?,?)',
        id, l.item_type === 'ingredient' ? l.item_id : null, l.item_type === 'recipe' ? l.item_id : null, +l.qty || 0, l.unit, nul(l.waste_pct));
    // 算一遍成本：单位不兼容或循环引用会在这里抛错，整个保存回滚
    await E.refresh();
    E.recipeCost(id);
    for (const p of await all('SELECT DISTINCT recipe_id FROM recipe_lines WHERE sub_recipe_id=?', id)) E.recipeCost(p.recipe_id);
    return id;
  });
}
api.post('/recipes', J(async (q) => ({ id: await saveRecipe(null, q.body) })));
api.put('/recipes/:id', J(async (q) => ({ id: await saveRecipe(int(q.params.id), q.body) })));
api.delete('/recipes/:id', J(async (q) => { await run('DELETE FROM recipes WHERE id=?', int(q.params.id)); }));

// ── 菜单
api.get('/menus', J(() => E.listMenus()));
api.post('/menus', J(async (q) => ({ id: await E.saveMenu(q.body) })));
api.put('/menus/:id', J(async (q) => ({ id: await E.saveMenu({ ...q.body, id: int(q.params.id) }) })));
api.delete('/menus/:id', J(async (q) => { await E.deleteMenu(int(q.params.id)); }));

// ══════════ 库存 ══════════
api.get('/stock', J((q) => E.stockList(int(q.query.outlet))));
api.get('/stock/moves', J((q) => all('SELECT * FROM stock_moves WHERE outlet_id=? AND item_type=? AND item_id=? ORDER BY ts DESC, id DESC LIMIT 200',
  int(q.query.outlet), q.query.item_type, int(q.query.item_id))));
api.get('/stock/lots', J((q) => E.lotsOf(int(q.query.outlet), q.query.item_type, int(q.query.item_id))));
api.post('/stock/waste', J(async (q) => ({ ref: await E.waste({ ...q.body, qty: +q.body.qty }) })));
api.post('/stock/par', J(async (q) => { await E.setPar(q.body); }));
api.get('/transfers', J((q) => E.listTransfers(q.user.allowed)));
api.post('/transfers', J(async (q) => ({ id: await E.transfer({ ...q.body, qty: +q.body.qty }) })));
api.get('/lots', J((q) => E.recentLots(int(q.query.outlet))));
api.get('/trace', J((q) => E.trace(String(q.query.lot || ''))));

// ── 盘点
api.get('/counts', J((q) => all(`SELECT c.*, (SELECT COUNT(*) FROM count_subs s WHERE s.count_id=c.id) subs,
  (SELECT COALESCE(SUM((l.counted-l.expected)*l.unit_cost),0) FROM count_lines l WHERE l.count_id=c.id) variance_value
  FROM stock_counts c WHERE outlet_id=? ORDER BY id DESC`, int(q.query.outlet))));
api.post('/counts', J(async (q) => ({ id: await E.createCount(q.body.outlet_id) })));
api.get('/counts/:id', ownCount, J((q) => E.getCount(int(q.params.id))));
api.post('/counts/:id/subs', ownCount, J(async (q) => ({ id: await E.addSubCount(int(q.params.id), q.body.name) })));
api.put('/counts/:id/subs/:sid', ownCount, J(async (q) => { await E.saveSubCount(int(q.params.id), int(q.params.sid), q.body.entries); }));
api.post('/counts/:id/confirm', ownCount, J(async (q) => { await E.confirmCount(int(q.params.id)); }));
api.delete('/counts/:id', ownCount, J(async (q) => { await run("DELETE FROM stock_counts WHERE id=? AND status='open'", int(q.params.id)); }));

// ══════════ 采购 ══════════
api.get('/orders/suggestions', J((q) => (q.query.mode === 'forecast'
  ? E.forecastSuggestions(int(q.query.outlet), { days: q.query.days, source: q.query.source, scale: q.query.scale,
      use_stock: q.query.use_stock !== '0', use_outstanding: q.query.use_outstanding !== '0' })
  : E.parSuggestions(int(q.query.outlet)))));
api.get('/orders', J((q) => E.listPOs(int(q.query.outlet))));
api.post('/orders', J(async (q) => ({ id: await E.createPO(q.body, q.user.display_name) })));
api.post('/orders/:id/submit', ownPO, J((q) => E.submitPO(int(q.params.id))));
api.post('/orders/:id/approve', ownPO, approver, J(async (q) => { await E.approvePO(int(q.params.id), q.body.note, q.user.display_name); }));
api.post('/orders/:id/reject', ownPO, approver, J(async (q) => { await E.rejectPO(int(q.params.id), q.body.reason, q.user.display_name); }));
api.post('/orders/:id/recall', ownPO, J(async (q) => { await E.recallPO(int(q.params.id)); }));
api.post('/orders/:id/receive', ownPO, J(async (q) => { await E.receivePO(int(q.params.id), q.body); }));
api.put('/orders/:id/invoice', ownPO, J(async (q) => { await E.saveInvoice(int(q.params.id), q.body); }));
api.delete('/orders/:id', ownPO, J(async (q) => { await E.deletePO(int(q.params.id)); }));

// ── 内部订货 (下单门店和供货门店两边都能看到)
api.get('/internal', J((q) => E.listInternalOrders(int(q.query.outlet))));
api.get('/internal/demand', J((q) => E.incomingDemand(int(q.query.outlet))));
api.post('/internal', J(async (q) => ({ id: await E.createInternalOrder(q.body) })));
api.post('/internal/:id/pick', ownIO, J(async (q) => { await E.pickInternalOrder(int(q.params.id), q.body); }));
api.post('/internal/:id/ship', ownIO, J(async (q) => { await E.shipInternalOrder(int(q.params.id)); }));
api.post('/internal/:id/receive', ownIO, J(async (q) => { await E.receiveInternalOrder(int(q.params.id)); }));
api.delete('/internal/:id', ownIO, J(async (q) => { await E.deleteInternalOrder(int(q.params.id)); }));

// ══════════ 生产计划 ══════════
api.get('/plans', J((q) => E.listPlans(int(q.query.outlet))));
api.get('/plans/suggestions', J((q) => E.productionSuggestions(int(q.query.outlet))));
api.get('/plans/subs', J((q) => E.subRecipeNeeds(int(q.query.outlet), int(q.query.recipe_id), +q.query.qty || 0)));
api.post('/plans', ownBody(ownPlan), J(async (q) => ({ id: await E.savePlan(q.body) })));
api.post('/plans/tasks/:id/status', ownPlanTask, J(async (q) => { await E.setTaskStatus(int(q.params.id), q.body.status); }));
api.get('/plans/:id', ownPlan, J((q) => E.getPlan(int(q.params.id))));
api.post('/plans/:id/activate', ownPlan, J(async (q) => { await E.activatePlan(int(q.params.id)); }));
api.post('/plans/:id/all-done', ownPlan, J(async (q) => { await E.markAllDone(int(q.params.id)); }));
api.post('/plans/:id/finish', ownPlan, J((q) => E.finishPlan(int(q.params.id), q.body.outputs || [])));
api.delete('/plans/:id', ownPlan, J(async (q) => { await E.deletePlan(int(q.params.id)); }));

// ══════════ 任务与 HACCP ══════════
api.get('/ccps', J(() => E.listCcps()));
api.post('/ccps', J(async (q) => ({ id: await E.saveCcp(q.body) })));
api.delete('/ccps/:id', J(async (q) => { await E.deleteCcp(int(q.params.id)); }));
api.get('/tasks', J((q) => E.listTasks(int(q.query.outlet))));
api.get('/tasks/occurrences', J((q) => E.occurrences(int(q.query.outlet), q.query.from || E.today(), q.query.to || q.query.from || E.today())));
api.get('/tasks/report', J((q) => E.taskReport(int(q.query.outlet), ...range(q.query))));
api.post('/tasks', ownBody(ownTask), J(async (q) => ({ id: await E.saveTask(q.body) })));
api.post('/tasks/:id/complete', ownTask, J((q) => E.completeTask(int(q.params.id), { ...q.body, done_by: q.body.done_by || q.user.display_name })));
api.delete('/tasks/:id', ownTask, J(async (q) => { await E.deleteTask(int(q.params.id)); }));

// ══════════ 销售 ══════════
api.get('/pos', J((q) => E.posItems(int(q.query.outlet))));
api.post('/pos/:id/link', ownPos, J((q) => E.linkPos(int(q.params.id), q.body.recipe_id || null)));
api.post('/pos/:id/ignore', ownPos, J(async (q) => { await E.ignorePos(int(q.params.id), q.body.ignored); }));
api.get('/sales', J((q) => E.salesLog(int(q.query.outlet), ...range(q.query))));
api.post('/sales/pos', J((q) => E.importPosSales(q.body.outlet_id, q.body.rows || [])));
api.post('/sales/manual', J(async (q) => {
  for (const r of q.body.rows || []) needOutlet(q, r.outlet_id);
  return { count: await E.recordManualSales(q.body.rows || []) };
}));

// ══════════ 报表 ══════════
api.get('/reports/sales', J((q) => E.salesDashboard(int(q.query.outlet), ...range(q.query))));
api.get('/reports/menu', J((q) => E.menuEngineering(int(q.query.outlet), ...range(q.query))));
api.get('/reports/management', J(async (q) => ({
  one: await E.managementFigures(int(q.query.outlet), ...range(q.query)),
  all: await E.managementAllOutlets(...range(q.query), q.user.allowed) })));
api.get('/reports/stock-period', J((q) => E.stockPeriod(int(q.query.outlet), ...range(q.query))));
api.get('/reports/variance', J((q) => E.countVariance(int(q.query.outlet), ...range(q.query))));
api.get('/reports/waste', J((q) => E.wasteReport(int(q.query.outlet), ...range(q.query))));
api.get('/dashboard', J((q) => E.dashboard(int(q.query.outlet))));

// ══════════ 管理员：账号、门店、操作记录、数据 ══════════
const admin = express.Router();
admin.use(adminOnly);
const USERNAME = /^[a-z0-9_.-]{2,32}$/;
function userArgs(b) {
  const username = String(b.username || '').trim().toLowerCase();
  if (!USERNAME.test(username)) E.fail('用户名 2–32 位，只能用小写字母、数字和 _ . - username: 2–32 chars, a-z 0-9 _ . -');
  if (!['admin', 'manager'].includes(b.role)) E.fail('角色不对 invalid role');
  const outlets = (b.outlets || []).map(Number).filter(Boolean);
  return [username, String(b.display_name || '').trim() || username, b.role, JSON.stringify(outlets), b.can_approve ? 1 : 0, b.can_edit_master ? 1 : 0, b.active === false ? 0 : 1];
}
// 至少要留一个启用状态的管理员，免得把自己锁在外面
async function keepAnAdmin() {
  if (!(await get("SELECT COUNT(*) n FROM users WHERE role='admin' AND active=1")).n) E.fail('至少要保留一个启用的管理员 at least one active admin is required');
}
admin.get('/users', J(() => A.listUsers()));
admin.post('/users', J(async (q) => {
  if (!A.validPassword(q.body.password)) E.fail('密码至少 8 位 password needs at least 8 characters');
  const a = userArgs(q.body);
  if (await get('SELECT id FROM users WHERE lower(username)=?', a[0])) E.fail('用户名已存在 username already taken');
  return { id: await ins('INSERT INTO users (username,display_name,role,outlets,can_approve,can_edit_master,active,password_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    ...a, await A.hashPassword(q.body.password), E.now()) };
}));
admin.put('/users/:id', J(async (q) => tx(async () => {
  const id = int(q.params.id);
  const a = userArgs(q.body);
  if (await get('SELECT id FROM users WHERE lower(username)=? AND id<>?', a[0], id)) E.fail('用户名已存在 username already taken');
  await run('UPDATE users SET username=?, display_name=?, role=?, outlets=?, can_approve=?, can_edit_master=?, active=? WHERE id=?', ...a, id);
  if (q.body.password) {
    if (!A.validPassword(q.body.password)) E.fail('密码至少 8 位 password needs at least 8 characters');
    await run('UPDATE users SET password_hash=? WHERE id=?', await A.hashPassword(q.body.password), id);
  }
  // 停用或重置密码后，这个人已有的登录全部失效
  if (q.body.password || a[6] === 0) await run('DELETE FROM sessions WHERE user_id=?', id);
  await keepAnAdmin();
})));
admin.delete('/users/:id', J(async (q) => tx(async () => {
  if (int(q.params.id) === q.user.id) E.fail('不能删除自己 you cannot delete yourself');
  await run('DELETE FROM users WHERE id=?', int(q.params.id));
  await keepAnAdmin();
})));

const outletArgs = (b) => {
  if (!String(b.name_zh || b.name_en || '').trim()) E.fail('门店名称必填 name is required');
  return [b.name_zh || b.name_en, b.name_en || b.name_zh, b.kind === 'central_kitchen' ? 'central_kitchen' : 'restaurant', b.is_supplier ? 1 : 0];
};
admin.post('/outlets', J(async (q) => ({ id: await ins('INSERT INTO outlets (name_zh,name_en,kind,is_supplier) VALUES (?,?,?,?)', ...outletArgs(q.body)) })));
admin.put('/outlets/:id', J(async (q) => { await run('UPDATE outlets SET name_zh=?, name_en=?, kind=?, is_supplier=? WHERE id=?', ...outletArgs(q.body), int(q.params.id)); }));
admin.delete('/outlets/:id', J(async (q) => { await run('DELETE FROM outlets WHERE id=?', int(q.params.id)); }));

admin.get('/audit', J((q) => all(`SELECT * FROM audit_log WHERE (?::int IS NULL OR user_id=?) ORDER BY id DESC LIMIT ?`,
  int(q.query.user) ?? null, int(q.query.user) ?? null, Math.min(int(q.query.limit) || 200, 1000))));
// 清空业务数据 (账号、设置、操作记录保留)；demo=true 时再装入示例数据
admin.post('/reset', J(async (q) => {
  await tx(async () => {
    await truncateBusiness();
    if (q.body?.demo) await seed();
  });
  await E.refresh();
}));
api.use('/admin', admin);

app.use('/api', api);
app.use('/api', (_q, res) => res.status(404).json({ error: 'not found' }));
// 统一错误处理：业务错误 400，权限 401/403，外键约束给可读的提示
app.use((err, _q, res, _next) => {
  const fk = err.code === '23503' || /foreign key/i.test(err.message);
  if (!err.status && !fk && !/[一-鿿]/.test(err.message)) console.error(err);   // 非业务错误打到日志里
  res.status(err.status || 400).json({ error: fk ? '仍被其他数据引用，无法删除 still referenced elsewhere' : err.message });
});

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
app.use(express.static(dist));

// ══════════ 启动 ══════════
await connect();
await withContext(async () => {
  await A.bootstrapAdmin();
  // 第一次启动时装入示例数据 (只装一次；之后管理员清空了也不会自己再装回来)。SEED_DEMO=0 关闭。
  if (!(await get("SELECT 1 x FROM settings WHERE key='demo_seeded'"))) {
    if (process.env.SEED_DEMO !== '0' && (await seed())) console.log('已装入示例数据 demo data loaded');
    await run("INSERT INTO settings (key,value) VALUES ('demo_seeded','true') ON CONFLICT (key) DO NOTHING");
  }
});
const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`Mise 已启动 (${dbKind() === 'postgres' ? 'PostgreSQL' : '内嵌 PGlite'}) → http://localhost:${port}`));
