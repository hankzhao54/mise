import { Fragment, useState } from 'react';
import { api, Empty, Field, ItemSelect, itemKey, Kpi, Modal, money, Note, num, Page, pct, qtyFmt, splitKey, Tabs, ts, useAct, useApp, useLoad } from './lib.jsx';

// ───────── 总览
export function Dashboard() {
  const { t, L, N, u, outlet } = useApp();
  const [d] = useLoad(() => api.get(`/dashboard?outlet=${outlet}`), [outlet]);
  if (!d) return null;
  const max = Math.max(1, ...d.days.map((x) => x.revenue));
  const todo = [
    [d.waiting_approval, L('张订单待审批', 'orders waiting for approval'), '#orders'],
    [d.incoming_internal, L('张内部订单待拣货', 'internal orders to pick'), '#internal'],
    [d.active_plans, L('个生产计划进行中', 'production plans active'), '#production'],
    [d.open_orders, L('张采购订单未完成', 'purchase orders open'), '#orders'],
  ].filter(([n]) => n > 0);
  return (
    <Page title={t('dashboard')}>
      <div className="kpis">
        <Kpi label={L('近 7 天净营业额', 'Net revenue, 7 days')} value={money(d.totals.revenue)} />
        <Kpi label={L('利润 (扣食材和人工)', 'Profit after prime cost')} value={money(d.totals.profit)} sub={`${L('平均毛利率', 'Avg margin')} ${pct(d.totals.avg_margin)}`} />
        <Kpi label={t('stock_value')} value={money(d.stock_value)} />
        <Kpi label={L('低库存 / 临期', 'Low stock / expiring')} value={`${d.low.length} / ${d.expiring.length}`} tone={d.low.length || d.expiring.length ? 'warn' : ''} />
      </div>
      {todo.length > 0 && <div className="todo-row">{todo.map(([n, text, href]) => <a key={text} href={href} className="todo"><b>{n}</b> {text}</a>)}</div>}
      <div className="grid2">
        <section className="card">
          <h3>{L('每日净营业额', 'Net revenue per day')}</h3>
          {d.days.length === 0 ? <Empty /> : (
            <div className="bars">
              {d.days.map((x) => (
                <div key={x.day} className="bar-col" title={`${x.day}  ${money(x.revenue)}`}>
                  <div className="bar-val">{num(x.revenue / 1000, 0)}k</div>
                  <div className="bar" style={{ height: `${(x.revenue / max) * 100}%` }} />
                  <div className="bar-lab">{x.day.slice(5)}</div>
                </div>))}
            </div>)}
        </section>
        <section className="card">
          <h3>{L('毛利贡献前五', 'Top 5 by margin')}</h3>
          {d.top.length === 0 ? <Empty /> : (
            <table><thead><tr><th>{t('dish')}</th><th className="r">{t('sold')}</th><th className="r">{t('total_margin')}</th><th className="r">{t('food_cost')}</th></tr></thead>
              <tbody>{d.top.map((r) => <tr key={r.recipe_id}><td>{N(r)}</td><td className="r">{num(r.qty, 0)}</td><td className="r">{money(r.total_margin)}</td><td className="r">{pct(r.food_cost_pct)}</td></tr>)}</tbody></table>)}
        </section>
      </div>
      <div className="grid2">
        <section className="card">
          <h3>{L('低于最低量', 'Below minimum')}</h3>
          {d.low.length === 0 ? <Empty text={L('都在最低量以上', 'Everything is above minimum')} /> : (
            <table><thead><tr><th>{t('item')}</th><th className="r">{t('on_hand')}</th><th className="r">{t('min')}</th><th className="r">{t('on_order')}</th></tr></thead>
              <tbody>{d.low.map((s) => <tr key={itemKey(s)}><td>{N(s)}</td><td className="r bad">{qtyFmt(s.on_hand, s.unit, u)}</td><td className="r">{qtyFmt(s.min_qty, s.unit, u)}</td><td className="r muted">{s.on_order ? qtyFmt(s.on_order, s.unit, u) : ''}</td></tr>)}</tbody></table>)}
        </section>
        <section className="card">
          <h3>{L('两天内到期', 'Expiring within 2 days')}</h3>
          {d.expiring.length === 0 ? <Empty text={L('没有临期批次', 'Nothing is about to expire')} /> : (
            <table><thead><tr><th>{t('item')}</th><th className="r">{t('on_hand')}</th><th>{t('expiry')}</th></tr></thead>
              <tbody>{d.expiring.map((s) => <tr key={itemKey(s)}><td>{N(s)}</td><td className="r">{qtyFmt(s.on_hand, s.unit, u)}</td><td className="bad">{s.next_expiry}</td></tr>)}</tbody></table>)}
        </section>
      </div>
    </Page>
  );
}

