import { useState } from 'react';
import { api, Empty, Field, ItemSelect, itemKey, Modal, money, Note, num, Page, qtyFmt, splitKey, Status, Tabs, ts, useAct, useApp, useLoad } from './lib.jsx';

// ───────── 库存
export function Stock() {
  const { t, L, N, u, meta, outlet } = useApp();
  const act = useAct();
  const [rows, reload] = useLoad(() => api.get(`/stock?outlet=${outlet}`), [outlet]);
  const [dlg, setDlg] = useState(null); // {type:'detail'|'waste'|'transfer'|'par'|'track'|'dish', row, ...}
  const [loc, setLoc] = useState('');
  const others = meta.outlets.filter((o) => o.id !== outlet);
  const reasons = meta.settings.waste_reasons;
  const openDetail = async (row) => {
    const [moves, lots] = await Promise.all([api.get(`/stock/moves?outlet=${outlet}&item_type=${row.item_type}&item_id=${row.item_id}`), api.get(`/stock/lots?outlet=${outlet}&item_type=${row.item_type}&item_id=${row.item_id}`)]);
    setDlg({ type: 'detail', row, moves, lots, tab: 'ledger' });
  };
  const run = async (fn) => { if (await act(fn)) { setDlg(null); reload(); } };
  const key = (r) => ({ outlet_id: outlet, item_type: r.item_type, item_id: r.item_id });
  const locations = [...new Set((rows || []).map((r) => r.location).filter(Boolean))].sort();
  const list = (rows || []).filter((r) => !loc || r.location === loc);
  const total = list.reduce((s, r) => s + Math.max(0, r.value), 0);
  return (
    <Page title={t('stock')} actions={<>
      <span className="muted">{t('stock_value')}: <b>{money(total)}</b></span>
      <select value={loc} onChange={(e) => setLoc(e.target.value)} aria-label={t('location')}><option value="">{L('全部储位', 'All storage locations')}</option>{locations.map((x) => <option key={x}>{x}</option>)}</select>
      <button onClick={() => setDlg({ type: 'dish', recipe_id: meta.dishes[0]?.id, qty: 1, reason: reasons[0] })}>{L('报废菜品', 'Waste a dish')}</button>
      <button onClick={() => setDlg({ type: 'track', key: '', min_qty: 0, par_qty: 0, location: '' })}>+ {L('添加库存品', 'Track item')}</button></>}>
      <section className="card">
        {rows && list.length === 0 ? <Empty /> : (
          <table><thead><tr><th>{t('item')}</th><th>{t('location')}</th><th className="r">{t('on_hand')}</th><th className="r">{t('on_order')}</th><th className="r">{t('min')}</th><th className="r">{t('par')}</th><th>{L('最近效期', 'Next expiry')}</th><th className="r">{t('value')}</th><th>{t('status')}</th><th /></tr></thead>
            <tbody>{list.map((r) => (
              <tr key={itemKey(r)}>
                <td><b>{N(r)}</b>{r.item_type === 'recipe' && <span className="tag soft">{t('prep')}</span>}</td>
                <td className="muted">{r.location}</td>
                <td className={'r ' + (r.on_hand < 0 ? 'bad' : '')}>{qtyFmt(r.on_hand, r.unit, u)}</td>
                <td className="r muted">{r.on_order ? qtyFmt(r.on_order, r.unit, u) : ''}</td>
                <td className="r">{r.min_qty ? qtyFmt(r.min_qty, r.unit, u) : '–'}</td>
                <td className="r">{r.par_qty ? qtyFmt(r.par_qty, r.unit, u) : '–'}</td>
                <td className="muted">{r.next_expiry || ''}</td>
                <td className="r">{money(r.value)}</td>
                <td>{r.low ? <span className="tag bad">{t('low')}</span> : <span className="tag good">{t('ok')}</span>}</td>
                <td className="r nowrap">
                  <button className="link" onClick={() => openDetail(r)}>{L('流水/批次', 'Ledger/lots')}</button>
                  <button className="link" onClick={() => setDlg({ type: 'par', row: r, min_qty: r.min_qty, par_qty: r.par_qty, location: r.location })}>{L('设置', 'Set up')}</button>
                  <button className="link" onClick={() => setDlg({ type: 'waste', row: r, qty: '', reason: reasons[0] })}>{t('waste')}</button>
                  <button className="link" onClick={() => setDlg({ type: 'transfer', row: r, qty: '', to: others[0]?.id })}>{t('transfer')}</button>
                </td>
              </tr>))}</tbody></table>)}
      </section>

      {dlg?.type === 'detail' && (
        <Modal title={N(dlg.row)} onClose={() => setDlg(null)} wide>
          <Tabs value={dlg.tab} onChange={(tab) => setDlg({ ...dlg, tab })} tabs={[['ledger', t('ledger')], ['lots', L('批次', 'Lots'), dlg.lots.length]]} />
          {dlg.tab === 'ledger' && <>
            <table><thead><tr><th>{t('time')}</th><th>{t('reason')}</th><th>{t('ref')}</th><th>{t('note')}</th><th className="r">{t('qty')}</th><th className="r">{t('unit_cost')}</th></tr></thead>
              <tbody>{dlg.moves.map((m) => (
                <tr key={m.id}><td>{ts(m.ts)}</td><td>{t(m.reason)}</td><td className="muted">{m.ref}</td><td className="muted">{m.note}</td>
                  <td className={'r ' + (m.qty < 0 ? 'bad' : 'pos')}>{m.qty > 0 ? '+' : ''}{qtyFmt(m.qty, dlg.row.unit, u)}</td><td className="r">{num(m.unit_cost, 3)}</td></tr>))}</tbody></table>
            <div className="meta-line"><span>{t('on_hand')} = Σ {t('qty')} = <b>{qtyFmt(dlg.row.on_hand, dlg.row.unit, u)}</b>{dlg.moves.length === 200 && L('（只显示最近 200 条）', ' (latest 200 shown)')}</span></div>
          </>}
          {dlg.tab === 'lots' && <>
            <Note>{L('出库时按「先到期先出」从上往下扣；没有效期的排在最后。', 'Stock leaves first-expired-first-out, top to bottom; lots without an expiry come last.')}</Note>
            {dlg.lots.length === 0 ? <Empty /> : (
              <table><thead><tr><th>{t('lot')}</th><th>{L('来源', 'Source')}</th><th>{L('入库时间', 'Created')}</th><th>{t('expiry')}</th><th className="r">{L('入库量', 'Initial')}</th><th className="r">{L('剩余', 'Remaining')}</th></tr></thead>
                <tbody>{dlg.lots.map((l) => (
                  <tr key={l.id}><td><a href={`#trace?lot=${encodeURIComponent(l.lot_no)}`} onClick={() => setDlg(null)}>{l.lot_no}</a></td><td>{t(l.source)} <span className="muted">{l.ref}</span></td><td>{ts(l.created_at)}</td>
                    <td>{l.expiry || '–'}</td><td className="r">{qtyFmt(l.qty, dlg.row.unit, u)}</td><td className="r"><b>{qtyFmt(l.remaining, dlg.row.unit, u)}</b></td></tr>))}</tbody></table>)}
          </>}
        </Modal>)}

      {dlg?.type === 'par' && (
        <Modal title={`${N(dlg.row)} · ${L('库存设置', 'Stock set-up')}`} onClose={() => setDlg(null)}>
          <div className="form">
            <Field label={`${t('min')} (${u(dlg.row.unit)})`} hint={L('低于它才会出现在订货建议里', 'Suggestions trigger below this')}><input type="number" value={dlg.min_qty} onChange={(e) => setDlg({ ...dlg, min_qty: e.target.value })} autoFocus /></Field>
            <Field label={`Par (${u(dlg.row.unit)})`} hint={L('订货后希望达到的库存量', 'The level you want to be at after ordering')}><input type="number" value={dlg.par_qty} onChange={(e) => setDlg({ ...dlg, par_qty: e.target.value })} /></Field>
            <Field label={t('location')} hint={L('盘点时可以按储位筛选', 'Counts can be filtered by storage location')}><input value={dlg.location} onChange={(e) => setDlg({ ...dlg, location: e.target.value })} list="locs" /><datalist id="locs">{locations.map((x) => <option key={x} value={x} />)}</datalist></Field>
          </div>
          <div className="modal-foot"><button onClick={() => setDlg(null)}>{t('cancel')}</button>
            <button className="primary" onClick={() => run(() => api.post('/stock/par', { ...key(dlg.row), min_qty: dlg.min_qty, par_qty: dlg.par_qty, location: dlg.location }))}>{t('save')}</button></div>
        </Modal>)}

      {dlg?.type === 'waste' && (
        <Modal title={`${t('waste')} · ${N(dlg.row)}`} onClose={() => setDlg(null)}>
          <div className="form">
            <Field label={`${t('qty')} (${u(dlg.row.unit)})`}><input type="number" value={dlg.qty} onChange={(e) => setDlg({ ...dlg, qty: e.target.value })} autoFocus /></Field>
            <Field label={L('报损原因 (必选)', 'Waste reason (required)')}><select value={dlg.reason} onChange={(e) => setDlg({ ...dlg, reason: e.target.value })}>{reasons.map((r) => <option key={r}>{r}</option>)}</select></Field>
          </div>
          <div className="modal-foot"><button onClick={() => setDlg(null)}>{t('cancel')}</button>
            <button className="primary" disabled={!(+dlg.qty > 0)} onClick={() => run(() => api.post('/stock/waste', { ...key(dlg.row), qty: dlg.qty, reason: dlg.reason }))}>{t('save')}</button></div>
        </Modal>)}

      {dlg?.type === 'dish' && (
        <Modal title={L('报废菜品', 'Waste a dish')} onClose={() => setDlg(null)}>
          <Note>{L('菜品本身没有库存。报废一份菜 = 按配方把它用掉的东西从库存里扣掉，并记为报损。', 'A dish has no stock of its own. Wasting a dish depletes what it is made of, through the recipe, and logs it as waste.')}</Note>
          <div className="form">
            <Field label={t('dish')}><select value={dlg.recipe_id} onChange={(e) => setDlg({ ...dlg, recipe_id: +e.target.value })}>{meta.dishes.map((d) => <option key={d.id} value={d.id}>{N(d)}</option>)}</select></Field>
            <Field label={L('份数', 'Portions')}><input type="number" value={dlg.qty} onChange={(e) => setDlg({ ...dlg, qty: e.target.value })} /></Field>
            <Field label={L('报损原因 (必选)', 'Waste reason (required)')}><select value={dlg.reason} onChange={(e) => setDlg({ ...dlg, reason: e.target.value })}>{reasons.map((r) => <option key={r}>{r}</option>)}</select></Field>
          </div>
          <div className="modal-foot"><button onClick={() => setDlg(null)}>{t('cancel')}</button>
            <button className="primary" disabled={!(+dlg.qty > 0)} onClick={() => run(() => api.post('/stock/waste', { outlet_id: outlet, item_type: 'recipe', item_id: dlg.recipe_id, qty: dlg.qty, reason: dlg.reason }))}>{t('save')}</button></div>
        </Modal>)}

      {dlg?.type === 'transfer' && (
        <Modal title={`${t('transfer')} · ${N(dlg.row)}`} onClose={() => setDlg(null)}>
          <div className="form">
            <Field label={L('调入门店', 'To outlet')}><select value={dlg.to} onChange={(e) => setDlg({ ...dlg, to: +e.target.value })}>{others.map((o) => <option key={o.id} value={o.id}>{N(o)}</option>)}</select></Field>
            <Field label={`${t('qty')} (${u(dlg.row.unit)}) · ${t('on_hand')} ${qtyFmt(dlg.row.on_hand, dlg.row.unit, u)}`}><input type="number" value={dlg.qty} onChange={(e) => setDlg({ ...dlg, qty: e.target.value })} autoFocus /></Field>
          </div>
          <div className="modal-foot"><button onClick={() => setDlg(null)}>{t('cancel')}</button>
            <button className="primary" disabled={!(+dlg.qty > 0)} onClick={() => run(() => api.post('/transfers', { from_outlet: outlet, to_outlet: dlg.to, item_type: dlg.row.item_type, item_id: dlg.row.item_id, qty: dlg.qty }))}>{t('transfer')}</button></div>
        </Modal>)}

      {dlg?.type === 'track' && (
        <Modal title={L('添加库存品', 'Track item')} onClose={() => setDlg(null)}>
          <div className="form">
            <Field label={t('item')}><ItemSelect value={dlg.key} items={meta.items} onChange={(v) => setDlg({ ...dlg, key: v })} /></Field>
            <Field label={t('min')}><input type="number" value={dlg.min_qty} onChange={(e) => setDlg({ ...dlg, min_qty: e.target.value })} /></Field>
            <Field label="Par"><input type="number" value={dlg.par_qty} onChange={(e) => setDlg({ ...dlg, par_qty: e.target.value })} /></Field>
            <Field label={t('location')}><input value={dlg.location} onChange={(e) => setDlg({ ...dlg, location: e.target.value })} /></Field>
          </div>
          <div className="modal-foot"><button onClick={() => setDlg(null)}>{t('cancel')}</button>
            <button className="primary" disabled={!dlg.key} onClick={() => run(() => api.post('/stock/par', { outlet_id: outlet, ...splitKey(dlg.key), min_qty: dlg.min_qty, par_qty: dlg.par_qty, location: dlg.location }))}>{t('save')}</button></div>
        </Modal>)}
    </Page>
  );
}

