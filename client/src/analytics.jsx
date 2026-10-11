import { useEffect, useState } from 'react';
import { api, daysAgo, Empty, Field, itemKey, Kpi, money, Note, num, Page, pct, qtyFmt, Range, Tabs, ts, useAct, useApp, useLoad } from './lib.jsx';

// ───────── 销售与 POS
export function Sales() {
  const { t, L, N, meta, outlet } = useApp();
  const act = useAct();
  const [tab, setTab] = useState('pos');
  const [pos, reloadPos] = useLoad(() => api.get(`/pos?outlet=${outlet}`), [outlet]);
  const [log, reloadLog] = useLoad(() => api.get(`/sales?outlet=${outlet}&from=${daysAgo(13)}&to=${daysAgo(0)}`), [outlet]);
  const [day, setDay] = useState(daysAgo(0));
  const [qty, setQty] = useState({});
  const [csv, setCsv] = useState('');
  const reload = () => { reloadPos(); reloadLog(); };
  const link = async (id, recipe_id) => { const r = await act(() => api.post(`/pos/${id}/link`, { recipe_id }), false); if (r) { act(() => Promise.resolve(), r.depleted ? L(`已关联，并补扣了 ${r.depleted} 笔历史销售的库存`, `Linked; ${r.depleted} earlier sales were depleted from stock`) : t('saved')); reload(); } };
  const ignore = async (id, ignored) => { if (await act(() => api.post(`/pos/${id}/ignore`, { ignored }))) reload(); };
  // 每行：PLU,名称,数量,金额
  const parsed = csv.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [plu, name, q, rev] = l.split(/[,;\t]/).map((x) => x.trim()); return { plu, name, qty: +q, revenue: rev === undefined || rev === '' ? undefined : +rev, day }; }).filter((r) => r.plu && r.qty > 0);
  const importPos = async () => { const r = await act(() => api.post('/sales/pos', { outlet_id: outlet, rows: parsed }), false); if (r) { act(() => Promise.resolve(), L(`导入 ${r.imported} 行，其中 ${r.unlinked} 行未关联（新建 ${r.created} 个 POS 商品）`, `${r.imported} rows imported, ${r.unlinked} unlinked (${r.created} new POS items)`)); setCsv(''); reload(); } };
  const manual = meta.dishes.filter((d) => +qty[d.id] > 0).map((d) => ({ outlet_id: outlet, day, recipe_id: d.id, qty: +qty[d.id] }));
  const postManual = async () => { if (await act(() => api.post('/sales/manual', { rows: manual }), L('已过账并扣库存', 'Posted; stock depleted'))) { setQty({}); reload(); } };
  const unlinked = (pos?.items || []).filter((i) => !i.recipe_id && !i.ignored).length;
  return (
    <Page title={t('sales')}>
      <Tabs value={tab} onChange={setTab} tabs={[['pos', L('POS 关联', 'POS connection'), unlinked], ['import', L('导入 POS 销售', 'Import POS sales')], ['manual', L('手工销售', 'Manual sales')], ['log', L('销售记录', 'Sales log')]]} />
      {tab === 'pos' && pos && <>
        <div className="kpis">
          <Kpi label={L('POS 关联健康度（近 30 天）', 'POS linking health (30 days)')} value={pct(pos.health)} tone={pos.health != null && pos.health < 0.999 ? 'warn' : 'good'} sub={L('已关联营业额 ÷ 全部营业额，目标 100%', 'Linked revenue ÷ total revenue; target 100%')} />
          <Kpi label={L('未关联营业额', 'Unlinked revenue')} value={money(pos.unlinked_revenue)} tone={pos.unlinked_revenue > 0 ? 'warn' : ''} />
        </div>
        <Note>{L('每个 POS 商品（按 PLU 识别）关联一个配方。已关联的每卖一份就按配方扣库存、算成本；没关联的只有营业额，没有成本，利润会被虚高。关联后，之前没扣的销售会补扣。折扣、配送费这类可以「忽略」。',
          'Each POS item (identified by its PLU) links to one recipe. Linked items deplete stock and carry a cost every time they sell; unlinked items bring revenue with no cost, which inflates profit. After linking, earlier undepleted sales are depleted. Discounts and delivery fees can be ignored.')}</Note>
        <section className="card">
          <table><thead><tr><th>PLU</th><th>{L('POS 名称', 'Name (POS)')}</th><th>{L('POS 类别', 'POS category')}</th><th className="r">{L('近 30 天销量', 'Qty, 30 d')}</th><th className="r">{t('revenue')}</th><th>{L('关联配方', 'Linked recipe')}</th><th /></tr></thead>
            <tbody>{pos.items.map((i) => (
              <tr key={i.id} className={i.ignored ? 'dim' : ''}><td>{i.plu}</td><td><b>{i.name}</b></td><td className="muted">{i.category}</td><td className="r">{num(i.qty, 0)}</td><td className="r">{money(i.revenue)}</td>
                <td>{i.ignored ? <span className="tag soft">{L('已忽略', 'Ignored')}</span> : (
                  <select value={i.recipe_id || ''} onChange={(e) => link(i.id, +e.target.value || null)} className={i.recipe_id ? '' : 'warn-input'}>
                    <option value="">{L('— 未关联 —', '— unlinked —')}</option>{meta.dishes.map((d) => <option key={d.id} value={d.id}>{N(d)}</option>)}</select>)}
                  {i.pending > 0 && !i.ignored && <span className="tag warn" style={{ marginLeft: 6 }}>{L(`${i.pending} 笔未扣库存`, `${i.pending} sales not depleted`)}</span>}</td>
                <td className="r"><button className="link" onClick={() => ignore(i.id, !i.ignored)}>{i.ignored ? L('恢复', 'Restore') : L('忽略', 'Ignore')}</button></td></tr>))}</tbody></table>
        </section>
      </>}
      {tab === 'import' && <section className="card">
        <Note>{L('真实系统里这一步由 POS 对接自动完成（每晚同步小票）。这里用粘贴代替：每行「PLU,名称,数量,金额」。没见过的 PLU 会自动建成未关联的 POS 商品。',
          'In the real product a POS integration does this automatically. Here you paste instead: one "PLU,name,qty,amount" per line. Unknown PLUs become new unlinked POS items.')}</Note>
        <div className="row"><Field label={t('date')}><input type="date" value={day} onChange={(e) => setDay(e.target.value)} /></Field></div>
        <Field label={L('销售数据', 'Sales data')}><textarea rows="8" value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={'101,叉烧拉面,24,83760\n102,猪肉水饺 12 只,15,43350\n305,新品冰粉,6,5340'} /></Field>
        <div className="modal-foot"><span className="muted">{L(`识别到 ${parsed.length} 行`, `${parsed.length} rows recognised`)}</span><span className="grow" /><button className="primary" disabled={!parsed.length} onClick={importPos}>{L('导入', 'Import')}</button></div>
      </section>}
      {tab === 'manual' && <section className="card">
        <Note>{L('没有 POS 时直接按配方录入。过账后立刻按配方扣库存。', 'Without a POS, register sales directly per recipe. Posting depletes stock through the recipe straight away.')}</Note>
        <div className="row"><Field label={t('date')}><input type="date" value={day} onChange={(e) => setDay(e.target.value)} /></Field></div>
        <table className="tight" style={{ maxWidth: 560 }}><thead><tr><th>{t('dish')}</th><th className="r">{t('sell_price')}</th><th>{t('sold')}</th></tr></thead>
          <tbody>{meta.dishes.map((d) => (
            <tr key={d.id}><td>{N(d)}</td><td className="r">{money(d.sell_price)}</td><td><input type="number" min="0" value={qty[d.id] ?? ''} onChange={(e) => setQty({ ...qty, [d.id]: e.target.value })} /></td></tr>))}</tbody></table>
        <div className="modal-foot"><span>{t('revenue')}: <b>{money(meta.dishes.reduce((s, d) => s + (+qty[d.id] || 0) * d.sell_price, 0))}</b></span><span className="grow" /><button className="primary" disabled={!manual.length} onClick={postManual}>{L('过账并扣库存', 'Post & deplete stock')}</button></div>
      </section>}
      {tab === 'log' && <section className="card">
        {log && log.length === 0 ? <Empty /> : (
          <div className="scroll tall"><table><thead><tr><th>{t('date')}</th><th>PLU</th><th>{L('POS 名称', 'Name (POS)')}</th><th>{t('recipe')}</th><th className="r">{t('sold')}</th><th className="r">{t('revenue')}</th><th>{L('库存', 'Stock')}</th></tr></thead>
            <tbody>{(log || []).map((s, i) => <tr key={i}><td>{s.day}</td><td className="muted">{s.plu || L('手工', 'manual')}</td><td>{s.pos_name}</td><td>{s.name_zh ? N(s) : <span className="muted">–</span>}</td><td className="r">{num(s.qty, 0)}</td><td className="r">{money(s.revenue)}</td>
              <td>{s.depleted ? <span className="tag good">{L('已扣', 'depleted')}</span> : <span className="tag soft">{L('未扣', 'not depleted')}</span>}</td></tr>)}</tbody></table></div>)}
      </section>}
    </Page>
  );
}

