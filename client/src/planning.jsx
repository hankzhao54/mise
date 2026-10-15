import { useEffect, useState } from 'react';
import { api, daysAgo, Empty, Field, itemKey, Kpi, Modal, money, Note, num, Page, pct, qtyFmt, Range, Status, Tabs, ts, useAct, useApp, useLoad } from './lib.jsx';

const mins = (a, b) => (a && b ? Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60000)) : null);

// ───────── 生产计划
export function Production() {
  const { t, L, N, u, outlet } = useApp();
  const act = useAct();
  const [sug, reloadSug] = useLoad(() => api.get(`/plans/suggestions?outlet=${outlet}`), [outlet]);
  const [list, reloadList] = useLoad(() => api.get(`/plans?outlet=${outlet}`), [outlet]);
  const [open, setOpen] = useState(undefined);   // undefined 关闭；{id} 打开；{draft} 新建
  const reload = () => { reloadSug(); reloadList(); };
  const newFrom = (tasks) => setOpen({ draft: { name: L('生产计划', 'Production plan') + ' ' + daysAgo(0).slice(5), plan_date: daysAgo(0), tasks } });
  return (
    <Page title={t('production')} actions={<button className="primary" onClick={() => newFrom([])}>+ {L('新建计划', 'New production plan')}</button>}>
      <Note>{L('流程：建计划（加配方，子配方自动带出）→ 激活 → 看板上逐个开始/完成任务 → 完成计划：按计划量领料、按实际产出入库，自动生成批号和效期。',
        'Flow: create a plan (add recipes; sub-recipes are added automatically) → activate → start and finish tasks on the board → finish the plan: ingredients are drawn for the planned quantity, the actual yield goes into stock with a lot number and expiry date.')}</Note>
      <section className="card">
        <div className="card-head"><h3>{L('生产建议（半成品低于最低量）', 'Suggestions (preps below minimum)')}</h3><span className="grow" />
          {sug?.length > 0 && <button onClick={() => newFrom(sug.map((s) => ({ recipe_id: s.recipe_id, qty: s.qty, assignee: '', workstation: '' })))}>{L('全部加入新计划', 'Add all to a new plan')}</button>}</div>
        {sug && sug.length === 0 ? <Empty text={L('半成品库存都在最低量以上', 'All preps are above minimum')} /> : (
          <table><thead><tr><th>{t('recipe')}</th><th className="r">{t('on_hand')}</th><th className="r">{L('已计划', 'Planned')}</th><th className="r">{t('min')}</th><th className="r">{t('par')}</th><th className="r">{L('批数', 'Batches')}</th><th className="r">{t('qty')}</th></tr></thead>
            <tbody>{(sug || []).map((s) => (
              <tr key={s.recipe_id}><td><b>{N(s)}</b></td><td className="r bad">{qtyFmt(s.on_hand, s.unit, u)}</td><td className="r muted">{s.planned ? qtyFmt(s.planned, s.unit, u) : ''}</td>
                <td className="r">{qtyFmt(s.min_qty, s.unit, u)}</td><td className="r">{qtyFmt(s.par_qty, s.unit, u)}</td>
                <td className="r">{s.batches} × {qtyFmt(s.batch_size, s.unit, u)}</td><td className="r"><b>{qtyFmt(s.qty, s.unit, u)}</b></td></tr>))}</tbody></table>)}
      </section>
      <section className="card">
        <h3>{L('计划列表', 'Plans')}</h3>
        {list && list.length === 0 ? <Empty /> : (
          <table><thead><tr><th>#</th><th>{t('name')}</th><th>{t('date')}</th><th className="r">{L('任务进度', 'Tasks done')}</th><th>{t('status')}</th><th /></tr></thead>
            <tbody>{(list || []).map((p) => (
              <tr key={p.id} className="click" onClick={() => setOpen({ id: p.id })}><td>P{p.id}</td><td><b>{p.name}</b></td><td>{p.plan_date}</td><td className="r">{p.done} / {p.tasks}</td>
                <td><Status s={p.status} /></td><td className="r"><span className="link">{t('view')}</span></td></tr>))}</tbody></table>)}
      </section>
      {open && <PlanModal key={open.id || 'new'} init={open} onClose={() => { setOpen(undefined); reload(); }} act={act} />}
    </Page>
  );
}

