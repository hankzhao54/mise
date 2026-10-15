// 销售：POS 商品关联、销售入账与扣库存、菜单 (套餐)、销售看板、菜单工程
import { all, get, ins, run, tx } from '../db.js';
import { dayAdd, fail, pricing, ready, recipeCost, settings, today } from './core.js';
import { consumeRecipe } from './stock.js';

// 每卖出一份，就按配方扣一次库存 —— 这样产生的消耗叫"理论消耗"
async function deplete(sale) {
  await consumeRecipe(sale.outlet_id, sale.recipe_id, sale.qty, 'sale', `S${sale.id}`, `${sale.day}T20:00:00.000`);
  await run('UPDATE sales SET depleted=1 WHERE id=?', sale.id);
}

// 手工销售：直接按配方录 (没有 POS 时用)
export async function recordManualSales(rows) {
  return tx(async () => {
    let n = 0;
    for (const s of rows) {
      const qty = +s.qty;
      if (!(qty > 0)) continue;
      const r = (await get("SELECT * FROM recipes WHERE id=? AND kind='dish'", s.recipe_id)) || fail(`不是可售菜品 not a dish: ${s.recipe_id}`);
      const day = s.day || today();
      const id = await ins('INSERT INTO sales (outlet_id,day,recipe_id,qty,revenue) VALUES (?,?,?,?,?)', s.outlet_id, day, r.id, qty,
        s.revenue != null && s.revenue !== '' ? +s.revenue : qty * r.sell_price);
      await deplete({ id, outlet_id: s.outlet_id, recipe_id: r.id, qty, day });
      n++;
    }
    return n;
  });
}

// POS 销售导入：每行按 PLU 找 POS 商品 (没有就自动建一个"未关联"的)。
//   已关联配方 → 立刻扣库存
//   未关联     → 只记营业额，不扣库存、不算成本，等关联后再补扣
export async function importPosSales(outlet, rows) {
  return tx(async () => {
    const out = { imported: 0, unlinked: 0, created: 0 };
    for (const s of rows) {
      const qty = +s.qty;
      if (!s.plu || !(qty > 0)) continue;
      let item = await get('SELECT * FROM pos_items WHERE outlet_id=? AND plu=?', outlet, String(s.plu));
      if (!item) {
        const id = await ins('INSERT INTO pos_items (outlet_id,plu,name,category) VALUES (?,?,?,?)', outlet, String(s.plu), s.name || String(s.plu), s.category || '');
        item = await get('SELECT * FROM pos_items WHERE id=?', id);
        out.created++;
      }
      const day = s.day || today();
      const price = item.recipe_id ? (await get('SELECT sell_price FROM recipes WHERE id=?', item.recipe_id)).sell_price : 0;
      const id = await ins('INSERT INTO sales (outlet_id,day,pos_item_id,recipe_id,qty,revenue,discount) VALUES (?,?,?,?,?,?,?)', outlet, day, item.id, item.recipe_id, qty,
        s.revenue != null && s.revenue !== '' ? +s.revenue : qty * price, +s.discount || 0);
      if (item.recipe_id && !item.ignored) await deplete({ id, outlet_id: outlet, recipe_id: item.recipe_id, qty, day });
      else out.unlinked++;
      out.imported++;
    }
    return out;
  });
}

// 关联 / 取消关联。关联后把这个 PLU 之前没扣过库存的销售补扣一遍。
export async function linkPos(id, recipeId) {
  const item = (await get('SELECT * FROM pos_items WHERE id=?', id)) || fail('POS 商品不存在 POS item not found');
  return tx(async () => {
    if (!recipeId) { await run('UPDATE pos_items SET recipe_id=NULL WHERE id=?', id); return { depleted: 0 }; }
    (await get("SELECT id FROM recipes WHERE id=? AND kind='dish'", recipeId)) || fail('只能关联菜品 only dishes can be linked');
    await run('UPDATE pos_items SET recipe_id=?, ignored=0 WHERE id=?', recipeId, id);
    const pending = await all('SELECT * FROM sales WHERE pos_item_id=? AND depleted=0 ORDER BY id', id);
    for (const s of pending) { await run('UPDATE sales SET recipe_id=? WHERE id=?', recipeId, s.id); await deplete({ ...s, recipe_id: recipeId, outlet_id: item.outlet_id }); }
    return { depleted: pending.length };
  });
}
// 忽略：折扣、小费、配送费这类不涉及库存的 POS 条目
export const ignorePos = (id, ignored) => run('UPDATE pos_items SET ignored=? WHERE id=?', ignored ? 1 : 0, id);

