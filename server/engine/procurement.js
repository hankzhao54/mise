// 采购：订货建议 (par / 预测)、订单与审批、收货与发票核对、内部订货
import { all, get, ins, run, tx } from '../db.js';
import { dayAdd, explode, fail, itemInfo, now, recipeCost, settings, today, unitCost } from './core.js';
import { addMove, mirrorIn, onHand, onOrder, stockList } from './stock.js';

// 订货用哪个包装：优先"最近订过的"，否则最便宜的；只在可订货的包装里选
function orderingPackage(ingredientId) {
  return get(`SELECT p.*, s.name supplier_name FROM packages p JOIN suppliers s ON s.id=p.supplier_id
              WHERE p.ingredient_id=? AND p.orderable=1
              ORDER BY p.last_ordered_at IS NULL, p.last_ordered_at DESC, p.price/p.pack_qty ASC LIMIT 1`, ingredientId);
}
const supplierOutlet = (outlet) => get('SELECT * FROM outlets WHERE is_supplier=1 AND id<>? ORDER BY id LIMIT 1', outlet);

// 把一堆"需要补的量"整理成建议：
//   原料           → 按供应商分组，数量向上取整到整包
//   可入库的半成品 → 普通门店：向内部供应商(中央厨房)下内部订单；内部供应商自己：去排生产
function buildSuggestions(outlet, needs) {
  const groups = new Map(), internal = [];
  const kitchen = supplierOutlet(outlet);
  for (const n of needs) {
    if (!(n.need > 1e-9)) continue;
    if (n.item_type === 'ingredient') {
      const pkg = orderingPackage(n.item_id);
      if (!pkg) continue;
      const packs = Math.max(1, Math.ceil(n.need / pkg.pack_qty - 1e-9));
      if (!groups.has(pkg.supplier_id)) groups.set(pkg.supplier_id, { supplier_id: pkg.supplier_id, supplier_name: pkg.supplier_name, lines: [], total: 0 });
      const g = groups.get(pkg.supplier_id);
      g.lines.push({ ...n, package_id: pkg.id, label: pkg.label, pack_qty: pkg.pack_qty, qty_packs: packs, price: pkg.price });
      g.total += packs * pkg.price;
    } else if (kitchen && !get('SELECT is_supplier FROM outlets WHERE id=?', outlet).is_supplier) {
      internal.push({ ...n, qty: Math.ceil(n.need - 1e-9) });
    }
  }
  for (const g of groups.values()) {
    const s = get('SELECT min_order FROM suppliers WHERE id=?', g.supplier_id);
    g.min_order = s.min_order;
    g.below_min = s.min_order > 0 && g.total < s.min_order;
  }
  return { suppliers: [...groups.values()], internal: internal.length ? { supplier_outlet_id: kitchen.id, supplier_zh: kitchen.name_zh, supplier_en: kitchen.name_en, lines: internal } : null };
}

// 方式一：补到 par。  可用量 = 现存 + 在途；低于最低量才触发，补到 par。
export function parSuggestions(outlet) {
  const needs = stockList(outlet).filter((s) => s.min_qty > 0 && s.on_hand + s.on_order < s.min_qty)
    .map((s) => ({ item_type: s.item_type, item_id: s.item_id, name_zh: s.name_zh, name_en: s.name_en, unit: s.unit,
      on_hand: s.on_hand, on_order: s.on_order, min_qty: s.min_qty, par_qty: s.par_qty, need: s.par_qty - s.on_hand - s.on_order }));
  return buildSuggestions(outlet, needs);
}