// ───────── 供应商
export function Suppliers() {
  const { t, L } = useApp();
  const act = useAct();
  const [rows, reload] = useLoad(() => api.get('/suppliers'), []);
  const [ed, setEd] = useState(null);
  const set = (k) => (e) => setEd({ ...ed, [k]: e.target.value });
  const save = async () => { if (await act(() => (ed.id ? api.put(`/suppliers/${ed.id}`, ed) : api.post('/suppliers', ed)))) { setEd(null); reload(); } };
  const del = async (s) => { if (confirm(t('confirm_del')) && await act(() => api.del(`/suppliers/${s.id}`))) reload(); };
  return (
    <Page title={t('suppliers')} actions={<button className="primary" onClick={() => setEd({ name: '', contact: '', lead_days: 1, min_order: 0, delivery_fee: 0, approval_limit: '' })}>+ {t('add')}</button>}>
      <section className="card">
        <table><thead><tr><th>{t('name')}</th><th>{t('contact')}</th><th className="r">{t('lead_days')}</th><th className="r">{L('最低起订额', 'Min. order')}</th><th className="r">{L('运费', 'Delivery fee')}</th><th className="r">{L('每日审批限额', 'Daily approval limit')}</th><th /></tr></thead>
          <tbody>{(rows || []).map((s) => (
            <tr key={s.id}><td><b>{s.name}</b></td><td>{s.contact}</td><td className="r">{s.lead_days}</td><td className="r">{s.min_order ? money(s.min_order) : '–'}</td>
              <td className="r">{s.delivery_fee ? money(s.delivery_fee) : '–'}</td><td className="r">{s.approval_limit != null ? money(s.approval_limit) : <span className="muted">{L('沿用全局', 'library default')}</span>}</td>
              <td className="r nowrap"><button className="link" onClick={() => setEd({ ...s, approval_limit: s.approval_limit ?? '' })}>{t('edit')}</button><button className="link danger" onClick={() => del(s)}>{t('del')}</button></td></tr>))}</tbody></table>
      </section>
      {ed && (
        <Modal title={t('supplier')} onClose={() => setEd(null)}>
          <div className="form">
            <Field label={t('name')}><input value={ed.name} onChange={set('name')} autoFocus /></Field>
            <Field label={t('contact')} hint={L('订单发到这个邮箱 (本项目不会真的发邮件)', 'Orders are emailed here (this project does not send email)')}><input value={ed.contact} onChange={set('contact')} /></Field>
            <Field label={t('lead_days')}><input type="number" min="0" value={ed.lead_days} onChange={set('lead_days')} /></Field>
            <Field label={L('最低起订额', 'Minimum order amount')} hint={L('低于它只提醒，不拦截', 'Below it you get a warning, not a block')}><input type="number" min="0" value={ed.min_order} onChange={set('min_order')} /></Field>
            <Field label={L('默认运费', 'Default delivery fee')} hint={L('单独记录，不摊进原料成本', 'Recorded separately; never added to ingredient cost')}><input type="number" min="0" value={ed.delivery_fee} onChange={set('delivery_fee')} /></Field>
            <Field label={L('每日审批限额', 'Daily approval limit')} hint={L('留空 = 沿用全局设置。当天发给它的订单总额超过限额就要审批', 'Empty = use the library setting. Orders pushing the day total above it need approval')}><input type="number" min="0" value={ed.approval_limit} onChange={set('approval_limit')} /></Field>
          </div>
          <div className="modal-foot"><button onClick={() => setEd(null)}>{t('cancel')}</button><button className="primary" disabled={!ed.name} onClick={save}>{t('save')}</button></div>
        </Modal>)}
    </Page>
  );
}

