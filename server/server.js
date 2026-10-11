// HTTP 层：把请求转给 engine，自己不含业务逻辑。
import express from 'express';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { all, get, ins, run, tx } from './db.js';
import * as E from './engine.js';
import { seed } from './seed.js';

seed();
const app = express();
app.get('/healthz', (_q, res) => res.send('ok'));   // 给托管平台做健康检查，不需要密码

// 访问密码 (HTTP Basic Auth)：设置了环境变量 BASIC_USER 和 BASIC_PASS 才启用。
// 本地运行不设，就不需要密码；放到公网时一定要设。
const { BASIC_USER, BASIC_PASS } = process.env;
if (BASIC_USER && BASIC_PASS) {
  const expected = Buffer.from(`${BASIC_USER}:${BASIC_PASS}`);
  app.use((q, res, next) => {
    const given = Buffer.from(Buffer.from((q.headers.authorization || '').replace(/^Basic /, ''), 'base64').toString());
    if (given.length === expected.length && timingSafeEqual(given, expected)) return next();
    res.set('WWW-Authenticate', 'Basic realm="Mise", charset="UTF-8"').status(401).send('需要密码 Authentication required');
  });
}
app.use(express.json({ limit: '2mb' }));
const api = express.Router();
const int = (v) => (v == null || v === '' ? undefined : parseInt(v, 10));
const nul = (v) => (v === '' || v == null ? null : +v);
const range = (q) => [q.from || E.dayAdd(E.today(), -6), q.to || E.today()];
const ok = (res) => res.json({ ok: true });

api.get('/meta', (_q, res) => res.json({
  outlets: all('SELECT * FROM outlets ORDER BY id'),
  settings: E.settings(), units: E.UNIT_LIST,
  allergens: ['gluten', 'crustacean', 'egg', 'fish', 'peanut', 'soy', 'milk', 'nuts', 'celery', 'mustard', 'sesame', 'sulphite', 'lupin', 'mollusc'],
  // 库存品：原料 + 可入库的半成品
  items: [
    ...all("SELECT 'ingredient' item_type, id item_id, name_zh, name_en, base_unit unit FROM ingredients ORDER BY name_en"),
    ...all("SELECT 'recipe' item_type, id item_id, name_zh, name_en, yield_unit unit FROM recipes WHERE kind='prep' AND stockable=1 ORDER BY name_en"),
  ],
  // 配方里能用的东西：原料 + 所有半成品 (含不可入库的)
  components: [
    ...all("SELECT 'ingredient' item_type, id item_id, name_zh, name_en, base_unit unit, waste_pct FROM ingredients ORDER BY name_en"),
    ...all("SELECT 'recipe' item_type, id item_id, name_zh, name_en, yield_unit unit, stockable FROM recipes WHERE kind='prep' ORDER BY name_en"),
  ],
  dishes: all("SELECT id, name_zh, name_en, sell_price FROM recipes WHERE kind='dish' ORDER BY id"),
  ccp_types: E.CCP_TYPES, task_types: E.TASK_TYPES,
}));
api.put('/settings', (q, res) => { E.saveSettings(q.body); res.json(E.settings()); });

// ── 供应商
api.get('/suppliers', (_q, res) => res.json(all('SELECT * FROM suppliers ORDER BY id')));
const supArgs = (b) => [b.name, b.contact || '', +b.lead_days || 0, +b.min_order || 0, +b.delivery_fee || 0, nul(b.approval_limit)];
api.post('/suppliers', (q, res) => res.json({ id: ins('INSERT INTO suppliers (name,contact,lead_days,min_order,delivery_fee,approval_limit) VALUES (?,?,?,?,?,?)', ...supArgs(q.body)) }));
api.put('/suppliers/:id', (q, res) => { run('UPDATE suppliers SET name=?, contact=?, lead_days=?, min_order=?, delivery_fee=?, approval_limit=? WHERE id=?', ...supArgs(q.body), int(q.params.id)); ok(res); });
api.delete('/suppliers/:id', (q, res) => { run('DELETE FROM suppliers WHERE id=?', int(q.params.id)); ok(res); });