// 方式二：需求预测。不看 par，从销售历史"自上而下"推：
//   1. 未来 N 天每一天，取同一个星期几的历史销量 (上周同日 / 近 4 周平均)
//   2. 乘以缩放比例 (130% = 预计旺季；105% = 留 5% 安全余量)
//   3. 按配方展开成原料和半成品的用量
//   4. 可选：减去现存、减去在途
export function forecastSuggestions(outlet, opt = {}) {
  const days = Math.max(1, Math.min(14, +opt.days || 3));
  const scale = (+opt.scale || 100) / 100;
  const src = opt.source === 'last_week' ? 'last_week' : 'avg4';
  const start = opt.start || dayAdd(today(), 1);
  const dishQty = new Map();
  for (let i = 0; i < days; i++) {
    const d = dayAdd(start, i);
    const back = src === 'last_week' ? [7] : [7, 14, 21, 28];
    // 只在有数据的那些周上取平均 (历史不足 4 周时不会被稀释)
    const weeks = back.map((b) => dayAdd(d, -b)).filter((p) => get('SELECT 1 x FROM sales WHERE outlet_id=? AND day=? LIMIT 1', outlet, p));
    if (!weeks.length) continue;
    const rows = all(`SELECT recipe_id, SUM(qty) q FROM sales WHERE outlet_id=? AND recipe_id IS NOT NULL AND day IN (${weeks.map(() => '?').join(',')}) GROUP BY recipe_id`, outlet, ...weeks);
    for (const r of rows) dishQty.set(r.recipe_id, (dishQty.get(r.recipe_id) || 0) + (r.q / weeks.length) * scale);
  }
  const need = new Map(), memo = new Map();
  for (const [rid, q] of dishQty) explode(rid, q, need, memo);
  const order = onOrder(outlet);
  const needs = [...need.values()].map((n) => {
    const have = onHand(outlet, n.item_type, n.item_id), coming = order[`${n.item_type}:${n.item_id}`] || 0;
    return { item_type: n.item_type, item_id: n.item_id, name_zh: n.name_zh, name_en: n.name_en, unit: n.unit, forecast: n.qty, on_hand: have, on_order: coming,
      need: n.qty - (opt.use_stock === false ? 0 : Math.max(0, have)) - (opt.use_outstanding === false ? 0 : coming) };
  });
  return { ...buildSuggestions(outlet, needs), days, scale: scale * 100, source: src, start,
    dishes: [...dishQty].map(([id, q]) => ({ ...itemInfo('recipe', id), recipe_id: id, qty: q })) };
}

// ───────────────────────── 订单 ─────────────────────────
export function createPO(po) {
  if (!po.lines?.length) fail('订单没有行 empty order');
  return tx(() => {
    const sup = get('SELECT * FROM suppliers WHERE id=?', po.supplier_id) || fail('供应商不存在 supplier not found');
    const id = ins('INSERT INTO purchase_orders (outlet_id,supplier_id,status,created_at,delivery_fee) VALUES (?,?,?,?,?)',
      po.outlet_id, po.supplier_id, 'in_progress', now(), sup.delivery_fee);
    for (const l of po.lines) {
      const p = get('SELECT * FROM packages WHERE id=?', l.package_id) || fail('包装不存在 package not found');
      if (p.supplier_id !== po.supplier_id) fail('包装不属于该供应商 package/supplier mismatch');
      if (!(+l.qty_packs > 0)) continue;
      ins('INSERT INTO po_lines (po_id,package_id,qty_packs,price) VALUES (?,?,?,?)', id, p.id, +l.qty_packs, p.price);
    }
    return id;
  });
}
export function getPO(id) {
  const o = get(`SELECT o.*, s.name supplier_name, s.min_order FROM purchase_orders o JOIN suppliers s ON s.id=o.supplier_id WHERE o.id=?`, id) || fail('订单不存在 order not found');
  o.lines = all(`SELECT l.*, p.label, p.pack_qty, p.ingredient_id, i.name_zh, i.name_en, i.base_unit unit
                 FROM po_lines l JOIN packages p ON p.id=l.package_id JOIN ingredients i ON i.id=p.ingredient_id WHERE l.po_id=?`, id);
  o.ordered_total = o.lines.reduce((s, l) => s + l.qty_packs * l.price, 0);
  o.received_total = o.lines.reduce((s, l) => s + l.received_value, 0);
  // 发票核对：差额 = 发票金额 − 实收货值。不为 0 就要找供应商对账或开红字发票
  o.invoice_diff = o.invoice_amount != null ? o.invoice_amount - o.received_total : null;
  o.below_min = o.min_order > 0 && o.ordered_total < o.min_order;
  return o;
}
export const listPOs = (outlet) =>
  all('SELECT id FROM purchase_orders WHERE outlet_id=? ORDER BY id DESC LIMIT 100', outlet).map((r) => getPO(r.id));