function PlanModal({ init, onClose, act }) {
  const { t, L, N, u, outlet, meta } = useApp();
  const [id, setId] = useState(init.id);
  const [plan, setPlan] = useState(null);
  const [ed, setEd] = useState(init.draft || null);
  const [finish, setFinish] = useState(null);
  const [result, setResult] = useState(null);
  const preps = meta.components.filter((c) => c.item_type === 'recipe');
  const load = async (pid = id) => {
    const p = await api.get(`/plans/${pid}`);
    setPlan(p);
    if (p.status === 'draft') setEd({ id: p.id, name: p.name, plan_date: p.plan_date, tasks: p.tasks.map((x) => ({ recipe_id: x.recipe_id, title: x.title, qty: x.qty, assignee: x.assignee, workstation: x.workstation })) });
  };
  useEffect(() => { if (id) load(id); }, [id]);
  const unitOf = (rid) => preps.find((p) => p.item_id === rid)?.unit || '';
  const setTask = (i, patch) => setEd({ ...ed, tasks: ed.tasks.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  // 把某一行用到的可入库子配方带出来：库存不够的才加，已经在计划里的就加量
  const addSubs = async (i) => {
    const row = ed.tasks[i];
    if (!row.recipe_id || !(+row.qty > 0)) return;
    const subs = await api.get(`/plans/subs?outlet=${outlet}&recipe_id=${row.recipe_id}&qty=${row.qty}`);
    const tasks = [...ed.tasks];
    let added = 0;
    for (const s of subs) {
      const missing = s.qty - Math.max(0, s.on_hand);
      if (missing <= 0) continue;
      const ex = tasks.findIndex((x) => x.recipe_id === s.recipe_id);
      if (ex >= 0) tasks[ex] = { ...tasks[ex], qty: Math.max(+tasks[ex].qty, s.qty) };
      else tasks.push({ recipe_id: s.recipe_id, qty: Math.round(s.qty * 100) / 100, assignee: '', workstation: '' });
      added++;
    }
    setEd({ ...ed, tasks });
    act(() => Promise.resolve(), added ? L(`带出了 ${added} 个子配方`, `${added} sub-recipe(s) added`) : L('子配方库存都够，不需要另外做', 'Sub-recipes are all in stock'));
  };
  const save = async () => {
    const r = await act(() => api.post('/plans', { ...ed, outlet_id: outlet }));
    if (r) { setId(r.id); load(r.id); }
    return r;
  };
  const activate = async () => { const r = await save(); if (r && await act(() => api.post(`/plans/${r.id}/activate`), L('计划已激活', 'Plan activated'))) load(r.id); };
  const setStatus = async (tid, status) => { if (await act(() => api.post(`/plans/tasks/${tid}/status`, { status }), false)) load(); };
  const openFinish = () => setFinish(plan.tasks.filter((x) => x.recipe_id && x.stockable).map((x) => ({ task_id: x.id, name_zh: x.name_zh, name_en: x.name_en, unit: x.unit, planned: x.qty, in_stock: true, produced_qty: x.qty, lot_no: `P${plan.id}-${x.id}`, expiry: x.shelf_life_days ? daysAgo(-x.shelf_life_days) : '' })));
  const doFinish = async () => { const r = await act(() => api.post(`/plans/${plan.id}/finish`, { outputs: finish }), L('计划已完成，库存已更新', 'Plan finished; stock updated')); if (r) { setResult(r); setFinish(null); load(); } };

  const status = plan?.status || 'draft';
  const title = (plan?.name || ed?.name || '') + (plan ? ` · P${plan.id}` : '');
  return (
    <Modal title={title} onClose={onClose} wide>
      {status === 'draft' && ed && <>
        <div className="form cols">
          <Field label={t('name')}><input value={ed.name} onChange={(e) => setEd({ ...ed, name: e.target.value })} /></Field>
          <Field label={t('date')}><input type="date" value={ed.plan_date} onChange={(e) => setEd({ ...ed, plan_date: e.target.value })} /></Field>
        </div>
        <table className="tight"><thead><tr><th>{L('配方 / 自定义任务', 'Recipe / custom task')}</th><th>{t('qty')}</th><th>{t('assignee')}</th><th>{L('工位', 'Workstation')}</th><th /></tr></thead>
          <tbody>{ed.tasks.map((x, i) => (
            <tr key={i}>
              <td>{x.recipe_id != null ? <select value={x.recipe_id} onChange={(e) => setTask(i, { recipe_id: +e.target.value })}>{preps.map((p) => <option key={p.item_id} value={p.item_id}>{N(p)}</option>)}</select>
                : <input value={x.title} placeholder={L('例如：清洁和面机', 'e.g. Clean the mixer')} onChange={(e) => setTask(i, { title: e.target.value })} />}</td>
              <td>{x.recipe_id != null && <div className="row tightrow"><input type="number" value={x.qty} onChange={(e) => setTask(i, { qty: e.target.value })} /><span className="unit">{u(unitOf(x.recipe_id))}</span></div>}</td>
              <td><input value={x.assignee || ''} onChange={(e) => setTask(i, { assignee: e.target.value })} /></td>
              <td><select value={x.workstation || ''} onChange={(e) => setTask(i, { workstation: e.target.value })}><option value="">—</option>{meta.settings.workstations.map((w) => <option key={w}>{w}</option>)}</select></td>
              <td className="nowrap">{x.recipe_id != null && <button className="link" onClick={() => addSubs(i)}>{L('带出子配方', 'Add sub-recipes')}</button>}<button className="link danger" onClick={() => setEd({ ...ed, tasks: ed.tasks.filter((_, j) => j !== i) })}>✕</button></td>
            </tr>))}</tbody></table>
        <div className="row"><button className="link" onClick={() => setEd({ ...ed, tasks: [...ed.tasks, { recipe_id: preps[0]?.item_id, qty: '', assignee: '', workstation: '' }] })}>+ {L('加配方', 'Add recipe')}</button>
          <button className="link" onClick={() => setEd({ ...ed, tasks: [...ed.tasks, { recipe_id: null, title: '', assignee: '', workstation: '' }] })}>+ {L('加自定义任务', 'Add custom task')}</button></div>
      </>}

      {status === 'active' && plan && <>
        <div className="row"><span className="grow" /><button onClick={async () => { if (await act(() => api.post(`/plans/${plan.id}/all-done`))) load(); }}>{L('全部标记完成', 'Mark all as done')}</button>
          <button className="primary" disabled={plan.tasks.some((x) => x.status !== 'done')} onClick={openFinish}>{L('完成计划', 'Finish plan')}</button></div>
        <div className="board">
          {['todo', 'doing', 'done'].map((col) => (
            <div className="board-col" key={col}><h4>{t(col)} <span className="muted">{plan.tasks.filter((x) => x.status === col).length}</span></h4>
              {plan.tasks.filter((x) => x.status === col).map((x) => (
                <div className="task" key={x.id}>
                  <b>{x.recipe_id ? N(x) : x.title}</b>
                  {x.recipe_id && <div>{qtyFmt(x.qty, x.unit, u)} <span className="muted">· {num(x.batches, 2)} {L('批', 'batch')}</span></div>}
                  <div className="muted small">{[x.assignee, x.workstation].filter(Boolean).join(' · ')}</div>
                  {x.started_at && <div className="muted small">⏱ {ts(x.started_at).slice(11)}{x.done_at ? ` → ${ts(x.done_at).slice(11)} (${mins(x.started_at, x.done_at)} min)` : ''}</div>}
                  <div className="row">
                    {col === 'todo' && <button onClick={() => setStatus(x.id, 'doing')}>{L('开始', 'Start')}</button>}
                    {col === 'doing' && <button className="primary" onClick={() => setStatus(x.id, 'done')}>{L('完成', 'Done')}</button>}
                    {col !== 'todo' && <button className="link" onClick={() => setStatus(x.id, 'todo')}>{L('退回', 'Reset')}</button>}
                  </div>
                </div>))}
            </div>))}
        </div>
      </>}

      {status === 'done' && plan && <>
        {result && <Note>{L('入库结果见下表。到「库存 → 流水/批次」可以看到领料和入库的每一条流水。', 'See the table for what went into stock. Stock → Ledger/lots shows every movement.')}</Note>}
        <table><thead><tr><th>{L('任务', 'Task')}</th><th>{t('assignee')}</th><th className="r">{L('计划', 'Planned')}</th><th className="r">{L('实际产出', 'Produced')}</th><th className="r">{L('出成率', 'Yield')}</th><th>{t('lot')}</th><th>{t('expiry')}</th><th className="r">{L('耗时', 'Duration')}</th></tr></thead>
          <tbody>{plan.tasks.map((x) => (
            <tr key={x.id}><td><b>{x.recipe_id ? N(x) : x.title}</b></td><td>{x.assignee}</td><td className="r">{x.recipe_id ? qtyFmt(x.qty, x.unit, u) : ''}</td>
              <td className="r">{x.produced_qty != null ? qtyFmt(x.produced_qty, x.unit, u) : x.recipe_id ? <span className="muted">{L('未入库', 'not stocked')}</span> : ''}</td>
              <td className={'r ' + (x.produced_qty != null && x.produced_qty < x.qty ? 'bad' : '')}>{x.produced_qty != null ? pct(x.produced_qty / x.qty) : ''}</td>
              <td>{x.lot_no && <a href={`#trace?lot=${encodeURIComponent(x.lot_no)}`}>{x.lot_no}</a>}</td><td>{x.expiry || ''}</td>
              <td className="r">{mins(x.started_at, x.done_at) != null ? `${mins(x.started_at, x.done_at)} min` : '–'}</td></tr>))}</tbody></table>
      </>}

      {plan && <>
        <div className="sub-h">{L('物料清单与预算', 'Bill of materials & budget')}{status === 'draft' && <span className="muted"> ({L('按上次保存的内容计算', 'based on the last save')})</span>}</div>
        <div className="kpis small">
          <Kpi label={L('食材', 'Food')} value={money(plan.budget.food)} /><Kpi label={L('人工', 'Labour')} value={money(plan.budget.labour)} />
          {status !== 'done' && <Kpi label={L('缺料项', 'Items short')} value={plan.bom.filter((b) => b.short > 0).length} tone={plan.bom.some((b) => b.short > 0) ? 'warn' : ''} />}
        </div>
        <table><thead><tr><th>{t('item')}</th><th className="r">{t('need')}</th>{status !== 'done' && <><th className="r">{t('on_hand')}</th><th className="r">{t('short')}</th></>}<th className="r">{t('cost')}</th></tr></thead>
          <tbody>{plan.bom.map((b) => (
            <tr key={itemKey(b)}><td>{N(b)}{b.item_type === 'recipe' && <span className="tag soft">{t('prep')}</span>}</td><td className="r">{qtyFmt(b.need, b.unit, u)}</td>
              {status !== 'done' && <><td className="r">{qtyFmt(b.on_hand, b.unit, u)}</td><td className={'r ' + (b.short > 0 ? 'bad' : '')}>{b.short > 0 ? qtyFmt(b.short, b.unit, u) : '✓'}</td></>}
              <td className="r">{money(b.cost)}</td></tr>))}</tbody></table>
      </>}

      <div className="modal-foot">
        {plan && status !== 'done' && <button className="danger" onClick={async () => { if (confirm(t('confirm_del')) && await act(() => api.del(`/plans/${plan.id}`))) onClose(); }}>{t('del')}</button>}<span className="grow" />
        <button onClick={onClose}>{t('close')}</button>
        {status === 'draft' && <><button disabled={!ed?.tasks.length} onClick={save}>{L('保存草稿', 'Save draft')}</button><button className="primary" disabled={!ed?.tasks.length} onClick={activate}>{L('保存并激活', 'Save & activate')}</button></>}
      </div>

      {finish && (
        <Modal title={L('完成计划 · 入库', 'Finish plan · put into stock')} onClose={() => setFinish(null)} wide>
          <Note>{L('只有可入库的配方出现在这里。实际产出可以改：产出比计划少，这一批的单位成本就更高。', 'Only stockable recipes appear here. Adjust the produced amount if needed: a lower yield makes this batch cost more per unit.')}</Note>
          {finish.length === 0 ? <Empty text={L('这个计划没有需要入库的配方', 'Nothing in this plan goes into stock')} /> : (
            <table className="tight"><thead><tr><th>{L('入库', 'Stock')}</th><th>{t('recipe')}</th><th className="r">{L('计划', 'Planned')}</th><th>{L('实际产出', 'Produced')}</th><th>{t('lot')}</th><th>{t('expiry')}</th></tr></thead>
              <tbody>{finish.map((f, i) => { const set = (patch) => setFinish(finish.map((x, j) => (j === i ? { ...x, ...patch } : x))); return (
                <tr key={f.task_id}><td className="c"><input type="checkbox" checked={f.in_stock} onChange={(e) => set({ in_stock: e.target.checked })} /></td><td>{N(f)}</td><td className="r">{qtyFmt(f.planned, f.unit, u)}</td>
                  <td><input type="number" value={f.produced_qty} onChange={(e) => set({ produced_qty: e.target.value })} /></td><td><input value={f.lot_no} onChange={(e) => set({ lot_no: e.target.value })} /></td>
                  <td><input type="date" value={f.expiry} onChange={(e) => set({ expiry: e.target.value })} /></td></tr>); })}</tbody></table>)}
          <div className="modal-foot"><button onClick={() => setFinish(null)}>{t('cancel')}</button><button className="primary" onClick={doFinish}>{t('confirm')}</button></div>
        </Modal>)}
    </Modal>
  );
}

// ───────── 任务与 HACCP
const WD = [['一', 'Mon', 1], ['二', 'Tue', 2], ['三', 'Wed', 3], ['四', 'Thu', 4], ['五', 'Fri', 5], ['六', 'Sat', 6], ['日', 'Sun', 0]];

export function Tasks() {
  const { t, L, outlet, meta } = useApp();
  const act = useAct();
  const [tab, setTab] = useState('today');
  const [day, setDay] = useState(daysAgo(0));
  const [occ, reloadOcc] = useLoad(() => api.get(`/tasks/occurrences?outlet=${outlet}&from=${day}&to=${day}`), [outlet, day]);
  const [tasks, reloadTasks] = useLoad(() => api.get(`/tasks?outlet=${outlet}`), [outlet]);
  const [ccps, reloadCcps] = useLoad(() => api.get('/ccps'), []);
  const [r, setR] = useState([daysAgo(6), daysAgo(0)]);
  const [rep] = useLoad(() => api.get(`/tasks/report?outlet=${outlet}&from=${r[0]}&to=${r[1]}`), [outlet, r[0], r[1], tab]);
  const [doing, setDoing] = useState(null);
  const [ed, setEd] = useState(null);
  const [ccp, setCcp] = useState(null);
  const reload = () => { reloadOcc(); reloadTasks(); reloadCcps(); };
  const run = async (fn, msg) => { if (await act(fn, msg)) { setDoing(null); setEd(null); setCcp(null); reload(); } };
  const freq = (x) => (x.frequency === 'weekly' ? `${t('weekly')} ${WD.filter((w) => x.weekdays.includes(w[2])).map((w) => L(w[0], w[1])).join(L('、', ', '))}` : x.frequency === 'monthly' ? `${t('monthly')} ${x.month_day}${L('号', '')}` : t(x.frequency));
  const blank = () => ({ outlet_id: outlet, name: '', type: 'general', ccp_id: '', description: '', frequency: 'daily', weekdays: [1], month_day: 1, start_date: daysAgo(0), end_date: '', time: '09:00', min_val: '', max_val: '', checklist: [''], assignee: '' });
  const complete = () => run(() => api.post(`/tasks/${doing.task.id}/complete`, { day: doing.day, value: doing.value, checks: doing.checks, remarks: doing.remarks, done_by: doing.done_by }), L('已记录', 'Recorded'));
  const outOfRange = doing && doing.task.type === 'temperature' && doing.value !== '' && (+doing.value < doing.task.min_val || +doing.value > doing.task.max_val);

  return (
    <Page title={t('tasks')}>
      <Tabs value={tab} onChange={setTab} tabs={[['today', L('每日待办', 'Daily tasks')], ['tasks', L('任务设置', 'Task set-up')], ['ccp', L('关键控制点 CCP', 'Critical control points')], ['report', L('报告', 'Report')]]} />

      {tab === 'today' && <section className="card">
        <div className="row"><Field label={t('date')}><input type="date" value={day} onChange={(e) => setDay(e.target.value)} /></Field>
          <button onClick={() => setDay(daysAgo(0))}>{L('今天', 'Today')}</button></div>
        {occ && occ.length === 0 ? <Empty text={L('这一天没有任务', 'No tasks on this day')} /> : (
          <table><thead><tr><th>{t('time')}</th><th>{L('任务', 'Task')}</th><th>{t('kind')}</th><th>CCP</th><th>{L('记录', 'Record')}</th><th>{t('status')}</th><th /></tr></thead>
            <tbody>{(occ || []).map((o) => (
              <tr key={o.task.id}><td>{o.task.time}</td><td><b>{o.task.name}</b>{o.task.description && <div className="muted small">{o.task.description}</div>}</td><td>{t(o.task.type)}</td><td className="muted">{o.task.ccp_code}</td>
                <td>{o.log && <span className={o.irregular ? 'bad' : ''}>{o.log.value != null ? `${o.log.value} °C ` : ''}{o.irregular && <span className="tag bad">{L('异常', 'Irregularity')}</span>}
                  <span className="muted small"> {o.log.done_by} {ts(o.log.done_at).slice(11)}</span>{o.log.remarks && <div className="small">{o.log.remarks}</div>}</span>}</td>
                <td><Status s={o.status === 'open' ? 'todo' : o.status} /></td>
                <td className="r nowrap">
                  {o.task.type === 'order' && <a className="link" href="#orders">{L('去订货', 'Create order')}</a>}
                  {o.task.type === 'count' && <a className="link" href="#counts">{L('去盘点', 'Count inventory')}</a>}
                  <button className="link" onClick={() => setDoing({ ...o, value: o.log?.value ?? '', checks: o.log?.checks?.length ? o.log.checks : o.task.checklist.map(() => false), remarks: o.log?.remarks || '', done_by: o.log?.done_by || meta.me.display_name })}>{o.log ? L('修改', 'Edit') : L('完成', 'Complete')}</button>
                </td></tr>))}</tbody></table>)}
      </section>}

      {tab === 'tasks' && <section className="card">
        <div className="card-head"><h3>{L('本店的周期任务', 'Recurring tasks for this outlet')}</h3><span className="grow" /><button className="primary" onClick={() => setEd(blank())}>+ {L('新建任务', 'Create new task')}</button></div>
        <table><thead><tr><th>{t('name')}</th><th>{t('kind')}</th><th>CCP</th><th>{L('频率', 'Frequency')}</th><th>{t('time')}</th><th>{L('限值', 'Limits')}</th><th /></tr></thead>
          <tbody>{(tasks || []).map((x) => (
            <tr key={x.id} className="click" onClick={() => setEd({ ...x, ccp_id: x.ccp_id || '', end_date: x.end_date || '', min_val: x.min_val ?? '', max_val: x.max_val ?? '', checklist: x.checklist.length ? x.checklist : [''] })}>
              <td><b>{x.name}</b></td><td>{t(x.type)}</td><td className="muted">{x.ccp_code}</td><td>{freq(x)}</td><td>{x.time}</td>
              <td>{x.type === 'temperature' ? `${x.min_val} – ${x.max_val} °C` : x.checklist.length ? L(`${x.checklist.length} 项清单`, `${x.checklist.length} checklist items`) : ''}</td><td className="r"><span className="link">{t('edit')}</span></td></tr>))}</tbody></table>
      </section>}

      {tab === 'ccp' && <section className="card">
        <Note>{L('关键控制点来自你的 HACCP 计划，是全局的（不分门店）。先定义 CCP，再给每个 CCP 挂上具体任务。', 'CCPs come from your HACCP plan and are library-wide (not per outlet). Define them first, then attach tasks to each.')}</Note>
        <div className="card-head"><span className="grow" /><button className="primary" onClick={() => setCcp({ name: '', code: `CCP-${(ccps?.length || 0) + 1}`, type: 'storage', description: '' })}>+ {L('新增 CCP', 'Add CCP')}</button></div>
        <table><thead><tr><th>{L('编号', 'Code')}</th><th>{t('name')}</th><th>{t('kind')}</th><th>{L('说明', 'Description')}</th><th /></tr></thead>
          <tbody>{(ccps || []).map((c) => (
            <tr key={c.id}><td><b>{c.code}</b></td><td>{c.name}</td><td>{t(c.type)}</td><td className="muted">{c.description}</td>
              <td className="r nowrap"><button className="link" onClick={() => setCcp({ ...c })}>{t('edit')}</button><button className="link danger" onClick={() => confirm(t('confirm_del')) && run(() => api.del(`/ccps/${c.id}`))}>{t('del')}</button></td></tr>))}</tbody></table>
      </section>}

      {tab === 'report' && rep && <>
        <div className="row" style={{ marginBottom: 12 }}><Range from={r[0]} to={r[1]} set={(a, b) => setR([a, b])} /></div>
        <div className="kpis">
          <Kpi label={L('应做', 'Due')} value={rep.due} /><Kpi label={L('已做', 'Completed')} value={rep.done} sub={pct(rep.compliance)} />
          <Kpi label={t('overdue')} value={rep.overdue} tone={rep.overdue ? 'warn' : ''} /><Kpi label={L('异常', 'Irregularities')} value={rep.irregular} tone={rep.irregular ? 'warn' : ''} />
        </div>
        <section className="card"><h3>{L('异常记录及处理措施', 'Irregularities and corrective actions')}</h3>
          {rep.irregularities.length === 0 ? <Empty text={L('这段时间没有异常', 'No irregularities in this period')} /> : (
            <table><thead><tr><th>{t('date')}</th><th>{L('任务', 'Task')}</th><th>CCP</th><th className="r">{L('读数', 'Reading')}</th><th>{L('限值', 'Limits')}</th><th>{L('处理措施', 'Corrective action')}</th><th>{L('记录人', 'By')}</th></tr></thead>
              <tbody>{rep.irregularities.map((o) => (
                <tr key={o.task.id + o.day}><td>{o.day}</td><td><b>{o.task.name}</b></td><td className="muted">{o.task.ccp_code}</td><td className="r bad">{o.log.value ?? ''}</td>
                  <td>{o.task.type === 'temperature' ? `${o.task.min_val} – ${o.task.max_val}` : ''}</td><td>{o.log.remarks}</td><td className="muted">{o.log.done_by}</td></tr>))}</tbody></table>)}
        </section>
        <section className="card"><h3>{L('全部记录', 'All occurrences')}</h3>
          <div className="scroll"><table><thead><tr><th>{t('date')}</th><th>{L('任务', 'Task')}</th><th>{L('记录', 'Record')}</th><th>{L('记录人', 'By')}</th><th>{t('status')}</th></tr></thead>
            <tbody>{[...rep.rows].reverse().map((o) => (
              <tr key={o.task.id + o.day}><td>{o.day}</td><td>{o.task.name}</td><td className={o.irregular ? 'bad' : ''}>{o.log?.value != null ? `${o.log.value} °C` : o.log ? '✓' : ''}</td><td className="muted">{o.log?.done_by}</td><td><Status s={o.status === 'open' ? 'todo' : o.status} /></td></tr>))}</tbody></table></div>
        </section>
      </>}

      {doing && (
        <Modal title={`${doing.task.name} · ${doing.day}`} onClose={() => setDoing(null)}>
          {doing.task.description && <p className="muted">{doing.task.description}</p>}
          <div className="form">
            {doing.task.type === 'temperature' && <Field label={L(`测量值 °C（允许范围 ${doing.task.min_val} – ${doing.task.max_val}）`, `Reading °C (allowed ${doing.task.min_val} – ${doing.task.max_val})`)}>
              <input type="number" step="0.1" value={doing.value} onChange={(e) => setDoing({ ...doing, value: e.target.value })} autoFocus /></Field>}
            {doing.task.checklist.map((c, i) => (
              <label className="check" key={i}><input type="checkbox" checked={!!doing.checks[i]} onChange={(e) => setDoing({ ...doing, checks: doing.task.checklist.map((_, j) => (j === i ? e.target.checked : !!doing.checks[j])) })} />{c}</label>))}
            {outOfRange && <div className="note bad-note">{L('读数超出限值：这次会记为「异常」，必须写明处理措施。', 'Reading is outside the limits: this will be logged as an irregularity and a corrective action is required.')}</div>}
            <Field label={outOfRange ? L('处理措施 (必填)', 'Corrective action (required)') : t('note')}><textarea rows="2" value={doing.remarks} onChange={(e) => setDoing({ ...doing, remarks: e.target.value })} /></Field>
            <Field label={L('记录人', 'Completed by')}><input value={doing.done_by} onChange={(e) => setDoing({ ...doing, done_by: e.target.value })} /></Field>
          </div>
          <div className="modal-foot"><button onClick={() => setDoing(null)}>{t('cancel')}</button><button className="primary" onClick={complete}>{L('完成', 'Complete')}</button></div>
        </Modal>)}

      {ed && (
        <Modal title={ed.id ? ed.name : L('新建任务', 'Create new task')} onClose={() => setEd(null)} wide>
          <div className="form cols">
            <Field label={t('name')}><input value={ed.name} onChange={(e) => setEd({ ...ed, name: e.target.value })} autoFocus /></Field>
            <Field label={t('kind')}><select value={ed.type} onChange={(e) => setEd({ ...ed, type: e.target.value })}>{meta.task_types.map((x) => <option key={x} value={x}>{t(x)}</option>)}</select></Field>
            <Field label="CCP"><select value={ed.ccp_id} onChange={(e) => setEd({ ...ed, ccp_id: +e.target.value || '' })}><option value="">{L('— 不关联 —', '— none —')}</option>{(ccps || []).map((c) => <option key={c.id} value={c.id}>{c.code} {c.name}</option>)}</select></Field>
            <Field label={t('assignee')}><input value={ed.assignee} onChange={(e) => setEd({ ...ed, assignee: e.target.value })} /></Field>
            <Field label={L('频率', 'Frequency')}><select value={ed.frequency} onChange={(e) => setEd({ ...ed, frequency: e.target.value })}>{['inactive', 'once', 'daily', 'weekly', 'monthly'].map((x) => <option key={x} value={x}>{t(x)}</option>)}</select></Field>
            {ed.frequency === 'monthly' && <Field label={L('每月几号', 'Day of month')}><input type="number" min="1" max="28" value={ed.month_day || 1} onChange={(e) => setEd({ ...ed, month_day: +e.target.value })} /></Field>}
            <Field label={L('开始日期', 'Start date')}><input type="date" value={ed.start_date} onChange={(e) => setEd({ ...ed, start_date: e.target.value })} /></Field>
            <Field label={L('结束日期 (可选)', 'End date (optional)')}><input type="date" value={ed.end_date} onChange={(e) => setEd({ ...ed, end_date: e.target.value })} /></Field>
            <Field label={t('time')}><input type="time" value={ed.time} onChange={(e) => setEd({ ...ed, time: e.target.value })} /></Field>
            {ed.type === 'temperature' && <>
              <Field label={L('最低温度 °C', 'Minimum °C')}><input type="number" value={ed.min_val} onChange={(e) => setEd({ ...ed, min_val: e.target.value })} /></Field>
              <Field label={L('最高温度 °C', 'Maximum °C')}><input type="number" value={ed.max_val} onChange={(e) => setEd({ ...ed, max_val: e.target.value })} /></Field></>}
          </div>
          {ed.frequency === 'weekly' && <><div className="sub-h">{L('星期几', 'Weekdays')}</div>
            <div className="chips">{WD.map(([zh, en, n]) => { const on = ed.weekdays.includes(n); return <button key={n} className={'chip' + (on ? ' on' : '')} onClick={() => setEd({ ...ed, weekdays: on ? ed.weekdays.filter((x) => x !== n) : [...ed.weekdays, n] })}>{L(zh, en)}</button>; })}</div></>}
          <Field label={L('说明', 'Description')}><textarea rows="2" value={ed.description} onChange={(e) => setEd({ ...ed, description: e.target.value })} /></Field>
          {ed.type === 'checklist' && <><div className="sub-h">{L('清单项', 'Checklist items')}</div>
            {ed.checklist.map((c, i) => <div className="row tightrow" key={i} style={{ marginBottom: 6 }}><input style={{ flex: 1 }} value={c} onChange={(e) => setEd({ ...ed, checklist: ed.checklist.map((x, j) => (j === i ? e.target.value : x)) })} /><button className="link danger" onClick={() => setEd({ ...ed, checklist: ed.checklist.filter((_, j) => j !== i) })}>✕</button></div>)}
            <button className="link" onClick={() => setEd({ ...ed, checklist: [...ed.checklist, ''] })}>+ {t('add_line')}</button></>}
          <div className="modal-foot">
            {ed.id && <button className="danger" onClick={() => confirm(L('删除后以后不再出现，过去的记录也会删除。确定？', 'This removes future occurrences and past records. Continue?')) && run(() => api.del(`/tasks/${ed.id}`))}>{t('del')}</button>}<span className="grow" />
            <button onClick={() => setEd(null)}>{t('cancel')}</button><button className="primary" disabled={!ed.name} onClick={() => run(() => api.post('/tasks', ed))}>{L('保存任务', 'Save task')}</button></div>
        </Modal>)}

      {ccp && (
        <Modal title="CCP" onClose={() => setCcp(null)}>
          <div className="form">
            <Field label={L('编号', 'Code')}><input value={ccp.code} onChange={(e) => setCcp({ ...ccp, code: e.target.value })} /></Field>
            <Field label={t('name')}><input value={ccp.name} onChange={(e) => setCcp({ ...ccp, name: e.target.value })} autoFocus /></Field>
            <Field label={L('CCP 类型', 'CCP type')}><select value={ccp.type} onChange={(e) => setCcp({ ...ccp, type: e.target.value })}>{meta.ccp_types.map((x) => <option key={x} value={x}>{t(x)}</option>)}</select></Field>
            <Field label={L('说明', 'Description')}><textarea rows="3" value={ccp.description} onChange={(e) => setCcp({ ...ccp, description: e.target.value })} /></Field>
          </div>
          <div className="modal-foot"><button onClick={() => setCcp(null)}>{t('cancel')}</button><button className="primary" disabled={!ccp.name || !ccp.code} onClick={() => run(() => api.post('/ccps', ccp))}>{t('save')}</button></div>
        </Modal>)}
    </Page>
  );
}
