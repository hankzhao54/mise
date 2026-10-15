// 核心：设置、单位换算、配方成本、配方展开。其他模块都建立在这上面。
//
// 性能上的一个安排：配方、原料、包装、设置这些"主数据"在每个请求开始时一次性读进内存 (目录 catalog)，
// 之后的成本计算、配方展开都是纯内存运算，不再逐行查数据库。
// 主数据被修改后调用 refresh() 重新读一次。
import { all, run, store } from '../db.js';

// 时间一律用【本机时区】的 ISO 字符串 (不带 Z)。这样"某一天"的含义和餐厅的营业日一致，
// 按 substr(ts,1,10) 取日期做报表也不会被时区搞错。
const pad = (n, w = 2) => String(n).padStart(w, '0');
export const localIso = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
export const now = () => localIso();
export const today = () => localIso().slice(0, 10);
export const dayAdd = (day, n) => new Date(Date.parse(day + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
export const fail = (m) => { throw new Error(m); };

// ───────────────────────── 设置 ─────────────────────────
export const DEFAULTS = {
  currency: 'HUF',
  default_vat: 5,            // 默认税率 %，配方可覆盖
  default_waste_pct: 0,      // 默认备料损耗 %，原料、配方行可逐级覆盖
  target_margin: 70,         // 目标毛利率 %，配方可覆盖
  rate_prep: 3000,           // 三种时薪 (每小时)：备料 / 烹饪 / 装盘。设为 0 即不计人工
  rate_cook: 3500,
  rate_plate: 3000,
  cost_basis: 'cheapest',    // 成本取价：cheapest 最便宜的包装 | last_ordered 最近一次订的包装
  blind_count: false,        // 盲盘：盘点时不显示账面数
  approval_limit: null,      // 每日订货限额 (对同一供应商)；null = 不启用审批
  waste_reasons: ['过期 Expired', '备料损耗 Prep waste', '做错/退菜 Mistake', '掉落损坏 Dropped', '试菜/员工餐 Tasting'],
  workstations: ['汤锅 Stock pot', '面点 Dough', '热厨 Hot line', '冷厨 Cold'],
};

// ───────────────────────── 目录 (主数据缓存) ─────────────────────────
async function loadCatalog() {
  const [st, ings, pkgs, recs, lines, outlets] = await Promise.all([
    all('SELECT * FROM settings'), all('SELECT * FROM ingredients'), all('SELECT * FROM packages ORDER BY id'),
    all('SELECT * FROM recipes'), all('SELECT * FROM recipe_lines ORDER BY id'), all('SELECT * FROM outlets ORDER BY id')]);
  const settings = { ...DEFAULTS };
  for (const r of st) settings[r.key] = JSON.parse(r.value);
  const group = (rows, key) => { const m = new Map(); for (const r of rows) { if (!m.has(r[key])) m.set(r[key], []); m.get(r[key]).push(r); } return m; };
  return {
    settings,
    ingredients: new Map(ings.map((i) => [i.id, { ...i, allergens: JSON.parse(i.allergens) }])),
    packages: group(pkgs, 'ingredient_id'),
    recipes: new Map(recs.map((r) => [r.id, r])),
    lines: group(lines, 'recipe_id'),
    outlets: new Map(outlets.map((o) => [o.id, o])),
  };
}
// 每个异步入口先 await ready()，之后同一请求里的同步函数都能用目录
export async function ready() {
  const s = store().shared;
  if (!s.cat) s.cat = await loadCatalog();
  return s.cat;
}
export async function refresh() { store().shared.cat = null; return ready(); }
function C() {
  const c = store().shared.cat;
  if (!c) fail('internal: catalog not loaded (call ready() first)');
  return c;
}
export const settings = () => C().settings;
export async function saveSettings(patch) {
  for (const k of Object.keys(patch)) {
    if (!(k in DEFAULTS)) continue;
    await run('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT (key) DO UPDATE SET value=excluded.value', k, JSON.stringify(patch[k]));
  }
  return (await refresh()).settings;
}
export const outletOf = (id) => C().outlets.get(id);

// ───────────────────────── 单位 ─────────────────────────
// 每个单位属于一个量纲，并有一个换算到基础单位的系数。不同量纲之间不能换算。
const UNITS = {
  g: ['mass', 1], kg: ['mass', 1000],
  ml: ['vol', 1], l: ['vol', 1000],
  pc: ['count', 1], portion: ['portion', 1],
};
export const UNIT_LIST = Object.keys(UNITS);
export function toBase(qty, unit, baseUnit) {
  const u = UNITS[unit], b = UNITS[baseUnit];
  if (!u || !b) fail(`未知单位 unknown unit: ${unit}/${baseUnit}`);
  if (u[0] !== b[0]) fail(`单位不兼容 incompatible units: ${unit} → ${baseUnit}`);
  return (qty * u[1]) / b[1];
}

// ───────────────────────── 成本 ─────────────────────────
// 用哪个包装的价格来算成本：默认取"单位价最便宜"的；也可以设成"最近一次订的"
export function costingPackage(ingredientId) {
  const pk = C().packages.get(ingredientId) || [];
  if (!pk.length) return undefined;
  if (settings().cost_basis === 'last_ordered') {
    const lo = pk.filter((p) => p.last_ordered_at).sort((a, b) => b.last_ordered_at.localeCompare(a.last_ordered_at))[0];
    if (lo) return lo;
  }
  return [...pk].sort((a, b) => a.price / a.pack_qty - b.price / b.pack_qty || a.id - b.id)[0];
}
// 原料单位成本 = 包装价格 / 包装含量 (6500 Ft / 25000 g = 0.26 Ft/g)
export function ingredientUnitCost(id) {
  const p = costingPackage(id);
  return p ? p.price / p.pack_qty : 0;
}

// 配方成本。对每一行：
//   净用量 → 毛用量 = 净用量 × (1 + 损耗率)        损耗率优先级：配方行 > 原料 > 全局默认
//   食材成本 = 毛用量 × 单位成本
// 行如果是子配方，递归算出子配方的每单位成本 (食材、人工分开累计)。stack 用来发现循环引用。
// 人工成本 = 主动工时 × 对应时薪；食材 + 人工 = prime cost
export function recipeCost(id, memo = new Map(), stack = []) {
  if (stack.includes(id)) fail('配方循环引用 circular recipe reference');
  if (memo.has(id)) return memo.get(id);
  const S = settings();
  const r = C().recipes.get(id) || fail(`配方不存在 recipe ${id} not found`);
  const allergens = new Set();
  let depth = 0;
  const lines = (C().lines.get(id) || []).map((l) => {
    let info, unitCost, labourPerUnit = 0, children = null, wastePct, wasteSrc;
    if (l.ingredient_id) {
      const ing = C().ingredients.get(l.ingredient_id);
      info = { item_type: 'ingredient', item_id: ing.id, name_zh: ing.name_zh, name_en: ing.name_en, base_unit: ing.base_unit, stockable: 1 };
      unitCost = ingredientUnitCost(ing.id);
      ing.allergens.forEach((a) => allergens.add(a));
      [wastePct, wasteSrc] = l.waste_pct != null ? [l.waste_pct, 'line'] : ing.waste_pct != null ? [ing.waste_pct, 'ingredient'] : [S.default_waste_pct, 'library'];
    } else {
      const sub = recipeCost(l.sub_recipe_id, memo, [...stack, id]);
      info = { item_type: 'recipe', item_id: sub.id, name_zh: sub.name_zh, name_en: sub.name_en, base_unit: sub.yield_unit, stockable: sub.stockable };
      unitCost = sub.perUnit;
      labourPerUnit = sub.labourPerUnit;
      children = sub.lines;
      depth = Math.max(depth, sub.depth + 1);
      sub.allergens.forEach((a) => allergens.add(a));
      // 子配方行上的损耗叠加在子配方内部原料各自的损耗之上
      [wastePct, wasteSrc] = [l.waste_pct ?? 0, 'line'];
    }
    const net = toBase(l.qty, l.unit, info.base_unit);
    const gross = net * (1 + (wastePct || 0) / 100);
    return { id: l.id, ...info, qty: l.qty, unit: l.unit, line_waste_pct: l.waste_pct, waste_pct: wastePct || 0, waste_src: wasteSrc,
      net, gross, unit_cost: unitCost, ingredient_cost: net * unitCost, waste_cost: (gross - net) * unitCost, cost: gross * unitCost,
      labour: gross * labourPerUnit, children };
  });
  const total = lines.reduce((s, l) => s + l.cost, 0);                       // 一批的食材成本
  const ownLabour = (r.prep_min * S.rate_prep + r.cook_min * S.rate_cook + r.plate_min * S.rate_plate) / 60;
  const labourTotal = ownLabour + lines.reduce((s, l) => s + l.labour, 0);  // 含子配方的人工
  const perUnit = total / r.yield_qty;
  const labourPerUnit = labourTotal / r.yield_qty;
  const out = { ...r, lines, depth, total, perUnit, own_labour: ownLabour, labour_total: labourTotal, labourPerUnit,
    primePerUnit: perUnit + labourPerUnit, allergens: [...allergens].sort() };
  if (r.kind === 'dish') Object.assign(out, pricing(perUnit, labourPerUnit, r.sell_price, r.vat_pct, r.target_margin));
  memo.set(id, out);
  return out;
}

// 售价相关的全部指标。售价是含税价，先去税再算。
//   利润     = 去税售价 − prime cost
//   毛利率   = 利润 ÷ 去税售价
//   目标成本 = 去税售价 × (1 − 目标毛利率)            价格不能涨时：成本要压到多少
//   目标售价 = prime cost ÷ (1 − 目标毛利率) × (1+税率) 成本不能降时：价格要定到多少
export function pricing(food, labour, sellPrice, vatPct, targetMargin) {
  const S = settings();
  const vat = vatPct ?? S.default_vat, target = targetMargin ?? S.target_margin;
  const net = sellPrice / (1 + vat / 100), prime = food + labour, profit = net - prime;
  return { vat, target, net_price: net, profit, margin: profit,
    margin_pct: net > 0 ? profit / net : null, food_cost_pct: net > 0 ? food / net : null,
    target_prime: net * (1 - target / 100),
    target_price: target < 100 ? (prime / (1 - target / 100)) * (1 + vat / 100) : null,
    meets_target: net > 0 ? profit / net >= target / 100 - 1e-9 : null };
}

// 把配方展开成"要从库存里扣的东西"：
// 遇到原料或【可入库】的半成品就停 (它们有库存)；遇到【不可入库】的半成品就继续往下拆。
// 返回 Map: "ingredient:3" → { item_type, item_id, qty, unit_cost, ... }
export function explode(recipeId, qty, out = new Map(), memo = new Map()) {
  const c = recipeCost(recipeId, memo);
  const f = qty / c.yield_qty;
  for (const l of c.lines) {
    if (l.item_type === 'recipe' && !l.stockable) { explode(l.item_id, l.gross * f, out, memo); continue; }
    const k = `${l.item_type}:${l.item_id}`;
    const cur = out.get(k) || { item_type: l.item_type, item_id: l.item_id, name_zh: l.name_zh, name_en: l.name_en, unit: l.base_unit, unit_cost: l.unit_cost, qty: 0 };
    cur.qty += l.gross * f;
    out.set(k, cur);
  }
  return out;
}

export function itemInfo(type, id) {
  if (type === 'ingredient') {
    const i = C().ingredients.get(id) || fail(`找不到原料 ingredient not found: ${id}`);
    return { name_zh: i.name_zh, name_en: i.name_en, unit: i.base_unit, category: i.category };
  }
  const r = C().recipes.get(id) || fail(`找不到配方 recipe not found: ${id}`);
  return { name_zh: r.name_zh, name_en: r.name_en, unit: r.yield_unit, category: r.category, shelf_life_days: r.shelf_life_days };
}
// 库存计价用食材成本 (不含人工)
export const unitCost = (type, id, memo) =>
  type === 'ingredient' ? ingredientUnitCost(id) : recipeCost(id, memo).perUnit;
