// 生产计划：计划 → 任务看板 → 完成入库
import { all, get, ins, run, tx } from '../db.js';
import { dayAdd, explode, fail, now, recipeCost, today } from './core.js';
import { addMove, consumeRecipe, onHand } from './stock.js';

// 加一个配方到计划时，它用到的【可入库】子配方也得有人做。
// 返回这些子配方各需要多少、现有多少 —— 界面据此让用户勾选"库存够，不用做"。
export function subRecipeNeeds(outlet, recipeId, qty) {
  const out = new Map();
  const walk = (rid, q) => {
    const c = recipeCost(rid);
    const f = q / c.yield_qty;
    for (const l of c.lines) {
      if (l.item_type !== 'recipe') continue;
      const need = l.gross * f;
      if (l.stockable) {
        const cur = out.get(l.item_id) || { recipe_id: l.item_id, name_zh: l.name_zh, name_en: l.name_en, unit: l.base_unit, qty: 0 };
        cur.qty += need;
        out.set(l.item_id, cur);
      }
      walk(l.item_id, need);
    }
  };
  walk(recipeId, qty);
  return [...out.values()].map((s) => ({ ...s, on_hand: onHand(outlet, 'recipe', s.recipe_id) }));
}

export function savePlan(p) {
  return tx(() => {
    let id = p.id;
    if (id) {
      const cur = get('SELECT status FROM production_plans WHERE id=?', id) || fail('计划不存在 plan not found');
      if (cur.status !== 'draft') fail('只能修改草稿状态的计划 only draft plans can be edited');
      run('UPDATE production_plans SET name=?, plan_date=? WHERE id=?', p.name, p.plan_date || today(), id);
      run('DELETE FROM production_tasks WHERE plan_id=?', id);
    } else {
      id = ins('INSERT INTO production_plans (outlet_id,name,plan_date,created_at) VALUES (?,?,?,?)', p.outlet_id, p.name || '生产计划', p.plan_date || today(), now());
    }
    for (const t of p.tasks || []) {
      if (t.recipe_id) {
        if (!(+t.qty > 0)) continue;
        ins('INSERT INTO production_tasks (plan_id,recipe_id,qty,assignee,workstation) VALUES (?,?,?,?,?)', id, t.recipe_id, +t.qty, t.assignee || '', t.workstation || '');
      } else if (t.title) {
        ins('INSERT INTO production_tasks (plan_id,title,assignee,workstation) VALUES (?,?,?,?)', id, t.title, t.assignee || '', t.workstation || '');
      }
    }
    return id;
  });
}

export function getPlan(id) {
  const p = get('SELECT * FROM production_plans WHERE id=?', id) || fail('计划不存在 plan not found');
  const memo = new Map();
  p.tasks = all('SELECT * FROM production_tasks WHERE plan_id=? ORDER BY id', id).map((t) => {
    if (!t.recipe_id) return { ...t, labour: 0, cost: 0 };
    const c = recipeCost(t.recipe_id, memo);
    const f = t.qty / c.yield_qty;
    return { ...t, name_zh: c.name_zh, name_en: c.name_en, unit: c.yield_unit, stockable: c.stockable, shelf_life_days: c.shelf_life_days, depth: c.depth,
      batches: f, cost: c.total * f, labour: c.own_labour * f, minutes: (c.prep_min + c.cook_min + c.plate_min) * f };
  });
  // 整个计划的物料清单：各任务展开后相加，再减去本计划自己会产出的半成品
  const need = new Map();
  for (const t of p.tasks) if (t.recipe_id) explode(t.recipe_id, t.qty, need, memo);
  for (const t of p.tasks) {
    const k = `recipe:${t.recipe_id}`;
    if (t.recipe_id && need.has(k)) need.get(k).qty -= t.qty;
  }
  p.bom = [...need.values()].filter((n) => n.qty > 1e-9).map((n) => {
    const have = onHand(p.outlet_id, n.item_type, n.item_id);
    return { ...n, need: n.qty, on_hand: have, short: Math.max(0, n.qty - Math.max(0, have)), cost: n.qty * n.unit_cost };
  });
  // 食材预算按物料清单算 (本计划自产的半成品不重复计)
  p.budget = { food: p.bom.reduce((s, b) => s + b.cost, 0), labour: p.tasks.reduce((s, t) => s + t.labour, 0) };
  return p;
}
export const listPlans = (outlet) =>
  all(`SELECT p.*, (SELECT COUNT(*) FROM production_tasks t WHERE t.plan_id=p.id) tasks,
              (SELECT COUNT(*) FROM production_tasks t WHERE t.plan_id=p.id AND t.status='done') done
       FROM production_plans p WHERE outlet_id=? ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, id DESC LIMIT 100`, outlet);

