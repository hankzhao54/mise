// 报表：全部是对台账 (stock_moves) 和销售表的查询，不存任何中间结果
import { all, get } from '../db.js';
import { dayAdd, itemInfo, settings, today, unitCost, recipeCost } from './core.js';
import { stockList } from './stock.js';
import { menuEngineering, salesDashboard } from './sales.js';

// 流水原因 → 报表列
const COL = { receive: 'ordered', production_in: 'created_in', transfer_in: 'moved_in', receive_internal: 'moved_in', sale: 'sold',
  production_out: 'created_out', transfer_out: 'moved_out', shipped_out: 'shipped_out', waste: 'wasted' };
const COLS = ['ordered', 'created_in', 'moved_in', 'sold', 'created_out', 'moved_out', 'shipped_out', 'wasted', 'gain', 'loss'];

// 期间库存报表 (Stock over period)：
//   期初 + 进 (收货、生产入库、调入、盘盈) − 出 (销售、生产领料、调出、内部发货、报损、盘亏) = 期末
// 每一项都能在台账里找到对应的流水，所以这个等式一定成立。
// 金额统一按【当前】单位成本折算 (真实系统会用当时的成本，这里从简)。
export function stockPeriod(outlet, from, to) {
  const memo = new Map(), map = new Map();
  for (const m of all(`SELECT item_type, item_id, reason, substr(ts,1,10) day, qty FROM stock_moves WHERE outlet_id=? AND substr(ts,1,10)<=?`, outlet, to)) {
    const k = `${m.item_type}:${m.item_id}`;
    if (!map.has(k)) map.set(k, { item_type: m.item_type, item_id: m.item_id, opening: 0, closing: 0, ...Object.fromEntries(COLS.map((c) => [c, 0])) });
    const r = map.get(k);
    r.closing += m.qty;
    if (m.day < from || m.reason === 'opening') { r.opening += m.qty; continue; }
    const col = m.reason === 'count_adjust' ? (m.qty >= 0 ? 'gain' : 'loss') : COL[m.reason];
    if (col) r[col] += m.qty;
  }
  const rows = [...map.values()].map((r) => {
    const info = itemInfo(r.item_type, r.item_id), uc = unitCost(r.item_type, r.item_id, memo);
    return { ...r, ...info, unit_cost: uc, opening_value: r.opening * uc, closing_value: r.closing * uc };
  }).sort((a, b) => a.item_type.localeCompare(b.item_type) || a.name_en.localeCompare(b.name_en));
  const value = Object.fromEntries(['opening', 'closing', ...COLS].map((c) => [c, rows.reduce((s, r) => s + r[c] * r.unit_cost, 0)]));
  return { rows, value };
}

// 管理报表 (毛利报告)：把库存变动和销售放在一起看
//   理论成本 = 销售按配方扣掉的货值 (上表的 sold)
//   净差异   = 盘盈 − 盘亏
//   实际成本 = 理论成本 + 报损 − 净差异
//   理论/实际成本率 = 成本 ÷ 净营业额；两者之差就是"配方算出来该赚的"和"实际赚到的"的差距
export function managementFigures(outlet, from, to) {
  const v = stockPeriod(outlet, from, to).value;
  const netSales = salesDashboard(outlet, from, to).totals.revenue;
  const theoretical = -v.sold, wasted = -v.wasted, positive = v.gain, negative = -v.loss, net = positive - negative;
  const actual = theoretical + wasted - net;
  const pct = (x) => (netSales ? x / netSales : null);
  return {
    movement: { opening: v.opening, goods_received: v.ordered, created_in: v.created_in, transfers_in: v.moved_in, sold: v.sold, created_out: v.created_out,
      transfers_out: v.moved_out, shipped_out: v.shipped_out, wasted: v.wasted, net_variance: net, closing: v.closing },
    variance: { positive, negative, net },
    profit: { net_sales: netSales, theoretical_cost: theoretical, actual_cost: actual, theoretical_pct: pct(theoretical), actual_pct: pct(actual),
      theoretical_gp: netSales ? 1 - pct(theoretical) : null, actual_gp: netSales ? 1 - pct(actual) : null,
      diff_cost: actual - theoretical, diff_pct: netSales ? pct(actual) - pct(theoretical) : null },
  };
}
export const managementAllOutlets = (from, to) =>
  all('SELECT * FROM outlets ORDER BY id').map((o) => ({ outlet_id: o.id, name_zh: o.name_zh, name_en: o.name_en, ...managementFigures(o.id, from, to) }));

