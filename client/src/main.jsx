import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, Ctx, makeI18n } from './lib.jsx';
import { Dashboard, Ingredients, Menus, Recipes, Suppliers } from './products.jsx';
import { Internal, Orders } from './purchasing.jsx';
import { Counts, Stock } from './inventory.jsx';
import { Production, Tasks } from './planning.jsx';
import { Insights, MenuEngineering, Sales, SalesDash, Trace } from './analytics.jsx';
import { Settings } from './settings.jsx';
import './styles.css';

const NAV = [
  [null, [['dashboard', Dashboard]]],
  ['g_products', [['recipes', Recipes], ['menus', Menus], ['ingredients', Ingredients], ['suppliers', Suppliers]]],
  ['g_procurement', [['orders', Orders], ['internal', Internal]]],
  ['g_inventory', [['stock', Stock], ['counts', Counts]]],
  ['g_planning', [['production', Production], ['tasks', Tasks]]],
  ['g_sales', [['sales', Sales], ['salesdash', SalesDash], ['menu', MenuEngineering]]],
  ['g_insights', [['insights', Insights], ['trace', Trace]]],
  [null, [['settings', Settings]]],
];
const PAGES = Object.fromEntries(NAV.flatMap(([, items]) => items));
const hashPage = () => location.hash.slice(1).split('?')[0] || 'dashboard';
const store = { get: (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } } };

function App() {
  const [lang, setLang] = useState(store.get('mise.lang', 'zh'));
  const [page, setPage] = useState(hashPage());
  const [meta, setMeta] = useState(null);
  const [outlet, setOutlet] = useState(+store.get('mise.outlet', 0));
  const [toast, setToast] = useState(null);

  // 新提示出现时取消上一个的定时器，否则旧定时器会把新提示提前关掉
  const timer = useRef(null);
  const flash = useCallback((msg, error) => { clearTimeout(timer.current); setToast({ msg, error }); timer.current = setTimeout(() => setToast(null), error ? 6000 : 2200); }, []);
  const reloadMeta = useCallback(() => api.get('/meta').then((m) => { setMeta(m); setOutlet((o) => (m.outlets.some((x) => x.id === o) ? o : m.outlets[0]?.id)); }), []);
  useEffect(() => { reloadMeta(); }, [reloadMeta]);
  useEffect(() => { const h = () => setPage(hashPage()); window.addEventListener('hashchange', h); return () => window.removeEventListener('hashchange', h); }, []);
  useEffect(() => { store.set('mise.lang', lang); document.documentElement.lang = lang; }, [lang]);
  useEffect(() => { if (outlet) store.set('mise.outlet', outlet); }, [outlet]);

  const ctx = useMemo(() => ({ ...makeI18n(lang), lang, meta, outlet, outletObj: meta?.outlets.find((o) => o.id === outlet), flash, reloadMeta }), [lang, meta, outlet, flash, reloadMeta]);
  if (!meta || !outlet) return null;
  const Cur = PAGES[page] || Dashboard;

  return (
    <Ctx.Provider value={ctx}>
      <div className="shell">
        <aside>
          <div className="brand">Mise<span>后厨管理 · 学习版</span></div>
          <nav>
            {NAV.map(([g, items], i) => (
              <div key={i}>
                {g ? <div className="nav-group">{ctx.t(g)}</div> : i > 0 && <div className="nav-sep" />}
                {items.map(([k]) => <a key={k} href={'#' + k} className={page === k ? 'on' : ''}>{ctx.t(k)}</a>)}
              </div>
            ))}
          </nav>
        </aside>
        <main>
          <header>
            <select value={outlet} onChange={(e) => setOutlet(+e.target.value)} aria-label="outlet">
              {meta.outlets.map((o) => <option key={o.id} value={o.id}>{ctx.N(o)}</option>)}
            </select>
            <div className="seg">
              <button className={lang === 'zh' ? 'on' : ''} onClick={() => setLang('zh')}>中文</button>
              <button className={lang === 'en' ? 'on' : ''} onClick={() => setLang('en')}>EN</button>
            </div>
          </header>
          <Cur key={page + outlet} />
        </main>
        {toast && <div className={'toast' + (toast.error ? ' error' : '')}>{toast.msg}</div>}
      </div>
    </Ctx.Provider>
  );
}

createRoot(document.getElementById('root')).render(<App />);