export function activatePlan(id) {
  const p = getPlan(id);
  if (p.status !== 'draft') fail('计划已激活 already active');
  if (!p.tasks.length) fail('计划里没有任务 the plan has no tasks');
  run("UPDATE production_plans SET status='active' WHERE id=?", id);
}
export function deletePlan(id) {
  const p = get('SELECT status FROM production_plans WHERE id=?', id);
  if (p?.status === 'done') fail('已完成的计划不能删除 finished plans cannot be deleted');
  run('DELETE FROM production_plans WHERE id=?', id);
}

// 任务状态：todo → doing (开始计时) → done。也可以"全部标记完成"(那样就没有耗时记录)。
export function setTaskStatus(taskId, status, ts) {
  const t = get('SELECT t.*, p.status plan_status FROM production_tasks t JOIN production_plans p ON p.id=t.plan_id WHERE t.id=?', taskId) || fail('任务不存在 task not found');
  if (t.plan_status !== 'active') fail('计划不在进行中 plan is not active');
  const at = ts || now();
  if (status === 'doing') run("UPDATE production_tasks SET status='doing', started_at=?, done_at=NULL WHERE id=?", at, taskId);
  else if (status === 'done') run("UPDATE production_tasks SET status='done', done_at=? WHERE id=?", at, taskId);
  else if (status === 'todo') run("UPDATE production_tasks SET status='todo', started_at=NULL, done_at=NULL WHERE id=?", taskId);
  else fail('未知状态 unknown status');
}
export function markAllDone(planId) {
  run("UPDATE production_tasks SET status='done', done_at=COALESCE(done_at, ?) WHERE plan_id=?", now(), planId);
}

// 完成计划。所有任务必须已完成。对每个【可入库】配方的任务 (可以选择不入库)：
//   · 按【计划量】领料 (理论投入)，按【实际产出】入库
//   · 入库单位成本 = 投入成本 ÷ 实际产出  → 出成率低，这批就贵
//   · 自动生成批号和效期 (生产日 + 保质期天数)，并把领料用到的批次记为它的"父批次"
// 先做层级低的 (被别人用的)，这样上层任务领料时能领到刚做好的半成品。
export function finishPlan(id, outputs = [], ts) {
  const p = getPlan(id);
  if (p.status !== 'active') fail('计划不在进行中 plan is not active');
  if (p.tasks.some((t) => t.status !== 'done')) fail('还有任务没完成 all tasks must be done first');
  return tx(() => {
    const at = ts || now();
    const result = [];
    for (const t of p.tasks.filter((x) => x.recipe_id && x.stockable).sort((a, b) => a.depth - b.depth || a.id - b.id)) {
      const o = outputs.find((x) => x.task_id === t.id) || {};
      if (o.in_stock === false) continue;
      const produced = o.produced_qty != null && o.produced_qty !== '' ? +o.produced_qty : t.qty;
      if (!(produced > 0)) continue;
      const lotNo = o.lot_no || `P${id}-${t.id}`;
      const expiry = o.expiry || (t.shelf_life_days ? dayAdd(at.slice(0, 10), t.shelf_life_days) : null);
      const used = consumeRecipe(p.outlet_id, t.recipe_id, t.qty, 'production_out', `PT${t.id}`, at);
      addMove({ ts: at, outlet_id: p.outlet_id, item_type: 'recipe', item_id: t.recipe_id, qty: produced, unit_cost: used.cost / produced,
        reason: 'production_in', ref: `PT${t.id}`, lot: { lot_no: lotNo, expiry, parents: used.lots } });
      run('UPDATE production_tasks SET produced_qty=?, lot_no=?, expiry=? WHERE id=?', produced, lotNo, expiry, t.id);
      result.push({ task_id: t.id, recipe_id: t.recipe_id, produced, lot_no: lotNo, expiry, unit_cost: used.cost / produced });
    }
    run("UPDATE production_plans SET status='done', finished_at=? WHERE id=?", at, id);
    return result;
  });
}

// 生产建议：半成品 现存 + 已计划 < 最低量 → 补到 par，向上取整到整批
export function productionSuggestions(outlet) {
  return all("SELECT * FROM par_levels WHERE outlet_id=? AND item_type='recipe' AND min_qty>0", outlet).map((s) => {
    const c = recipeCost(s.item_id);
    const have = onHand(outlet, 'recipe', s.item_id);
    const planned = get(`SELECT COALESCE(SUM(t.qty),0) q FROM production_tasks t JOIN production_plans p ON p.id=t.plan_id
                         WHERE p.outlet_id=? AND p.status IN ('draft','active') AND t.recipe_id=?`, outlet, s.item_id).q;
    if (have + planned >= s.min_qty) return null;
    const batches = Math.max(1, Math.ceil((s.par_qty - have - planned) / c.yield_qty - 1e-9));
    return { recipe_id: s.item_id, name_zh: c.name_zh, name_en: c.name_en, unit: c.yield_unit, on_hand: have, planned, min_qty: s.min_qty, par_qty: s.par_qty,
      batches, batch_size: c.yield_qty, qty: batches * c.yield_qty };
  }).filter(Boolean);
}