// 审批规则：这家店今天已经发给这个供应商的金额 + 本单金额 > 限额 → 不发送，进入待审批。
// 限额取最具体的一层：供应商自己的 > 全局设置。正好等于限额不需要审批。
function approvalCheck(o) {
  const sup = get('SELECT approval_limit FROM suppliers WHERE id=?', o.supplier_id);
  const limit = sup.approval_limit ?? settings().approval_limit;
  if (limit == null) return null;
  const sentToday = all("SELECT id FROM purchase_orders WHERE outlet_id=? AND supplier_id=? AND id<>? AND substr(sent_at,1,10)=?", o.outlet_id, o.supplier_id, o.id, today())
    .reduce((s, r) => s + getPO(r.id).ordered_total, 0);
  return sentToday + o.ordered_total > limit ? { limit, sent_today: sentToday, total: o.ordered_total } : null;
}
function markSent(o) {
  const t = now();
  run("UPDATE purchase_orders SET status='sent', sent_at=? WHERE id=?", t, o.id);
  for (const l of o.lines) run('UPDATE packages SET last_ordered_at=? WHERE id=?', t, l.package_id);
}
export function submitPO(id) {
  const o = getPO(id);
  if (!['in_progress', 'rejected'].includes(o.status)) fail('订单已提交 already submitted');
  return tx(() => {
    const flag = approvalCheck(o);
    if (flag) {
      run("UPDATE purchase_orders SET status='waiting_approval', reject_reason='', flag_note=? WHERE id=?", JSON.stringify(flag), id);
      return { status: 'waiting_approval', flag };
    }
    markSent(o);
    return { status: 'sent', below_min: o.below_min };
  });
}
export function approvePO(id, note) {
  const o = getPO(id);
  if (o.status !== 'waiting_approval') fail('订单不在待审批状态 not waiting for approval');
  tx(() => { markSent(o); run('UPDATE purchase_orders SET approver_note=? WHERE id=?', note || '', id); });
}
export function rejectPO(id, reason) {
  if (!reason) fail('必须填写拒绝原因 a rejection reason is required');
  const o = getPO(id);
  if (o.status !== 'waiting_approval') fail('订单不在待审批状态 not waiting for approval');
  run("UPDATE purchase_orders SET status='rejected', reject_reason=? WHERE id=?", reason, id);
}
export function recallPO(id) {
  const o = getPO(id);
  if (!['waiting_approval', 'rejected'].includes(o.status)) fail('只能撤回待审批或被拒的订单 cannot recall');
  run("UPDATE purchase_orders SET status='in_progress' WHERE id=?", id);
}
export function deletePO(id) {
  const o = getPO(id);
  if (o.lines.some((l) => l.received_packs > 0)) fail('已有到货记录，不能删除 has deliveries');
  run('DELETE FROM purchase_orders WHERE id=?', id);
}

