// 库存：台账、批次 (FEFO)、按配方扣减、报损、调拨、盘点、追溯
import { all, get, ins, run, tx } from '../db.js';
import { explode, fail, itemInfo, now, recipeCost, unitCost } from './core.js';

// ───────────────────────── 台账 + 批次 ─────────────────────────
// reason 一览：
//   opening 期初          receive 采购收货          receive_internal 内部订货收货
//   sale 销售扣减         production_in/out 生产入库/领料
//   transfer_in/out 调拨  shipped_out 内部订货发货   waste 报损   count_adjust 盘点调整
export function onHand(outlet, type, id) {
  return get('SELECT COALESCE(SUM(qty),0) q FROM stock_moves WHERE outlet_id=? AND item_type=? AND item_id=?', outlet, type, id).q;
}

const LOT_PREFIX = { opening: 'OPEN-', receive: 'RCV-', production_in: 'PRD-', transfer_in: 'TRF-', receive_internal: 'INT-', count_adjust: 'ADJ-' };

// 写一条流水，并同步批次：
//   入库 (qty>0)：新建一个批次。如果之前库存是负的，先拿这批补上欠的，剩下的才是批次余量。
//   出库 (qty<0)：按"先到期先出"(FEFO) 逐个批次扣；没有效期的排最后。
// 返回 { id, lots:[{lot_id, qty}] } —— 调用方靠它知道动了哪些批次。
export function addMove(m) {
  const ts = m.ts || now();
  const before = onHand(m.outlet_id, m.item_type, m.item_id);
  const id = ins('INSERT INTO stock_moves (ts,outlet_id,item_type,item_id,qty,unit_cost,reason,ref,note) VALUES (?,?,?,?,?,?,?,?,?)',
    ts, m.outlet_id, m.item_type, m.item_id, m.qty, m.unit_cost ?? unitCost(m.item_type, m.item_id), m.reason, m.ref || '', m.note || '');
  const used = [];
  if (m.qty > 0) {
    const L = m.lot || {};
    const remaining = Math.max(0, m.qty - Math.max(0, -before));
    const lotId = ins('INSERT INTO lots (lot_no,outlet_id,item_type,item_id,qty,remaining,expiry,created_at,source,ref,supplier_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      L.lot_no || `${LOT_PREFIX[m.reason] || 'LOT-'}${id}`, m.outlet_id, m.item_type, m.item_id, m.qty, remaining, L.expiry || null, ts, m.reason, m.ref || '', L.supplier_id ?? null);
    run('INSERT INTO lot_moves (lot_id,move_id,qty) VALUES (?,?,?)', lotId, id, m.qty);
    for (const p of new Set(L.parents || [])) run('INSERT OR IGNORE INTO lot_links (parent_lot_id,child_lot_id) VALUES (?,?)', p, lotId);
    used.push({ lot_id: lotId, qty: m.qty });
  } else if (m.qty < 0) {
    let need = -m.qty;
    const lots = all(`SELECT id, remaining FROM lots WHERE outlet_id=? AND item_type=? AND item_id=? AND remaining>1e-9
                      ORDER BY expiry IS NULL, expiry, id`, m.outlet_id, m.item_type, m.item_id);
    for (const l of lots) {
      if (need <= 1e-9) break;
      const x = Math.min(need, l.remaining);
      run('UPDATE lots SET remaining=remaining-? WHERE id=?', x, l.id);
      run('INSERT INTO lot_moves (lot_id,move_id,qty) VALUES (?,?,?)', l.id, id, -x);
      used.push({ lot_id: l.id, qty: x });
      need -= x;
    }
  }
  return { id, lots: used };
}

// 按配方扣库存：做/卖 qty 个单位 → 展开配方 → 每样东西扣一条流水。
// 返回 { cost 食材成本, lots 用到的批次 id }
export function consumeRecipe(outlet, recipeId, qty, reason, ref, ts, note) {
  let cost = 0;
  const lots = [];
  for (const l of explode(recipeId, qty).values()) {
    const r = addMove({ ts, outlet_id: outlet, item_type: l.item_type, item_id: l.item_id, qty: -l.qty, unit_cost: l.unit_cost, reason, ref, note });
    cost += l.qty * l.unit_cost;
    lots.push(...r.lots.map((x) => x.lot_id));
  }
  return { cost, lots };
}

// 在途量：外部订单未到货的部分 + 内部订货未收到的部分。key 形如 "ingredient:3"
export function onOrder(outlet) {
  const out = {};
  all(`SELECT p.ingredient_id id, SUM((l.qty_packs - l.received_packs) * p.pack_qty) q
       FROM po_lines l JOIN purchase_orders o ON o.id=l.po_id JOIN packages p ON p.id=l.package_id
       WHERE o.outlet_id=? AND o.status IN ('in_progress','waiting_approval','sent','partial') AND l.qty_packs > l.received_packs
       GROUP BY p.ingredient_id`, outlet).forEach((r) => { out[`ingredient:${r.id}`] = r.q; });
  all(`SELECT l.item_type t, l.item_id id, SUM(COALESCE(l.picked_qty, l.qty)) q
       FROM internal_order_lines l JOIN internal_orders o ON o.id=l.order_id
       WHERE o.outlet_id=? AND o.status IN ('incoming','picked','shipped') GROUP BY l.item_type, l.item_id`, outlet)
    .forEach((r) => { out[`${r.t}:${r.id}`] = (out[`${r.t}:${r.id}`] || 0) + r.q; });
  return out;
}

export function stockList(outlet) {
  const memo = new Map();
  const keys = all(`
    SELECT item_type, item_id FROM stock_moves WHERE outlet_id=?1
    UNION SELECT item_type, item_id FROM par_levels WHERE outlet_id=?1`, outlet);
  const order = onOrder(outlet);
  return keys.map((k) => {
    const info = itemInfo(k.item_type, k.item_id);
    const par = get('SELECT min_qty, par_qty, location FROM par_levels WHERE outlet_id=? AND item_type=? AND item_id=?', outlet, k.item_type, k.item_id) || { min_qty: 0, par_qty: 0, location: '' };
    const q = onHand(outlet, k.item_type, k.item_id);
    const uc = unitCost(k.item_type, k.item_id, memo);
    const exp = get('SELECT MIN(expiry) e FROM lots WHERE outlet_id=? AND item_type=? AND item_id=? AND remaining>1e-9 AND expiry IS NOT NULL', outlet, k.item_type, k.item_id).e;
    return { ...k, ...info, on_hand: q, ...par, unit_cost: uc, value: q * uc, next_expiry: exp,
      on_order: order[`${k.item_type}:${k.item_id}`] || 0, low: par.min_qty > 0 && q < par.min_qty };
  }).sort((a, b) => a.item_type.localeCompare(b.item_type) || a.name_en.localeCompare(b.name_en));
}

export function setPar(p) {
  run(`INSERT INTO par_levels (outlet_id,item_type,item_id,min_qty,par_qty,location) VALUES (?,?,?,?,?,?)
       ON CONFLICT DO UPDATE SET min_qty=excluded.min_qty, par_qty=excluded.par_qty, location=excluded.location`,
    p.outlet_id, p.item_type, p.item_id, +p.min_qty || 0, +p.par_qty || 0, p.location || '');
}

export const lotsOf = (outlet, type, id) =>
  all('SELECT * FROM lots WHERE outlet_id=? AND item_type=? AND item_id=? AND remaining>1e-9 ORDER BY expiry IS NULL, expiry, id', outlet, type, id);

// ───────────────────────── 报损 ─────────────────────────
// 必须选原因 (报损报表按它汇总)。两种对象：
//   库存品 (原料 / 可入库半成品)：直接扣它自己
//   没有库存的配方 (菜品 / 不可入库半成品)：按配方展开，扣掉它用的东西 —— 比如做坏了一碗面
export function waste(w) {
  if (!(w.qty > 0)) fail('数量必须大于 0 qty must be > 0');
  if (!w.reason) fail('请选择报损原因 a waste reason is required');
  return tx(() => {
    const ref = `W${Date.now().toString(36)}`;
    const direct = w.item_type === 'ingredient' || get('SELECT stockable FROM recipes WHERE id=?', w.item_id)?.stockable;
    if (direct) addMove({ ts: w.ts, outlet_id: w.outlet_id, item_type: w.item_type, item_id: w.item_id, qty: -w.qty, reason: 'waste', ref, note: w.reason });
    else consumeRecipe(w.outlet_id, w.item_id, w.qty, 'waste', ref, w.ts, `${w.reason} · ${itemInfo('recipe', w.item_id).name_zh} ×${w.qty}`);
    return ref;
  });
}

// ───────────────────────── 调拨 ─────────────────────────
// 把出库时动到的批次"镜像"到目的地：同批号、同效期，并记下父子关系 (追溯不断链)
export function mirrorIn(dest, type, id, used, totalQty, reason, ref, ts, uc) {
  let rest = totalQty;
  for (const u of used) {
    const src = get('SELECT * FROM lots WHERE id=?', u.lot_id);
    addMove({ ts, outlet_id: dest, item_type: type, item_id: id, qty: u.qty, unit_cost: uc, reason, ref,
      lot: { lot_no: src.lot_no, expiry: src.expiry, supplier_id: src.supplier_id, parents: [src.id] } });
    rest -= u.qty;
  }
  // 出库时没有批次可扣的部分 (库存本来就是负的)，照样入库，只是追不到来源
  if (rest > 1e-9) addMove({ ts, outlet_id: dest, item_type: type, item_id: id, qty: rest, unit_cost: uc, reason, ref });
}

export function transfer(t) {
  if (t.from_outlet === t.to_outlet) fail('调出和调入不能相同 same outlet');
  if (!(t.qty > 0)) fail('数量必须大于 0 qty must be > 0');
  return tx(() => {
    const ts = t.ts || now();
    const id = ins('INSERT INTO transfers (ts,from_outlet,to_outlet,item_type,item_id,qty,note) VALUES (?,?,?,?,?,?,?)',
      ts, t.from_outlet, t.to_outlet, t.item_type, t.item_id, t.qty, t.note || '');
    const uc = unitCost(t.item_type, t.item_id);
    const out = addMove({ ts, outlet_id: t.from_outlet, item_type: t.item_type, item_id: t.item_id, qty: -t.qty, unit_cost: uc, reason: 'transfer_out', ref: `T${id}` });
    mirrorIn(t.to_outlet, t.item_type, t.item_id, out.lots, t.qty, 'transfer_in', `T${id}`, ts, uc);
    return id;
  });
}

// ───────────────────────── 盘点 ─────────────────────────
// 一次盘点可以有多个分盘 (几个人同时盘不同区域)。规则：
//   · 某个品项的实盘数 = 所有分盘里它的数量之和
//   · 确认时，实盘数【覆盖】库存 (写一条 count_adjust = 实盘 − 账面)
//   · 没盘到的品项保持不变；想清零必须明确盘成 0
export function createCount(outlet) {
  if (get("SELECT id FROM stock_counts WHERE outlet_id=? AND status='open'", outlet)) fail('已有一张未完成的盘点单 an open count already exists');
  return tx(() => {
    const id = ins('INSERT INTO stock_counts (outlet_id, created_at) VALUES (?,?)', outlet, now());
    ins('INSERT INTO count_subs (count_id,name) VALUES (?,?)', id, '分盘 1');
    return id;
  });
}
export function addSubCount(countId, name) {
  const c = get('SELECT * FROM stock_counts WHERE id=?', countId);
  if (!c || c.status !== 'open') fail('盘点单已关闭 count is closed');
  const n = get('SELECT COUNT(*) n FROM count_subs WHERE count_id=?', countId).n;
  return ins('INSERT INTO count_subs (count_id,name) VALUES (?,?)', countId, name || `分盘 ${n + 1}`);
}
export function saveSubCount(countId, subId, entries) {
  const c = get('SELECT * FROM stock_counts WHERE id=?', countId);
  if (!c || c.status !== 'open') fail('盘点单已关闭 count is closed');
  if (!get('SELECT id FROM count_subs WHERE id=? AND count_id=?', subId, countId)) fail('分盘不存在 sub-count not found');
  tx(() => {
    run('DELETE FROM count_entries WHERE sub_id=?', subId);
    for (const e of entries || []) {
      if (e.qty === '' || e.qty == null || isNaN(+e.qty)) continue;
      ins('INSERT INTO count_entries (sub_id,item_type,item_id,qty) VALUES (?,?,?,?)', subId, e.item_type, e.item_id, +e.qty);
    }
  });
}
export function getCount(id) {
  const c = get('SELECT * FROM stock_counts WHERE id=?', id) || fail('盘点单不存在 count not found');
  c.subs = all('SELECT * FROM count_subs WHERE count_id=? ORDER BY id', id).map((s) => ({ ...s, entries: all('SELECT item_type,item_id,qty FROM count_entries WHERE sub_id=?', s.id) }));
  if (c.status === 'open') {
    const totals = {};
    for (const s of c.subs) for (const e of s.entries) totals[`${e.item_type}:${e.item_id}`] = (totals[`${e.item_type}:${e.item_id}`] || 0) + e.qty;
    c.lines = stockList(c.outlet_id).map((s) => ({ item_type: s.item_type, item_id: s.item_id, name_zh: s.name_zh, name_en: s.name_en, unit: s.unit,
      location: s.location, expected: s.on_hand, unit_cost: s.unit_cost, counted: totals[`${s.item_type}:${s.item_id}`] ?? null }));
  } else {
    c.lines = all('SELECT * FROM count_lines WHERE count_id=?', id).map((l) => ({ ...l, ...itemInfo(l.item_type, l.item_id) }));
  }
  return c;
}
export function confirmCount(id, ts) {
  const c = getCount(id);
  if (c.status !== 'open') fail('盘点单已关闭 count is closed');
  tx(() => {
    const t = ts || now();
    for (const l of c.lines) {
      if (l.counted == null) continue; // 没盘的不动
      ins('INSERT INTO count_lines (count_id,item_type,item_id,expected,counted,unit_cost) VALUES (?,?,?,?,?,?)', id, l.item_type, l.item_id, l.expected, l.counted, l.unit_cost);
      const diff = l.counted - l.expected;
      if (Math.abs(diff) > 1e-9)
        addMove({ ts: t, outlet_id: c.outlet_id, item_type: l.item_type, item_id: l.item_id, qty: diff, unit_cost: l.unit_cost, reason: 'count_adjust', ref: `C${id}` });
    }
    run("UPDATE stock_counts SET status='approved', approved_at=? WHERE id=?", t, id);
  });
}

// ───────────────────────── 追溯 ─────────────────────────
// 输入批号 → 往上找来源 (它是用哪些批次做的 / 从哪调来的 / 哪个供应商)
//           往下找去向 (被做成了什么、发到了哪家店、哪天卖掉的)
export function trace(lotNo) {
  const roots = all('SELECT * FROM lots WHERE lot_no=? ORDER BY id', lotNo);
  if (!roots.length) fail('找不到这个批号 lot not found');
  const memo = new Map();
  const describe = (l) => {
    const info = itemInfo(l.item_type, l.item_id);
    const outlet = get('SELECT name_zh, name_en FROM outlets WHERE id=?', l.outlet_id);
    const supplier = l.supplier_id ? get('SELECT name FROM suppliers WHERE id=?', l.supplier_id)?.name : null;
    // 这个批次的去向：按原因汇总出库量
    const usage = all(`SELECT m.reason, -SUM(lm.qty) qty, MIN(substr(m.ts,1,10)) first_day, MAX(substr(m.ts,1,10)) last_day
                       FROM lot_moves lm JOIN stock_moves m ON m.id=lm.move_id WHERE lm.lot_id=? AND lm.qty<0 GROUP BY m.reason`, l.id);
    return { id: l.id, lot_no: l.lot_no, item_type: l.item_type, item_id: l.item_id, name_zh: info.name_zh, name_en: info.name_en, unit: info.unit,
      outlet_zh: outlet.name_zh, outlet_en: outlet.name_en, supplier, qty: l.qty, remaining: l.remaining, expiry: l.expiry,
      created_at: l.created_at, source: l.source, ref: l.ref, usage };
  };
  const walk = (lot, dir, seen) => {
    if (seen.has(lot.id)) return null;
    seen.add(lot.id);
    const next = dir === 'up'
      ? all('SELECT l.* FROM lot_links k JOIN lots l ON l.id=k.parent_lot_id WHERE k.child_lot_id=?', lot.id)
      : all('SELECT l.* FROM lot_links k JOIN lots l ON l.id=k.child_lot_id WHERE k.parent_lot_id=?', lot.id);
    if (!memo.has(lot.id)) memo.set(lot.id, describe(lot));
    return { ...memo.get(lot.id), children: next.map((n) => walk(n, dir, seen)).filter(Boolean) };
  };
  return {
    lot_no: lotNo,
    backward: roots.map((r) => walk(r, 'up', new Set())),
    forward: roots.map((r) => walk(r, 'down', new Set())),
  };
}
export const recentLots = (outlet) =>
  all('SELECT * FROM lots WHERE outlet_id=? ORDER BY id DESC LIMIT 60', outlet).map((l) => ({ ...l, ...itemInfo(l.item_type, l.item_id) }));