// 盘点差异：哪些东西账实不符、值多少钱。负数 = 账上有、实际没有。
export function countVariance(outlet, from, to) {
  const memo = new Map();
  const rows = all(`SELECT item_type, item_id, SUM(qty) adjust,
      -SUM(CASE WHEN reason IN ('sale','production_out') THEN qty ELSE 0 END) theoretical,
      -SUM(CASE WHEN reason='waste' THEN qty ELSE 0 END) waste,
      SUM(CASE WHEN reason='count_adjust' THEN qty ELSE 0 END) variance
    FROM stock_moves WHERE outlet_id=? AND substr(ts,1,10) BETWEEN ? AND ? GROUP BY item_type, item_id`, outlet, from, to)
    .filter((r) => r.theoretical || r.waste || r.variance)
    .map((r) => {
      const uc = unitCost(r.item_type, r.item_id, memo);
      return { ...r, ...itemInfo(r.item_type, r.item_id), unit_cost: uc, actual: r.theoretical + r.waste - r.variance,
        variance_value: r.variance * uc, variance_pct: r.theoretical ? -r.variance / r.theoretical : null };
    }).sort((a, b) => a.variance_value - b.variance_value);
  const counts = all(`SELECT c.id, c.approved_at, COALESCE(SUM((l.counted - l.expected) * l.unit_cost),0) value, COUNT(l.id) items
                      FROM stock_counts c LEFT JOIN count_lines l ON l.count_id=c.id
                      WHERE c.outlet_id=? AND c.status='approved' AND substr(c.approved_at,1,10) BETWEEN ? AND ? GROUP BY c.id ORDER BY c.approved_at`, outlet, from, to);
  return { rows, counts };
}

// 报损报表：按原因、按品项汇总
export function wasteReport(outlet, from, to) {
  const memo = new Map();
  const moves = all(`SELECT * FROM stock_moves WHERE outlet_id=? AND reason='waste' AND substr(ts,1,10) BETWEEN ? AND ? ORDER BY ts DESC`, outlet, from, to)
    .map((m) => ({ ...m, ...itemInfo(m.item_type, m.item_id), value: -m.qty * unitCost(m.item_type, m.item_id, memo), cause: (m.note || '').split(' · ')[0] || '—' }));
  const group = (key) => {
    const g = new Map();
    for (const m of moves) { const k = key(m); const c = g.get(k) || { key: k, value: 0, events: 0, name_zh: m.name_zh, name_en: m.name_en }; c.value += m.value; c.events++; g.set(k, c); }
    return [...g.values()].sort((a, b) => b.value - a.value);
  };
  return { total: moves.reduce((s, m) => s + m.value, 0), by_reason: group((m) => m.cause), by_item: group((m) => `${m.item_type}:${m.item_id}`), moves: moves.slice(0, 200) };
}

export function dashboard(outlet) {
  const to = today(), from = dayAdd(to, -6);
  const sd = salesDashboard(outlet, from, to);
  const stock = stockList(outlet);
  const soon = dayAdd(to, 2);
  return { from, to, days: sd.days, totals: sd.totals, top: menuEngineering(outlet, from, to).rows.slice(0, 5),
    stock_value: stock.reduce((s, r) => s + Math.max(0, r.value), 0),
    low: stock.filter((s) => s.low),
    expiring: stock.filter((s) => s.next_expiry && s.next_expiry <= soon && s.on_hand > 0),
    open_orders: get("SELECT COUNT(*) n FROM purchase_orders WHERE outlet_id=? AND status IN ('in_progress','sent','partial')", outlet).n,
    waiting_approval: get("SELECT COUNT(*) n FROM purchase_orders WHERE outlet_id=? AND status='waiting_approval'", outlet).n,
    incoming_internal: get("SELECT COUNT(*) n FROM internal_orders WHERE supplier_outlet_id=? AND status='incoming'", outlet).n,
    active_plans: get("SELECT COUNT(*) n FROM production_plans WHERE outlet_id=? AND status='active'", outlet).n };
}