// 收货。每行三种状态：all 全到 / part 部分 (填数量) / none 没到。
//   · 可以分多次收：close=false 时订单保持打开 (partial)，下次继续收剩下的
//   · 实付单价可以和订单不同；勾了 update_price 才回写到包装价格 (一次性促销价就别勾)
//   · update_stock=false 时不加库存 —— 用于"货已经在盘点里数进去了"的情况，避免重复
export function receivePO(id, body = {}) {
  const o = getPO(id);
  if (!['sent', 'partial'].includes(o.status)) fail('订单不在可收货状态 order is not receivable');
  const lines = body.lines || [];
  tx(() => {
    const ts = body.ts || now();
    for (const l of o.lines) {
      const input = lines.find((x) => x.id === l.id) || {};
      const outstanding = l.qty_packs - l.received_packs;
      const state = input.state || 'all';
      const packs = state === 'none' ? 0 : state === 'part' ? +input.packs || 0 : outstanding;
      if (!(packs > 0)) continue;
      const price = input.price != null && input.price !== '' ? +input.price : l.price;
      run('UPDATE po_lines SET received_packs=received_packs+?, received_value=received_value+? WHERE id=?', packs, packs * price, l.id);
      if (input.update_price !== false && price !== l.price) {
        run('UPDATE packages SET price=? WHERE id=?', price, l.package_id);
        ins('INSERT INTO package_prices (package_id,ts,price,source) VALUES (?,?,?,?)', l.package_id, ts, price, `PO${id}`);
      }
      if (body.update_stock !== false)
        addMove({ ts, outlet_id: o.outlet_id, item_type: 'ingredient', item_id: l.ingredient_id, qty: packs * l.pack_qty, unit_cost: price / l.pack_qty,
          reason: 'receive', ref: `PO${id}`, lot: { lot_no: input.lot_no || undefined, expiry: input.expiry || null, supplier_id: o.supplier_id } });
    }
    const fresh = getPO(id);
    const complete = fresh.lines.every((l) => l.received_packs >= l.qty_packs - 1e-9);
    const close = body.close !== false || complete;
    run('UPDATE purchase_orders SET status=?, closed_at=? WHERE id=?', close ? 'delivered' : 'partial', close ? ts : null, id);
    saveInvoice(id, body);
  });
}
export function saveInvoice(id, b) {
  const o = get('SELECT * FROM purchase_orders WHERE id=?', id) || fail('订单不存在 order not found');
  const num = (v, d) => (v === '' || v == null ? d : +v);
  run('UPDATE purchase_orders SET invoice_no=?, invoice_amount=?, invoice_status=?, delivery_fee=? WHERE id=?',
    b.invoice_no ?? o.invoice_no, b.invoice_amount === '' ? null : num(b.invoice_amount, o.invoice_amount), b.invoice_status || o.invoice_status, num(b.delivery_fee, o.delivery_fee), id);
}

