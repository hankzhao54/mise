import { useState } from 'react';
import { api, Field, Note, Page, useAct, useApp } from './lib.jsx';

// ───────── 全局设置 (Library settings)：这里的值是各处"留空 = 沿用"的那个默认值
export function Settings() {
  const { t, L, meta, reloadMeta } = useApp();
  const act = useAct();
  const [s, setS] = useState({ ...meta.settings, approval_limit: meta.settings.approval_limit ?? '', waste_reasons: meta.settings.waste_reasons.join('\n'), workstations: meta.settings.workstations.join('\n') });
  const set = (k) => (e) => setS({ ...s, [k]: e.target.value });
  const lines = (v) => v.split('\n').map((x) => x.trim()).filter(Boolean);
  const save = async () => {
    const body = { default_vat: +s.default_vat, default_waste_pct: +s.default_waste_pct, target_margin: +s.target_margin, rate_prep: +s.rate_prep, rate_cook: +s.rate_cook, rate_plate: +s.rate_plate,
      cost_basis: s.cost_basis, blind_count: !!s.blind_count, approval_limit: s.approval_limit === '' ? null : +s.approval_limit, waste_reasons: lines(s.waste_reasons), workstations: lines(s.workstations) };
    if (await act(() => api.put('/settings', body))) reloadMeta();
  };
  return (
    <Page title={t('settings')} actions={<button className="primary" onClick={save}>{t('save')}</button>}>
      <Note>{L('改这里会立刻影响所有配方的成本和毛利 —— 成本从不存库，每次都是现算的。', 'Changes here immediately affect every recipe cost and margin — costs are never stored, always computed on the fly.')}</Note>
      <section className="card">
        <h3>{L('成本默认值', 'Costing defaults')}</h3>
        <div className="form cols">
          <Field label={L('默认税率 %', 'Default tax rate (VAT) %')} hint={L('配方上可以单独覆盖', 'A recipe can override it')}><input type="number" value={s.default_vat} onChange={set('default_vat')} /></Field>
          <Field label={L('默认备料损耗 %', 'Default preparation waste %')} hint={L('优先级：配方行 > 原料 > 这里', 'Precedence: recipe line > ingredient > here')}><input type="number" value={s.default_waste_pct} onChange={set('default_waste_pct')} /></Field>
          <Field label={L('目标毛利率 %', 'Target profit margin %')} hint={L('配方、菜单上可以单独覆盖', 'Recipes and menus can override it')}><input type="number" value={s.target_margin} onChange={set('target_margin')} /></Field>
          <Field label={L('成本取哪个包装的价格', 'Package used for costing')}><select value={s.cost_basis} onChange={set('cost_basis')}><option value="cheapest">{L('最便宜的包装', 'Cheapest package')}</option><option value="last_ordered">{L('最近一次订的包装', 'Last ordered package')}</option></select></Field>
        </div>
        <h3 style={{ marginTop: 18 }}>{L('人工时薪 (Ft / 小时)', 'Production cost defaults (Ft per hour)')}</h3>
        <div className="form cols">
          <Field label={L('备料', 'Prepping')}><input type="number" value={s.rate_prep} onChange={set('rate_prep')} /></Field>
          <Field label={L('烹饪', 'Cooking')}><input type="number" value={s.rate_cook} onChange={set('rate_cook')} /></Field>
          <Field label={L('装盘', 'Plating')}><input type="number" value={s.rate_plate} onChange={set('rate_plate')} /></Field>
        </div>
        <p className="muted small">{L('人工成本 = 配方上的主动工时 × 对应时薪。三个都设为 0 就等于不计人工，prime cost 退化为食材成本。', 'Personnel cost = active time on the recipe × the matching rate. Set all three to 0 to leave labour out; prime cost then equals food cost.')}</p>
      </section>
      <section className="card">
        <h3>{L('库存与采购', 'Inventory & procurement')}</h3>
        <div className="form cols">
          <Field label={L('盲盘', 'Blind count')} hint={L('盘点时不显示账面数，避免"照着抄"', 'Hide theoretical stock while counting')}><select value={s.blind_count ? 1 : 0} onChange={(e) => setS({ ...s, blind_count: +e.target.value === 1 })}><option value={0}>{L('关', 'Off')}</option><option value={1}>{L('开', 'On')}</option></select></Field>
          <Field label={L('订单审批：每日限额', 'Order approval: daily limit')} hint={L('留空 = 不启用。供应商上可以单独设置', 'Empty = off. A supplier can have its own limit')}><input type="number" value={s.approval_limit} onChange={set('approval_limit')} /></Field>
        </div>
        <div className="form cols">
          <Field label={L('报损原因（每行一个）', 'Waste reasons (one per line)')}><textarea rows="6" value={s.waste_reasons} onChange={set('waste_reasons')} /></Field>
          <Field label={L('生产工位（每行一个）', 'Workstations (one per line)')}><textarea rows="6" value={s.workstations} onChange={set('workstations')} /></Field>
        </div>
      </section>
    </Page>
  );
}