// ── 原料 + 包装
const ingredientOut = (i) => ({ ...i, allergens: JSON.parse(i.allergens), unit_cost: E.ingredientUnitCost(i.id), costing_package_id: E.costingPackage(i.id)?.id,
  packages: all('SELECT p.*, s.name supplier_name FROM packages p JOIN suppliers s ON s.id=p.supplier_id WHERE ingredient_id=? ORDER BY price/pack_qty, id', i.id) });
api.get('/ingredients', (_q, res) => res.json(all('SELECT * FROM ingredients ORDER BY category, name_en').map(ingredientOut)));
// 价格历史
api.get('/ingredients/:id/prices', (q, res) => res.json(all(
  `SELECT h.*, p.label, s.name supplier_name FROM package_prices h JOIN packages p ON p.id=h.package_id JOIN suppliers s ON s.id=p.supplier_id
   WHERE p.ingredient_id=? ORDER BY h.ts DESC LIMIT 100`, int(q.params.id))));
function saveIngredient(id, b) {
  return tx(() => {
    const args = [b.name_zh, b.name_en || b.name_zh, b.category || '', b.base_unit, JSON.stringify(b.allergens || []), nul(b.waste_pct)];
    if (id) run('UPDATE ingredients SET name_zh=?, name_en=?, category=?, base_unit=?, allergens=?, waste_pct=? WHERE id=?', ...args, id);
    else id = ins('INSERT INTO ingredients (name_zh,name_en,category,base_unit,allergens,waste_pct) VALUES (?,?,?,?,?,?)', ...args);
    const pk = b.packages || [];
    const keep = pk.filter((p) => p.id).map((p) => p.id);
    for (const old of all('SELECT id FROM packages WHERE ingredient_id=?', id))
      if (!keep.includes(old.id)) run('DELETE FROM packages WHERE id=?', old.id);
    for (const p of pk) {
      if (!(+p.pack_qty > 0)) throw new Error('包装含量必须大于 0 pack size must be > 0');
      const a = [p.supplier_id, p.label || '', p.article_no || '', +p.pack_qty, +p.price || 0, p.orderable === false || p.orderable === 0 ? 0 : 1];
      let pid = p.id;
      const before = pid ? get('SELECT price FROM packages WHERE id=?', pid)?.price : null;
      if (pid) run('UPDATE packages SET supplier_id=?, label=?, article_no=?, pack_qty=?, price=?, orderable=? WHERE id=?', ...a, pid);
      else pid = ins('INSERT INTO packages (supplier_id,label,article_no,pack_qty,price,orderable,ingredient_id) VALUES (?,?,?,?,?,?,?)', ...a, id);
      if (before !== (+p.price || 0)) ins('INSERT INTO package_prices (package_id,ts,price,source) VALUES (?,?,?,?)', pid, E.now(), +p.price || 0, before == null ? '初始' : '手工改价');
    }
    return id;
  });
}
api.post('/ingredients', (q, res) => res.json({ id: saveIngredient(null, q.body) }));
api.put('/ingredients/:id', (q, res) => res.json({ id: saveIngredient(int(q.params.id), q.body) }));
api.delete('/ingredients/:id', (q, res) => { run('DELETE FROM ingredients WHERE id=?', int(q.params.id)); ok(res); });