// POS 关联健康度 = 已关联商品的营业额 ÷ 全部营业额 (近 30 天，忽略的不算)。目标 100%。
export async function posItems(outlet) {
  const from = dayAdd(today(), -30);
  const items = await all(`SELECT p.*, r.name_zh recipe_zh, r.name_en recipe_en,
      (SELECT COALESCE(SUM(revenue),0) FROM sales s WHERE s.pos_item_id=p.id AND s.day>=?) revenue,
      (SELECT COALESCE(SUM(qty),0) FROM sales s WHERE s.pos_item_id=p.id AND s.day>=?) qty,
      (SELECT COUNT(*) FROM sales s WHERE s.pos_item_id=p.id AND s.depleted=0) pending
    FROM pos_items p LEFT JOIN recipes r ON r.id=p.recipe_id WHERE p.outlet_id=?`, from, from, outlet);
  items.sort((a, b) => a.ignored - b.ignored || (a.recipe_id ? 1 : 0) - (b.recipe_id ? 1 : 0) || b.revenue - a.revenue);
  const live = items.filter((i) => !i.ignored);
  const total = live.reduce((s, i) => s + i.revenue, 0), linked = live.filter((i) => i.recipe_id).reduce((s, i) => s + i.revenue, 0);
  return { items, health: total ? linked / total : null, unlinked_revenue: total - linked };
}

export const salesLog = (outlet, from, to) =>
  all(`SELECT s.day, COALESCE(MIN(p.name), MIN(r.name_zh)) pos_name, MIN(p.plu) plu, MIN(r.name_zh) name_zh, MIN(r.name_en) name_en,
              SUM(s.qty) qty, SUM(s.revenue) revenue, MIN(s.depleted) depleted
       FROM sales s LEFT JOIN pos_items p ON p.id=s.pos_item_id LEFT JOIN recipes r ON r.id=s.recipe_id
       WHERE s.outlet_id=? AND s.day BETWEEN ? AND ? GROUP BY s.day, s.pos_item_id, s.recipe_id ORDER BY s.day DESC, revenue DESC`, outlet, from, to);

// ───────────────────────── 销售看板 ─────────────────────────
//   利润 = 去税营业额 − prime cost (食材 + 人工)
//   未关联的销售只有营业额、没有成本，会把利润"虚高" —— 所以要同时看关联健康度
//   outlets：只统计这些门店 (null = 全部)
export async function salesDashboard(outlets, from, to) {
  await ready();
  const S = settings(), memo = new Map();
  const ids = outlets == null ? null : [].concat(outlets);
  const w = ids ? `AND s.outlet_id IN (${ids.map(() => '?').join(',') || 'NULL'})` : '';
  const rows = (await all(`SELECT s.day, s.pos_item_id, s.recipe_id, MIN(p.name) pos_name, MIN(p.plu) plu, MIN(p.category) category, MIN(p.ignored) ignored,
                                  SUM(s.qty) qty, SUM(s.revenue) revenue, SUM(s.discount) discount
                           FROM sales s LEFT JOIN pos_items p ON p.id=s.pos_item_id
                           WHERE s.day BETWEEN ? AND ? ${w} GROUP BY s.day, s.pos_item_id, s.recipe_id`, from, to, ...(ids || []))).filter((r) => !r.ignored);
  const mix = new Map(), days = new Map();
  const tot = { revenue_incl: 0, revenue: 0, discount: 0, prime: 0, food: 0, covered: 0, covered_profit: 0 };
  for (const r of rows) {
    const c = r.recipe_id ? recipeCost(r.recipe_id, memo) : null;
    const net = r.revenue / (1 + (c ? c.vat : S.default_vat) / 100);
    const prime = c ? c.primePerUnit * r.qty : 0, food = c ? c.perUnit * r.qty : 0;
    tot.revenue_incl += r.revenue; tot.revenue += net; tot.discount += r.discount; tot.prime += prime; tot.food += food;
    if (c) { tot.covered += net; tot.covered_profit += net - prime; }
    const k = `${r.pos_item_id}:${r.recipe_id}`;
    const m = mix.get(k) || { pos_name: r.pos_name || c?.name_zh, plu: r.plu, category: r.category || (r.pos_item_id ? '' : 'N/A'), recipe_id: r.recipe_id,
      name_zh: c?.name_zh, name_en: c?.name_en, qty: 0, revenue: 0, prime: 0, discount: 0 };
    m.qty += r.qty; m.revenue += net; m.prime += prime; m.discount += r.discount;
    mix.set(k, m);
    const d = days.get(r.day) || { day: r.day, revenue_incl: 0, revenue: 0, prime: 0 };
    d.revenue_incl += r.revenue; d.revenue += net; d.prime += prime;
    days.set(r.day, d);
  }
  return {
    totals: { ...tot, profit: tot.revenue - tot.prime, avg_margin: tot.covered ? tot.covered_profit / tot.covered : null, linking: tot.revenue ? tot.covered / tot.revenue : null },
    days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)).map((d) => ({ ...d, profit: d.revenue - d.prime })),
    mix: [...mix.values()].map((m) => ({ ...m, profit: m.revenue - m.prime, margin: m.revenue && m.recipe_id ? (m.revenue - m.prime) / m.revenue : null })).sort((a, b) => b.revenue - a.revenue),
  };
}