// ───────── 销售看板
export function SalesDash() {
  const { t, L, N, outlet } = useApp();
  const [r, setR] = useState([daysAgo(13), daysAgo(0)]);
  const [d] = useLoad(() => api.get(`/reports/sales?outlet=${outlet}&from=${r[0]}&to=${r[1]}`), [outlet, r[0], r[1]]);
  const max = d ? Math.max(1, ...d.days.map((x) => x.revenue)) : 1;
  return (
    <Page title={t('salesdash')} actions={<Range from={r[0]} to={r[1]} set={(a, b) => setR([a, b])} />}>
      {d && <>
        <div className="kpis">
          <Kpi label={L('营业额', 'Revenue')} value={money(d.totals.revenue)} sub={`${L('含税', 'incl. VAT')} ${money(d.totals.revenue_incl)}`} />
          <Kpi label="Prime cost (CoGS)" value={money(d.totals.prime)} sub={`${L('其中食材', 'of which food')} ${money(d.totals.food)}`} />
          <Kpi label={L('利润', 'Profit')} value={money(d.totals.profit)} sub={L('净营业额 − prime cost', 'Revenue excl. − prime cost')} />
          <Kpi label={L('平均毛利率', 'Average profit margin')} value={pct(d.totals.avg_margin)} sub={L('只算已关联配方的营业额', 'Across linked revenue only')} />
          <Kpi label={L('POS 关联覆盖', 'PoS linking coverage')} value={pct(d.totals.linking)} tone={d.totals.linking != null && d.totals.linking < 0.999 ? 'warn' : 'good'} />
        </div>
        <section className="card">
          <h3>{L('每日营业额与利润', 'Revenue and profit per day')}</h3>
          {d.days.length === 0 ? <Empty /> : <>
            <div className="bars tallbars">{d.days.map((x) => (
              <div key={x.day} className="bar-col" title={`${x.day}\n${L('净营业额', 'Revenue')} ${money(x.revenue)}\nPrime ${money(x.prime)}\n${L('利润', 'Profit')} ${money(x.profit)}`}>
                <div className="bar-val">{num(x.revenue / 1000, 0)}k</div>
                <div className="bar stack" style={{ height: `${(x.revenue / max) * 100}%` }}><div className="seg-cost" style={{ height: `${x.revenue ? (x.prime / x.revenue) * 100 : 0}%` }} /></div>
                <div className="bar-lab">{x.day.slice(5)}</div>
              </div>))}</div>
            <div className="legend"><span><i className="sw profit" />{L('利润', 'Profit')}</span><span><i className="sw cost" />Prime cost</span></div>
          </>}
        </section>
        <section className="card">
          <h3>{L('销售构成明细', 'Sales mix detail')}</h3>
          <table><thead><tr><th>{L('POS 名称', 'Name (POS)')}</th><th>PLU</th><th>{L('配方', 'Name (recipe)')}</th><th className="r">{t('qty')}</th><th className="r">{L('净营业额', 'Revenue (excl.)')}</th><th className="r">Prime cost</th><th className="r">{L('利润', 'Profit')}</th><th className="r">{t('margin')}</th></tr></thead>
            <tbody>{d.mix.map((m, i) => (
              <tr key={i}><td><b>{m.pos_name}</b></td><td className="muted">{m.plu || 'N/A'}</td><td>{m.recipe_id ? N(m) : <span className="tag warn">{L('未关联', 'unlinked')}</span>}</td><td className="r">{num(m.qty, 0)}</td>
                <td className="r">{money(m.revenue)}</td><td className="r">{m.recipe_id ? money(m.prime) : '–'}</td><td className="r">{m.recipe_id ? money(m.profit) : '–'}</td><td className="r">{pct(m.margin)}</td></tr>))}</tbody></table>
        </section>
      </>}
    </Page>
  );
}

