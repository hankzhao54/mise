// 任务与 HACCP：关键控制点 (CCP) → 周期性任务 → 每天的待办 → 执行记录 → 报告
import { all, get, ins, run } from '../db.js';
import { dayAdd, fail, now, today } from './core.js';

export const CCP_TYPES = ['delivery', 'storage', 'preparation', 'processing', 'cooking', 'reheating', 'service', 'display', 'waste', 'facility', 'other'];
export const TASK_TYPES = ['temperature', 'general', 'checklist', 'cleaning', 'packaging', 'maintenance', 'waste', 'pest', 'facility', 'stock', 'chemical', 'training', 'traceability', 'order', 'count'];

export const listCcps = () => all('SELECT * FROM ccps ORDER BY code');
export function saveCcp(c) {
  if (!c.name || !c.code) fail('名称和编号必填 name and code are required');
  if (c.id) { run('UPDATE ccps SET name=?, code=?, type=?, description=? WHERE id=?', c.name, c.code, c.type || 'other', c.description || '', c.id); return c.id; }
  return ins('INSERT INTO ccps (name,code,type,description) VALUES (?,?,?,?)', c.name, c.code, c.type || 'other', c.description || '');
}
export const deleteCcp = (id) => run('DELETE FROM ccps WHERE id=?', id);

const parse = (t) => ({ ...t, weekdays: JSON.parse(t.weekdays), checklist: JSON.parse(t.checklist) });
export const listTasks = (outlet) =>
  all('SELECT t.*, c.code ccp_code, c.name ccp_name FROM tasks t LEFT JOIN ccps c ON c.id=t.ccp_id WHERE t.outlet_id=? ORDER BY t.time, t.id', outlet).map(parse);
export function saveTask(t) {
  if (!t.name) fail('任务名称必填 name is required');
  if (t.type === 'temperature' && (t.min_val === '' || t.min_val == null || t.max_val === '' || t.max_val == null)) fail('温度检查需要上下限 temperature checks need min and max');
  const a = [t.name, t.type || 'general', t.ccp_id || null, t.description || '', t.frequency || 'daily', JSON.stringify(t.weekdays || []), t.month_day || null,
    t.start_date || today(), t.end_date || null, t.time || '', t.type === 'temperature' ? +t.min_val : null, t.type === 'temperature' ? +t.max_val : null,
    JSON.stringify((t.checklist || []).filter(Boolean)), t.assignee || ''];
  if (t.id) { run('UPDATE tasks SET name=?,type=?,ccp_id=?,description=?,frequency=?,weekdays=?,month_day=?,start_date=?,end_date=?,time=?,min_val=?,max_val=?,checklist=?,assignee=? WHERE id=?', ...a, t.id); return t.id; }
  return ins('INSERT INTO tasks (name,type,ccp_id,description,frequency,weekdays,month_day,start_date,end_date,time,min_val,max_val,checklist,assignee,outlet_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', ...a, t.outlet_id);
}
// 删除周期任务 = 以后不再出现；过去的执行记录也一并清掉 (教学项目从简)
export const deleteTask = (id) => run('DELETE FROM tasks WHERE id=?', id);

// 某个任务在某一天是否应该出现
export function isDue(t, day) {
  if (t.frequency === 'inactive' || day < t.start_date || (t.end_date && day > t.end_date)) return false;
  const d = new Date(day + 'T12:00:00Z');
  if (t.frequency === 'once') return day === t.start_date;
  if (t.frequency === 'daily') return true;
  if (t.frequency === 'weekly') return t.weekdays.includes(d.getUTCDay());
  if (t.frequency === 'monthly') return d.getUTCDate() === (t.month_day || 1);
  return false;
}

// 待办不存库：每次按"任务定义 + 日期"现算，再和执行记录对上。
// 状态：done 已完成 / overdue 过了当天还没做 / open 待办
export function occurrences(outlet, from, to) {
  const tasks = listTasks(outlet), out = [];
  const logs = new Map(all('SELECT l.* FROM task_logs l JOIN tasks t ON t.id=l.task_id WHERE t.outlet_id=? AND l.day BETWEEN ? AND ?', outlet, from, to)
    .map((l) => [`${l.task_id}:${l.day}`, { ...l, checks: JSON.parse(l.checks) }]));
  for (let d = from; d <= to; d = dayAdd(d, 1))
    for (const t of tasks) {
      if (!isDue(t, d)) continue;
      const log = logs.get(`${t.id}:${d}`) || null;
      out.push({ task: t, day: d, log, status: log ? 'done' : d < today() ? 'overdue' : 'open', irregular: log ? !log.ok : false });
    }
  return out;
}

// 完成一次任务。是否"异常"由系统判定：
//   温度检查 → 读数超出 [下限, 上限]；清单任务 → 有没勾的项
export function completeTask(taskId, body) {
  const t = get('SELECT * FROM tasks WHERE id=?', taskId) || fail('任务不存在 task not found');
  const day = body.day || today();
  const checks = body.checks || [];
  let ok = 1;
  if (t.type === 'temperature') {
    if (body.value === '' || body.value == null || isNaN(+body.value)) fail('请填写测量值 a reading is required');
    if (+body.value < t.min_val || +body.value > t.max_val) ok = 0;
  }
  const list = JSON.parse(t.checklist);
  if (list.length && list.some((_, i) => !checks[i])) ok = 0;
  if (!ok && !body.remarks) fail('出现异常时必须填写处理措施 a corrective action is required when a limit is breached');
  run(`INSERT INTO task_logs (task_id,day,value,checks,remarks,done_by,done_at,ok) VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(task_id,day) DO UPDATE SET value=excluded.value, checks=excluded.checks, remarks=excluded.remarks, done_by=excluded.done_by, done_at=excluded.done_at, ok=excluded.ok`,
    taskId, day, body.value === '' || body.value == null ? null : +body.value, JSON.stringify(checks), body.remarks || '', body.done_by || '', body.done_at || now(), ok);
  return { ok: !!ok };
}

// 报告：一段时间内该做多少、做了多少、几次异常 —— HACCP 检查时拿出来的就是这个
export function taskReport(outlet, from, to) {
  const occ = occurrences(outlet, from, to);
  const done = occ.filter((o) => o.status === 'done');
  return { from, to, due: occ.length, done: done.length, overdue: occ.filter((o) => o.status === 'overdue').length,
    irregular: done.filter((o) => o.irregular).length, compliance: occ.length ? done.length / occ.length : null,
    irregularities: done.filter((o) => o.irregular), rows: occ };
}
