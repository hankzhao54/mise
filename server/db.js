// 数据库层：建表 + 几个最小的查询助手。
// 用 Node 自带的 node:sqlite，无需安装任何数据库。
// 表结构就是整个系统的骨架 —— 建议先通读这个文件。
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
// v2 换了表结构，所以换一个文件名；旧的 data.db 不会被动
export const DB_PATH = process.env.DB_PATH || path.join(dir, '..', 'mise-v2.db');
export const db = new DatabaseSync(DB_PATH);

db.exec(`
PRAGMA foreign_keys = ON;

-- ══════════ 全局设置 (Library settings) ══════════
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- ══════════ 主数据 ══════════
-- 门店 / 中央厨房。配方、原料属于"库"(全局)；库存、订单、生产、销售属于某个门店
-- is_supplier=1 表示它是"内部供应商"，别的门店可以向它订货
CREATE TABLE IF NOT EXISTS outlets (
  id INTEGER PRIMARY KEY, name_zh TEXT NOT NULL, name_en TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('central_kitchen','restaurant')),
  is_supplier INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, contact TEXT DEFAULT '', lead_days INTEGER DEFAULT 1,
  min_order REAL NOT NULL DEFAULT 0,      -- 最低起订金额：低于它只提醒，不拦截
  delivery_fee REAL NOT NULL DEFAULT 0,   -- 默认运费：单独记录，不摊进原料成本
  approval_limit REAL                     -- 每日订货限额；NULL = 沿用全局设置
);

-- 原料：只定义"是什么"和基础单位，不含价格
CREATE TABLE IF NOT EXISTS ingredients (
  id INTEGER PRIMARY KEY, name_zh TEXT NOT NULL, name_en TEXT NOT NULL,
  category TEXT DEFAULT '', base_unit TEXT NOT NULL CHECK (base_unit IN ('g','ml','pc')),
  allergens TEXT NOT NULL DEFAULT '[]',
  waste_pct REAL                          -- 原料级默认损耗；NULL = 沿用全局默认
);

-- 采购包装：价格在这里。一个原料可以有多个供应商/包装
CREATE TABLE IF NOT EXISTS packages (
  id INTEGER PRIMARY KEY,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  label TEXT NOT NULL, article_no TEXT DEFAULT '', pack_qty REAL NOT NULL, price REAL NOT NULL,
  orderable INTEGER NOT NULL DEFAULT 1, last_ordered_at TEXT
);
-- 价格历史：每次改价留一行
CREATE TABLE IF NOT EXISTS package_prices (
  id INTEGER PRIMARY KEY, package_id INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  ts TEXT NOT NULL, price REAL NOT NULL, source TEXT DEFAULT ''
);

-- 配方：prep = 半成品 (可被其他配方引用)，dish = 售卖菜品
-- stockable=1 的半成品有实物库存 (提前做好入库)；=0 的现做现用，扣库存时继续往下拆到原料
CREATE TABLE IF NOT EXISTS recipes (
  id INTEGER PRIMARY KEY, name_zh TEXT NOT NULL, name_en TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('prep','dish')), stockable INTEGER NOT NULL DEFAULT 0,
  category TEXT DEFAULT '', yield_qty REAL NOT NULL, yield_unit TEXT NOT NULL,
  sell_price REAL DEFAULT 0,
  vat_pct REAL,                           -- NULL = 沿用全局默认税率
  target_margin REAL,                     -- NULL = 沿用全局目标毛利率
  prep_min REAL NOT NULL DEFAULT 0, cook_min REAL NOT NULL DEFAULT 0, plate_min REAL NOT NULL DEFAULT 0,  -- 主动工时(分钟/批)
  shelf_life_days INTEGER,                -- 保质期，生产入库时用来算效期
  method TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS recipe_lines (
  id INTEGER PRIMARY KEY,
  recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  ingredient_id INTEGER REFERENCES ingredients(id),
  sub_recipe_id INTEGER REFERENCES recipes(id),
  qty REAL NOT NULL, unit TEXT NOT NULL,
  waste_pct REAL,                         -- 行级损耗；NULL = 沿用原料/全局
  CHECK ((ingredient_id IS NULL) <> (sub_recipe_id IS NULL))
);

-- 菜单 (套餐)：一组配方 + 一个套餐价，用来算整套成本和做配方间的对比
CREATE TABLE IF NOT EXISTS menus (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, price REAL NOT NULL DEFAULT 0, vat_pct REAL, target_margin REAL
);
CREATE TABLE IF NOT EXISTS menu_items (
  id INTEGER PRIMARY KEY, menu_id INTEGER NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
  course TEXT NOT NULL DEFAULT '', recipe_id INTEGER NOT NULL REFERENCES recipes(id)
);

-- ══════════ 库存 ══════════
-- 台账：只追加，不修改；现存量 = SUM(qty)
CREATE TABLE IF NOT EXISTS stock_moves (
  id INTEGER PRIMARY KEY, ts TEXT NOT NULL,
  outlet_id INTEGER NOT NULL REFERENCES outlets(id),
  item_type TEXT NOT NULL CHECK (item_type IN ('ingredient','recipe')),
  item_id INTEGER NOT NULL, qty REAL NOT NULL, unit_cost REAL NOT NULL DEFAULT 0,
  reason TEXT NOT NULL, ref TEXT DEFAULT '', note TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_moves ON stock_moves (outlet_id, item_type, item_id);
CREATE INDEX IF NOT EXISTS idx_moves_ref ON stock_moves (ref);

-- 批次：每次入库生成一个批次；出库按"先到期先出"(FEFO) 从批次里扣
CREATE TABLE IF NOT EXISTS lots (
  id INTEGER PRIMARY KEY, lot_no TEXT NOT NULL,
  outlet_id INTEGER NOT NULL REFERENCES outlets(id),
  item_type TEXT NOT NULL, item_id INTEGER NOT NULL,
  qty REAL NOT NULL, remaining REAL NOT NULL, expiry TEXT,
  created_at TEXT NOT NULL, source TEXT NOT NULL, ref TEXT DEFAULT '', supplier_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_lots ON lots (outlet_id, item_type, item_id);
-- 哪条流水动了哪个批次、动了多少
CREATE TABLE IF NOT EXISTS lot_moves (
  id INTEGER PRIMARY KEY, lot_id INTEGER NOT NULL REFERENCES lots(id), move_id INTEGER NOT NULL REFERENCES stock_moves(id), qty REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lot_moves ON lot_moves (lot_id);
CREATE INDEX IF NOT EXISTS idx_lot_moves_m ON lot_moves (move_id);
-- 批次的"父子"关系：原料批次 → 半成品批次；调出批次 → 调入批次。追溯就是沿着它走
CREATE TABLE IF NOT EXISTS lot_links (
  parent_lot_id INTEGER NOT NULL REFERENCES lots(id), child_lot_id INTEGER NOT NULL REFERENCES lots(id),
  PRIMARY KEY (parent_lot_id, child_lot_id)
);

-- 每个门店对每个库存品的设置：最低量、par、储位
CREATE TABLE IF NOT EXISTS par_levels (
  outlet_id INTEGER NOT NULL, item_type TEXT NOT NULL, item_id INTEGER NOT NULL,
  min_qty REAL NOT NULL DEFAULT 0, par_qty REAL NOT NULL DEFAULT 0, location TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (outlet_id, item_type, item_id)
);

-- 盘点：一次盘点 (count) 下可以有多个分盘 (sub-count，多人/分区同时盘)，合计后覆盖库存
CREATE TABLE IF NOT EXISTS stock_counts (
  id INTEGER PRIMARY KEY, outlet_id INTEGER NOT NULL REFERENCES outlets(id),
  created_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', approved_at TEXT
);
CREATE TABLE IF NOT EXISTS count_subs (
  id INTEGER PRIMARY KEY, count_id INTEGER NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE, name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS count_entries (
  id INTEGER PRIMARY KEY, sub_id INTEGER NOT NULL REFERENCES count_subs(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL, item_id INTEGER NOT NULL, qty REAL NOT NULL
);
-- 确认后的结果快照 (账面 / 实盘)
CREATE TABLE IF NOT EXISTS count_lines (
  id INTEGER PRIMARY KEY, count_id INTEGER NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL, item_id INTEGER NOT NULL, expected REAL NOT NULL, counted REAL NOT NULL, unit_cost REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS transfers (
  id INTEGER PRIMARY KEY, ts TEXT NOT NULL,
  from_outlet INTEGER NOT NULL REFERENCES outlets(id), to_outlet INTEGER NOT NULL REFERENCES outlets(id),
  item_type TEXT NOT NULL, item_id INTEGER NOT NULL, qty REAL NOT NULL, note TEXT DEFAULT ''
);

-- ══════════ 采购 ══════════
-- status: in_progress 购物车 → (waiting_approval 待审批 → rejected 被拒) → sent 已发送 → partial 部分到货 → delivered 已到货
CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY, outlet_id INTEGER NOT NULL REFERENCES outlets(id),
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  status TEXT NOT NULL DEFAULT 'in_progress', created_at TEXT NOT NULL, sent_at TEXT, closed_at TEXT,
  flag_note TEXT DEFAULT '', reject_reason TEXT DEFAULT '', approver_note TEXT DEFAULT '',
  invoice_no TEXT DEFAULT '', invoice_amount REAL, invoice_status TEXT DEFAULT 'not_received',
  delivery_fee REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS po_lines (
  id INTEGER PRIMARY KEY, po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  package_id INTEGER NOT NULL REFERENCES packages(id),
  qty_packs REAL NOT NULL, price REAL NOT NULL, received_packs REAL NOT NULL DEFAULT 0, received_value REAL NOT NULL DEFAULT 0
);

-- 内部订货：门店向"内部供应商"(中央厨房) 订可入库的半成品
-- status: incoming 新订单 → picked 已拣货 → shipped 已发货 → received 门店已收货
CREATE TABLE IF NOT EXISTS internal_orders (
  id INTEGER PRIMARY KEY, outlet_id INTEGER NOT NULL REFERENCES outlets(id),
  supplier_outlet_id INTEGER NOT NULL REFERENCES outlets(id),
  status TEXT NOT NULL DEFAULT 'incoming', created_at TEXT NOT NULL, shipped_at TEXT, received_at TEXT, note TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS internal_order_lines (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES internal_orders(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL DEFAULT 'recipe', item_id INTEGER NOT NULL, qty REAL NOT NULL, picked_qty REAL
);

-- ══════════ 生产 ══════════
-- status: draft 草稿 → active 进行中 → done 已完成
CREATE TABLE IF NOT EXISTS production_plans (
  id INTEGER PRIMARY KEY, outlet_id INTEGER NOT NULL REFERENCES outlets(id),
  name TEXT NOT NULL, plan_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL, finished_at TEXT
);
-- 任务：做某个配方 (recipe_id) 或自定义任务 (只有 title，比如"清洁")；status: todo → doing → done
CREATE TABLE IF NOT EXISTS production_tasks (
  id INTEGER PRIMARY KEY, plan_id INTEGER NOT NULL REFERENCES production_plans(id) ON DELETE CASCADE,
  recipe_id INTEGER REFERENCES recipes(id), title TEXT DEFAULT '', qty REAL NOT NULL DEFAULT 0,
  assignee TEXT DEFAULT '', workstation TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo', started_at TEXT, done_at TEXT,
  produced_qty REAL, lot_no TEXT, expiry TEXT
);

-- ══════════ 任务与 HACCP ══════════
CREATE TABLE IF NOT EXISTS ccps (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'other', description TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY, outlet_id INTEGER NOT NULL REFERENCES outlets(id),
  name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'general', ccp_id INTEGER REFERENCES ccps(id), description TEXT DEFAULT '',
  frequency TEXT NOT NULL DEFAULT 'daily',   -- inactive | once | daily | weekly | monthly
  weekdays TEXT NOT NULL DEFAULT '[]',       -- weekly 用：[1,3,5]，0=周日
  month_day INTEGER,                         -- monthly 用
  start_date TEXT NOT NULL, end_date TEXT, time TEXT DEFAULT '',
  min_val REAL, max_val REAL,                -- 温度检查的上下限
  checklist TEXT NOT NULL DEFAULT '[]', assignee TEXT DEFAULT ''
);
-- 一次执行记录。ok=0 表示异常 (超出限值 / 清单未全部完成)
CREATE TABLE IF NOT EXISTS task_logs (
  id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  day TEXT NOT NULL, value REAL, checks TEXT NOT NULL DEFAULT '[]', remarks TEXT DEFAULT '',
  done_by TEXT DEFAULT '', done_at TEXT NOT NULL, ok INTEGER NOT NULL DEFAULT 1,
  UNIQUE (task_id, day)
);

-- ══════════ 销售 ══════════
-- POS 商品 (按 PLU 识别)。一个 PLU 关联一个配方；没关联的卖了也不会扣库存、不会算成本
CREATE TABLE IF NOT EXISTS pos_items (
  id INTEGER PRIMARY KEY, outlet_id INTEGER NOT NULL REFERENCES outlets(id),
  plu TEXT NOT NULL, name TEXT NOT NULL, category TEXT DEFAULT '',
  recipe_id INTEGER REFERENCES recipes(id), ignored INTEGER NOT NULL DEFAULT 0,
  UNIQUE (outlet_id, plu)
);
CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY, outlet_id INTEGER NOT NULL REFERENCES outlets(id),
  day TEXT NOT NULL, pos_item_id INTEGER REFERENCES pos_items(id), recipe_id INTEGER REFERENCES recipes(id),
  qty REAL NOT NULL, revenue REAL NOT NULL, discount REAL NOT NULL DEFAULT 0,
  depleted INTEGER NOT NULL DEFAULT 0      -- 是否已按配方扣过库存
);
CREATE INDEX IF NOT EXISTS idx_sales ON sales (outlet_id, day);
`);

export const all = (sql, ...p) => db.prepare(sql).all(...p);
export const get = (sql, ...p) => db.prepare(sql).get(...p);
export const run = (sql, ...p) => db.prepare(sql).run(...p);
export const ins = (sql, ...p) => Number(db.prepare(sql).run(...p).lastInsertRowid);

// 事务：一组写入要么全成功要么全回滚（可嵌套，只有最外层真正提交）
let depth = 0;
export function tx(fn) {
  if (depth === 0) db.exec('BEGIN');
  depth++;
  try {
    const r = fn();
    depth--;
    if (depth === 0) db.exec('COMMIT');
    return r;
  } catch (e) {
    depth--;
    if (depth === 0) db.exec('ROLLBACK');
    throw e;
  }
}