// ── 配方
api.get('/recipes', (_q, res) => {
  const memo = new Map();
  res.json(all('SELECT id FROM recipes ORDER BY kind DESC, id').map((r) => {
    const { lines, method, ...c } = E.recipeCost(r.id, memo);
    return { ...c, line_count: lines.length };
  }));
});
api.get('/recipes/:id', (q, res) => {
  const id = int(q.params.id);
  res.json({ ...E.recipeCost(id), used_in: all('SELECT DISTINCT r.id, r.name_zh, r.name_en FROM recipe_lines l JOIN recipes r ON r.id=l.recipe_id WHERE l.sub_recipe_id=?', id) });
});
api.get('/recipes/:id/bom', (q, res) => res.json(E.bom(int(q.query.outlet), int(q.params.id), +q.query.portions || 0)));
function saveRecipe(id, b) {
  return tx(() => {
    const dish = b.kind === 'dish';
    if (!(+b.yield_qty > 0)) throw new Error('产出量必须大于 0 yield must be > 0');
    const args = [b.name_zh, b.name_en || b.name_zh, b.kind, dish ? 0 : b.stockable ? 1 : 0, b.category || '', +b.yield_qty, dish ? 'portion' : b.yield_unit,
      +b.sell_price || 0, nul(b.vat_pct), nul(b.target_margin), +b.prep_min || 0, +b.cook_min || 0, +b.plate_min || 0, nul(b.shelf_life_days), b.method || ''];
    if (id) run('UPDATE recipes SET name_zh=?, name_en=?, kind=?, stockable=?, category=?, yield_qty=?, yield_unit=?, sell_price=?, vat_pct=?, target_margin=?, prep_min=?, cook_min=?, plate_min=?, shelf_life_days=?, method=? WHERE id=?', ...args, id);
    else id = ins('INSERT INTO recipes (name_zh,name_en,kind,stockable,category,yield_qty,yield_unit,sell_price,vat_pct,target_margin,prep_min,cook_min,plate_min,shelf_life_days,method) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', ...args);
    run('DELETE FROM recipe_lines WHERE recipe_id=?', id);
    for (const l of b.lines || [])
      ins('INSERT INTO recipe_lines (recipe_id,ingredient_id,sub_recipe_id,qty,unit,waste_pct) VALUES (?,?,?,?,?,?)',
        id, l.item_type === 'ingredient' ? l.item_id : null, l.item_type === 'recipe' ? l.item_id : null, +l.qty || 0, l.unit, nul(l.waste_pct));
    // 算一遍成本：单位不兼容或循环引用会在这里抛错，整个保存回滚
    E.recipeCost(id);
    for (const p of all('SELECT DISTINCT recipe_id FROM recipe_lines WHERE sub_recipe_id=?', id)) E.recipeCost(p.recipe_id);
    return id;
  });
}
api.post('/recipes', (q, res) => res.json({ id: saveRecipe(null, q.body) }));
api.put('/recipes/:id', (q, res) => res.json({ id: saveRecipe(int(q.params.id), q.body) }));
api.delete('/recipes/:id', (q, res) => { run('DELETE FROM recipes WHERE id=?', int(q.params.id)); ok(res); });

// ── 菜单
api.get('/menus', (_q, res) => res.json(E.listMenus()));
api.post('/menus', (q, res) => res.json({ id: E.saveMenu(q.body) }));
api.put('/menus/:id', (q, res) => res.json({ id: E.saveMenu({ ...q.body, id: int(q.params.id) }) }));
api.delete('/menus/:id', (q, res) => { E.deleteMenu(int(q.params.id)); ok(res); });

// ── 库存
api.get('/stock', (q, res) => res.json(E.stockList(int(q.query.outlet))));
api.get('/stock/moves', (q, res) => res.json(all(
  'SELECT * FROM stock_moves WHERE outlet_id=? AND item_type=? AND item_id=? ORDER BY ts DESC, id DESC LIMIT 200',
  int(q.query.outlet), q.query.item_type, int(q.query.item_id))));
api.get('/stock/lots', (q, res) => res.json(E.lotsOf(int(q.query.outlet), q.query.item_type, int(q.query.item_id))));
api.post('/stock/waste', (q, res) => res.json({ ref: E.waste({ ...q.body, qty: +q.body.qty }) }));
api.post('/stock/par', (q, res) => { E.setPar(q.body); ok(res); });
api.get('/transfers', (_q, res) => res.json(all('SELECT * FROM transfers ORDER BY id DESC LIMIT 100').map((t) => ({ ...t, ...E.itemInfo(t.item_type, t.item_id) }))));
api.post('/transfers', (q, res) => res.json({ id: E.transfer({ ...q.body, qty: +q.body.qty }) }));
api.get('/lots', (q, res) => res.json(E.recentLots(int(q.query.outlet))));
api.get('/trace', (q, res) => res.json(E.trace(String(q.query.lot || ''))));