// ───────── 盘点
export function Counts() {
  const { t, L, N, u, outlet, meta } = useApp();
  const act = useAct();
  const [list, reload] = useLoad(() => api.get(`/counts?outlet=${outlet}`), [outlet]);
  const [cur, setCur] = useState(null);       // 当前打开的盘点单
  const [sub, setSub] = useState(null);       // 当前分盘 id
  const [mine, setMine] = useState({});       // 当前分盘的输入：{ "ingredient:3": "12" }
  const [loc, setLoc] = useState('');
  const [preview, setPreview] = useState(false);
  const blind = meta.settings.blind_count;

  const load = async (id, subId) => {
    const c = await api.get(`/counts/${id}`);
    const s = c.subs.find((x) => x.id === subId) || c.subs[0];
    setCur(c); setSub(s?.id); setPreview(false);
    setMine(Object.fromEntries((s?.entries || []).map((e) => [itemKey(e), String(e.qty)])));
  };
  const saveSub = () => api.put(`/counts/${cur.id}/subs/${sub}`, { entries: Object.entries(mine).filter(([, v]) => v !== '').map(([k, v]) => { const [item_type, id] = k.split(':'); return { item_type, item_id: +id, qty: v }; }) });
  const create = async () => { const r = await act(() => api.post('/counts', { outlet_id: outlet }), L('已开始盘点', 'Count started')); if (r) { reload(); load(r.id); } };
  const switchSub = async (id) => { await saveSub(); load(cur.id, id); };
  const addSub = async () => {
    const name = prompt(L('分盘名称（例如：冷库 - 小陈）', 'Sub-count name (e.g. Walk-in — Sam)'));
    if (!name) return;
    await saveSub();
    const r = await api.post(`/counts/${cur.id}/subs`, { name });
    load(cur.id, r.id);
  };
  const toPreview = async () => { await saveSub(); await load(cur.id, sub); setPreview(true); };
  const confirmCount = async () => { if (await act(() => api.post(`/counts/${cur.id}/confirm`), L('盘点已确认，库存已更新', 'Count confirmed; stock updated'))) { setCur(null); reload(); } };

  const isOpen = cur?.status === 'open';
  const locations = cur ? [...new Set(cur.lines.map((l) => l.location).filter(Boolean))].sort() : [];
  // 其他分盘已经盘的数量 (合计 − 本分盘已保存的)
  const others = (l) => (l.counted ?? 0) - (cur.subs.find((s) => s.id === sub)?.entries.find((e) => itemKey(e) === itemKey(l))?.qty ?? 0);
  const diffRows = cur ? cur.lines.filter((l) => l.counted != null) : [];
  const diffValue = diffRows.reduce((s, l) => s + (l.counted - l.expected) * l.unit_cost, 0);

  return (
    <Page title={t('counts')} actions={<button className="primary" onClick={create}>+ {L('开始盘点', 'Start count')}</button>}>
      <Note>{L('规则：一次盘点可以分成几个「分盘」，几个人同时盘不同区域；同一品项的数量会相加。确认后实盘数覆盖库存。没盘到的品项保持不变，想清零必须明确填 0。盘点前先把收货、调拨、报损都登记完。',
        'Rules: one count can be split into sub-counts so several people count different areas at once; quantities for the same item add up. On confirmation the counted quantity overwrites stock. Items you leave empty keep their stock — to zero an item, count it as 0. Register deliveries, transfers and waste before you count.')}</Note>
      <section className="card">
        {list && list.length === 0 ? <Empty /> : (
          <table><thead><tr><th>#</th><th>{t('time')}</th><th className="r">{L('分盘数', 'Sub-counts')}</th><th className="r">{L('差异金额', 'Variance value')}</th><th>{t('status')}</th><th /></tr></thead>
            <tbody>{(list || []).map((c) => (
              <tr key={c.id} className="click" onClick={() => load(c.id)}><td>C{c.id}</td><td>{ts(c.approved_at || c.created_at)}</td><td className="r">{c.subs}</td>
                <td className={'r ' + (c.variance_value < 0 ? 'bad' : '')}>{c.status === 'approved' ? money(c.variance_value) : ''}</td>
                <td><Status s={c.status} /></td><td className="r"><span className="link">{t('view')}</span></td></tr>))}</tbody></table>)}
      </section>

      {cur && isOpen && !preview && (
        <Modal title={`${t('counts')} C${cur.id}`} onClose={() => { saveSub(); setCur(null); reload(); }} wide>
          <div className="row">
            <Field label={L('分盘', 'Sub-count')}><select value={sub} onChange={(e) => switchSub(+e.target.value)}>{cur.subs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
            <button onClick={addSub}>+ {L('新分盘', 'New sub-count')}</button>
            <Field label={t('location')}><select value={loc} onChange={(e) => setLoc(e.target.value)}><option value="">{t('all')}</option>{locations.map((x) => <option key={x}>{x}</option>)}</select></Field>
            {blind && <span className="tag warn">{L('盲盘：不显示账面数', 'Blind count: theoretical stock hidden')}</span>}
          </div>
          <table className="tight"><thead><tr><th>{t('item')}</th><th>{t('location')}</th>{!blind && <th className="r">{t('expected')}</th>}<th>{L('本分盘', 'This sub-count')}</th><th className="r">{L('其他分盘', 'Other sub-counts')}</th><th className="r">{L('合计', 'Count total')}</th></tr></thead>
            <tbody>{cur.lines.filter((l) => !loc || l.location === loc).map((l) => {
              const k = itemKey(l), o = others(l), v = mine[k] ?? '';
              const has = v !== '' || o !== 0 || l.counted != null;
              return (
                <tr key={k}><td>{N(l)}</td><td className="muted">{l.location}</td>{!blind && <td className="r muted">{num(l.expected, 1)} {u(l.unit)}</td>}
                  <td><input type="number" value={v} placeholder={u(l.unit)} onChange={(e) => setMine({ ...mine, [k]: e.target.value })} /></td>
                  <td className="r muted">{o ? num(o, 1) : ''}</td><td className="r">{has ? <b>{num(o + (+v || 0), 1)}</b> : <span className="muted">{L('未盘', 'not counted')}</span>}</td></tr>);
            })}</tbody></table>
          <div className="modal-foot">
            <button className="danger" onClick={async () => { if (confirm(t('confirm_del'))) { await api.del(`/counts/${cur.id}`); setCur(null); reload(); } }}>{L('取消盘点', 'Cancel count')}</button><span className="grow" />
            <button onClick={async () => { if (await act(saveSub)) { setCur(null); reload(); } }}>{L('保存，稍后继续', 'Save & continue later')}</button>
            <button className="primary" onClick={toPreview}>{L('保存盘点 → 查看差异', 'Save count → review variances')}</button>
          </div>
        </Modal>)}

      {cur && (preview || !isOpen) && (
        <Modal title={`${t('counts')} C${cur.id} · ${isOpen ? L('确认前检查', 'Review before confirming') : t('approved')}`} onClose={() => (isOpen ? setPreview(false) : setCur(null))} wide>
          {diffRows.length === 0 ? <Empty text={L('还没有盘任何品项', 'Nothing has been counted yet')} /> : (
            <table><thead><tr><th>{t('item')}</th><th className="r">{t('expected')}</th><th className="r">{t('counted')}</th><th className="r">{t('diff')}</th><th className="r">{L('差异金额', 'Variance value')}</th></tr></thead>
              <tbody>{diffRows.map((l) => { const d = l.counted - l.expected; return (
                <tr key={itemKey(l)}><td>{N(l)}</td><td className="r">{num(l.expected, 1)} {u(l.unit)}</td><td className="r">{num(l.counted, 1)} {u(l.unit)}</td>
                  <td className={'r ' + (d < -1e-6 ? 'bad' : d > 1e-6 ? 'pos' : '')}>{Math.abs(d) > 1e-6 ? num(d, 1) : ''}</td>
                  <td className={'r ' + (d < -1e-6 ? 'bad' : '')}>{Math.abs(d) > 1e-6 ? money(d * l.unit_cost) : ''}</td></tr>); })}</tbody></table>)}
          <div className="meta-line"><span>{L('差异合计', 'Total variance')}: <b className={diffValue < 0 ? 'bad' : ''}>{money(diffValue)}</b></span>
            {isOpen && <span>{L(`已盘 ${diffRows.length} / ${cur.lines.length} 项，其余保持不变`, `${diffRows.length} of ${cur.lines.length} items counted; the rest stay as they are`)}</span>}</div>
          <div className="modal-foot">
            {isOpen ? <><button onClick={() => setPreview(false)}>{L('返回继续盘', 'Back to counting')}</button><button className="primary" disabled={!diffRows.length} onClick={confirmCount}>{L('确认并保存（不可撤销）', 'Confirm & save (cannot be undone)')}</button></>
              : <button onClick={() => setCur(null)}>{t('close')}</button>}
          </div>
        </Modal>)}
    </Page>
  );
}
