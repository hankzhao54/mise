// 登录页、修改密码，以及管理员页面：账号、门店、操作记录、数据
import { useState } from 'react';
import { api, Empty, Field, Modal, Note, Page, ts, useAct, useApp, useLoad } from './lib.jsx';

// ───────── 登录
export function Login({ lang, setLang, onLogin }) {
  const L = (zh, en) => (lang === 'zh' ? zh : en);
  const [f, setF] = useState({ username: '', password: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try { onLogin(await api.post('/login', f)); } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">Mise<span>{L('后厨管理', 'Kitchen management')}</span></div>
        <Field label={L('用户名', 'Username')}><input autoFocus autoComplete="username" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} /></Field>
        <Field label={L('密码', 'Password')}><input type="password" autoComplete="current-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
        {err && <div className="login-err" role="alert">{err}</div>}
        <button className="primary" disabled={busy || !f.username || !f.password}>{busy ? '…' : L('登录', 'Sign in')}</button>
        <div className="seg login-lang">
          <button type="button" className={lang === 'zh' ? 'on' : ''} onClick={() => setLang('zh')}>中文</button>
          <button type="button" className={lang === 'en' ? 'on' : ''} onClick={() => setLang('en')}>EN</button>
        </div>
        <p className="muted small">{L('没有账号请找管理员开通。', 'Ask an administrator for an account.')}</p>
      </form>
    </div>
  );
}