// ── 盘点
api.get('/counts', (q, res) => res.json(all(`SELECT c.*, (SELECT COUNT(*) FROM count_subs s WHERE s.count_id=c.id) subs,
  (SELECT COALESCE(SUM((l.counted-l.expected)*l.unit_cost),0) FROM count_lines l WHERE l.count_id=c.id) variance_value
  FROM stock_counts c WHERE outlet_id=? ORDER BY id DESC`, int(q.query.outlet))));
api.post('/counts', (q, res) => res.json({ id: E.createCount(q.body.outlet_id) }));
api.get('/counts/:id', (q, res) => res.json(E.getCount(int(q.params.id))));
api.post('/counts/:id/subs', (q, res) => res.json({ id: E.addSubCount(int(q.params.id), q.body.name) }));
api.put('/counts/:id/subs/:sid', (q, res) => { E.saveSubCount(int(q.params.id), int(q.params.sid), q.body.entries); ok(res); });
api.post('/counts/:id/confirm', (q, res) => { E.confirmCount(int(q.params.id)); ok(res); });
api.delete('/counts/:id', (q, res) => { run("DELETE FROM stock_counts WHERE id=? AND status='open'", int(q.params.id)); ok(res); });

// ── 采购
api.get('/orders/suggestions', (q, res) => res.json(q.query.mode === 'forecast'
  ? E.forecastSuggestions(int(q.query.outlet), { days: q.query.days, source: q.query.source, scale: q.query.scale,
      use_stock: q.query.use_stock !== '0', use_outstanding: q.query.use_outstanding !== '0' })
  : E.parSuggestions(int(q.query.outlet))));
api.get('/orders', (q, res) => res.json(E.listPOs(int(q.query.outlet))));
api.post('/orders', (q, res) => res.json({ id: E.createPO(q.body) }));
api.post('/orders/:id/submit', (q, res) => res.json(E.submitPO(int(q.params.id))));
api.post('/orders/:id/approve', (q, res) => { E.approvePO(int(q.params.id), q.body.note); ok(res); });
api.post('/orders/:id/reject', (q, res) => { E.rejectPO(int(q.params.id), q.body.reason); ok(res); });
api.post('/orders/:id/recall', (q, res) => { E.recallPO(int(q.params.id)); ok(res); });
api.post('/orders/:id/receive', (q, res) => { E.receivePO(int(q.params.id), q.body); ok(res); });
api.put('/orders/:id/invoice', (q, res) => { E.saveInvoice(int(q.params.id), q.body); ok(res); });
api.delete('/orders/:id', (q, res) => { E.deletePO(int(q.params.id)); ok(res); });

// ── 内部订货
api.get('/internal', (q, res) => res.json(E.listInternalOrders(int(q.query.outlet))));
api.get('/internal/demand', (q, res) => res.json(E.incomingDemand(int(q.query.outlet))));
api.post('/internal', (q, res) => res.json({ id: E.createInternalOrder(q.body) }));
api.post('/internal/:id/pick', (q, res) => { E.pickInternalOrder(int(q.params.id), q.body); ok(res); });
api.post('/internal/:id/ship', (q, res) => { E.shipInternalOrder(int(q.params.id)); ok(res); });
api.post('/internal/:id/receive', (q, res) => { E.receiveInternalOrder(int(q.params.id)); ok(res); });
api.delete('/internal/:id', (q, res) => { E.deleteInternalOrder(int(q.params.id)); ok(res); });