// ───────── 菜单工程
const CLS = { star: '#2f7d4f', plowhorse: '#b7791f', puzzle: '#3b6fb6', dog: '#b84a3a' };

function Matrix({ data }) {
  const { t, N } = useApp();
  const W = 640, H = 360, P = { l: 56, r: 20, t: 20, b: 44 };
  const maxX = Math.max(...data.rows.map((r) => r.qty), data.pop_threshold) * 1.15;
  const ms = data.rows.map((r) => r.unit_margin);
  const minY = Math.min(0, ...ms), maxY = Math.max(...ms, data.margin_threshold) * 1.15;
  const x = (v) => P.l + (v / maxX) * (W - P.l - P.r);
  const y = (v) => H - P.b - ((v - minY) / (maxY - minY)) * (H - P.t - P.b);
  const tx = x(data.pop_threshold), ty = y(data.margin_threshold);
  const q = [['puzzle', P.l + 8, P.t + 16, 'start'], ['star', W - P.r - 8, P.t + 16, 'end'], ['dog', P.l + 8, H - P.b - 8, 'start'], ['plowhorse', W - P.r - 8, H - P.b - 8, 'end']];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="matrix" role="img" aria-label={t('menu')}>
      <rect x={P.l} y={P.t} width={W - P.l - P.r} height={H - P.t - P.b} className="plot" />
      <line x1={tx} x2={tx} y1={P.t} y2={H - P.b} className="thr" /><line x1={P.l} x2={W - P.r} y1={ty} y2={ty} className="thr" />
      {q.map(([k, qx, qy, a]) => <text key={k} x={qx} y={qy} textAnchor={a} fill={CLS[k]} className="quad">{t(k)}</text>)}
      {data.rows.map((r) => (
        <g key={r.recipe_id}><circle cx={x(r.qty)} cy={y(r.unit_margin)} r={7} fill={CLS[r.cls]} />
          <text x={x(r.qty)} y={y(r.unit_margin) - 12} textAnchor="middle" className="dot-lab">{N(r)}</text></g>))}
      <text x={(W + P.l) / 2} y={H - 10} textAnchor="middle" className="axis">{t('popularity')} →</text>
      <text x={16} y={H / 2} textAnchor="middle" className="axis" transform={`rotate(-90 16 ${H / 2})`}>{t('unit_margin')} →</text>
    </svg>
  );
}

