// 示例数据：一个中央厨房 (内部供应商) + 两家门店，一套小菜单，14 天销售，
// 以及每个模块各一点已发生的业务，让每个页面打开都有东西看。
// `npm run seed` 会清空并重建。
import { all, get, ins, run, tx } from './db.js';
import * as E from './engine.js';

const TABLES = ['task_logs', 'tasks', 'ccps', 'sales', 'pos_items', 'production_tasks', 'production_plans', 'internal_order_lines', 'internal_orders',
  'po_lines', 'purchase_orders', 'transfers', 'count_lines', 'count_entries', 'count_subs', 'stock_counts', 'par_levels', 'lot_links', 'lot_moves', 'lots',
  'stock_moves', 'menu_items', 'menus', 'recipe_lines', 'recipes', 'package_prices', 'packages', 'ingredients', 'suppliers', 'outlets', 'settings'];

export function seed({ reset = false } = {}) {
  if (reset) { tx(() => TABLES.forEach((t) => run(`DELETE FROM ${t}`))); E.resetSettingsCache(); }
  if (get('SELECT COUNT(*) n FROM outlets').n > 0) return false;

  tx(() => {
    const day = (n) => E.dayAdd(E.today(), -n);
    const at = (n, hm = '06:00') => `${day(n)}T${hm}:00.000`;

    const CK = ins("INSERT INTO outlets (name_zh,name_en,kind,is_supplier) VALUES ('中央厨房','Central Kitchen','central_kitchen',1)");
    const R1 = ins("INSERT INTO outlets (name_zh,name_en,kind) VALUES ('一号店','Restaurant 1','restaurant')");
    const R2 = ins("INSERT INTO outlets (name_zh,name_en,kind) VALUES ('二号店','Restaurant 2','restaurant')");

    const S1 = ins("INSERT INTO suppliers (name,contact,lead_days,min_order,delivery_fee) VALUES ('Metro 批发','orders@metro.example',1,15000,0)");
    const S2 = ins("INSERT INTO suppliers (name,contact,lead_days,min_order,delivery_fee) VALUES ('亚洲食品行 Asia Foods','sales@asiafoods.example',2,20000,2500)");
    // 鲜肉坊设了每日限额：超过就要审批
    const S3 = ins("INSERT INTO suppliers (name,contact,lead_days,min_order,delivery_fee,approval_limit) VALUES ('鲜肉坊 Fresh Meat','hello@freshmeat.example',1,0,1500,50000)");

    // [key, 中文, 英文, 类别, 基础单位, 过敏原, 供应商, 包装名, 货号, 包装含量, 价格(Ft), 原料级损耗%]
    const ING = {};
    [
      ['flour', '面粉', 'Wheat flour', '干货', 'g', ['gluten'], S1, '25 kg 袋', 'M-1001', 25000, 6500],
      ['salt', '盐', 'Salt', '干货', 'g', [], S1, '1 kg', 'M-1002', 1000, 200],
      ['rice', '大米', 'Rice', '干货', 'g', [], S2, '20 kg 袋', 'A-2001', 20000, 14000],
      ['egg', '鸡蛋', 'Eggs', '蛋奶', 'pc', ['egg'], S1, '30 枚/盘', 'M-1003', 30, 2400],
      ['soy', '酱油', 'Soy sauce', '调味', 'ml', ['soy', 'gluten'], S2, '5 L 桶', 'A-2002', 5000, 6000],
      ['chili', '辣椒油', 'Chili oil', '调味', 'ml', ['sesame'], S2, '1 L 瓶', 'A-2003', 1000, 3500],
      ['oil', '食用油', 'Cooking oil', '调味', 'ml', [], S1, '10 L 桶', 'M-1004', 10000, 7500],
      ['bones', '猪骨', 'Pork bones', '肉类', 'g', [], S3, '10 kg 箱', 'F-3001', 10000, 9000],
      ['chicken', '鸡架', 'Chicken carcass', '肉类', 'g', [], S3, '10 kg 箱', 'F-3002', 10000, 5000],
      ['belly', '五花肉', 'Pork belly', '肉类', 'g', [], S3, '5 kg', 'F-3003', 5000, 14000],
      ['mince', '猪肉馅', 'Minced pork', '肉类', 'g', [], S3, '5 kg', 'F-3004', 5000, 11000],
      ['shrimp', '虾仁', 'Shrimp', '海鲜', 'g', ['crustacean'], S2, '1 kg 冻', 'A-2004', 1000, 6500],
      ['tofu', '豆腐', 'Tofu', '豆制品', 'g', ['soy'], S2, '1 kg', 'A-2005', 1000, 1400],
      ['scallion', '小葱', 'Scallion', '蔬菜', 'g', [], S1, '1 kg', 'M-1005', 1000, 1800, 10],
      ['ginger', '姜', 'Ginger', '蔬菜', 'g', [], S1, '1 kg', 'M-1006', 1000, 1500],
      ['garlic', '蒜', 'Garlic', '蔬菜', 'g', [], S1, '1 kg', 'M-1007', 1000, 1600],
      ['cabbage', '白菜', 'Napa cabbage', '蔬菜', 'g', [], S1, '10 kg 箱', 'M-1008', 10000, 3500, 20],
      ['cola', '可乐 330ml', 'Cola 330ml', '饮料', 'pc', [], S1, '24 罐/箱', 'M-1009', 24, 4800],
    ].forEach(([k, zh, en, cat, unit, al, sup, label, art, qty, price, wastePct]) => {
      ING[k] = ins('INSERT INTO ingredients (name_zh,name_en,category,base_unit,allergens,waste_pct) VALUES (?,?,?,?,?,?)', zh, en, cat, unit, JSON.stringify(al), wastePct ?? null);
      const p = ins('INSERT INTO packages (ingredient_id,supplier_id,label,article_no,pack_qty,price) VALUES (?,?,?,?,?,?)', ING[k], sup, label, art, qty, price);
      ins('INSERT INTO package_prices (package_id,ts,price,source) VALUES (?,?,?,?)', p, at(60), price, '初始');
    });
    // 同一原料的第二个供应商：单位价更贵 (0.29 vs 0.26 Ft/g)，所以成本默认不取它
    ins('INSERT INTO packages (ingredient_id,supplier_id,label,article_no,pack_qty,price) VALUES (?,?,?,?,?,?)', ING.flour, S2, '10 kg 袋', 'A-2010', 10000, 2900);
    // 给猪骨造一点价格历史
    const bonesPkg = get('SELECT id FROM packages WHERE ingredient_id=?', ING.bones).id;
    run('UPDATE package_prices SET price=8200 WHERE package_id=?', bonesPkg);
    ins('INSERT INTO package_prices (package_id,ts,price,source) VALUES (?,?,?,?)', bonesPkg, at(30), 8600, '手工改价');
    ins('INSERT INTO package_prices (package_id,ts,price,source) VALUES (?,?,?,?)', bonesPkg, at(10), 9000, '手工改价');

    const REC = {};
    // lines: [ref, qty, unit, 行级损耗%(可省)]；o: 其余字段
    const recipe = (k, zh, en, kind, cat, yq, yu, lines, o = {}) => {
      REC[k] = ins(`INSERT INTO recipes (name_zh,name_en,kind,stockable,category,yield_qty,yield_unit,sell_price,vat_pct,target_margin,prep_min,cook_min,plate_min,shelf_life_days)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, zh, en, kind, o.stockable ? 1 : 0, cat, yq, yu, o.price || 0, o.vat ?? null, o.target ?? null, o.prep || 0, o.cook || 0, o.plate || 0, o.shelf ?? null);
      for (const [ref, qty, unit, wastePct] of lines)
        ins('INSERT INTO recipe_lines (recipe_id,ingredient_id,sub_recipe_id,qty,unit,waste_pct) VALUES (?,?,?,?,?,?)',
          REC[k], ING[ref] ?? null, ING[ref] ? null : REC[ref], qty, unit, wastePct ?? null);
    };
    // 可入库的半成品 (中央厨房生产，门店通过内部订货拿)
    recipe('broth', '猪骨高汤', 'Pork bone broth', 'prep', '汤底', 10000, 'ml', [['bones', 5, 'kg'], ['chicken', 2, 'kg'], ['ginger', 100, 'g', 0], ['scallion', 200, 'g', 0]], { stockable: 1, prep: 30, cook: 20, shelf: 3 });
    recipe('noodles', '手工面条', 'Fresh noodles', 'prep', '面点', 5000, 'g', [['flour', 3.5, 'kg'], ['egg', 10, 'pc'], ['salt', 50, 'g']], { stockable: 1, prep: 45, shelf: 2 });
    recipe('chashu', '叉烧', 'Chashu pork', 'prep', '熟食', 1500, 'g', [['belly', 2, 'kg'], ['soy', 300, 'ml'], ['ginger', 50, 'g'], ['garlic', 50, 'g']], { stockable: 1, prep: 20, cook: 15, shelf: 4 });
    recipe('filling', '饺子馅', 'Dumpling filling', 'prep', '面点', 3000, 'g', [['mince', 1.5, 'kg'], ['cabbage', 1.5, 'kg'], ['scallion', 150, 'g'], ['ginger', 50, 'g'], ['soy', 100, 'ml']], { stockable: 1, prep: 25, shelf: 1 });
    recipe('dumpling', '猪肉水饺 (生)', 'Pork dumplings (raw)', 'prep', '面点', 200, 'pc', [['filling', 3000, 'g'], ['flour', 1.5, 'kg']], { stockable: 1, prep: 90, shelf: 30 });
    // 不可入库的半成品：门店现调现用，卖出时直接拆到原料
    recipe('dip', '饺子蘸料', 'Dumpling dip', 'prep', '酱汁', 500, 'ml', [['soy', 400, 'ml'], ['chili', 100, 'ml'], ['garlic', 20, 'g']], { stockable: 0, prep: 5 });
    // 菜品 (门店售卖)
    recipe('ramen', '叉烧拉面', 'Chashu ramen', 'dish', '面', 1, 'portion', [['broth', 400, 'ml'], ['noodles', 150, 'g'], ['chashu', 60, 'g'], ['egg', 1, 'pc'], ['scallion', 10, 'g']], { price: 3490, cook: 4, plate: 2 });
    recipe('jiaozi', '猪肉水饺 12 只', 'Pork dumplings ×12', 'dish', '小吃', 1, 'portion', [['dumpling', 12, 'pc'], ['dip', 25, 'ml']], { price: 2890, cook: 6, plate: 1 });
    recipe('mapo', '麻婆豆腐饭', 'Mapo tofu rice', 'dish', '饭', 1, 'portion', [['tofu', 250, 'g'], ['mince', 60, 'g'], ['chili', 15, 'ml'], ['rice', 120, 'g'], ['garlic', 5, 'g'], ['scallion', 10, 'g']], { price: 3190, cook: 6, plate: 1 });
    recipe('friedrice', '虾仁炒饭', 'Shrimp fried rice', 'dish', '饭', 1, 'portion', [['shrimp', 80, 'g'], ['rice', 150, 'g'], ['egg', 1, 'pc'], ['oil', 20, 'ml'], ['scallion', 10, 'g']], { price: 3690, cook: 5, plate: 1 });
    recipe('colad', '可乐', 'Cola', 'dish', '饮料', 1, 'portion', [['cola', 1, 'pc']], { price: 690, vat: 27, target: 45 });

    const lunch = ins("INSERT INTO menus (name,price) VALUES ('午市套餐 Lunch set',4990)");
    [['主食', 'ramen'], ['小吃', 'jiaozi'], ['饮料', 'colad']].forEach(([c, k]) => ins('INSERT INTO menu_items (menu_id,course,recipe_id) VALUES (?,?,?)', lunch, c, REC[k]));

    const open = (outlet, type, id, qty) => E.addMove({ ts: at(15), outlet_id: outlet, item_type: type, item_id: id, qty, reason: 'opening', ref: 'seed' });
    const par = (outlet, type, id, min, p, location) => E.setPar({ outlet_id: outlet, item_type: type, item_id: id, min_qty: min, par_qty: p, location });

    // 中央厨房：原料 + 少量半成品
    const ckStock = { flour: 40000, salt: 2000, egg: 90, soy: 6000, bones: 8000, chicken: 6000, belly: 3000, mince: 6000, scallion: 2000, ginger: 800, garlic: 900, cabbage: 8000 };
    for (const [k, q] of Object.entries(ckStock)) open(CK, 'ingredient', ING[k], q);
    [['flour', 20000, 50000, '干货库'], ['egg', 90, 180, '冷藏库'], ['soy', 3000, 10000, '干货库'], ['bones', 10000, 30000, '冷冻库'], ['chicken', 4000, 20000, '冷冻库'],
      ['belly', 4000, 10000, '冷藏库'], ['mince', 3000, 10000, '冷藏库'], ['scallion', 1000, 3000, '冷藏库'], ['ginger', 500, 2000, '冷藏库'], ['garlic', 500, 2000, '干货库'],
      ['cabbage', 5000, 20000, '冷藏库'], ['salt', 500, 2000, '干货库']].forEach(([k, a, b, loc]) => par(CK, 'ingredient', ING[k], a, b, loc));
    open(CK, 'recipe', REC.broth, 12000); open(CK, 'recipe', REC.noodles, 6000); open(CK, 'recipe', REC.chashu, 2000);
    [['broth', 20000, 40000], ['noodles', 8000, 15000], ['chashu', 3000, 6000], ['filling', 0, 0], ['dumpling', 400, 1000]]
      .forEach(([k, a, b]) => par(CK, 'recipe', REC[k], a, b, '成品冷库'));

    // 门店：半成品 + 直接用的原料
    for (const R of [R1, R2]) {
      const st = { egg: 840, scallion: 9000, soy: 9000, chili: 6000, tofu: 62000, mince: 15000, rice: 85000, garlic: 1800, shrimp: 19000, oil: 9000, cola: 640 };
      for (const [k, q] of Object.entries(st)) open(R, 'ingredient', ING[k], q);
      open(R, 'recipe', REC.broth, 165000); open(R, 'recipe', REC.noodles, 62000); open(R, 'recipe', REC.chashu, 25500); open(R, 'recipe', REC.dumpling, 4500);
      [['egg', 120, 420, '冷藏'], ['scallion', 1500, 5000, '冷藏'], ['tofu', 8000, 30000, '冷藏'], ['rice', 15000, 40000, '干货架'], ['shrimp', 3000, 10000, '冷冻'],
        ['cola', 120, 336, '吧台'], ['chili', 1000, 3000, '干货架'], ['soy', 2000, 5000, '干货架'], ['mince', 2000, 8000, '冷藏'], ['oil', 2000, 10000, '干货架'], ['garlic', 300, 1000, '干货架']]
        .forEach(([k, a, b, loc]) => par(R, 'ingredient', ING[k], a, b, loc));
      [['broth', 30000, 80000, '冷藏'], ['noodles', 10000, 30000, '冷藏'], ['chashu', 4000, 12000, '冷藏'], ['dumpling', 800, 2400, '冷冻']]
        .forEach(([k, a, b, loc]) => par(R, 'recipe', REC[k], a, b, loc));
    }

    // ── 中央厨房：5 天前做了一批面条和饺子 (两层嵌套)，演示批次
    const plan = E.savePlan({ outlet_id: CK, name: '周备货 · 面点', plan_date: day(5), tasks: [
      { recipe_id: REC.noodles, qty: 5000, assignee: '老王', workstation: '面点 Dough' },
      { recipe_id: REC.filling, qty: 3000, assignee: '小李', workstation: '冷厨 Cold' },
      { recipe_id: REC.dumpling, qty: 200, assignee: '小李', workstation: '面点 Dough' },
      { title: '清洁和面机', assignee: '老王' }] });
    E.activatePlan(plan);
    for (const t of all('SELECT id FROM production_tasks WHERE plan_id=?', plan)) { E.setTaskStatus(t.id, 'doing', at(5, '07:00')); E.setTaskStatus(t.id, 'done', at(5, '08:10')); }
    const dTask = get('SELECT id FROM production_tasks WHERE plan_id=? AND recipe_id=?', plan, REC.dumpling).id;
    E.finishPlan(plan, [{ task_id: dTask, produced_qty: 192 }], at(5, '10:00'));   // 饺子计划 200 只，实际包了 192 只

    // ── 一号店 4 天前向中央厨房订了饺子：下单 → 拣货发货 → 收货 (批号跟着走)
    const io = E.createInternalOrder({ outlet_id: R1, supplier_outlet_id: CK, ts: at(4, '09:00'), lines: [{ item_id: REC.dumpling, qty: 150 }] });
    E.pickInternalOrder(io, { ship: true, ts: at(4, '13:00') });
    E.receiveInternalOrder(io, at(4, '15:00'));
    // 二号店今天刚下的单，中央厨房还没处理
    E.createInternalOrder({ outlet_id: R2, supplier_outlet_id: CK, lines: [{ item_id: REC.broth, qty: 30000 }, { item_id: REC.noodles, qty: 8000 }, { item_id: REC.dumpling, qty: 300 }] });

    // ── POS 商品：菜品都已关联；一个没关联 (柠檬茶)，一个被忽略 (配送费)
    const PLU = { ramen: '101', jiaozi: '102', mapo: '103', friedrice: '104', colad: '201' };
    for (const R of [R1, R2]) {
      for (const [k, plu] of Object.entries(PLU)) {
        const r = get('SELECT * FROM recipes WHERE id=?', REC[k]);
        ins('INSERT INTO pos_items (outlet_id,plu,name,category,recipe_id) VALUES (?,?,?,?,?)', R, plu, r.name_zh, r.category, r.id);
      }
      ins("INSERT INTO pos_items (outlet_id,plu,name,category) VALUES (?,?,?,?)", R, '202', '冻柠茶', '饮料');
      ins("INSERT INTO pos_items (outlet_id,plu,name,category,ignored) VALUES (?,?,?,?,1)", R, '900', '外卖配送费', '其他');
    }
    // 14 天销售（固定随机种子，每次生成的数据一样）
    let seedN = 42;
    const rnd = () => (seedN = (seedN * 1103515245 + 12345) % 2147483648) / 2147483648;
    const base = { ramen: 26, jiaozi: 17, mapo: 6, friedrice: 9, colad: 22 };
    for (let d = 14; d >= 1; d--)
      for (const [R, f] of [[R1, 1], [R2, 0.8]]) {
        const weekend = [0, 6].includes(new Date(day(d) + 'T12:00:00Z').getUTCDay()) ? 1.25 : 1;
        const rows = Object.entries(base).map(([k, b]) => {
          const qty = Math.round(b * f * weekend * (0.8 + rnd() * 0.4));
          return { plu: PLU[k], qty, revenue: qty * get('SELECT sell_price p FROM recipes WHERE id=?', REC[k]).p, day: day(d) };
        });
        const tea = Math.round(8 * f * (0.7 + rnd() * 0.6));
        rows.push({ plu: '202', qty: tea, revenue: tea * 890, day: day(d) }, { plu: '900', qty: 5, revenue: 5 * 490, day: day(d) });
        E.importPosSales(R, rows);
      }

    // ── 一号店：两次报损 + 昨晚的盘点 (分两个分盘)，几样东西比账面少
    E.waste({ outlet_id: R1, item_type: 'ingredient', item_id: ING.tofu, qty: 1500, reason: '过期 Expired', ts: at(3, '21:00') });
    E.waste({ outlet_id: R1, item_type: 'recipe', item_id: REC.ramen, qty: 2, reason: '做错/退菜 Mistake', ts: at(2, '19:30') });
    const cid = E.createCount(R1);
    const sub1 = get('SELECT id FROM count_subs WHERE count_id=?', cid).id;
    const sub2 = E.addSubCount(cid, '吧台和干货 (小陈)');
    const shrink = { [`recipe:${REC.chashu}`]: 0.93, [`ingredient:${ING.shrimp}`]: 0.95, [`recipe:${REC.broth}`]: 0.97, [`ingredient:${ING.cola}`]: 0.96, [`ingredient:${ING.rice}`]: 1.01 };
    const dry = [ING.cola, ING.rice, ING.soy, ING.chili, ING.oil, ING.garlic];
    const entry = (l) => ({ item_type: l.item_type, item_id: l.item_id, qty: Math.round(l.expected * (shrink[`${l.item_type}:${l.item_id}`] ?? 1)) });
    const lines = E.getCount(cid).lines;
    const isDry = (l) => l.item_type === 'ingredient' && dry.includes(l.item_id);
    E.saveSubCount(cid, sub1, lines.filter((l) => !isDry(l)).map(entry));
    E.saveSubCount(cid, sub2, lines.filter(isDry).map(entry));
    E.confirmCount(cid, at(1, '22:00'));

    // ── 中央厨房：一张部分到货的订单 (演示多次收货和发票核对)
    const flourPkg = get('SELECT id FROM packages WHERE ingredient_id=? AND supplier_id=?', ING.flour, S1).id;
    const eggPkg = get('SELECT id FROM packages WHERE ingredient_id=?', ING.egg).id;
    const po = E.createPO({ outlet_id: CK, supplier_id: S1, lines: [{ package_id: flourPkg, qty_packs: 2 }, { package_id: eggPkg, qty_packs: 6 }] });
    E.submitPO(po);
    run('UPDATE purchase_orders SET sent_at=?, created_at=? WHERE id=?', at(2, '08:00'), at(2, '08:00'), po);
    const pl = E.getPO(po).lines;
    E.receivePO(po, { ts: at(1, '07:30'), close: false, invoice_no: 'INV-88213', invoice_amount: 14900, invoice_status: 'received',
      lines: [{ id: pl[0].id, state: 'all' }, { id: pl[1].id, state: 'part', packs: 3, expiry: day(-12) }] });

    // ── 任务与 HACCP
    const c1 = E.saveCcp({ code: 'CCP-1', name: '收货验收', type: 'delivery', description: '冷链食材到货温度不得高于 5°C' });
    const c2 = E.saveCcp({ code: 'CCP-2', name: '冷藏储存', type: 'storage', description: '冷藏设备保持 0–5°C' });
    const c3 = E.saveCcp({ code: 'CCP-3', name: '加热烹制', type: 'cooking', description: '肉类中心温度不低于 75°C' });
    void c1;
    for (const O of [CK, R1, R2]) {
      const fridge = E.saveTask({ outlet_id: O, name: '冷藏柜温度检查', type: 'temperature', ccp_id: c2, frequency: 'daily', start_date: day(14), time: '09:00', min_val: 0, max_val: 5, description: '读取冷藏柜显示温度并记录' });
      const clean = E.saveTask({ outlet_id: O, name: '收市清洁检查', type: 'checklist', frequency: 'daily', start_date: day(14), time: '22:00', checklist: ['台面消毒', '地面清洗', '垃圾清运', '冰箱门封条擦拭'] });
      E.saveTask({ outlet_id: O, name: '每周深度清洁', type: 'cleaning', frequency: 'weekly', weekdays: [1], start_date: day(14), time: '15:00' });
      E.saveTask({ outlet_id: O, name: '月度盘点', type: 'count', frequency: 'monthly', month_day: 1, start_date: day(60), time: '22:30' });
      if (O === CK) E.saveTask({ outlet_id: O, name: '叉烧中心温度', type: 'temperature', ccp_id: c3, frequency: 'weekly', weekdays: [1, 4], start_date: day(14), time: '11:00', min_val: 75, max_val: 100 });
      for (let d = 4; d >= 1; d--) {
        const hot = O === R1 && d === 2;   // 一号店前天冷藏柜超温
        E.completeTask(fridge, { day: day(d), value: hot ? 7.5 : 3 + ((d * 7 + O) % 4) * 0.4, done_by: '店长', done_at: at(d, '09:05'),
          remarks: hot ? '门没关严，已关好并在 30 分钟后复测为 4.1°C' : '' });
        if (!(O === R2 && d === 1)) E.completeTask(clean, { day: day(d), checks: [true, true, true, true], done_by: '晚班', done_at: at(d, '22:20') });
      }
    }
  });
  return true;
}

if (process.argv[1]?.endsWith('seed.js')) {
  seed({ reset: process.argv.includes('--reset') });
  console.log('示例数据已就绪 seed done');
}