// ── 生产计划
api.get('/plans', (q, res) => res.json(E.listPlans(int(q.query.outlet))));
api.get('/plans/suggestions', (q, res) => res.json(E.productionSuggestions(int(q.query.outlet))));
api.get('/plans/subs', (q, res) => res.json(E.subRecipeNeeds(int(q.query.outlet), int(q.query.recipe_id), +q.query.qty || 0)));
api.post('/plans', (q, res) => res.json({ id: E.savePlan(q.body) }));
api.get('/plans/:id', (q, res) => res.json(E.getPlan(int(q.params.id))));
api.post('/plans/:id/activate', (q, res) => { E.activatePlan(int(q.params.id)); ok(res); });
api.post('/plans/:id/all-done', (q, res) => { E.markAllDone(int(q.params.id)); ok(res); });
api.post('/plans/:id/finish', (q, res) => res.json(E.finishPlan(int(q.params.id), q.body.outputs || [])));
api.post('/plans/tasks/:tid/status', (q, res) => { E.setTaskStatus(int(q.params.tid), q.body.status); ok(res); });
api.delete('/plans/:id', (q, res) => { E.deletePlan(int(q.params.id)); ok(res); });

// ── 任务与 HACCP
api.get('/ccps', (_q, res) => res.json(E.listCcps()));
api.post('/ccps', (q, res) => res.json({ id: E.saveCcp(q.body) }));
api.delete('/ccps/:id', (q, res) => { E.deleteCcp(int(q.params.id)); ok(res); });
api.get('/tasks', (q, res) => res.json(E.listTasks(int(q.query.outlet))));
api.get('/tasks/occurrences', (q, res) => res.json(E.occurrences(int(q.query.outlet), q.query.from || E.today(), q.query.to || q.query.from || E.today())));
api.get('/tasks/report', (q, res) => res.json(E.taskReport(int(q.query.outlet), ...range(q.query))));
api.post('/tasks', (q, res) => res.json({ id: E.saveTask(q.body) }));
api.post('/tasks/:id/complete', (q, res) => res.json(E.completeTask(int(q.params.id), q.body)));
api.delete('/tasks/:id', (q, res) => { E.deleteTask(int(q.params.id)); ok(res); });

// ── 销售
api.get('/pos', (q, res) => res.json(E.posItems(int(q.query.outlet))));
api.post('/pos/:id/link', (q, res) => res.json(E.linkPos(int(q.params.id), q.body.recipe_id || null)));
api.post('/pos/:id/ignore', (q, res) => { E.ignorePos(int(q.params.id), q.body.ignored); ok(res); });
api.get('/sales', (q, res) => res.json(E.salesLog(int(q.query.outlet), ...range(q.query))));
api.post('/sales/pos', (q, res) => res.json(E.importPosSales(q.body.outlet_id, q.body.rows || [])));
api.post('/sales/manual', (q, res) => res.json({ count: E.recordManualSales(q.body.rows || []) }));

// ── 报表
api.get('/reports/sales', (q, res) => res.json(E.salesDashboard(int(q.query.outlet), ...range(q.query))));
api.get('/reports/menu', (q, res) => res.json(E.menuEngineering(int(q.query.outlet), ...range(q.query))));
api.get('/reports/management', (q, res) => res.json({ one: E.managementFigures(int(q.query.outlet), ...range(q.query)), all: E.managementAllOutlets(...range(q.query)) }));
api.get('/reports/stock-period', (q, res) => res.json(E.stockPeriod(int(q.query.outlet), ...range(q.query))));
api.get('/reports/variance', (q, res) => res.json(E.countVariance(int(q.query.outlet), ...range(q.query))));
api.get('/reports/waste', (q, res) => res.json(E.wasteReport(int(q.query.outlet), ...range(q.query))));
api.get('/dashboard', (q, res) => res.json(E.dashboard(int(q.query.outlet))));

app.use('/api', api);
app.use('/api', (_q, res) => res.status(404).json({ error: 'not found' }));
// 业务错误统一返回 400 + 可读的消息
app.use((err, _q, res, _next) => {
  const fk = /FOREIGN KEY/.test(err.message);
  res.status(400).json({ error: fk ? '仍被其他数据引用，无法删除 still referenced elsewhere' : err.message });
});

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
app.use(express.static(dist));

const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`Mise 已启动 → http://localhost:${port}`));