export function MenuEngineering() {
  const { t, L, N, outlet } = useApp();
  const [r, setR] = useState([daysAgo(13), daysAgo(0)]);
  const [d] = useLoad(() => api.get(`/reports/menu?outlet=${outlet}&from=${r[0]}&to=${r[1]}`), [outlet, r[0], r[1]]);
  return (
    <Page title={t('menu')} actions={<Range from={r[0]} to={r[1]} set={(a, b) => setR([a, b])} />}>
      <Note>{L('经典的四象限法（Kasavana & Smith）：按销量和单份毛利把菜分成明星、耕马、谜题、瘦狗。这是行业通用方法，不是 Apicbase 帮助文档里的某个页面 —— 那边把配方、菜单、成本统称为 Menu Engineering。',
        'The classic Kasavana & Smith matrix: dishes are split by popularity and unit margin into stars, plowhorses, puzzles and dogs. It is a general industry method rather than a page from the Apicbase help centre, where "Menu Engineering" is the name for recipes, menus and costing as a whole.')}</Note>
      {d && d.rows.length === 0 && <section className="card"><Empty /></section>}
      {d && d.rows.length > 0 && <>
        <section className="card"><Matrix data={d} /></section>
        <section className="card">
          <table><thead><tr><th>{t('dish')}</th><th>{t('cls')}</th><th className="r">{t('sold')}</th><th className="r">{t('mix')}</th><th className="r">{t('net_price')}</th><th className="r">{L('食材成本', 'Food cost')}</th><th className="r">{t('unit_margin')}</th><th className="r">{t('food_cost')}</th><th className="r">{t('total_margin')}</th></tr></thead>
            <tbody>{d.rows.map((x) => (
              <tr key={x.recipe_id}><td><b>{N(x)}</b></td><td><span className="tag" style={{ background: CLS[x.cls], color: '#fff' }}>{t(x.cls)}</span></td>
                <td className="r">{num(x.qty, 0)}</td><td className="r">{pct(x.mix_pct)}</td><td className="r">{money(x.unit_price)}</td><td className="r">{money(x.unit_cost)}</td>
                <td className="r">{money(x.unit_margin)}</td><td className="r">{pct(x.food_cost_pct)}</td><td className="r"><b>{money(x.total_margin)}</b></td></tr>))}</tbody></table>
          <div className="meta-line">
            <span>{L('销量门槛', 'Popularity threshold')} ≥ <b>{num(d.pop_threshold, 1)}</b> (= {num(d.totals.qty, 0)} ÷ {d.rows.length} × 70%)</span>
            <span>{L('毛利门槛', 'Margin threshold')} ≥ <b>{money(d.margin_threshold)}</b> (= {money(d.totals.margin)} ÷ {num(d.totals.qty, 0)})</span>
          </div>
        </section>
      </>}
    </Page>
  );
}