// ───────────────────────── 内部订货 ─────────────────────────
// 门店 → 中央厨房：下单 (incoming) → 厨房拣货 (picked) → 发货 (shipped，此时扣厨房库存)
//                 → 门店收货 (received，此时加门店库存，批号跟着走)
// 只能订【可入库】的半成品。
export function createInternalOrder(o) {
  const lines = (o.lines || []).filter((l) => +l.qty > 0);
  if (!lines.length) fail('订单没有行 empty order');
  const sup = get('SELECT * FROM outlets WHERE id=?', o.supplier_outlet_id);
  if (!sup?.is_supplier) fail('对方不是内部供应商 not an internal supplier');
  if (sup.id === o.outlet_id) fail('不能向自己订货 cannot order from yourself');
  return tx(() => {
    const id = ins('INSERT INTO internal_orders (outlet_id,supplier_outlet_id,created_at,note) VALUES (?,?,?,?)', o.outlet_id, sup.id, o.ts || now(), o.note || '');
    for (const l of lines) {
      if (!get('SELECT stockable FROM recipes WHERE id=?', l.item_id)?.stockable) fail('只能订可入库的半成品 only stockable recipes can be ordered internally');
      ins('INSERT INTO internal_order_lines (order_id,item_id,qty) VALUES (?,?,?)', id, l.item_id, +l.qty);
    }
    return id;
  });
}
export function getInternalOrder(id) {
  const o = get(`SELECT o.*, a.name_zh outlet_zh, a.name_en outlet_en, b.name_zh supplier_zh, b.name_en supplier_en
                 FROM internal_orders o JOIN outlets a ON a.id=o.outlet_id JOIN outlets b ON b.id=o.supplier_outlet_id WHERE o.id=?`, id) || fail('内部订单不存在 internal order not found');
  o.lines = all('SELECT * FROM internal_order_lines WHERE order_id=?', id).map((l) => ({ ...l, ...itemInfo(l.item_type, l.item_id),
    supplier_stock: onHand(o.supplier_outlet_id, l.item_type, l.item_id) }));
  return o;
}
// 一家店既可能是下单方，也可能是供货方：两个方向都列出来
export function listInternalOrders(outlet) {
  const ids = all('SELECT id, outlet_id FROM internal_orders WHERE outlet_id=?1 OR supplier_outlet_id=?1 ORDER BY id DESC LIMIT 100', outlet);
  return ids.map((r) => ({ ...getInternalOrder(r.id), role: r.outlet_id === outlet ? 'buyer' : 'supplier' }));
}
// 拣货：填每行实际拣了多少 (可以少于订的)。ship=true 时拣完直接发货。
export function pickInternalOrder(id, body = {}) {
  const o = getInternalOrder(id);
  if (!['incoming', 'picked'].includes(o.status)) fail('订单已发货 already shipped');
  tx(() => {
    for (const l of o.lines) {
      const input = (body.lines || []).find((x) => x.id === l.id);
      const picked = input && input.picked_qty !== '' && input.picked_qty != null ? Math.max(0, +input.picked_qty) : l.picked_qty ?? l.qty;
      run('UPDATE internal_order_lines SET picked_qty=? WHERE id=?', picked, l.id);
    }
    run("UPDATE internal_orders SET status='picked' WHERE id=?", id);
    if (body.ship) shipInternalOrder(id, body.ts);
  });
}
export function shipInternalOrder(id, ts) {
  const o = getInternalOrder(id);
  if (o.status !== 'picked') fail('先拣货再发货 pick before shipping');
  tx(() => {
    const t = ts || now();
    for (const l of o.lines) {
      if (!(l.picked_qty > 0)) continue;
      addMove({ ts: t, outlet_id: o.supplier_outlet_id, item_type: l.item_type, item_id: l.item_id, qty: -l.picked_qty, reason: 'shipped_out', ref: `IO${id}` });
    }
    run("UPDATE internal_orders SET status='shipped', shipped_at=? WHERE id=?", t, id);
  });
}
export function receiveInternalOrder(id, ts) {
  const o = getInternalOrder(id);
  if (o.status !== 'shipped') fail('订单还没发货 not shipped yet');
  tx(() => {
    const t = ts || now();
    for (const l of o.lines) {
      if (!(l.picked_qty > 0)) continue;
      // 找到发货那条流水动过的批次，镜像到门店
      const used = all(`SELECT lm.lot_id, -lm.qty qty FROM lot_moves lm JOIN stock_moves m ON m.id=lm.move_id
                        WHERE m.ref=? AND m.reason='shipped_out' AND m.item_type=? AND m.item_id=?`, `IO${id}`, l.item_type, l.item_id);
      mirrorIn(o.outlet_id, l.item_type, l.item_id, used, l.picked_qty, 'receive_internal', `IO${id}`, t, unitCost(l.item_type, l.item_id));
    }
    run("UPDATE internal_orders SET status='received', received_at=? WHERE id=?", t, id);
  });
}
export function deleteInternalOrder(id) {
  const o = getInternalOrder(id);
  if (!['incoming', 'picked'].includes(o.status)) fail('已发货的订单不能删除 already shipped');
  run('DELETE FROM internal_orders WHERE id=?', id);
}
// 中央厨房视角：把所有新订单按配方汇总 —— 这就是今天要生产的量
export function incomingDemand(supplierOutlet) {
  return all(`SELECT l.item_id recipe_id, SUM(l.qty) qty, COUNT(DISTINCT o.id) orders
              FROM internal_order_lines l JOIN internal_orders o ON o.id=l.order_id
              WHERE o.supplier_outlet_id=? AND o.status='incoming' GROUP BY l.item_id`, supplierOutlet)
    .map((r) => ({ ...r, ...itemInfo('recipe', r.recipe_id), on_hand: onHand(supplierOutlet, 'recipe', r.recipe_id), batch: recipeCost(r.recipe_id).yield_qty }));
}

// ───────────────────────── 物料清单 (BoM) ─────────────────────────
// "做 N 份这个配方，需要哪些东西、现在有多少、还差多少、要订几包"
export function bom(outlet, recipeId, portions) {
  const order = onOrder(outlet);
  return [...explode(recipeId, +portions || 0).values()].map((n) => {
    const have = onHand(outlet, n.item_type, n.item_id);
    const short = Math.max(0, n.qty - Math.max(0, have));
    const pkg = n.item_type === 'ingredient' ? orderingPackage(n.item_id) : null;
    return { ...n, need: n.qty, on_hand: have, on_order: order[`${n.item_type}:${n.item_id}`] || 0, short,
      package_id: pkg?.id, label: pkg?.label, supplier_id: pkg?.supplier_id, supplier_name: pkg?.supplier_name,
      qty_packs: pkg && short > 0 ? Math.ceil(short / pkg.pack_qty - 1e-9) : 0, price: pkg?.price, cost: n.qty * n.unit_cost };
  });
}
