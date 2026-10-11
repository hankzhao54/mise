import { useState } from 'react';
import { api, Empty, Field, itemKey, Modal, money, Note, num, Page, qtyFmt, Status, Tabs, ts, useAct, useApp, useLoad } from './lib.jsx';

// ───────── 订货：建议 → 订单 → 审批 → 收货 → 发票
export function Orders() {
  const { t, L, N, u, outlet, outletObj, meta } = useApp();
  const act = useAct();
  const [tab, setTab] = useState('suggest');
  const [mode, setMode] = useState('par');
  const [f, setF] = useState({ days: 3, source: 'avg4', scale: 100, use_stock: true, use_outstanding: true });
  const q = mode === 'forecast' ? `&mode=forecast&days=${f.days}&source=${f.source}&scale=${f.scale}&use_stock=${f.use_stock ? 1 : 0}&use_outstanding=${f.use_outstanding ? 1 : 0}` : '';
  const [sug, reloadSug] = useLoad(() => api.get(`/orders/suggestions?outlet=${outlet}${q}`), [outlet, q]);
  const [list, reloadList] = useLoad(() => api.get(`/orders?outlet=${outlet}`), [outlet]);
  const [recv, setRecv] = useState(null);
  const [inv, setInv] = useState(null);
  const [decide, setDecide] = useState(null);
  const reload = () => { reloadSug(); reloadList(); };
  const { flash } = useApp();

  // 生成订单并提交：可能直接发送，也可能因为超限额进入待审批
  const orderGroup = async (g) => {
    try {
      const { id } = await api.post('/orders', { outlet_id: outlet, supplier_id: g.supplier_id, lines: g.lines });
      const r = await api.post(`/orders/${id}/submit`);
      flash(r.status === 'waiting_approval'
        ? L(`超过每日限额 ${money(r.flag.limit)}，已转入待审批`, `Above the daily limit of ${money(r.flag.limit)} — sent for approval`)
        : L('订单已发送', 'Order sent') + (r.below_min ? L('（低于供应商最低起订额）', ' (below the supplier minimum)') : ''), r.status === 'waiting_approval');
      reload(); setTab(r.status === 'waiting_approval' ? 'approve' : 'orders');
    } catch (e) { flash(e.message, true); }
  };
  const orderInternal = async () => {
    if (await act(() => api.post('/internal', { outlet_id: outlet, supplier_outlet_id: sug.internal.supplier_outlet_id, lines: sug.internal.lines.map((l) => ({ item_id: l.item_id, qty: l.qty })) }), L('内部订单已发给中央厨房', 'Internal order sent to the kitchen'))) reload();
  };
  const run = async (fn, msg) => { if (await act(fn, msg)) { setRecv(null); setInv(null); setDecide(null); reload(); } };
  const waiting = (list || []).filter((o) => o.status === 'waiting_approval');
  const setL = (id, patch) => setRecv({ ...recv, lines: recv.lines.map((l) => (l.id === id ? { ...l, ...patch } : l)) });
  const openRecv = (o) => setRecv({ ...o, update_stock: true, invoice_amount: o.invoice_amount ?? '',
    lines: o.lines.filter((l) => l.qty_packs > l.received_packs).map((l) => ({ ...l, state: 'all', packs: l.qty_packs - l.received_packs, paid: l.price, update_price: true, expiry: '' })) });
  const recvBody = (close) => ({ close, update_stock: recv.update_stock, invoice_no: recv.invoice_no, invoice_amount: recv.invoice_amount, invoice_status: recv.invoice_status, delivery_fee: recv.delivery_fee,
    lines: recv.lines.map((l) => ({ id: l.id, state: l.state, packs: l.packs, price: l.paid, update_price: l.update_price, expiry: l.expiry })) });

  const cols = mode === 'forecast'
    ? [[L('预测用量', 'Forecast usage'), (l) => qtyFmt(l.forecast, l.unit, u)], [t('on_hand'), (l) => qtyFmt(l.on_hand, l.unit, u)], [t('on_order'), (l) => (l.on_order ? qtyFmt(l.on_order, l.unit, u) : '')]]
    : [[t('on_hand'), (l) => <span className="bad">{qtyFmt(l.on_hand, l.unit, u)}</span>], [t('on_order'), (l) => (l.on_order ? qtyFmt(l.on_order, l.unit, u) : '')], [t('min'), (l) => qtyFmt(l.min_qty, l.unit, u)], [t('par'), (l) => qtyFmt(l.par_qty, l.unit, u)]];

  return (
    <Page title={t('orders')}>
      <Tabs value={tab} onChange={setTab} tabs={[['suggest', L('订货建议', 'Suggestions')], ['orders', L('订单', 'Orders'), (list || []).filter((o) => ['sent', 'partial'].includes(o.status)).length], ['approve', L('审批', 'Approvals'), waiting.length]]} />

      {tab === 'suggest' && <>
        <section className="card">
          <div className="row">
            <div className="seg"><button className={mode === 'par' ? 'on' : ''} onClick={() => setMode('par')}>{L('补到 Par', 'Order to par')}</button><button className={mode === 'forecast' ? 'on' : ''} onClick={() => setMode('forecast')}>{L('需求预测', 'Demand forecast')}</button></div>
            {mode === 'forecast' && <>
              <Field label={L('订几天的量', 'Order for (days)')}><input type="number" min="1" max="14" value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} style={{ width: 80 }} /></Field>
              <Field label={L('销售参考', 'Sales period')}><select value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}><option value="avg4">{L('近 4 周同日平均', 'Average of last 4 weeks')}</option><option value="last_week">{L('上周同日', 'Same period last week')}</option></select></Field>
              <Field label={L('缩放 %', 'Scale %')}><input type="number" value={f.scale} onChange={(e) => setF({ ...f, scale: e.target.value })} style={{ width: 80 }} /></Field>
              <label className="check"><input type="checkbox" checked={f.use_stock} onChange={(e) => setF({ ...f, use_stock: e.target.checked })} />{L('减去现存', 'Subtract current stock')}</label>
              <label className="check"><input type="checkbox" checked={f.use_outstanding} onChange={(e) => setF({ ...f, use_outstanding: e.target.checked })} />{L('减去在途', 'Subtract outstanding orders')}</label>
            </>}
          </div>
          <Note>{mode === 'par'
            ? L('规则：现存 + 在途 < 最低量 → 补到 Par，按包装向上取整。最低量和 Par 在「库存」页逐项设置。', 'Rule: when on hand + on order falls below the minimum, order up to par, rounded up to whole packages. Set min and par per item on the Stock page.')
            : L('规则：未来每一天取同一个星期几的历史销量 → 乘缩放比例 → 按配方展开成用料 → 减去现存和在途。130% 适合旺季，105% 相当于留 5% 余量。', 'Rule: for each upcoming day take the sales of the same weekday → apply the scale → explode through recipes → subtract stock and outstanding orders. 130% suits a busy period; 105% adds a 5% buffer.')}</Note>
          {mode === 'forecast' && sug?.dishes && <div className="chips">{sug.dishes.map((d) => <span key={d.recipe_id} className="chip static">{N(d)} × {num(d.qty, 0)}</span>)}</div>}
        </section>
        {sug && !sug.suppliers.length && !sug.internal && <section className="card"><Empty text={L('目前不需要订货', 'Nothing to order right now')} /></section>}
        {(sug?.suppliers || []).map((g) => (
          <section className="card" key={g.supplier_id}>
            <div className="card-head"><h2>{g.supplier_name}</h2><span className="grow" />
              {g.below_min && <span className="tag warn">{L(`低于最低起订额 ${money(g.min_order)}`, `Below minimum ${money(g.min_order)}`)}</span>}
              <span>{t('total')}: <b>{money(g.total)}</b></span>
              <button className="primary" onClick={() => orderGroup(g)}>{L('生成并提交订单', 'Create & submit order')}</button></div>
            <table><thead><tr><th>{t('item')}</th>{cols.map(([h]) => <th key={h} className="r">{h}</th>)}<th className="r">{t('need')}</th><th>{t('label')}</th><th className="r">{t('packs')}</th><th className="r">{t('value')}</th></tr></thead>
              <tbody>{g.lines.map((l) => (
                <tr key={l.package_id}><td>{N(l)}</td>{cols.map(([h, fn]) => <td key={h} className="r">{fn(l)}</td>)}<td className="r">{qtyFmt(l.need, l.unit, u)}</td>
                  <td>{l.label}</td><td className="r"><b>{l.qty_packs}</b></td><td className="r">{money(l.qty_packs * l.price)}</td></tr>))}</tbody></table>
          </section>))}
        {sug?.internal && (
          <section className="card">
            <div className="card-head"><h2>{L('内部订货', 'Internal order')} → {L(sug.internal.supplier_zh, sug.internal.supplier_en)}</h2><span className="grow" />
              <button className="primary" onClick={orderInternal}>{L('生成内部订单', 'Create internal order')}</button></div>
            <table><thead><tr><th>{t('item')}</th>{cols.map(([h]) => <th key={h} className="r">{h}</th>)}<th className="r">{L('订货量', 'Order qty')}</th></tr></thead>
              <tbody>{sug.internal.lines.map((l) => <tr key={itemKey(l)}><td>{N(l)}</td>{cols.map(([h, fn]) => <td key={h} className="r">{fn(l)}</td>)}<td className="r"><b>{qtyFmt(l.qty, l.unit, u)}</b></td></tr>)}</tbody></table>
          </section>)}
        {sug && !sug.internal && outletObj.is_supplier === 1 && <Note>{L('本店是内部供应商：半成品不够时不是订货，而是去「生产计划」排产。', 'This outlet is an internal supplier: when a prep runs low you plan production instead of ordering it.')}</Note>}
      </>}

      {tab === 'orders' && <section className="card">
        {list && list.length === 0 ? <Empty /> : (
          <table><thead><tr><th>#</th><th>{t('supplier')}</th><th>{t('created')}</th><th>{t('lines')}</th><th className="r">{L('订货额', 'Ordered')}</th><th className="r">{L('实收额', 'Received')}</th><th>{t('status')}</th><th>{L('发票', 'Invoice')}</th><th /></tr></thead>
            <tbody>{(list || []).map((o) => (
              <tr key={o.id}><td>PO{o.id}</td><td><b>{o.supplier_name}</b></td><td>{ts(o.sent_at || o.created_at)}</td>
                <td className="muted">{o.lines.map((l) => `${N(l)} ${l.received_packs}/${l.qty_packs}`).join(', ')}</td>
                <td className="r">{money(o.ordered_total)}</td><td className="r">{o.received_total ? money(o.received_total) : ''}</td>
                <td><Status s={o.status} />{o.status === 'rejected' && <div className="small bad">{o.reject_reason}</div>}</td>
                <td>{o.invoice_no && <span className="small">{o.invoice_no}</span>}{o.invoice_diff != null && Math.abs(o.invoice_diff) > 0.5 && <div className="small bad">{L('差额', 'diff')} {money(o.invoice_diff)}</div>}</td>
                <td className="r nowrap">
                  {['in_progress', 'rejected'].includes(o.status) && <button className="link" onClick={() => run(() => api.post(`/orders/${o.id}/submit`), L('已提交', 'Submitted'))}>{o.status === 'rejected' ? L('重新提交', 'Resubmit') : L('提交', 'Submit')}</button>}
                  {o.status === 'waiting_approval' && <button className="link" onClick={() => run(() => api.post(`/orders/${o.id}/recall`))}>{L('撤回', 'Recall')}</button>}
                  {['sent', 'partial'].includes(o.status) && <button className="link" onClick={() => openRecv(o)}>{t('receive')}</button>}
                  {['partial', 'delivered'].includes(o.status) && <button className="link" onClick={() => setInv({ ...o, invoice_amount: o.invoice_amount ?? '' })}>{L('发票', 'Invoice')}</button>}
                  {['in_progress', 'rejected', 'sent'].includes(o.status) && <button className="link danger" onClick={() => confirm(t('confirm_del')) && run(() => api.del(`/orders/${o.id}`))}>{t('del')}</button>}
                </td></tr>))}</tbody></table>)}
      </section>}

      {tab === 'approve' && <section className="card">
        <Note>{L(`规则：这家店当天已发给同一供应商的金额 + 本单金额 > 限额，就不发送而是等审批。限额取最具体的一层：供应商自己的，否则全局设置（现在是 ${meta.settings.approval_limit == null ? '未启用' : money(meta.settings.approval_limit)}）。`,
          `Rule: if what this outlet already sent to the supplier today plus this order exceeds the limit, the order is held for approval. The most specific limit wins: the supplier's own, else the library setting (currently ${meta.settings.approval_limit == null ? 'off' : money(meta.settings.approval_limit)}).`)}</Note>
        {waiting.length === 0 ? <Empty text={L('没有待审批的订单', 'No orders are waiting for approval')} /> : (
          <table><thead><tr><th>#</th><th>{t('supplier')}</th><th>{t('lines')}</th><th className="r">{L('本单', 'This order')}</th><th className="r">{L('当日已发', 'Sent today')}</th><th className="r">{L('限额', 'Limit')}</th><th /></tr></thead>
            <tbody>{waiting.map((o) => {
              const fl = JSON.parse(o.flag_note || '{}');
              return (<tr key={o.id}><td>PO{o.id}</td><td><b>{o.supplier_name}</b></td><td className="muted">{o.lines.map((l) => `${N(l)} ×${l.qty_packs}`).join(', ')}</td>
                <td className="r">{money(o.ordered_total)}</td><td className="r">{money(fl.sent_today)}</td><td className="r">{money(fl.limit)}</td>
                <td className="r nowrap"><button className="primary" onClick={() => setDecide({ o, type: 'approve', text: '' })}>{L('批准并发送', 'Approve & send')}</button> <button className="danger" onClick={() => setDecide({ o, type: 'reject', text: '' })}>{L('拒绝', 'Reject')}</button></td></tr>);
            })}</tbody></table>)}
      </section>}

      {decide && (
        <Modal title={`PO${decide.o.id} · ${decide.type === 'approve' ? L('批准', 'Approve') : L('拒绝', 'Reject')}`} onClose={() => setDecide(null)}>
          <Field label={decide.type === 'approve' ? L('备注 (可选)', 'Comment (optional)') : L('拒绝原因 (必填)', 'Rejection reason (required)')}><textarea rows="3" value={decide.text} onChange={(e) => setDecide({ ...decide, text: e.target.value })} autoFocus /></Field>
          <div className="modal-foot"><button onClick={() => setDecide(null)}>{t('cancel')}</button>
            <button className="primary" disabled={decide.type === 'reject' && !decide.text} onClick={() => run(() => api.post(`/orders/${decide.o.id}/${decide.type}`, decide.type === 'approve' ? { note: decide.text } : { reason: decide.text }))}>{t('confirm')}</button></div>
        </Modal>)}

      {recv && (
        <Modal title={`${t('receive')} · PO${recv.id} · ${recv.supplier_name}`} onClose={() => setRecv(null)} wide>
          <table className="tight"><thead><tr><th>{t('item')}</th><th className="r">{L('未到', 'Outstanding')}</th><th>{L('到货情况', 'Delivery state')}</th><th>{L('实收件数', 'Delivered')}</th><th>{L('实付单价', 'Price paid')}</th><th>{L('更新价格', 'Update price')}</th><th>{t('expiry')}</th></tr></thead>
            <tbody>{recv.lines.map((l) => (
              <tr key={l.id}><td>{N(l)} <span className="muted">· {l.label}</span></td><td className="r">{l.qty_packs - l.received_packs}</td>
                <td><select value={l.state} onChange={(e) => setL(l.id, { state: e.target.value })}><option value="all">{L('全到', 'All')}</option><option value="part">{L('部分', 'Part')}</option><option value="none">{L('没到', 'None')}</option></select></td>
                <td><input type="number" disabled={l.state !== 'part'} value={l.state === 'none' ? 0 : l.state === 'all' ? l.qty_packs - l.received_packs : l.packs} onChange={(e) => setL(l.id, { packs: e.target.value })} /></td>
                <td><input type="number" value={l.paid} onChange={(e) => setL(l.id, { paid: e.target.value })} /></td>
                <td className="c"><input type="checkbox" checked={l.update_price} onChange={(e) => setL(l.id, { update_price: e.target.checked })} /></td>
                <td><input type="date" value={l.expiry} onChange={(e) => setL(l.id, { expiry: e.target.value })} /></td></tr>))}</tbody></table>
          <p className="muted small">{L('实付单价和订单不同时，勾了「更新价格」才会回写到包装价格并留下价格历史；一次性促销价就别勾。', 'When the price paid differs, "Update price" writes it back to the package and logs price history. Leave it off for one-time offers.')}</p>
          <div className="form cols">
            <Field label={L('发票号', 'Invoice #')}><input value={recv.invoice_no} onChange={(e) => setRecv({ ...recv, invoice_no: e.target.value })} /></Field>
            <Field label={L('发票金额 (不含运费)', 'Invoice amount (excl. delivery)')}><input type="number" value={recv.invoice_amount} onChange={(e) => setRecv({ ...recv, invoice_amount: e.target.value })} /></Field>
            <Field label={L('发票状态', 'Invoice status')}><InvStatus value={recv.invoice_status} onChange={(v) => setRecv({ ...recv, invoice_status: v })} /></Field>
            <Field label={L('运费', 'Delivery fee')}><input type="number" value={recv.delivery_fee} onChange={(e) => setRecv({ ...recv, delivery_fee: e.target.value })} /></Field>
          </div>
          <label className="check"><input type="checkbox" checked={recv.update_stock} onChange={(e) => setRecv({ ...recv, update_stock: e.target.checked })} />
            {L('更新库存（如果这批货已经在盘点里数进去了，就取消勾选，避免重复入库）', 'Update stock (untick if these goods were already counted in a stock count, to avoid adding them twice)')}</label>
          <div className="modal-foot"><button onClick={() => setRecv(null)}>{t('cancel')}</button>
            <button onClick={() => run(() => api.post(`/orders/${recv.id}/receive`, recvBody(false)))}>{L('保存本次到货 (订单保持打开)', 'Save delivery (keep order open)')}</button>
            <button className="primary" onClick={() => run(() => api.post(`/orders/${recv.id}/receive`, recvBody(true)))}>{L('保存并关闭订单', 'Save delivery & close order')}</button></div>
        </Modal>)}

      {inv && (
        <Modal title={`${L('发票核对', 'Invoice reconciliation')} · PO${inv.id}`} onClose={() => setInv(null)}>
          <div className="form">
            <Field label={L('发票号', 'Invoice #')}><input value={inv.invoice_no} onChange={(e) => setInv({ ...inv, invoice_no: e.target.value })} /></Field>
            <Field label={L('发票金额 (不含税、不含运费)', 'Invoice amount (excl. VAT and delivery)')}><input type="number" value={inv.invoice_amount} onChange={(e) => setInv({ ...inv, invoice_amount: e.target.value })} /></Field>
            <Field label={L('发票状态', 'Invoice status')}><InvStatus value={inv.invoice_status} onChange={(v) => setInv({ ...inv, invoice_status: v })} /></Field>
          </div>
          <dl className="compare"><dt>{L('订货额', 'Ordered')}</dt><dd>{money(inv.ordered_total)}</dd><dt>{L('实收货值', 'Received goods')}</dt><dd>{money(inv.received_total)}</dd>
            <dt>{L('发票金额', 'Invoice')}</dt><dd>{inv.invoice_amount === '' ? '–' : money(+inv.invoice_amount)}</dd>
            <dt><b>{L('差额 = 发票 − 实收', 'Difference = invoice − received')}</b></dt><dd><b className={inv.invoice_amount !== '' && Math.abs(inv.invoice_amount - inv.received_total) > 0.5 ? 'bad' : 'pos'}>{inv.invoice_amount === '' ? '–' : money(inv.invoice_amount - inv.received_total)}</b></dd></dl>
          <p className="muted small">{L('差额不为 0 时，展开订单行对照：是数量没到齐，还是单价和约定的不一样，然后找供应商开红字发票。', 'When the difference is not zero, compare line by line: a short delivery or a price that differs from the agreement — then ask the supplier for a credit note.')}</p>
          <div className="modal-foot"><button onClick={() => setInv(null)}>{t('cancel')}</button><button className="primary" onClick={() => run(() => api.put(`/orders/${inv.id}/invoice`, inv))}>{t('save')}</button></div>
        </Modal>)}
    </Page>
  );
}
function InvStatus({ value, onChange }) {
  const { L } = useApp();
  return (<select value={value} onChange={(e) => onChange(e.target.value)}>
    {[['not_received', L('未收到', 'Not yet received')], ['received', L('已收到', 'Received')], ['payable', L('可付款', 'Payable')], ['paid', L('已付款', 'Paid')]].map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>);
}

// ───────── 内部订货：门店 ↔ 中央厨房
export function Internal() {
  const { t, L, N, u, outlet, outletObj, meta } = useApp();
  const act = useAct();
  const [list, reload] = useLoad(() => api.get(`/internal?outlet=${outlet}`), [outlet]);
  const [demand, reloadDemand] = useLoad(() => (outletObj.is_supplier ? api.get(`/internal/demand?outlet=${outlet}`) : Promise.resolve([])), [outlet]);
  const [draft, setDraft] = useState(null);
  const [pick, setPick] = useState(null);
  const isSupplier = outletObj.is_supplier === 1;
  const kitchen = meta.outlets.find((o) => o.is_supplier && o.id !== outlet);
  const preps = meta.items.filter((i) => i.item_type === 'recipe');
  const run = async (fn, msg) => { if (await act(fn, msg)) { setDraft(null); setPick(null); reload(); reloadDemand(); } };
  const mine = (list || []).filter((o) => o.role === 'buyer'), theirs = (list || []).filter((o) => o.role === 'supplier');
  // 把汇总需求变成一张生产计划草稿：只做库存不够的部分，向上取整到整批
  const toPlan = async () => {
    const tasks = demand.map((d) => ({ recipe_id: d.recipe_id, qty: Math.ceil(Math.max(0, d.qty - Math.max(0, d.on_hand)) / d.batch) * d.batch })).filter((x) => x.qty > 0);
    if (!tasks.length) return act(() => Promise.reject(new Error(L('库存已经够发货，不需要生产', 'Stock already covers these orders'))));
    // 这些配方自己用到的可入库子配方 (比如饺子要用馅)：库存不够的也排进去
    for (const tk of [...tasks]) {
      for (const s of await api.get(`/plans/subs?outlet=${outlet}&recipe_id=${tk.recipe_id}&qty=${tk.qty}`)) {
        const ex = tasks.find((x) => x.recipe_id === s.recipe_id);
        if (ex) ex.qty = Math.max(ex.qty, s.qty); else if (s.qty > Math.max(0, s.on_hand)) tasks.push({ recipe_id: s.recipe_id, qty: Math.round(s.qty * 100) / 100 });
      }
    }
    return run(() => api.post('/plans', { outlet_id: outlet, name: L('内部订单备货', 'Internal orders'), tasks }), L('已生成生产计划草稿，去「生产计划」查看', 'Draft plan created — see Production plan'));
  };
  const OrderTable = ({ rows, supplierSide }) => (
    <table><thead><tr><th>#</th><th>{supplierSide ? L('下单门店', 'Ordering outlet') : L('供货方', 'Supplier')}</th><th>{t('created')}</th><th>{t('lines')}</th><th>{t('status')}</th><th /></tr></thead>
      <tbody>{rows.map((o) => (
        <tr key={o.id}><td>IO{o.id}</td><td><b>{supplierSide ? L(o.outlet_zh, o.outlet_en) : L(o.supplier_zh, o.supplier_en)}</b></td><td>{ts(o.created_at)}</td>
          <td className="muted">{o.lines.map((l) => `${N(l)} ${qtyFmt(l.picked_qty ?? l.qty, l.unit, u)}${l.picked_qty != null && l.picked_qty !== l.qty ? ` (${L('订', 'ordered')} ${qtyFmt(l.qty, l.unit, u)})` : ''}`).join(', ')}</td>
          <td><Status s={o.status} /></td>
          <td className="r nowrap">
            {supplierSide && ['incoming', 'picked'].includes(o.status) && <button className="link" onClick={() => setPick({ ...o, lines: o.lines.map((l) => ({ ...l, picked: l.picked_qty ?? l.qty })) })}>{L('拣货', 'Pick')}</button>}
            {supplierSide && o.status === 'picked' && <button className="link" onClick={() => run(() => api.post(`/internal/${o.id}/ship`), L('已发货', 'Shipped'))}>{L('发货', 'Ship')}</button>}
            {!supplierSide && o.status === 'shipped' && <button className="link" onClick={() => run(() => api.post(`/internal/${o.id}/receive`), L('已收货入库', 'Received into stock'))}>{t('receive')}</button>}
            {['incoming', 'picked'].includes(o.status) && <button className="link danger" onClick={() => confirm(t('confirm_del')) && run(() => api.del(`/internal/${o.id}`))}>{t('del')}</button>}
          </td></tr>))}</tbody></table>);
  return (
    <Page title={t('internal')} actions={!isSupplier && kitchen && <button className="primary" onClick={() => setDraft({ lines: [{ item_id: preps[0]?.item_id, qty: '' }] })}>+ {L('新建内部订单', 'New internal order')}</button>}>
      <Note>{L('流程：门店下单 → 中央厨房拣货（可以少拣）→ 发货（这时扣厨房库存）→ 门店收货（这时加门店库存，批号和效期跟着走）。只能订「可入库」的半成品。',
        'Flow: outlet orders → kitchen picks (possibly less) → ships (kitchen stock is depleted here) → outlet receives (outlet stock increases; lot and expiry travel with the goods). Only stockable preps can be ordered.')}</Note>
      {isSupplier && <>
        <section className="card">
          <div className="card-head"><h2>{L('新订单汇总 = 今天要备的货', 'Incoming orders, aggregated')}</h2><span className="grow" />
            {demand?.length > 0 && <button className="primary" onClick={toPlan}>{L('按缺口生成生产计划', 'Create production plan for the shortfall')}</button>}</div>
          {demand && demand.length === 0 ? <Empty text={L('没有新订单', 'No incoming orders')} /> : (
            <table><thead><tr><th>{t('recipe')}</th><th className="r">{L('订单数', 'Orders')}</th><th className="r">{L('需求合计', 'Total demand')}</th><th className="r">{t('on_hand')}</th><th className="r">{t('short')}</th></tr></thead>
              <tbody>{(demand || []).map((d) => { const s = d.qty - Math.max(0, d.on_hand); return (
                <tr key={d.recipe_id}><td><b>{N(d)}</b></td><td className="r">{d.orders}</td><td className="r">{qtyFmt(d.qty, d.unit, u)}</td><td className="r">{qtyFmt(d.on_hand, d.unit, u)}</td>
                  <td className={'r ' + (s > 0 ? 'bad' : '')}>{s > 0 ? qtyFmt(s, d.unit, u) : '✓'}</td></tr>); })}</tbody></table>)}
        </section>
        <section className="card"><h3>{L('收到的订单', 'Orders received')}</h3>{theirs.length === 0 ? <Empty /> : <OrderTable rows={theirs} supplierSide />}</section>
      </>}
      {(!isSupplier || mine.length > 0) && <section className="card"><h3>{L('我下的订单', 'Orders placed')}</h3>{mine.length === 0 ? <Empty /> : <OrderTable rows={mine} />}</section>}

      {draft && (
        <Modal title={`${L('新建内部订单', 'New internal order')} → ${N(kitchen)}`} onClose={() => setDraft(null)}>
          <table className="tight"><thead><tr><th>{t('recipe')}</th><th>{t('qty')}</th><th /></tr></thead>
            <tbody>{draft.lines.map((l, i) => (
              <tr key={i}><td><select value={l.item_id} onChange={(e) => setDraft({ lines: draft.lines.map((x, j) => (j === i ? { ...x, item_id: +e.target.value } : x)) })}>{preps.map((p) => <option key={p.item_id} value={p.item_id}>{N(p)} ({u(p.unit)})</option>)}</select></td>
                <td><input type="number" value={l.qty} onChange={(e) => setDraft({ lines: draft.lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)) })} /></td>
                <td><button className="link danger" onClick={() => setDraft({ lines: draft.lines.filter((_, j) => j !== i) })}>✕</button></td></tr>))}</tbody></table>
          <button className="link" onClick={() => setDraft({ lines: [...draft.lines, { item_id: preps[0]?.item_id, qty: '' }] })}>+ {t('add_line')}</button>
          <div className="modal-foot"><button onClick={() => setDraft(null)}>{t('cancel')}</button>
            <button className="primary" onClick={() => run(() => api.post('/internal', { outlet_id: outlet, supplier_outlet_id: kitchen.id, lines: draft.lines }), L('订单已发出', 'Order placed'))}>{L('下单', 'Place order')}</button></div>
        </Modal>)}
      {pick && (
        <Modal title={`${L('拣货', 'Pick')} · IO${pick.id} → ${L(pick.outlet_zh, pick.outlet_en)}`} onClose={() => setPick(null)} wide>
          <table className="tight"><thead><tr><th>{t('recipe')}</th><th className="r">{L('订货量', 'Ordered')}</th><th className="r">{L('本店现存', 'In stock here')}</th><th>{L('拣货量', 'Picked qty')}</th></tr></thead>
            <tbody>{pick.lines.map((l) => (
              <tr key={l.id}><td>{N(l)}</td><td className="r">{qtyFmt(l.qty, l.unit, u)}</td><td className={'r ' + (l.supplier_stock < l.qty ? 'bad' : '')}>{qtyFmt(l.supplier_stock, l.unit, u)}</td>
                <td><input type="number" value={l.picked} onChange={(e) => setPick({ ...pick, lines: pick.lines.map((x) => (x.id === l.id ? { ...x, picked: e.target.value } : x)) })} /></td></tr>))}</tbody></table>
          <div className="modal-foot"><button onClick={() => setPick(null)}>{t('cancel')}</button>
            <button onClick={() => run(() => api.post(`/internal/${pick.id}/pick`, { lines: pick.lines.map((l) => ({ id: l.id, picked_qty: l.picked })) }))}>{L('拣货并保存', 'Pick & save')}</button>
            <button className="primary" onClick={() => run(() => api.post(`/internal/${pick.id}/pick`, { ship: true, lines: pick.lines.map((l) => ({ id: l.id, picked_qty: l.picked })) }), L('已发货', 'Shipped'))}>{L('拣货并发货', 'Pick & ship')}</button></div>
        </Modal>)}
    </Page>
  );
}