// ───────── 管理报表
export function Insights() {
  const { t, L, N, u, outlet } = useApp();
  const [tab, setTab] = useState('gp');
  const [r, setR] = useState([daysAgo(13), daysAgo(0)]);
  const q = `outlet=${outlet}&from=${r[0]}&to=${r[1]}`;
  const [mf] = useLoad(() => api.get(`/reports/management?${q}`), [q]);
  const [sp] = useLoad(() => (tab === 'stock' ? api.get(`/reports/stock-period?${q}`) : Promise.resolve(null)), [q, tab]);
  const [cv] = useLoad(() => (tab === 'variance' ? api.get(`/reports/variance?${q}`) : Promise.resolve(null)), [q, tab]);
  const [ws] = useLoad(() => (tab === 'waste' ? api.get(`/reports/waste?${q}`) : Promise.resolve(null)), [q, tab]);
  const m = mf?.one;
  const MOVE = m ? [[L('期初库存', 'Opening value'), m.movement.opening], [L('采购收货', 'Goods received'), m.movement.goods_received], [L('生产入库', 'Created in'), m.movement.created_in], [L('调入', 'Transfers in'), m.movement.transfers_in],
    [L('销售消耗', 'Sold'), m.movement.sold], [L('生产领料', 'Created out'), m.movement.created_out], [L('调出', 'Transfers out'), m.movement.transfers_out], [L('内部发货', 'Shipped out'), m.movement.shipped_out],
    [L('报损', 'Wasted'), m.movement.wasted], [L('盘点净差异', 'Net variance'), m.movement.net_variance]] : [];
  const SP = [['ordered', L('收货', 'Ordered')], ['created_in', L('生产入', 'Created in')], ['moved_in', L('调入', 'Moved in')], ['sold', L('销售', 'Sold')], ['created_out', L('领料', 'Created out')],
    ['moved_out', L('调出', 'Moved out')], ['shipped_out', L('内部发货', 'Shipped out')], ['wasted', L('报损', 'Wasted')], ['gain', L('盘盈', 'Uncontrolled gain')], ['loss', L('盘亏', 'Uncontrolled loss')]];
  const cell = (v, unit) => (Math.abs(v) < 1e-9 ? '' : <span className={v < 0 ? 'bad' : 'pos'}>{v > 0 ? '+' : ''}{qtyFmt(v, unit, u)}</span>);
  return (
    <Page title={t('insights')} actions={<Range from={r[0]} to={r[1]} set={(a, b) => setR([a, b])} />}>
      <Tabs value={tab} onChange={setTab} tabs={[['gp', L('毛利报告', 'Gross profit report')], ['stock', L('期间库存', 'Stock over period')], ['variance', L('盘点差异', 'Count variance')], ['waste', L('报损报表', 'Waste report')]]} />
      {tab === 'gp' && m && <>
        <div className="grid2">
          <section className="card">
            <h3>{L('库存变动（金额）', 'Inventory movement (value)')}</h3>
            <dl className="compare">{MOVE.map(([k, v]) => <FragmentRow key={k} k={k} v={<span className={v < -0.5 ? 'bad' : ''}>{money(v)}</span>} />)}
              <dt><b>{L('期末库存', 'Closing value')}</b></dt><dd><b>{money(m.movement.closing)}</b></dd></dl>
            <p className="muted small">{L('期末 = 期初 + 上面所有变动。每一项都能在库存流水里逐条对上。', 'Closing = opening + every movement above. Each line can be traced back to the stock ledger.')}</p>
          </section>
          <section className="card">
            <h3>{L('销售与毛利', 'Sales & gross profit')}</h3>
            <dl className="compare">
              <dt>{L('净营业额', 'Net sales')}</dt><dd>{money(m.profit.net_sales)}</dd>
              <dt>{L('理论成本（按配方该用掉的）', 'Theoretical cost (what recipes say)')}</dt><dd>{money(m.profit.theoretical_cost)} · {pct(m.profit.theoretical_pct)}</dd>
              <dt>+ {L('报损', 'Wasted')}</dt><dd>{money(-m.movement.wasted)}</dd>
              <dt>− {L('盘点净差异', 'Net variance')} <span className="muted small">({L('盘盈', 'gain')} {money(m.variance.positive)} − {L('盘亏', 'loss')} {money(m.variance.negative)})</span></dt><dd>{money(m.variance.net)}</dd>
              <dt><b>{L('实际成本', 'Actual cost')}</b></dt><dd><b>{money(m.profit.actual_cost)} · {pct(m.profit.actual_pct)}</b></dd>
              <dt>{L('理论毛利率', 'Theoretical GP %')}</dt><dd>{pct(m.profit.theoretical_gp)}</dd>
              <dt>{L('实际毛利率', 'Actual GP %')}</dt><dd>{pct(m.profit.actual_gp)}</dd>
              <dt><b>{L('差距（漏掉的利润）', 'Difference (profit that leaked)')}</b></dt><dd><b className={m.profit.diff_cost > 0.5 ? 'bad' : 'pos'}>{money(m.profit.diff_cost)} · {m.profit.diff_pct == null ? '–' : (m.profit.diff_pct * 100).toFixed(2) + L(' 个百分点', ' pts')}</b></dd>
            </dl>
          </section>
        </div>
        <section className="card">
          <h3>{L('各门店对比', 'Sales & performance — all outlets')}</h3>
          <table><thead><tr><th>{L('门店', 'Outlet')}</th><th className="r">{L('净营业额', 'Net sales')}</th><th className="r">{L('理论成本', 'Theoretical cost')}</th><th className="r">{L('实际成本', 'Actual cost')}</th><th className="r">{L('理论成本率', 'Theoretical %')}</th><th className="r">{L('实际成本率', 'Actual %')}</th><th className="r">{L('毛利差距', 'GP difference')}</th><th className="r">{L('期末库存', 'Closing value')}</th></tr></thead>
            <tbody>{mf.all.map((o) => (
              <tr key={o.outlet_id}><td><b>{N(o)}</b></td><td className="r">{money(o.profit.net_sales)}</td><td className="r">{money(o.profit.theoretical_cost)}</td><td className="r">{money(o.profit.actual_cost)}</td>
                <td className="r">{pct(o.profit.theoretical_pct)}</td><td className="r">{pct(o.profit.actual_pct)}</td>
                <td className={'r ' + (o.profit.diff_pct > 0.0005 ? 'bad' : '')}>{o.profit.diff_pct == null ? '–' : (-(o.profit.diff_pct) * 100).toFixed(2) + L(' 点', ' pts')}</td><td className="r">{money(o.movement.closing)}</td></tr>))}</tbody></table>
          <p className="muted small">{L('中央厨房没有销售，所以没有成本率；它的货通过「内部发货」流向门店。', 'The central kitchen has no sales, so no cost percentages; its goods flow to the outlets as "shipped out".')}</p>
        </section>
      </>}
      {tab === 'stock' && sp && <section className="card">
        <Note>{L('每个品项：期初 + 各项进出 = 期末。底部是按当前单位成本折算的金额合计。', 'Per item: opening + every movement = closing. The footer shows totals in value at the current unit cost.')}</Note>
        <div className="scroll tall"><table className="dense"><thead><tr><th>{t('item')}</th><th className="r">{L('期初', 'Opening')}</th>{SP.map(([k, h]) => <th key={k} className="r">{h}</th>)}<th className="r">{L('期末', 'Closing')}</th><th className="r">{L('期末金额', 'Closing value')}</th></tr></thead>
          <tbody>{sp.rows.map((x) => (
            <tr key={itemKey(x)}><td><b>{N(x)}</b></td><td className="r">{qtyFmt(x.opening, x.unit, u)}</td>{SP.map(([k]) => <td key={k} className="r">{cell(x[k], x.unit)}</td>)}
              <td className="r"><b>{qtyFmt(x.closing, x.unit, u)}</b></td><td className="r">{money(x.closing_value)}</td></tr>))}</tbody>
          <tfoot><tr><td><b>{t('value')}</b></td><td className="r">{money(sp.value.opening)}</td>{SP.map(([k]) => <td key={k} className="r">{Math.abs(sp.value[k]) > 0.5 ? money(sp.value[k]) : ''}</td>)}<td /><td className="r"><b>{money(sp.value.closing)}</b></td></tr></tfoot></table></div>
      </section>}
      {tab === 'variance' && cv && <>
        <section className="card">
          <h3>{L('每次盘点的差异金额', 'Count variance value per count')}</h3>
          {cv.counts.length === 0 ? <Empty text={L('这段时间没有已确认的盘点', 'No confirmed counts in this period')} /> : (
            <table><thead><tr><th>#</th><th>{t('time')}</th><th className="r">{L('盘点品项数', 'Items counted')}</th><th className="r">{L('差异金额', 'Variance value')}</th></tr></thead>
              <tbody>{cv.counts.map((c) => <tr key={c.id}><td>C{c.id}</td><td>{ts(c.approved_at)}</td><td className="r">{c.items}</td><td className={'r ' + (c.value < 0 ? 'bad' : '')}>{money(c.value)}</td></tr>)}</tbody></table>)}
        </section>
        <section className="card">
          <h3>{L('按品项：理论消耗 vs 实际消耗', 'Per item: theoretical vs actual usage')}</h3>
          {cv.rows.length === 0 ? <Empty /> : (
            <table><thead><tr><th>{t('item')}</th><th className="r">{L('理论消耗', 'Theoretical')}</th><th className="r">{L('已登记报损', 'Logged waste')}</th><th className="r">{L('盘点差异', 'Count variance')}</th><th className="r">{L('实际消耗', 'Actual')}</th><th className="r">%</th><th className="r">{L('差异金额', 'Variance value')}</th></tr></thead>
              <tbody>{cv.rows.map((x) => (
                <tr key={itemKey(x)}><td><b>{N(x)}</b></td><td className="r">{qtyFmt(x.theoretical, x.unit, u)}</td><td className="r">{x.waste ? qtyFmt(x.waste, x.unit, u) : ''}</td>
                  <td className={'r ' + (x.variance < 0 ? 'bad' : x.variance > 0 ? 'pos' : '')}>{x.variance ? qtyFmt(x.variance, x.unit, u) : ''}</td><td className="r">{qtyFmt(x.actual, x.unit, u)}</td>
                  <td className={'r ' + (x.variance_pct > 0.02 ? 'bad' : '')}>{x.variance && x.variance_pct != null ? pct(x.variance_pct) : ''}</td>
                  <td className={'r ' + (x.variance_value < 0 ? 'bad' : '')}>{x.variance ? money(x.variance_value) : ''}</td></tr>))}</tbody></table>)}
          <p className="muted small">{L('负差异 = 账上有、实际没有。常见原因：出品份量超标、损耗没登记、配方用量写少了、收货短少没核对。', 'Negative variance = stock that should be there but is not. Usual causes: over-portioning, unlogged waste, recipes that understate usage, short deliveries nobody checked.')}</p>
        </section>
      </>}
      {tab === 'waste' && ws && <>
        <div className="kpis"><Kpi label={L('报损合计', 'Total waste')} value={money(ws.total)} /></div>
        <div className="grid2">
          <section className="card"><h3>{L('按原因', 'By reason')}</h3>
            {ws.by_reason.length === 0 ? <Empty /> : <table><thead><tr><th>{t('reason')}</th><th className="r">{L('次数', 'Events')}</th><th className="r">{t('value')}</th></tr></thead>
              <tbody>{ws.by_reason.map((x) => <tr key={x.key}><td>{x.key}</td><td className="r">{x.events}</td><td className="r">{money(x.value)}</td></tr>)}</tbody></table>}</section>
          <section className="card"><h3>{L('按品项', 'By item')}</h3>
            {ws.by_item.length === 0 ? <Empty /> : <table><thead><tr><th>{t('item')}</th><th className="r">{L('次数', 'Events')}</th><th className="r">{t('value')}</th></tr></thead>
              <tbody>{ws.by_item.map((x) => <tr key={x.key}><td>{N(x)}</td><td className="r">{x.events}</td><td className="r">{money(x.value)}</td></tr>)}</tbody></table>}</section>
        </div>
        <section className="card"><h3>{L('明细', 'Events')}</h3>
          <table><thead><tr><th>{t('time')}</th><th>{t('item')}</th><th className="r">{t('qty')}</th><th className="r">{t('value')}</th><th>{t('reason')}</th></tr></thead>
            <tbody>{ws.moves.map((x) => <tr key={x.id}><td>{ts(x.ts)}</td><td>{N(x)}</td><td className="r">{qtyFmt(-x.qty, x.unit, u)}</td><td className="r">{money(x.value)}</td><td className="muted">{x.note}</td></tr>)}</tbody></table></section>
      </>}
    </Page>
  );
}
const FragmentRow = ({ k, v }) => <><dt>{k}</dt><dd>{v}</dd></>;