// ───────────────────────── 菜单工程矩阵 ─────────────────────────
// 经典的 Kasavana & Smith 四象限法 (这是通用方法，不是 Apicbase 文档里的某个页面)：
//   销量门槛 = 平均份额 × 70%；毛利门槛 = 加权平均单份毛利
//   明星 star = 高/高, 耕马 plowhorse = 卖得好/毛利低, 谜题 puzzle = 卖得差/毛利高, 瘦狗 dog = 低/低
//   outlets：只统计这些门店 (null = 全部)
export async function menuEngineering(outlets, from, to) {
  await ready();
  const ids = outlets == null ? null : [].concat(outlets);
  const w = ids ? `AND outlet_id IN (${ids.map(() => '?').join(',') || 'NULL'})` : '';
  const memo = new Map();
  const rows = (await all(`SELECT recipe_id, SUM(qty) qty, SUM(revenue) revenue FROM sales WHERE recipe_id IS NOT NULL AND day BETWEEN ? AND ? ${w} GROUP BY recipe_id`, from, to, ...(ids || [])))
    .map((s) => {
      const c = recipeCost(s.recipe_id, memo);
      const netRev = s.revenue / (1 + c.vat / 100), cost = c.perUnit * s.qty;
      return { recipe_id: s.recipe_id, name_zh: c.name_zh, name_en: c.name_en, category: c.category, qty: s.qty,
        net_revenue: netRev, cost, unit_cost: c.perUnit, unit_price: netRev / s.qty, unit_margin: (netRev - cost) / s.qty,
        total_margin: netRev - cost, food_cost_pct: netRev > 0 ? cost / netRev : 0 };
    });
  const totalQty = rows.reduce((s, r) => s + r.qty, 0), totalMargin = rows.reduce((s, r) => s + r.total_margin, 0);
  const popThreshold = rows.length ? (totalQty / rows.length) * 0.7 : 0;
  const marginThreshold = totalQty ? totalMargin / totalQty : 0;
  for (const r of rows) {
    r.mix_pct = totalQty ? r.qty / totalQty : 0;
    const pop = r.qty >= popThreshold, prof = r.unit_margin >= marginThreshold;
    r.cls = pop && prof ? 'star' : pop ? 'plowhorse' : prof ? 'puzzle' : 'dog';
  }
  rows.sort((a, b) => b.total_margin - a.total_margin);
  const netRevenue = rows.reduce((s, r) => s + r.net_revenue, 0), cost = rows.reduce((s, r) => s + r.cost, 0);
  return { rows, pop_threshold: popThreshold, margin_threshold: marginThreshold,
    totals: { qty: totalQty, net_revenue: netRevenue, cost, margin: totalMargin, food_cost_pct: netRevenue ? cost / netRevenue : 0 } };
}

// ───────────────────────── 菜单 (套餐) ─────────────────────────
// 菜单 = 分道次的一组配方 + 套餐价。用途：
//   · 整套成本：每道各一份的成本相加，和套餐价比 (只适用于固定套餐)
//   · 配方对比：把每个配方各自的成本、毛利、是否达标并排放
//   · 过敏原表：配方 × 过敏原
function buildMenu(m, items) {
  const memo = new Map();
  m.items = items.map((i) => {
    const c = recipeCost(i.recipe_id, memo);
    return { id: i.id, course: i.course, recipe_id: i.recipe_id, name_zh: c.name_zh, name_en: c.name_en, food: c.perUnit, labour: c.labourPerUnit, prime: c.primePerUnit,
      sell_price: c.sell_price, net_price: c.net_price, profit: c.profit, margin_pct: c.margin_pct, target: c.target, meets_target: c.meets_target, allergens: c.allergens };
  });
  m.food = m.items.reduce((s, i) => s + i.food, 0);
  m.labour = m.items.reduce((s, i) => s + i.labour, 0);
  Object.assign(m, pricing(m.food, m.labour, m.price, m.vat_pct, m.target_margin));
  m.prime = m.food + m.labour;
  m.allergens = [...new Set(m.items.flatMap((i) => i.allergens))].sort();
  return m;
}
export async function listMenus() {
  await ready();
  const [menus, items] = await Promise.all([all('SELECT * FROM menus ORDER BY id'), all('SELECT * FROM menu_items ORDER BY id')]);
  return menus.map((m) => buildMenu(m, items.filter((i) => i.menu_id === m.id)));
}
export async function saveMenu(m) {
  if (!m.name) fail('菜单名称必填 name is required');
  return tx(async () => {
    const a = [m.name, +m.price || 0, m.vat_pct === '' || m.vat_pct == null ? null : +m.vat_pct, m.target_margin === '' || m.target_margin == null ? null : +m.target_margin];
    let id = m.id;
    if (id) await run('UPDATE menus SET name=?, price=?, vat_pct=?, target_margin=? WHERE id=?', ...a, id);
    else id = await ins('INSERT INTO menus (name,price,vat_pct,target_margin) VALUES (?,?,?,?)', ...a);
    await run('DELETE FROM menu_items WHERE menu_id=?', id);
    for (const i of m.items || []) if (i.recipe_id) await ins('INSERT INTO menu_items (menu_id,course,recipe_id) VALUES (?,?,?)', id, i.course || '', i.recipe_id);
    return id;
  });
}
export const deleteMenu = (id) => run('DELETE FROM menus WHERE id=?', id);
