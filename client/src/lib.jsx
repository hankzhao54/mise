// 前端公用：请求、中英文、格式化、几个小组件
import { createContext, useCallback, useContext, useEffect, useState } from 'react';

async function req(method, url, body) {
  const r = await fetch('/api' + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
export const api = { get: (u) => req('GET', u), post: (u, b) => req('POST', u, b || {}), put: (u, b) => req('PUT', u, b), del: (u) => req('DELETE', u) };

// 常用词放在字典里 (t)，只出现一次的文案直接写 L('中文', 'English')
const T = {
  dashboard: ['总览', 'Dashboard'], ingredients: ['原料', 'Ingredients'], recipes: ['配方', 'Recipes'], menus: ['菜单', 'Menus'], suppliers: ['供应商', 'Suppliers'],
  stock: ['库存', 'Stock'], counts: ['盘点', 'Counts'], orders: ['订货', 'Ordering'], internal: ['内部订货', 'Internal orders'], production: ['生产计划', 'Production plan'],
  tasks: ['任务与 HACCP', 'Tasks & HACCP'], sales: ['销售与 POS', 'Sales & POS'], salesdash: ['销售看板', 'Sales dashboard'], menu: ['菜单工程', 'Menu engineering'],
  insights: ['管理报表', 'Management figures'], trace: ['批次追溯', 'Traceability'], settings: ['设置', 'Settings'],
  g_products: ['产品', 'Products'], g_procurement: ['采购', 'Procurement'], g_inventory: ['库存', 'Inventory'], g_planning: ['计划', 'Planning'], g_sales: ['销售', 'Sales'], g_insights: ['洞察', 'Insights'],
  name: ['名称', 'Name'], name_zh: ['中文名', 'Chinese name'], name_en: ['英文名', 'English name'], category: ['类别', 'Category'], unit: ['单位', 'Unit'],
  base_unit: ['基础单位', 'Base unit'], unit_cost: ['单位成本', 'Unit cost'], allergens: ['过敏原', 'Allergens'], packages: ['采购包装', 'Packages'],
  supplier: ['供应商', 'Supplier'], label: ['包装', 'Package'], pack_qty: ['含量', 'Pack size'], price: ['价格', 'Price'],
  add: ['新增', 'Add'], save: ['保存', 'Save'], cancel: ['取消', 'Cancel'], del: ['删除', 'Delete'], edit: ['编辑', 'Edit'], close: ['关闭', 'Close'], confirm: ['确认', 'Confirm'],
  contact: ['邮箱', 'Email'], lead_days: ['交货天数', 'Lead days'], kind: ['类型', 'Type'], prep: ['半成品', 'Prep'], dish: ['菜品', 'Dish'], all: ['全部', 'All'],
  yield: ['产出量', 'Yield'], sell_price: ['含税售价', 'Price incl. VAT'], vat: ['税率 %', 'VAT %'], cost: ['成本', 'Cost'],
  food_cost: ['食材成本率', 'Food cost %'], margin: ['毛利率', 'Margin'], net_price: ['去税售价', 'Net price'],
  lines: ['用料', 'Ingredients'], qty: ['数量', 'Qty'], waste_pct: ['损耗 %', 'Waste %'], gross: ['毛用量', 'Gross qty'],
  ingredient: ['原料', 'Ingredient'], add_line: ['加一行', 'Add line'],
  on_hand: ['现存', 'On hand'], on_order: ['在途', 'On order'], min: ['最低量', 'Min'], par: ['Par', 'Par'], value: ['金额', 'Value'], status: ['状态', 'Status'],
  low: ['低于最低量', 'Below min'], ok: ['正常', 'OK'], ledger: ['流水', 'Ledger'], waste: ['报损', 'Waste'], transfer: ['调拨', 'Transfer'],
  note: ['备注', 'Remarks'], time: ['时间', 'Time'], reason: ['原因', 'Reason'], ref: ['单号', 'Ref'], item: ['品项', 'Item'], location: ['储位', 'Storage location'],
  expected: ['账面', 'Theoretical'], counted: ['实盘', 'Counted'], diff: ['差异', 'Variance'],
  open: ['进行中', 'Open'], approved: ['已确认', 'Confirmed'], created: ['创建时间', 'Created'],
  need: ['需要', 'Needed'], packs: ['件数', 'Packs'], total: ['合计', 'Total'], receive: ['收货', 'Receive'],
  date: ['日期', 'Date'], short: ['缺口', 'Short'], recipe: ['配方', 'Recipe'], sold: ['销量', 'Sold'], revenue: ['营业额', 'Revenue'], net_revenue: ['净营业额', 'Net revenue'],
  from: ['从', 'From'], to: ['到', 'To'], empty: ['暂无数据', 'No data'], confirm_del: ['确定删除？', 'Delete this?'], saved: ['已保存', 'Saved'], done_: ['已完成', 'Done'],
  mix: ['销量占比', 'Mix %'], unit_margin: ['单份毛利', 'Unit margin'], total_margin: ['总毛利', 'Total margin'], cls: ['分类', 'Class'],
  star: ['明星', 'Star'], plowhorse: ['耕马', 'Plowhorse'], puzzle: ['谜题', 'Puzzle'], dog: ['瘦狗', 'Dog'], popularity: ['销量', 'Popularity'],
  stock_value: ['库存金额', 'Stock value'], expiry: ['效期', 'Expiry'], lot: ['批号', 'Lot'], view: ['查看', 'View'], assignee: ['负责人', 'Assignee'],
  // 库存流水原因
  opening: ['期初', 'Opening'], sale: ['销售', 'Sale'], production_in: ['生产入库', 'Created in'], production_out: ['生产领料', 'Created out'],
  transfer_in: ['调入', 'Moved in'], transfer_out: ['调出', 'Moved out'], count_adjust: ['盘点调整', 'Count variance'],
  receive_internal: ['内部收货', 'Internal receipt'], shipped_out: ['内部发货', 'Shipped out'],
  // 订单状态
  in_progress: ['购物车', 'In progress'], waiting_approval: ['待审批', 'Waiting for approval'], rejected: ['被拒绝', 'Rejected'], sent: ['已发送', 'Sent'],
  partial: ['部分到货', 'Partly delivered'], delivered: ['已到货', 'Delivered'],
  incoming: ['新订单', 'Incoming'], picked: ['已拣货', 'Picked'], shipped: ['已发货', 'Shipped'], received: ['已收货', 'Received'],
  draft: ['草稿', 'Draft'], active: ['进行中', 'Active'], done: ['已完成', 'Done'], todo: ['待做', 'To do'], doing: ['进行中', 'In progress'],
  overdue: ['逾期', 'Overdue'],
  portion: ['份', 'portion'], pc: ['个', 'pc'],
  // HACCP 类型
  temperature: ['温度检查', 'Temperature check'], general: ['一般任务', 'General task'], checklist: ['清单任务', 'Checklist'], cleaning: ['清洁消毒', 'Cleaning & sanitation'],
  packaging: ['包装', 'Packaging'], maintenance: ['设备维护', 'Maintenance'], pest: ['虫害控制', 'Pest control'], facility: ['设施管理', 'Facility'],
  chemical: ['化学品管控', 'Chemical control'], training: ['培训', 'Training'], traceability: ['追溯与召回', 'Traceability & recall'], order: ['订货', 'Order'], count: ['盘点', 'Count'],
  delivery: ['收货验收', 'Delivery & receipt'], storage: ['储存', 'Storage'], preparation: ['备料', 'Preparation'], processing: ['加工', 'Processing'], cooking: ['烹制', 'Cooking'],
  reheating: ['复热', 'Reheating'], service: ['出品', 'Service'], display: ['陈列', 'Food display'], other: ['其他', 'Other'],
  inactive: ['停用', 'Inactive'], once: ['一次', 'Once'], daily: ['每天', 'Daily'], weekly: ['每周', 'Weekly'], monthly: ['每月', 'Monthly'],
};

export const Ctx = createContext(null);
export const useApp = () => useContext(Ctx);
export function makeI18n(lang) {
  const i = lang === 'zh' ? 0 : 1;
  return {
    t: (k) => (T[k] ? T[k][i] : k),
    L: (zh, en) => (i === 0 ? zh : en),
    N: (x) => (x ? (i === 0 ? x.name_zh : x.name_en) || x.name_zh || x.name_en : ''),
    u: (unit) => (T[unit] && (unit === 'portion' || unit === 'pc') ? T[unit][i] : unit),
  };
}

const nf = (d) => new Intl.NumberFormat('hu-HU', { maximumFractionDigits: d, minimumFractionDigits: 0 });
export const money = (v, d = 0) => (v == null || isNaN(v) ? '–' : nf(Math.abs(v) < 100 && d === 0 ? 2 : d).format(v) + ' Ft');
export const num = (v, d = 1) => (v == null || isNaN(v) ? '–' : nf(d).format(v));
export const pct = (v) => (v == null || isNaN(v) ? '–' : (v * 100).toFixed(1) + '%');
// 库存量显示：大数自动换成 kg / L，方便阅读
export function qtyFmt(v, unit, u = (x) => x) {
  if (v == null) return '–';
  if (unit === 'g' && Math.abs(v) >= 1000) return num(v / 1000, 2) + ' kg';
  if (unit === 'ml' && Math.abs(v) >= 1000) return num(v / 1000, 2) + ' L';
  return num(v, 1) + ' ' + u(unit);
}
// 本机时区的日期 (和服务器端 today() 一致)
export const daysAgo = (n) => { const d = new Date(Date.now() - n * 864e5); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const ts = (s) => (s || '').slice(0, 16).replace('T', ' ');

export function useLoad(fn, deps) {
  const [data, setData] = useState(null);
  const [tick, setTick] = useState(0);
  const { flash } = useApp();
  useEffect(() => { let on = true; fn().then((d) => on && setData(d)).catch((e) => flash(e.message, true)); return () => { on = false; }; }, [...deps, tick]);
  return [data, useCallback(() => setTick((x) => x + 1), [])];
}
// 包一层：执行 → 成功提示 → 失败提示。返回是否成功。
export function useAct() {
  const { flash, t } = useApp();
  return async (fn, msg) => {
    try { const r = await fn(); if (msg !== false) flash(msg || t('saved')); return r ?? true; } catch (e) { flash(e.message, true); return false; }
  };
}

// 弹窗可以叠放 (比如计划里的"完成"对话框)：Esc 只关最上面那个
const modalStack = [];
export function Modal({ title, onClose, children, wide }) {
  useEffect(() => {
    const me = {};
    modalStack.push(me);
    const h = (e) => e.key === 'Escape' && modalStack[modalStack.length - 1] === me && onClose();
    window.addEventListener('keydown', h);
    return () => { window.removeEventListener('keydown', h); modalStack.splice(modalStack.indexOf(me), 1); };
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={'modal' + (wide ? ' wide' : '')} role="dialog" aria-modal="true">
        <div className="modal-head"><h2>{title}</h2><button className="ghost" onClick={onClose} aria-label="close">✕</button></div>
        {children}
      </div>
    </div>
  );
}
export const Field = ({ label, hint, children }) => <label className="field"><span>{label}</span>{children}{hint && <em>{hint}</em>}</label>;
export const Page = ({ title, actions, children }) => (
  <div className="page"><div className="page-head"><h1>{title}</h1><div className="row">{actions}</div></div>{children}</div>
);
export const Empty = ({ text }) => { const { t } = useApp(); return <div className="empty">{text || t('empty')}</div>; };
export const Kpi = ({ label, value, sub, tone }) => (
  <div className={'kpi ' + (tone || '')}><div className="kpi-label">{label}</div><div className="kpi-value">{value}</div>{sub && <div className="kpi-sub">{sub}</div>}</div>
);
export const Tabs = ({ value, onChange, tabs }) => (
  <div className="tabs" role="tablist">{tabs.map(([k, label, badge]) => (
    <button key={k} role="tab" aria-selected={value === k} className={value === k ? 'on' : ''} onClick={() => onChange(k)}>{label}{badge ? <span className="badge">{badge}</span> : null}</button>))}</div>
);
const TONE = { sent: 'accent', partial: 'accent', delivered: 'good', waiting_approval: 'warn', rejected: 'bad', in_progress: 'soft', incoming: 'warn', picked: 'accent', shipped: 'accent', received: 'good',
  draft: 'soft', active: 'accent', done: 'good', open: 'accent', approved: 'good', overdue: 'bad', todo: 'soft', doing: 'accent' };
export const Status = ({ s }) => { const { t } = useApp(); return <span className={'tag ' + (TONE[s] || 'soft')}>{t(s)}</span>; };
export const Note = ({ children }) => <div className="note">{children}</div>;
export function Range({ from, to, set }) {
  const { t } = useApp();
  return (<div className="row">
    <Field label={t('from')}><input type="date" value={from} onChange={(e) => set(e.target.value, to)} /></Field>
    <Field label={t('to')}><input type="date" value={to} onChange={(e) => set(from, e.target.value)} /></Field>
  </div>);
}
// 品项下拉：值是 "ingredient:3" 这样的组合键
export function ItemSelect({ value, onChange, items }) {
  const { N, t, L } = useApp();
  return (
    <select value={value || ''} onChange={(e) => onChange(e.target.value)}>
      <option value="">—</option>
      {['ingredient', 'recipe'].map((g) => items.some((i) => i.item_type === g) && (
        <optgroup key={g} label={g === 'ingredient' ? t('ingredient') : t('prep')}>
          {items.filter((i) => i.item_type === g).map((i) => <option key={i.item_id} value={`${g}:${i.item_id}`}>{N(i)}{g === 'recipe' && i.stockable === 0 ? L(' (现做)', ' (made to order)') : ''}</option>)}
        </optgroup>))}
    </select>
  );
}
export const splitKey = (k) => { const [item_type, id] = (k || ':').split(':'); return { item_type, item_id: +id }; };
export const itemKey = (x) => `${x.item_type}:${x.item_id}`;