// ───────── 批次追溯
function TraceTree({ nodes, depth = 0 }) {
  const { t, L, u } = useApp();
  return nodes.map((n) => (
    <div key={n.id} className="trace-node" style={{ marginLeft: depth ? 22 : 0 }}>
      <div className="trace-card">
        <div><b>{L(n.name_zh, n.name_en)}</b> <span className="tag soft">{n.lot_no}</span> <span className="muted">{L(n.outlet_zh, n.outlet_en)}</span></div>
        <div className="small muted">{t(n.source)} {n.ref} · {ts(n.created_at)}{n.supplier ? ` · ${n.supplier}` : ''}{n.expiry ? ` · ${t('expiry')} ${n.expiry}` : ''}</div>
        <div className="small">{L('入库', 'In')} {qtyFmt(n.qty, n.unit, u)} · {L('剩余', 'left')} <b>{qtyFmt(n.remaining, n.unit, u)}</b>
          {n.usage.map((x) => <span key={x.reason} className="tag" style={{ marginLeft: 6 }}>{t(x.reason)} {qtyFmt(x.qty, n.unit, u)}{x.first_day ? ` · ${x.first_day === x.last_day ? x.first_day.slice(5) : `${x.first_day.slice(5)}→${x.last_day.slice(5)}`}` : ''}</span>)}</div>
      </div>
      {n.children.length > 0 && <TraceTree nodes={n.children} depth={depth + 1} />}
    </div>));
}
export function Trace() {
  const { t, L, N, u, outlet } = useApp();
  const act = useAct();
  const fromHash = () => decodeURIComponent((location.hash.split('lot=')[1] || ''));
  const [lot, setLot] = useState(fromHash());
  const [res, setRes] = useState(null);
  const [recent] = useLoad(() => api.get(`/lots?outlet=${outlet}`), [outlet]);
  const run = async (no) => { if (!no) return; setLot(no); const r = await act(() => api.get(`/trace?lot=${encodeURIComponent(no)}`), false); setRes(r || null); };
  useEffect(() => { if (fromHash()) run(fromHash()); const h = () => fromHash() && run(fromHash()); window.addEventListener('hashchange', h); return () => window.removeEventListener('hashchange', h); }, []);
  return (
    <Page title={t('trace')}>
      <Note>{L('每次入库生成一个批次；生产时，领料用到的批次成为成品批次的「父批次」；调拨和内部订货时批号跟着货走。于是任何一个批号都能往上查到原料和供应商（哪批货做的），往下查到去向（做成了什么、发到哪家店、哪几天卖掉的）。出问题要召回时用的就是这条链。',
        'Every receipt creates a lot. In production the lots drawn become parents of the output lot; on transfers and internal orders the lot number travels with the goods. So any lot can be traced back to ingredients and suppliers, and forward to where it went (what it became, which outlet got it, on which days it sold). This chain is what a recall relies on.')}</Note>
      <section className="card">
        <div className="row"><Field label={t('lot')}><input value={lot} onChange={(e) => setLot(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run(lot)} placeholder="P1-3" /></Field><button className="primary" onClick={() => run(lot)}>{L('追溯', 'Trace')}</button></div>
      </section>
      {res && <div className="grid2">
        <section className="card"><h3>↑ {L('向上：它是用什么做的 / 从哪来的', 'Backward: what it was made from / where it came from')}</h3><TraceTree nodes={res.backward} /></section>
        <section className="card"><h3>↓ {L('向下：它去了哪里', 'Forward: where it went')}</h3><TraceTree nodes={res.forward} /></section>
      </div>}
      <section className="card">
        <h3>{L('本店最近的批次（点批号追溯）', 'Recent lots at this outlet (click a lot to trace it)')}</h3>
        <div className="scroll"><table><thead><tr><th>{t('lot')}</th><th>{t('item')}</th><th>{L('来源', 'Source')}</th><th>{L('入库时间', 'Created')}</th><th>{t('expiry')}</th><th className="r">{L('入库量', 'Initial')}</th><th className="r">{L('剩余', 'Remaining')}</th></tr></thead>
          <tbody>{(recent || []).map((l) => (
            <tr key={l.id} className="click" onClick={() => { run(l.lot_no); window.scrollTo({ top: 0 }); }}><td><span className="link">{l.lot_no}</span></td><td>{N(l)}</td><td>{t(l.source)} <span className="muted">{l.ref}</span></td><td>{ts(l.created_at)}</td><td>{l.expiry || '–'}</td>
              <td className="r">{qtyFmt(l.qty, l.unit, u)}</td><td className="r">{qtyFmt(l.remaining, l.unit, u)}</td></tr>))}</tbody></table></div>
      </section>
    </Page>
  );
}