// ───────── 原料
export function Ingredients() {
  const { t, L, N, u, meta, reloadMeta } = useApp();
  const act = useAct();
  const [rows, reload] = useLoad(() => api.get('/ingredients'), []);
  const [sup] = useLoad(() => api.get('/suppliers'), []);
  const [ed, setEd] = useState(null);
  const [hist, setHist] = useState(null);
  const blankPk = () => ({ supplier_id: sup?.[0]?.id, label: '', article_no: '', pack_qty: 1000, price: 0, orderable: 1 });
  const open = async (i) => { setEd(JSON.parse(JSON.stringify({ ...i, waste_pct: i.waste_pct ?? '' }))); setHist(await api.get(`/ingredients/${i.id}/prices`)); };
  const setPk = (i, patch) => setEd({ ...ed, packages: ed.packages.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const save = async () => { if (await act(() => (ed.id ? api.put(`/ingredients/${ed.id}`, ed) : api.post('/ingredients', ed)))) { setEd(null); reload(); reloadMeta(); } };
  const del = async () => { if (confirm(t('confirm_del')) && await act(() => api.del(`/ingredients/${ed.id}`))) { setEd(null); reload(); reloadMeta(); } };
  const basis = meta.settings.cost_basis === 'last_ordered' ? L('最近订的', 'last ordered') : L('最便宜的', 'cheapest');
  return (
    <Page title={t('ingredients')} actions={<button className="primary" onClick={() => { setHist(null); setEd({ name_zh: '', name_en: '', category: '', base_unit: 'g', allergens: [], waste_pct: '', packages: [blankPk()] }); }}>+ {t('add')}</button>}>
      <Note>{L(`成本按「${basis}」包装的单位价计算（可在设置里切换）。`, `Cost uses the ${basis} package's unit price (switch it in Settings).`)}</Note>
      <section className="card">
        <table><thead><tr><th>{t('name')}</th><th>{t('category')}</th><th>{L('计价包装', 'Costing package')}</th><th className="r">{t('price')}</th><th className="r">{t('unit_cost')}</th><th className="r">{t('waste_pct')}</th><th>{t('allergens')}</th></tr></thead>
          <tbody>{(rows || []).map((i) => {
            const p = i.packages.find((x) => x.id === i.costing_package_id);
            return (
              <tr key={i.id} className="click" onClick={() => open(i)}>
                <td><b>{N(i)}</b></td><td>{i.category}</td>
                <td>{p ? `${p.supplier_name} · ${p.label}` : '–'}{i.packages.length > 1 && <span className="muted"> +{i.packages.length - 1}</span>}</td>
                <td className="r">{p ? money(p.price) : '–'}</td>
                <td className="r">{num(i.unit_cost, 3)} Ft/{u(i.base_unit)}</td>
                <td className="r">{i.waste_pct != null ? i.waste_pct + '%' : <span className="muted">{meta.settings.default_waste_pct}%</span>}</td>
                <td>{i.allergens.map((a) => <span key={a} className="tag">{a}</span>)}</td>
              </tr>);
          })}</tbody></table>
      </section>
      {ed && (
        <Modal title={ed.id ? N(ed) : t('add')} onClose={() => setEd(null)} wide>
          <div className="form cols">
            <Field label={t('name_zh')}><input value={ed.name_zh} onChange={(e) => setEd({ ...ed, name_zh: e.target.value })} autoFocus /></Field>
            <Field label={t('name_en')}><input value={ed.name_en} onChange={(e) => setEd({ ...ed, name_en: e.target.value })} /></Field>
            <Field label={t('category')}><input value={ed.category} onChange={(e) => setEd({ ...ed, category: e.target.value })} /></Field>
            <Field label={t('base_unit')}><select value={ed.base_unit} onChange={(e) => setEd({ ...ed, base_unit: e.target.value })}>{['g', 'ml', 'pc'].map((x) => <option key={x} value={x}>{u(x)}</option>)}</select></Field>
            <Field label={L('默认备料损耗 %', 'Default prep waste %')} hint={L(`留空 = 用全局默认 ${meta.settings.default_waste_pct}%；配方行里还能再覆盖`, `Empty = library default ${meta.settings.default_waste_pct}%; a recipe line can override again`)}>
              <input type="number" min="0" value={ed.waste_pct} onChange={(e) => setEd({ ...ed, waste_pct: e.target.value })} /></Field>
          </div>
          <div className="sub-h">{t('allergens')}</div>
          <div className="chips">{meta.allergens.map((a) => {
            const on = ed.allergens.includes(a);
            return <button key={a} className={'chip' + (on ? ' on' : '')} onClick={() => setEd({ ...ed, allergens: on ? ed.allergens.filter((x) => x !== a) : [...ed.allergens, a] })}>{a}</button>;
          })}</div>
          <div className="sub-h">{t('packages')}</div>
          <table className="tight"><thead><tr><th>{t('supplier')}</th><th>{t('label')}</th><th>{L('货号', 'Article no.')}</th><th>{t('pack_qty')} ({u(ed.base_unit)})</th><th>{t('price')}</th><th className="r">{t('unit_cost')}</th><th>{L('可订货', 'Orderable')}</th><th /></tr></thead>
            <tbody>{ed.packages.map((p, i) => (
              <tr key={i}>
                <td><select value={p.supplier_id} onChange={(e) => setPk(i, { supplier_id: +e.target.value })}>{(sup || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></td>
                <td><input value={p.label} onChange={(e) => setPk(i, { label: e.target.value })} /></td>
                <td><input value={p.article_no || ''} onChange={(e) => setPk(i, { article_no: e.target.value })} /></td>
                <td><input type="number" value={p.pack_qty} onChange={(e) => setPk(i, { pack_qty: e.target.value })} /></td>
                <td><input type="number" value={p.price} onChange={(e) => setPk(i, { price: e.target.value })} /></td>
                <td className="r">{+p.pack_qty > 0 ? num(p.price / p.pack_qty, 3) : '–'}{p.id && p.id === ed.costing_package_id && <span className="tag accent" style={{ marginLeft: 6 }}>{L('计价', 'costing')}</span>}</td>
                <td><input type="checkbox" checked={!!p.orderable} onChange={(e) => setPk(i, { orderable: e.target.checked ? 1 : 0 })} /></td>
                <td><button className="link danger" onClick={() => setEd({ ...ed, packages: ed.packages.filter((_, j) => j !== i) })}>✕</button></td>
              </tr>))}</tbody></table>
          <button className="link" onClick={() => setEd({ ...ed, packages: [...ed.packages, blankPk()] })}>+ {t('add_line')}</button>
          {hist && hist.length > 0 && <>
            <div className="sub-h">{L('价格历史', 'Price history')}</div>
            <table><thead><tr><th>{t('time')}</th><th>{t('label')}</th><th className="r">{t('price')}</th><th>{L('来源', 'Source')}</th></tr></thead>
              <tbody>{hist.map((h) => <tr key={h.id}><td>{ts(h.ts)}</td><td>{h.supplier_name} · {h.label}</td><td className="r">{money(h.price)}</td><td className="muted">{h.source}</td></tr>)}</tbody></table>
          </>}
          <div className="modal-foot">
            {ed.id && <button className="danger" onClick={del}>{t('del')}</button>}<span className="grow" />
            <button onClick={() => setEd(null)}>{t('cancel')}</button><button className="primary" disabled={!ed.name_zh} onClick={save}>{t('save')}</button>
          </div>
        </Modal>)}
    </Page>
  );
}

// ───────── 配方
const COMPAT = { g: ['g', 'kg'], ml: ['ml', 'l'], pc: ['pc'], portion: ['portion'] };

function CostTree({ lines, depth = 0 }) {
  const { N, u, L } = useApp();
  return lines.map((l) => (
    <Fragment key={`${depth}-${l.id}`}>
      <tr className={depth ? 'child' : ''}>
        <td style={{ paddingLeft: 12 + depth * 22 }}>{l.children ? '▾ ' : ''}{N(l)}
          {l.item_type === 'recipe' && <span className="tag soft">{l.stockable ? L('半成品', 'prep') : L('现做', 'made to order')}</span>}</td>
        <td className="r">{num(l.qty, 2)} {u(l.unit)}</td>
        <td className="r">{l.waste_pct ? <span title={l.waste_src}>{l.waste_pct}%<sup className="muted"> {l.waste_src === 'line' ? L('行', 'line') : l.waste_src === 'ingredient' ? L('原料', 'ingr.') : L('全局', 'lib.')}</sup></span> : ''}</td>
        <td className="r">{qtyFmt(l.gross, l.base_unit, u)}</td>
        <td className="r">{num(l.unit_cost, 3)}</td>
        <td className="r">{depth === 0 ? money(l.ingredient_cost, 1) : ''}</td>
        <td className="r">{depth === 0 && l.waste_cost > 0.005 ? money(l.waste_cost, 1) : ''}</td>
        <td className="r">{depth === 0 ? <b>{money(l.cost, 1)}</b> : ''}</td>
      </tr>
      {l.children && <CostTree lines={l.children} depth={depth + 1} />}
    </Fragment>));
}

function Financial({ c }) {
  const { t, L, u } = useApp();
  const unit = u(c.yield_unit);
  return (<>
    <div className="blocks">
      <div className="block">
        <h4>{L('① 一份的成本', '① Cost of one serving')} <span className="muted">/ {unit}</span></h4>
        <dl>
          <dt>{L('食材成本 (含损耗)', 'Food cost (incl. waste)')}</dt><dd>{money(c.perUnit, c.perUnit < 100 ? 3 : 1)}</dd>
          <dt>{L('人工成本', 'Personnel cost')}</dt><dd>{money(c.labourPerUnit, c.labourPerUnit < 100 ? 3 : 1)}</dd>
          <dt><b>Prime cost</b></dt><dd><b>{money(c.primePerUnit, c.primePerUnit < 100 ? 3 : 1)}</b></dd>
        </dl>
        <p className="muted small">{L(`整批：食材 ${money(c.total, 0)}，人工 ${money(c.labour_total, 0)}（其中本配方 ${money(c.own_labour, 0)}，其余来自子配方）`,
          `Whole batch: food ${money(c.total, 0)}, labour ${money(c.labour_total, 0)} (${money(c.own_labour, 0)} own, the rest from sub-recipes)`)}</p>
      </div>
      {c.kind === 'dish' && <>
        <div className="block">
          <h4>{L('② 按现售价的实际利润', '② Actual profit at your sell price')}</h4>
          <dl>
            <dt>{t('net_price')} <span className="muted">({L('含税', 'incl.')} {money(c.sell_price)} ÷ {1 + c.vat / 100})</span></dt><dd>{money(c.net_price)}</dd>
            <dt>{L('利润 = 去税售价 − prime cost', 'Profit = net price − prime cost')}</dt><dd>{money(c.profit)}</dd>
            <dt><b>{L('实际毛利率', 'Actual margin')}</b></dt><dd><b className={c.meets_target ? 'pos' : 'bad'}>{pct(c.margin_pct)}</b></dd>
            <dt>{t('food_cost')}</dt><dd>{pct(c.food_cost_pct)}</dd>
          </dl>
          <p className={'small ' + (c.meets_target ? 'pos' : 'bad')}>{c.meets_target ? L(`达到目标 ${c.target}%`, `Meets the ${c.target}% target`)
            : L(`低于目标 ${c.target}%，差 ${((c.target / 100 - c.margin_pct) * 100).toFixed(1)} 个百分点`, `Below the ${c.target}% target by ${((c.target / 100 - c.margin_pct) * 100).toFixed(1)} points`)}</p>
        </div>
        <div className="block">
          <h4>{L('③ 按目标毛利率反推', '③ Targets from your target margin')} <span className="muted">{c.target}%</span></h4>
          <dl>
            <dt>{L('目标 prime cost', 'Target prime cost')}<br /><span className="muted small">{L('价格不能涨时，成本要压到', 'If the price cannot go up, cost must come down to')}</span></dt><dd>{money(c.target_prime)}</dd>
            <dt>{L('目标含税售价', 'Target sell price')}<br /><span className="muted small">{L('成本不能降时，价格要定到', 'If cost cannot come down, price must go up to')}</span></dt><dd>{money(c.target_price)}</dd>
          </dl>
        </div>
      </>}
    </div>
    <table><thead><tr><th>{t('item')}</th><th className="r">{t('qty')}</th><th className="r">{t('waste_pct')}</th><th className="r">{t('gross')}</th><th className="r">{t('unit_cost')}</th>
      <th className="r">{L('食材', 'Ingredient')}</th><th className="r">{L('损耗', 'Waste')}</th><th className="r">{t('cost')}</th></tr></thead>
      <tbody><CostTree lines={c.lines} /></tbody></table>
  </>);
}

function Bom({ id }) {
  const { t, L, N, u, outlet } = useApp();
  const act = useAct();
  const [n, setN] = useState(50);
  const [rows, setRows] = useState(null);
  const run = async () => setRows(await api.get(`/recipes/${id}/bom?outlet=${outlet}&portions=${n}`));
  const order = async () => {
    const by = {};
    rows.filter((r) => r.qty_packs > 0).forEach((r) => (by[r.supplier_id] ||= []).push({ package_id: r.package_id, qty_packs: r.qty_packs }));
    for (const [sid, lines] of Object.entries(by)) await act(() => api.post('/orders', { outlet_id: outlet, supplier_id: +sid, lines }), L('已加入购物车', 'Added to cart'));
  };
  return (<>
    <Note>{L('物料清单：做这么多份需要哪些东西、现在有多少、还差多少。可入库的半成品按库存品列出，现做的半成品已经拆到原料。',
      'Bill of materials: what you need for this many servings, what is in stock and what is short. Stockable preps are listed as stock items; made-to-order preps are already exploded to ingredients.')}</Note>
    <div className="row"><Field label={L('份数 / 产出量', 'Servings / yield')}><input type="number" value={n} onChange={(e) => setN(e.target.value)} /></Field>
      <button className="primary" onClick={run}>{L('生成物料清单', 'Generate BoM')}</button>
      {rows?.some((r) => r.qty_packs > 0) && <button onClick={order}>{L('把缺口加入购物车', 'Add shortages to cart')}</button>}</div>
    {rows && <table><thead><tr><th>{t('item')}</th><th className="r">{t('need')}</th><th className="r">{t('on_hand')}</th><th className="r">{t('short')}</th><th>{L('订货包装', 'Order package')}</th><th className="r">{t('packs')}</th><th className="r">{t('value')}</th></tr></thead>
      <tbody>{rows.map((r) => (
        <tr key={itemKey(r)}><td>{N(r)}{r.item_type === 'recipe' && <span className="tag soft">{t('prep')}</span>}</td><td className="r">{qtyFmt(r.need, r.unit, u)}</td><td className="r">{qtyFmt(r.on_hand, r.unit, u)}</td>
          <td className={'r ' + (r.short > 0 ? 'bad' : '')}>{r.short > 0 ? qtyFmt(r.short, r.unit, u) : '✓'}</td>
          <td className="muted">{r.package_id ? `${r.supplier_name} · ${r.label}` : r.item_type === 'recipe' ? L('内部订货 / 生产', 'internal order / produce') : '–'}</td>
          <td className="r">{r.qty_packs || ''}</td><td className="r">{r.qty_packs ? money(r.qty_packs * r.price) : ''}</td></tr>))}</tbody></table>}
  </>);
}

function RecipeEditor({ id, onClose }) {
  const { t, L, N, u, meta, reloadMeta } = useApp();
  const act = useAct();
  const [cost, reload] = useLoad(() => (id ? api.get(`/recipes/${id}`) : Promise.resolve({ lines: [], used_in: [], allergens: [] })), [id]);
  const [ed, setEd] = useState(null);
  const [tab, setTab] = useState('general');
  const nn = (v) => v ?? '';
  if (cost && !ed) {
    setEd(id ? { ...cost, vat_pct: nn(cost.vat_pct), target_margin: nn(cost.target_margin), shelf_life_days: nn(cost.shelf_life_days),
      lines: cost.lines.map((l) => ({ key: itemKey(l), qty: l.qty, unit: l.unit, waste_pct: nn(l.line_waste_pct) })) }
      : { name_zh: '', name_en: '', kind: 'dish', stockable: 0, category: '', yield_qty: 1, yield_unit: 'g', sell_price: 0, vat_pct: '', target_margin: '', prep_min: 0, cook_min: 0, plate_min: 0, shelf_life_days: '', method: '', lines: [] });
  }
  if (!ed) return null;
  const set = (k) => (e) => setEd({ ...ed, [k]: e.target.value });
  const comp = (key) => meta.components.find((i) => itemKey(i) === key);
  const setLine = (i, patch) => setEd({ ...ed, lines: ed.lines.map((l, j) => {
    if (j !== i) return l;
    const n = { ...l, ...patch };
    const okU = COMPAT[comp(n.key)?.unit] || [];
    if (!okU.includes(n.unit)) n.unit = okU[0] || '';
    return n;
  }) });
  const inherit = (key) => { const c = comp(key); return !c ? '' : c.item_type === 'recipe' ? '0' : String(c.waste_pct ?? meta.settings.default_waste_pct); };
  const items = meta.components.filter((i) => !(i.item_type === 'recipe' && i.item_id === id));
  const save = async () => {
    const body = { ...ed, lines: ed.lines.filter((l) => l.key).map((l) => ({ ...splitKey(l.key), qty: l.qty, unit: l.unit, waste_pct: l.waste_pct })) };
    const r = await act(() => (id ? api.put(`/recipes/${id}`, body) : api.post('/recipes', body)));
    if (!r) return;
    reloadMeta();
    if (!id) onClose(r.id); else reload();
  };
  const del = async () => { if (confirm(t('confirm_del')) && await act(() => api.del(`/recipes/${id}`))) { reloadMeta(); onClose(); } };
  const S = meta.settings;
  return (
    <Modal title={id ? N(ed) : t('add')} onClose={() => onClose()} wide>
      {id && <Tabs value={tab} onChange={setTab} tabs={[['general', L('基本信息', 'General')], ['financial', L('财务', 'Financial')], ['bom', L('物料清单', 'Bill of materials')]]} />}
      {tab === 'general' && <>
        <div className="form cols">
          <Field label={t('name_zh')}><input value={ed.name_zh} onChange={set('name_zh')} /></Field>
          <Field label={t('name_en')}><input value={ed.name_en} onChange={set('name_en')} /></Field>
          <Field label={t('kind')}><select value={ed.kind} onChange={set('kind')}><option value="dish">{t('dish')}</option><option value="prep">{t('prep')}</option></select></Field>
          <Field label={t('category')}><input value={ed.category} onChange={set('category')} /></Field>
          <Field label={t('yield')}><div className="row tightrow">
            <input type="number" value={ed.yield_qty} onChange={set('yield_qty')} />
            {ed.kind === 'dish' ? <span className="unit">{u('portion')}</span>
              : <select value={ed.yield_unit} onChange={set('yield_unit')}>{['g', 'ml', 'pc'].map((x) => <option key={x} value={x}>{u(x)}</option>)}</select>}
          </div></Field>
          {ed.kind === 'dish' ? <>
            <Field label={t('sell_price')}><input type="number" value={ed.sell_price} onChange={set('sell_price')} /></Field>
            <Field label={t('vat')} hint={L(`留空 = 全局 ${S.default_vat}%`, `Empty = library ${S.default_vat}%`)}><input type="number" value={ed.vat_pct} onChange={set('vat_pct')} /></Field>
            <Field label={L('目标毛利率 %', 'Target margin %')} hint={L(`留空 = 全局 ${S.target_margin}%`, `Empty = library ${S.target_margin}%`)}><input type="number" value={ed.target_margin} onChange={set('target_margin')} /></Field>
          </> : <>
            <Field label={L('可入库', 'Stockable')} hint={L('提前做好、有库存的勾上；现做现用的不勾（卖出时直接拆到原料）', 'Tick for preps made ahead and kept in stock; leave off for made-to-order preps (exploded to ingredients on sale)')}>
              <select value={ed.stockable ? 1 : 0} onChange={(e) => setEd({ ...ed, stockable: +e.target.value })}><option value={1}>{L('是', 'Yes')}</option><option value={0}>{L('否', 'No')}</option></select></Field>
            <Field label={L('保质期 (天)', 'Shelf life (days)')} hint={L('生产入库时自动算效期', 'Used to fill the expiry date on production')}><input type="number" min="0" value={ed.shelf_life_days} onChange={set('shelf_life_days')} /></Field>
          </>}
        </div>
        <div className="sub-h">{L('主动工时 (分钟 / 批)', 'Active labour time (minutes per batch)')}</div>
        <div className="form cols">
          <Field label={L(`备料 · ${S.rate_prep} Ft/小时`, `Prepping · ${S.rate_prep} Ft/h`)}><input type="number" min="0" value={ed.prep_min} onChange={set('prep_min')} /></Field>
          <Field label={L(`烹饪 · ${S.rate_cook} Ft/小时`, `Cooking · ${S.rate_cook} Ft/h`)}><input type="number" min="0" value={ed.cook_min} onChange={set('cook_min')} /></Field>
          <Field label={L(`装盘 · ${S.rate_plate} Ft/小时`, `Plating · ${S.rate_plate} Ft/h`)}><input type="number" min="0" value={ed.plate_min} onChange={set('plate_min')} /></Field>
        </div>
        <div className="sub-h">{t('lines')}</div>
        <table className="tight"><thead><tr><th>{t('item')}</th><th>{L('净用量', 'Net qty')}</th><th>{t('unit')}</th><th>{t('waste_pct')}</th><th /></tr></thead>
          <tbody>{ed.lines.map((l, i) => (
            <tr key={i}>
              <td><ItemSelect value={l.key} items={items} onChange={(v) => setLine(i, { key: v })} /></td>
              <td><input type="number" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} /></td>
              <td><select value={l.unit} onChange={(e) => setLine(i, { unit: e.target.value })}>{(COMPAT[comp(l.key)?.unit] || []).map((x) => <option key={x} value={x}>{u(x)}</option>)}</select></td>
              <td><input type="number" min="0" value={l.waste_pct} placeholder={inherit(l.key)} onChange={(e) => setLine(i, { waste_pct: e.target.value })} /></td>
              <td><button className="link danger" onClick={() => setEd({ ...ed, lines: ed.lines.filter((_, j) => j !== i) })}>✕</button></td>
            </tr>))}</tbody></table>
        <button className="link" onClick={() => setEd({ ...ed, lines: [...ed.lines, { key: '', qty: 0, unit: '', waste_pct: '' }] })}>+ {t('add_line')}</button>
        <p className="muted small">{L('损耗留空 = 沿用灰色的默认值（原料上设的，或全局默认）。毛用量 = 净用量 ×（1 + 损耗%）。', 'Leave waste empty to inherit the grey default (from the ingredient, or the library). Gross = net × (1 + waste%).')}</p>
        {id && <div className="meta-line">
          <span>{t('allergens')}: {cost.allergens.length ? cost.allergens.map((a) => <span key={a} className="tag">{a}</span>) : '–'}</span>
          {cost.used_in.length > 0 && <span>{L('被引用于', 'Used in')}: {cost.used_in.map((r) => N(r)).join(', ')}</span>}
        </div>}
      </>}
      {tab === 'financial' && id && cost.lines && <Financial c={cost} />}
      {tab === 'bom' && id && <Bom id={id} />}
      <div className="modal-foot">
        {id && tab === 'general' && <button className="danger" onClick={del}>{t('del')}</button>}<span className="grow" />
        <button onClick={() => onClose()}>{t('close')}</button>
        {tab === 'general' && <button className="primary" disabled={!ed.name_zh} onClick={save}>{t('save')}</button>}
      </div>
    </Modal>
  );
}

export function Recipes() {
  const { t, L, N, u } = useApp();
  const [rows, reload] = useLoad(() => api.get('/recipes'), []);
  const [kind, setKind] = useState('all');
  const [open, setOpen] = useState(undefined); // undefined 关闭, null 新建, 数字 编辑
  const list = (rows || []).filter((r) => kind === 'all' || r.kind === kind);
  return (
    <Page title={t('recipes')} actions={<>
      <div className="seg">{['all', 'dish', 'prep'].map((k) => <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{t(k)}</button>)}</div>
      <button className="primary" onClick={() => setOpen(null)}>+ {t('add')}</button></>}>
      <section className="card">
        <table><thead><tr><th>{t('name')}</th><th>{t('kind')}</th><th className="r">{t('yield')}</th><th className="r">{L('食材', 'Food')}</th><th className="r">{L('人工', 'Labour')}</th><th className="r">Prime</th>
          <th className="r">{t('net_price')}</th><th className="r">{t('margin')}</th><th className="r">{L('目标', 'Target')}</th><th>{t('allergens')}</th></tr></thead>
          <tbody>{list.map((r) => {
            const d = r.perUnit < 100 ? 3 : 0;
            return (
              <tr key={r.id} className="click" onClick={() => setOpen(r.id)}>
                <td><b>{N(r)}</b></td>
                <td><span className={'tag ' + (r.kind === 'prep' ? 'soft' : 'accent')}>{r.kind === 'dish' ? t('dish') : r.stockable ? L('半成品 · 可入库', 'Prep · stockable') : L('半成品 · 现做', 'Prep · made to order')}</span></td>
                <td className="r">{qtyFmt(r.yield_qty, r.yield_unit, u)}</td>
                <td className="r">{money(r.perUnit, d)}</td><td className="r">{money(r.labourPerUnit, d)}</td><td className="r"><b>{money(r.primePerUnit, d)}</b></td>
                <td className="r">{r.kind === 'dish' ? money(r.net_price) : ''}</td>
                <td className={'r ' + (r.kind === 'dish' ? (r.meets_target ? 'pos' : 'bad') : '')}>{r.kind === 'dish' ? pct(r.margin_pct) : ''}</td>
                <td className="r muted">{r.kind === 'dish' ? r.target + '%' : ''}</td>
                <td>{r.allergens.map((a) => <span key={a} className="tag">{a}</span>)}</td>
              </tr>);
          })}</tbody></table>
      </section>
      {open !== undefined && <RecipeEditor key={open ?? 'new'} id={open} onClose={(newId) => { reload(); setOpen(newId || undefined); }} />}
    </Page>
  );
}

// ───────── 菜单 (套餐)
export function Menus() {
  const { t, L, N, meta } = useApp();
  const act = useAct();
  const [rows, reload] = useLoad(() => api.get('/menus'), []);
  const [ed, setEd] = useState(null);
  const open = (m) => setEd(m ? { ...m, vat_pct: m.vat_pct ?? '', target_margin: m.target_margin ?? '', items: m.items.map((i) => ({ course: i.course, recipe_id: i.recipe_id })) } : { name: '', price: 0, vat_pct: '', target_margin: '', items: [{ course: '', recipe_id: '' }] });
  const setItem = (i, patch) => setEd({ ...ed, items: ed.items.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const save = async () => { if (await act(() => (ed.id ? api.put(`/menus/${ed.id}`, ed) : api.post('/menus', ed)))) { setEd(null); reload(); } };
  return (
    <Page title={t('menus')} actions={<button className="primary" onClick={() => open(null)}>+ {t('add')}</button>}>
      <Note>{L('菜单 = 分道次的一组配方 + 一个套餐价。用来看整套的成本和毛利、把各配方并排对比、生成过敏原表。整套成本只适用于固定套餐（客人不能自选）。',
        'A menu is a set of recipes grouped in courses plus a menu price. Use it for the total cost and margin, to compare recipes side by side, and for the allergen card. Total menu cost only makes sense for fixed menus.')}</Note>
      {rows && rows.length === 0 && <section className="card"><Empty /></section>}
      {(rows || []).map((m) => (
        <section className="card" key={m.id}>
          <div className="card-head"><h2>{m.name}</h2><button onClick={() => open(m)}>{t('edit')}</button></div>
          <div className="kpis small">
            <Kpi label={L('套餐价 (含税)', 'Menu price (incl.)')} value={money(m.price)} sub={`${t('net_price')} ${money(m.net_price)}`} />
            <Kpi label={L('整套食材成本', 'Total food cost')} value={money(m.food)} sub={pct(m.food_cost_pct)} />
            <Kpi label="Prime cost" value={money(m.prime)} sub={`${L('人工', 'labour')} ${money(m.labour)}`} />
            <Kpi label={t('margin')} value={pct(m.margin_pct)} tone={m.meets_target ? 'good' : 'warn'} sub={`${L('目标', 'target')} ${m.target}% · ${L('目标售价', 'target price')} ${money(m.target_price)}`} />
          </div>
          <div className="sub-h">{L('配方对比', 'Recipe comparison')}</div>
          <table><thead><tr><th>{L('道次', 'Course')}</th><th>{t('recipe')}</th><th className="r">{L('食材', 'Food')}</th><th className="r">Prime</th><th className="r">{L('单点净价', 'Net price à la carte')}</th><th className="r">{t('margin')}</th><th className="r">{L('目标', 'Target')}</th></tr></thead>
            <tbody>{m.items.map((i) => (
              <tr key={i.id}><td className="muted">{i.course}</td><td><b>{N(i)}</b></td><td className="r">{money(i.food)}</td><td className="r">{money(i.prime)}</td><td className="r">{money(i.net_price)}</td>
                <td className={'r ' + (i.meets_target ? 'pos' : 'bad')}>{pct(i.margin_pct)}</td><td className="r muted">{i.target}%</td></tr>))}</tbody></table>
          <div className="sub-h">{L('过敏原表', 'Allergen card')}</div>
          {m.allergens.length === 0 ? <Empty text={L('不含已登记的过敏原', 'No registered allergens')} /> : (
            <table className="matrix-t"><thead><tr><th>{t('recipe')}</th>{m.allergens.map((a) => <th key={a} className="c">{a}</th>)}</tr></thead>
              <tbody>{m.items.map((i) => <tr key={i.id}><td>{N(i)}</td>{m.allergens.map((a) => <td key={a} className="c">{i.allergens.includes(a) ? '●' : ''}</td>)}</tr>)}</tbody></table>)}
        </section>))}
      {ed && (
        <Modal title={ed.id ? ed.name : t('add')} onClose={() => setEd(null)} wide>
          <div className="form cols">
            <Field label={t('name')}><input value={ed.name} onChange={(e) => setEd({ ...ed, name: e.target.value })} autoFocus /></Field>
            <Field label={L('套餐价 (含税)', 'Menu price (incl. VAT)')}><input type="number" value={ed.price} onChange={(e) => setEd({ ...ed, price: e.target.value })} /></Field>
            <Field label={t('vat')}><input type="number" value={ed.vat_pct} placeholder={meta.settings.default_vat} onChange={(e) => setEd({ ...ed, vat_pct: e.target.value })} /></Field>
            <Field label={L('目标毛利率 %', 'Target margin %')}><input type="number" value={ed.target_margin} placeholder={meta.settings.target_margin} onChange={(e) => setEd({ ...ed, target_margin: e.target.value })} /></Field>
          </div>
          <table className="tight"><thead><tr><th>{L('道次', 'Course')}</th><th>{t('recipe')}</th><th /></tr></thead>
            <tbody>{ed.items.map((x, i) => (
              <tr key={i}><td><input value={x.course} onChange={(e) => setItem(i, { course: e.target.value })} placeholder={L('例如 主食', 'e.g. Main')} /></td>
                <td><select value={x.recipe_id} onChange={(e) => setItem(i, { recipe_id: +e.target.value })}><option value="">—</option>{meta.dishes.map((d) => <option key={d.id} value={d.id}>{N(d)}</option>)}</select></td>
                <td><button className="link danger" onClick={() => setEd({ ...ed, items: ed.items.filter((_, j) => j !== i) })}>✕</button></td></tr>))}</tbody></table>
          <button className="link" onClick={() => setEd({ ...ed, items: [...ed.items, { course: '', recipe_id: '' }] })}>+ {t('add_line')}</button>
          <div className="modal-foot">
            {ed.id && <button className="danger" onClick={async () => { if (confirm(t('confirm_del')) && await act(() => api.del(`/menus/${ed.id}`))) { setEd(null); reload(); } }}>{t('del')}</button>}<span className="grow" />
            <button onClick={() => setEd(null)}>{t('cancel')}</button><button className="primary" disabled={!ed.name} onClick={save}>{t('save')}</button>
          </div>
        </Modal>)}
    </Page>
  );
}