// ───────── 修改自己的密码
export function PasswordDialog({ onClose }) {
  const { L, t } = useApp();
  const act = useAct();
  const [f, setF] = useState({ old_password: '', new_password: '', again: '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const mismatch = f.again && f.again !== f.new_password;
  const save = async () => { if (await act(() => api.post('/me/password', f), L('密码已修改', 'Password changed'))) onClose(); };
  return (
    <Modal title={L('修改密码', 'Change password')} onClose={onClose}>
      <div className="form">
        <Field label={L('原密码', 'Current password')}><input type="password" autoComplete="current-password" value={f.old_password} onChange={set('old_password')} autoFocus /></Field>
        <Field label={L('新密码', 'New password')} hint={L('至少 8 位', 'At least 8 characters')}><input type="password" autoComplete="new-password" value={f.new_password} onChange={set('new_password')} /></Field>
        <Field label={L('再输一次', 'Repeat new password')} hint={mismatch ? L('两次不一致', 'Does not match') : ''}><input type="password" autoComplete="new-password" value={f.again} onChange={set('again')} /></Field>
      </div>
      <p className="muted small">{L('改完后，你在其他设备上的登录会失效。', 'Other devices you are signed in on will be signed out.')}</p>
      <div className="modal-foot"><button onClick={onClose}>{t('cancel')}</button>
        <button className="primary" disabled={!f.old_password || f.new_password.length < 8 || f.again !== f.new_password} onClick={save}>{t('save')}</button></div>
    </Modal>
  );
}

// ───────── 账号
const blankUser = { username: '', display_name: '', role: 'manager', outlets: [], can_approve: false, can_edit_master: false, active: true, password: '' };
export function Users() {
  const { t, L, N, meta } = useApp();
  const act = useAct();
  const [rows, reload] = useLoad(() => api.get('/admin/users'), []);
  const [ed, setEd] = useState(null);
  const set = (k) => (e) => setEd({ ...ed, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const toggleOutlet = (id) => setEd({ ...ed, outlets: ed.outlets.includes(id) ? ed.outlets.filter((x) => x !== id) : [...ed.outlets, id] });
  const save = async () => {
    const body = { ...ed, password: ed.password || undefined };
    if (await act(() => (ed.id ? api.put(`/admin/users/${ed.id}`, body) : api.post('/admin/users', body)))) { setEd(null); reload(); }
  };
  const del = async (u) => { if (confirm(L(`删除账号 ${u.username}？`, `Delete ${u.username}?`)) && await act(() => api.del(`/admin/users/${u.id}`))) reload(); };
  const outletNames = (u) => (u.role === 'admin' || !u.outlets.length ? L('全部门店', 'All outlets') : u.outlets.map((id) => N(meta.outlets.find((o) => o.id === id)) || `#${id}`).join('、'));
  const isAdmin = ed?.role === 'admin';
  return (
    <Page title={L('账号', 'Users')} actions={<button className="primary" onClick={() => setEd({ ...blankUser })}>+ {t('add')}</button>}>
      <Note>{L('管理员：所有功能，包括账号、门店、设置。管理人员：日常操作，可以限定只看某几家门店；审批订单、修改主数据 (配方、原料、价格、供应商、菜单) 要单独打开。',
        'Admin: everything, including users, outlets and settings. Manager: day-to-day work, optionally limited to some outlets; approving orders and editing master data (recipes, ingredients, prices, suppliers, menus) are separate switches.')}</Note>
      <section className="card">
        {!rows ? null : !rows.length ? <Empty /> : (
          <table><thead><tr><th>{L('用户名', 'Username')}</th><th>{L('显示名', 'Display name')}</th><th>{L('角色', 'Role')}</th><th>{L('门店', 'Outlets')}</th><th>{L('权限', 'Permissions')}</th><th>{L('最近登录', 'Last sign-in')}</th><th /></tr></thead>
            <tbody>{rows.map((u) => (
              <tr key={u.id} className={u.active ? '' : 'muted'}>
                <td><b>{u.username}</b>{!u.active && <span className="tag bad">{L('已停用', 'Disabled')}</span>}</td>
                <td>{u.display_name}</td>
                <td><span className={'tag ' + (u.role === 'admin' ? 'accent' : 'soft')}>{u.role === 'admin' ? L('管理员', 'Admin') : L('管理人员', 'Manager')}</span></td>
                <td className="small">{outletNames(u)}</td>
                <td className="small">{u.role === 'admin' ? '—' : [u.can_approve && L('审批订单', 'Approve orders'), u.can_edit_master && L('改主数据', 'Edit master data')].filter(Boolean).join('、') || <span className="muted">{L('日常操作', 'Day-to-day')}</span>}</td>
                <td className="muted small">{ts(u.last_login_at) || '–'}</td>
                <td className="r nowrap"><button className="link" onClick={() => setEd({ ...u, password: '' })}>{t('edit')}</button>
                  {u.id !== meta.me.id && <button className="link danger" onClick={() => del(u)}>{t('del')}</button>}</td>
              </tr>))}</tbody></table>)}
      </section>
      {ed && (
        <Modal title={ed.id ? L('编辑账号', 'Edit user') : L('新账号', 'New user')} onClose={() => setEd(null)}>
          <div className="form cols">
            <Field label={L('用户名', 'Username')} hint={L('登录用，小写字母、数字、_ . -', 'For signing in: a-z, 0-9, _ . -')}><input value={ed.username} onChange={set('username')} autoFocus autoComplete="off" /></Field>
            <Field label={L('显示名', 'Display name')} hint={L('记录里显示的名字', 'Shown in records')}><input value={ed.display_name} onChange={set('display_name')} /></Field>
          </div>
          <div className="form">
            <Field label={L('角色', 'Role')}>
              <select value={ed.role} onChange={set('role')} disabled={ed.id === meta.me.id}>
                <option value="manager">{L('管理人员', 'Manager')}</option><option value="admin">{L('管理员', 'Admin')}</option>
              </select>
            </Field>
            {!isAdmin && <>
              <Field label={L('能操作的门店', 'Outlets')} hint={L('一个都不选 = 全部门店', 'None selected = all outlets')}>
                <div className="chips">{meta.outlets.map((o) => <button type="button" key={o.id} className={'chip' + (ed.outlets.includes(o.id) ? ' on' : '')} onClick={() => toggleOutlet(o.id)}>{N(o)}</button>)}</div>
              </Field>
              <label className="check"><input type="checkbox" checked={!!ed.can_approve} onChange={set('can_approve')} /> {L('可以审批超限额的订单', 'Can approve orders above the limit')}</label>
              <label className="check"><input type="checkbox" checked={!!ed.can_edit_master} onChange={set('can_edit_master')} /> {L('可以修改主数据 (配方、原料与价格、供应商、菜单、HACCP 控制点)', 'Can edit master data (recipes, ingredients & prices, suppliers, menus, CCPs)')}</label>
            </>}
            {ed.id && ed.id !== meta.me.id && <label className="check"><input type="checkbox" checked={!!ed.active} onChange={set('active')} /> {L('启用 (停用后立即退出登录)', 'Active (disabling signs the user out)')}</label>}
            <Field label={ed.id ? L('重置密码', 'Reset password') : L('初始密码', 'Initial password')} hint={ed.id ? L('留空 = 不改', 'Leave empty to keep') : L('至少 8 位，告诉对方后让他自己改', 'At least 8 characters; ask them to change it')}>
              <input type="text" autoComplete="new-password" value={ed.password} onChange={set('password')} />
            </Field>
          </div>
          <div className="modal-foot"><button onClick={() => setEd(null)}>{t('cancel')}</button>
            <button className="primary" disabled={!ed.username || (!ed.id && ed.password.length < 8)} onClick={save}>{t('save')}</button></div>
        </Modal>)}
    </Page>
  );
}

// ───────── 门店
export function Outlets() {
  const { t, L, meta, reloadMeta } = useApp();
  const act = useAct();
  const [ed, setEd] = useState(null);
  const set = (k) => (e) => setEd({ ...ed, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const save = async () => {
    const body = { ...ed, is_supplier: ed.kind === 'central_kitchen' || ed.is_supplier };
    if (await act(() => (ed.id ? api.put(`/admin/outlets/${ed.id}`, body) : api.post('/admin/outlets', body)))) { setEd(null); reloadMeta(); }
  };
  const del = async (o) => { if (confirm(t('confirm_del')) && await act(() => api.del(`/admin/outlets/${o.id}`))) reloadMeta(); };
  return (
    <Page title={L('门店', 'Outlets')} actions={<button className="primary" onClick={() => setEd({ name_zh: '', name_en: '', kind: 'restaurant', is_supplier: false })}>+ {t('add')}</button>}>
      <section className="card">
        {!meta.outlets.length ? <Empty text={L('还没有门店，先建一个。', 'No outlets yet — add one first.')} /> : (
          <table><thead><tr><th>{t('name_zh')}</th><th>{t('name_en')}</th><th>{t('kind')}</th><th>{L('内部供应', 'Internal supplier')}</th><th /></tr></thead>
            <tbody>{meta.outlets.map((o) => (
              <tr key={o.id}><td><b>{o.name_zh}</b></td><td>{o.name_en}</td>
                <td>{o.kind === 'central_kitchen' ? L('中央厨房', 'Central kitchen') : L('门店', 'Restaurant')}</td>
                <td>{o.is_supplier ? '✓' : ''}</td>
                <td className="r nowrap"><button className="link" onClick={() => setEd({ ...o, is_supplier: !!o.is_supplier })}>{t('edit')}</button><button className="link danger" onClick={() => del(o)}>{t('del')}</button></td></tr>))}</tbody></table>)}
        <p className="muted small">{L('有业务数据 (库存、订单、销售…) 的门店不能删除。', 'Outlets with business data (stock, orders, sales…) cannot be deleted.')}</p>
      </section>
      {ed && (
        <Modal title={L('门店', 'Outlet')} onClose={() => setEd(null)}>
          <div className="form">
            <Field label={t('name_zh')}><input value={ed.name_zh} onChange={set('name_zh')} autoFocus /></Field>
            <Field label={t('name_en')}><input value={ed.name_en} onChange={set('name_en')} /></Field>
            <Field label={t('kind')}><select value={ed.kind} onChange={set('kind')}><option value="restaurant">{L('门店', 'Restaurant')}</option><option value="central_kitchen">{L('中央厨房', 'Central kitchen')}</option></select></Field>
            {ed.kind !== 'central_kitchen' && <label className="check"><input type="checkbox" checked={ed.is_supplier} onChange={set('is_supplier')} /> {L('其他门店可以向它内部订货', 'Other outlets can place internal orders with it')}</label>}
          </div>
          <div className="modal-foot"><button onClick={() => setEd(null)}>{t('cancel')}</button><button className="primary" disabled={!ed.name_zh && !ed.name_en} onClick={save}>{t('save')}</button></div>
        </Modal>)}
    </Page>
  );
}

// ───────── 操作记录
export function Audit() {
  const { L } = useApp();
  const [user, setUser] = useState('');
  const [users] = useLoad(() => api.get('/admin/users'), []);
  const [rows] = useLoad(() => api.get('/admin/audit?limit=500' + (user ? `&user=${user}` : '')), [user]);
  return (
    <Page title={L('操作记录', 'Audit log')} actions={
      <Field label={L('人员', 'User')}><select value={user} onChange={(e) => setUser(e.target.value)}><option value="">{L('全部', 'All')}</option>{(users || []).map((u) => <option key={u.id} value={u.id}>{u.display_name} ({u.username})</option>)}</select></Field>}>
      <Note>{L('每一次成功的修改 (新增、保存、审批、收货、删除…) 和登录都会记一条。密码不会被记录。', 'Every successful change (create, save, approve, receive, delete…) and every sign-in is recorded. Passwords are never logged.')}</Note>
      <section className="card">
        {!rows ? null : !rows.length ? <Empty /> : (
          <table><thead><tr><th>{L('时间', 'Time')}</th><th>{L('人员', 'User')}</th><th>{L('操作', 'Action')}</th><th>{L('内容', 'Details')}</th></tr></thead>
            <tbody>{rows.map((a) => (
              <tr key={a.id}><td className="nowrap muted">{ts(a.ts)}</td><td className="nowrap">{a.username}</td>
                <td className="nowrap"><span className="tag soft">{a.method}</span>{a.path.replace(/^\/api/, '')}</td>
                <td className="small mono clip">{a.summary}</td></tr>))}</tbody></table>)}
      </section>
    </Page>
  );
}

// ───────── 数据：清空 / 装入示例
export function DataAdmin() {
  const { L, meta, reloadMeta } = useApp();
  const act = useAct();
  const [typed, setTyped] = useState('');
  const word = L('清空', 'CLEAR');
  const reset = async (demo) => {
    if (await act(() => api.post('/admin/reset', { demo }), demo ? L('已装入示例数据', 'Demo data loaded') : L('已清空', 'Cleared'))) { setTyped(''); reloadMeta(); }
  };
  return (
    <Page title={L('数据', 'Data')}>
      <section className="card">
        <h3>{L('当前数据库', 'Current database')}</h3>
        <p>{meta.db === 'postgres' ? L('PostgreSQL (正式数据库，例如 Supabase)', 'PostgreSQL (production database, e.g. Supabase)') : L('内嵌 PGlite (本地开发用，存在服务器磁盘上)', 'Embedded PGlite (for local development, stored on the server disk)')}</p>
      </section>
      <section className="card">
        <h3>{L('开始正式使用', 'Go live')}</h3>
        <p>{L('清空全部业务数据：门店、供应商、原料、配方、菜单、库存、订单、生产、销售、HACCP 记录。账号、设置和操作记录会保留。清空后先到「门店」建门店。',
          'Removes all business data: outlets, suppliers, ingredients, recipes, menus, stock, orders, production, sales and HACCP records. Users, settings and the audit log are kept. Afterwards, create your outlets first.')}</p>
        <div className="row">
          <Field label={L(`输入「${word}」确认`, `Type "${word}" to confirm`)}><input value={typed} onChange={(e) => setTyped(e.target.value)} /></Field>
          <button className="danger-btn" disabled={typed !== word} onClick={() => reset(false)}>{L('清空全部业务数据', 'Clear all business data')}</button>
        </div>
      </section>
      <section className="card">
        <h3>{L('示例数据', 'Demo data')}</h3>
        <p>{L('用一套示例 (中央厨房 + 两家门店 + 两周销售) 替换现有业务数据，方便培训和演示。同样会先清空。',
          'Replaces the business data with a demo set (a central kitchen, two restaurants, two weeks of sales) for training. This also clears existing data first.')}</p>
        <button disabled={typed !== word} onClick={() => reset(true)}>{L('清空并装入示例数据', 'Clear and load demo data')}</button>
        {typed !== word && <span className="muted small"> {L('(先在上面输入确认词)', '(type the confirmation word above first)')}</span>}
      </section>
    </Page>
  );
}
