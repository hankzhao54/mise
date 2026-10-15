import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, Ctx, makeI18n } from './lib.jsx';
import { Dashboard, Ingredients, Menus, Recipes, Suppliers } from './products.jsx';
import { Internal, Orders } from './purchasing.jsx';
import { Counts, Stock } from './inventory.jsx';
import { Production, Tasks } from './planning.jsx';
import { Insights, MenuEngineering, Sales, SalesDash, Trace } from './analytics.jsx';
import { Settings } from './settings.jsx';
import { Audit, DataAdmin, Login, Outlets, PasswordDialog, Users } from './admin.jsx';
import './styles.css';

const NAV = [
  [null, [['dashboard', Dashboard]]],
  ['g_products', [['recipes', Recipes], ['menus', Menus], ['ingredients', Ingredients], ['suppliers', Suppliers]]],
  ['g_procurement', [['orders', Orders], ['internal', Internal]]],
  ['g_inventory', [['stock', Stock], ['counts', Counts]]],
  ['g_planning', [['production', Production], ['tasks', Tasks]]],
  ['g_sales', [['sales', Sales], ['salesdash', SalesDash], ['menu', MenuEngineering]]],
  ['g_insights', [['insights', Insights], ['trace', Trace]]],
];
// 只有管理员能看到的页面
const ADMIN_NAV = ['g_admin', [['users', Users], ['outlets', Outlets], ['audit', Audit], ['data', DataAdmin], ['settings', Settings]]];
const ADMIN_PAGES = new Set(ADMIN_NAV[1].map(([k]) => k));
const PAGES = Object.fromEntries([...NAV, ADMIN_NAV].flatMap(([, items]) => items));
const hashPage = () => location.hash.slice(1).split('?')[0] || 'dashboard';
const store = { get: (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } } };

function App() {
  const [lang, setLang] = useState(store.get('mise.lang', 'zh'));
  const [me, setMe] = useState(undefined);   // undefined = 还在检查登录状态，null = 未登录
  const [page, setPage] = useState(hashPage());
  const [meta, setMeta] = useState(null);
  const [outlet, setOutlet] = useState(+store.get('mise.outlet', 0));
  const [toast, setToast] = useState(null);
  const [menu, setMenu] = useState(false);
  const [pwd, setPwd] = useState(false);

  // 新提示出现时取消上一个的定时器，否则旧定时器会把新提示提前关掉
  const timer = useRef(null);
  const flash = useCallback((msg, error) => { clearTimeout(timer.current); setToast({ msg, error }); timer.current = setTimeout(() => setToast(null), error ? 6000 : 2200); }, []);
  const reloadMeta = useCallback(() => api.get('/meta').then((m) => {
    setMeta(m);
    setOutlet((o) => (m.my_outlets.includes(o) ? o : m.my_outlets[0] || 0));
  }).catch(() => {}), []);

  useEffect(() => { api.get('/me').then(setMe).catch(() => setMe(null)); }, []);
  useEffect(() => { if (me) reloadMeta(); }, [me, reloadMeta]);
  useEffect(() => { const h = () => { setMe(null); setMeta(null); }; window.addEventListener('mise:signed-out', h); return () => window.removeEventListener('mise:signed-out', h); }, []);
  useEffect(() => { const h = () => setPage(hashPage()); window.addEventListener('hashchange', h); return () => window.removeEventListener('hashchange', h); }, []);
  useEffect(() => { store.set('mise.lang', lang); document.documentElement.lang = lang; }, [lang]);
  useEffect(() => { if (outlet) store.set('mise.outlet', outlet); }, [outlet]);
  useEffect(() => { if (!menu) return; const h = () => setMenu(false); setTimeout(() => window.addEventListener('click', h), 0); return () => window.removeEventListener('click', h); }, [menu]);

  const ctx = useMemo(() => ({ ...makeI18n(lang), lang, meta, outlet, outletObj: meta?.outlets.find((o) => o.id === outlet), flash, reloadMeta }), [lang, meta, outlet, flash, reloadMeta]);
  const logout = async () => { await api.post('/logout').catch(() => {}); setMe(null); setMeta(null); };

  if (me === undefined) return null;
  if (!me) return <Login lang={lang} setLang={setLang} onLogin={(u) => setMe(u)} />;
  if (!meta) return null;

  const isAdmin = meta.me.role === 'admin';
  const nav = isAdmin ? [...NAV, ADMIN_NAV] : NAV;
  const myOutlets = meta.outlets.filter((o) => meta.my_outlets.includes(o.id));
  // 没有可用门店时 (刚清空数据，或账号没分配门店) 只能进管理页面
  const needOutlet = !ADMIN_PAGES.has(page);
  const Cur = (!isAdmin && ADMIN_PAGES.has(page)) ? Dashboard : PAGES[page] || Dashboard;
  const L = ctx.L;

  return (
    <Ctx.Provider value={ctx}>
      <div className="shell">
        <aside>
          <div className="brand">Mise<span>{L('后厨管理', 'Kitchen management')}</span></div>
          <nav>
            {nav.map(([g, items], i) => (
              <div key={i}>
                {g ? <div className="nav-group">{ctx.t(g)}</div> : i > 0 && <div className="nav-sep" />}
                {items.map(([k]) => <a key={k} href={'#' + k} className={page === k ? 'on' : ''}>{ctx.t(k)}</a>)}
              </div>
            ))}
          </nav>
        </aside>
        <main>
          <header>
            {myOutlets.length > 0 && (
              <select value={outlet} onChange={(e) => setOutlet(+e.target.value)} aria-label="outlet">
                {myOutlets.map((o) => <option key={o.id} value={o.id}>{ctx.N(o)}</option>)}
              </select>)}
            <div className="seg">
              <button className={lang === 'zh' ? 'on' : ''} onClick={() => setLang('zh')}>中文</button>
              <button className={lang === 'en' ? 'on' : ''} onClick={() => setLang('en')}>EN</button>
            </div>
            <div className="user-menu">
              <button onClick={() => setMenu(!menu)} aria-haspopup="menu" aria-expanded={menu}>👤 {meta.me.display_name}</button>
              {menu && (
                <div className="user-pop" role="menu">
                  <div className="who">{meta.me.username} · {isAdmin ? L('管理员', 'Admin') : L('管理人员', 'Manager')}</div>
                  <button role="menuitem" onClick={() => setPwd(true)}>{L('修改密码', 'Change password')}</button>
                  <button role="menuitem" onClick={logout}>{L('退出登录', 'Sign out')}</button>
                </div>)}
            </div>
          </header>
          {needOutlet && !outlet
            ? <div className="no-outlet"><h2>{L('还没有可用的门店', 'No outlet available')}</h2>
                <p className="muted">{isAdmin ? <>{L('先到 ', 'Create one under ')}<a href="#outlets">{ctx.t('outlets')}</a>{L(' 建一个门店。', ' first.')}</> : L('请联系管理员给你的账号分配门店。', 'Ask an administrator to assign an outlet to your account.')}</p></div>
            : <Cur key={page + outlet} />}
        </main>
        {pwd && <PasswordDialog onClose={() => setPwd(false)} />}
        {toast && <div className={'toast' + (toast.error ? ' error' : '')}>{toast.msg}</div>}
      </div>
    </Ctx.Provider>
  );
}

createRoot(document.getElementById('root')).render(<App />);
