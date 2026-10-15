// 手算核对：用一个临时数据库把每个模块的核心规则跑一遍。 运行： npm test
// 每一段都是"规则 → 手算的期望值 → 断言"，读它等于读一份可执行的原理说明。
import assert from 'node:assert/strict';

// 用内存里的嵌入式 Postgres (PGlite)：和生产环境同一套 SQL，跑完即弃
process.env.PGLITE_DIR = 'memory';
delete process.env.DATABASE_URL;
const { all, get, run, connect, disconnect } = await import('./db.js');
const E = await import('./engine.js');
const { seed } = await import('./seed.js');
await connect();
await seed();

const near = (a, b, msg, eps = 0.01) => assert.ok(Math.abs(a - b) < eps, `${msg}: got ${a}, want ${b}`);
const byName = async (t) => new Map((await all(`SELECT id, name_en FROM ${t}`)).map((r) => [r.name_en, r.id]));
const RID = await byName('recipes'), IID = await byName('ingredients'), SUP = await all('SELECT * FROM suppliers');
const rid = (en) => RID.get(en), iid = (en) => IID.get(en), sup = (like) => SUP.find((x) => x.name.includes(like));
const [CK, R1, R2] = (await all('SELECT id FROM outlets ORDER BY id')).map((o) => o.id);
const ALL = ['2000-01-01', '2999-01-01'];
let n = 0;
const section = async (name, fn) => { await E.refresh(); await fn(); n++; console.log(`  ✔ ${name}`); };

await section('单位换算：同量纲可换，不同量纲报错', async () => {
  near(E.toBase(2, 'kg', 'g'), 2000, 'kg→g');
  assert.throws(() => E.toBase(1, 'kg', 'ml'), /incompatible/);
});

await section('食材成本：逐行 净用量 → 毛用量 → × 单位成本，子配方递归', async () => {
  // 高汤 = 5kg×0.9 + 2kg×0.5 + 100g×1.5 + 200g×1.8 = 6010 Ft / 10000 ml
  const broth = E.recipeCost(rid('Pork bone broth'));
  near(broth.total, 6010, 'broth batch');
  near(broth.perUnit, 0.601, 'broth per ml', 1e-6);
  // 拉面 = 高汤 240.4 + 面 51.6 + 叉烧 244.6 + 蛋 80 + 葱 (10g×1.10×1.8=19.8) = 636.4
  near(E.recipeCost(rid('Chashu ramen')).perUnit, 636.4, 'ramen food cost');
  assert.deepEqual(E.recipeCost(rid('Chashu ramen')).allergens, ['egg', 'gluten', 'soy']);
});

await section('损耗：毛用量 = 净用量 × (1 + 损耗%)；优先级 配方行 > 原料 > 全局', async () => {
  const filling = E.recipeCost(rid('Dumpling filling')).lines;
  const cabbage = filling.find((l) => l.name_en === 'Napa cabbage');
  near(cabbage.gross, 1800, '1500 g × 1.20');                  // 白菜原料级 20%
  assert.equal(cabbage.waste_src, 'ingredient');
  const scallionInBroth = E.recipeCost(rid('Pork bone broth')).lines.find((l) => l.name_en === 'Scallion');
  near(scallionInBroth.gross, 200, 'line override 0%');        // 小葱原料级 10%，但高汤这一行写了 0
  assert.equal(scallionInBroth.waste_src, 'line');
  const salt = E.recipeCost(rid('Fresh noodles')).lines.find((l) => l.name_en === 'Salt');
  assert.equal(salt.waste_src, 'library');                     // 盐哪里都没写 → 用全局默认
  await E.saveSettings({ default_waste_pct: 5 });
  near(E.recipeCost(rid('Fresh noodles')).lines.find((l) => l.name_en === 'Salt').gross, 52.5, '50 g × 1.05');
  await E.saveSettings({ default_waste_pct: 0 });
});

await section('人工与 prime cost；按目标毛利率反推成本和售价', async () => {
  const r = E.recipeCost(rid('Chashu ramen'));
  // 自身：烹饪 4 分钟×3500/60 + 装盘 2 分钟×3000/60 = 333.33
  near(r.own_labour, 333.33, 'own labour');
  // 子配方人工按用量折算：高汤 2666.67/10000×400 + 面 2250/5000×150 + 叉烧 1875/1500×60 = 249.17
  near(r.labourPerUnit, 582.5, 'labour incl. sub-recipes');
  near(r.primePerUnit, 636.4 + 582.5, 'prime cost');
  const net = 3490 / 1.05;
  near(r.net_price, net, 'net price');
  near(r.margin_pct, (net - 1218.9) / net, 'margin %', 1e-6);
  assert.equal(r.meets_target, false);                          // 63% < 目标 70%
  near(r.target_prime, net * 0.3, 'target prime cost');
  near(r.target_price, (1218.9 / 0.3) * 1.05, 'target sell price');
  // 把人工时薪设为 0 = 不计人工
  await E.saveSettings({ rate_prep: 0, rate_cook: 0, rate_plate: 0 });
  near(E.recipeCost(rid('Chashu ramen')).labourPerUnit, 0, 'labour off');
  await E.saveSettings({ rate_prep: 3000, rate_cook: 3500, rate_plate: 3000 });
});

await section('成本取价：默认最便宜的包装；可切换为最近一次订的', async () => {
  near(E.ingredientUnitCost(iid('Wheat flour')), 0.26, 'cheapest', 1e-9);       // 25kg@6500 比 10kg@2900 便宜
  const pricey = (await get('SELECT id FROM packages WHERE ingredient_id=? AND pack_qty=10000', iid('Wheat flour'))).id;
  const before = (await get('SELECT last_ordered_at t FROM packages WHERE id=?', pricey)).t;
  await run("UPDATE packages SET last_ordered_at='2999-01-01' WHERE id=?", pricey);
  await E.saveSettings({ cost_basis: 'last_ordered' });
  near(E.ingredientUnitCost(iid('Wheat flour')), 0.29, 'last ordered', 1e-9);
  await E.saveSettings({ cost_basis: 'cheapest' });
  await run('UPDATE packages SET last_ordered_at=? WHERE id=?', before, pricey);
});

await section('配方展开：可入库的半成品到此为止，不可入库的继续拆到原料', async () => {
  const m = E.explode(rid('Pork dumplings ×12'), 10);
  assert.ok(m.has(`recipe:${rid('Pork dumplings (raw)')}`), 'stockable prep is consumed as a stock item');
  assert.ok(!m.has(`recipe:${rid('Dumpling dip')}`), 'non-stockable prep is exploded');
  // 蘸料 25 ml/份 × 10 份 = 250 ml = 半批 → 酱油 200 ml、辣椒油 50 ml
  near(m.get(`ingredient:${iid('Soy sauce')}`).qty, 200, 'soy via dip');
  near(m.get(`ingredient:${iid('Chili oil')}`).qty, 50, 'chili via dip');
});

await section('台账与批次：现存 = Σ流水 = Σ批次余量；出库先到期先出 (FEFO)', async () => {
  for (const s of await E.stockList(R1)) {
    const lots = (await E.lotsOf(R1, s.item_type, s.item_id)).reduce((a, l) => a + l.remaining, 0);
    if (s.on_hand >= 0) near(lots, s.on_hand, `lot remaining = on hand (${s.name_en})`, 1e-6);
  }
  // 一号店的饺子：期初那批没有效期，中央厨房调来的那批有 → 先消耗有效期的
  const dump = await all('SELECT * FROM lots WHERE outlet_id=? AND item_type=? AND item_id=? ORDER BY id', R1, 'recipe', rid('Pork dumplings (raw)'));
  const fromCk = dump.find((l) => l.expiry);
  assert.ok(fromCk && fromCk.remaining < fromCk.qty, 'the dated lot is drawn down first');
});

await section('盘点：分盘合计 → 覆盖库存；没盘的不动；想清零要盘成 0', async () => {
  const garlic0 = await E.onHand(CK, 'ingredient', iid('Garlic')), flour0 = await E.onHand(CK, 'ingredient', iid('Wheat flour'));
  const cid = await E.createCount(CK);
  await assert.rejects(() => E.createCount(CK), /open count/);
  const [s1] = (await E.getCount(cid)).subs, s2 = await E.addSubCount(cid, '干货库');
  const flour = { item_type: 'ingredient', item_id: iid('Wheat flour') };
  await E.saveSubCount(cid, s1.id, [{ ...flour, qty: 10000 }, { item_type: 'ingredient', item_id: iid('Salt'), qty: 0 }]);
  await E.saveSubCount(cid, s2, [{ ...flour, qty: 22500 }]);
  near((await E.getCount(cid)).lines.find((l) => l.name_en === 'Wheat flour').counted, 32500, 'sum of sub-counts');
  await E.confirmCount(cid);
  near(await E.onHand(CK, 'ingredient', iid('Wheat flour')), 32500, 'count overwrites stock');
  near(await E.onHand(CK, 'ingredient', iid('Salt')), 0, 'counted as zero');
  near(await E.onHand(CK, 'ingredient', iid('Garlic')), garlic0, 'uncounted item untouched');
  near((await get("SELECT qty FROM stock_moves WHERE reason='count_adjust' AND ref=? AND item_id=?", `C${cid}`, iid('Wheat flour'))).qty, 32500 - flour0, 'adjustment = counted − expected');
});

await section('补到 par：现存 + 在途 < 最低量 → 补到 par，向上取整到整包，按供应商分组', async () => {
  const lines = (await E.parSuggestions(CK)).suppliers.flatMap((g) => g.lines);
  const bones = lines.find((l) => l.name_en === 'Pork bones');
  assert.equal(bones.qty_packs, Math.ceil((30000 - bones.on_hand - bones.on_order) / 10000));
  // 普通门店缺半成品 → 建议向中央厨房下内部订单，而不是找外部供应商
  const r1 = await E.parSuggestions(R1);
  assert.ok(r1.internal && r1.internal.supplier_outlet_id === CK);
  const broth = r1.internal.lines.find((l) => l.name_en === 'Pork bone broth');
  // 下了内部订单后，在途量计入，同一样东西不再重复建议
  const io = await E.createInternalOrder({ outlet_id: R1, supplier_outlet_id: CK, lines: [{ item_id: broth.item_id, qty: broth.qty }] });
  assert.ok(!(await E.parSuggestions(R1)).internal?.lines.some((l) => l.name_en === 'Pork bone broth'), 'on-order suppresses the suggestion');
  await E.deleteInternalOrder(io);
});

await section('订单审批：当日已发金额 + 本单 > 限额 → 待审批；拒绝必须给原因', async () => {
  const meat = (await E.parSuggestions(CK)).suppliers.find((g) => g.supplier_id === sup('Fresh').id);
  const po = await E.createPO({ outlet_id: CK, supplier_id: meat.supplier_id, lines: meat.lines });
  assert.ok((await E.getPO(po)).ordered_total > 50000);
  const r = await E.submitPO(po);
  assert.equal(r.status, 'waiting_approval');
  assert.equal(r.flag.limit, 50000);
  await assert.rejects(() => E.receivePO(po), /not receivable/);
  await assert.rejects(() => E.rejectPO(po, ''), /reason/);
  await E.rejectPO(po, '太多了，分两天订');
  assert.equal((await E.getPO(po)).status, 'rejected');
  await E.recallPO(po);
  await E.submitPO(po);
  await E.approvePO(po, '周末备货，同意');
  assert.equal((await E.getPO(po)).status, 'sent');
  // 小单不超限 → 直接发送；并且订过的包装记下"最近订货时间"
  const small = await E.createPO({ outlet_id: R1, supplier_id: meat.supplier_id, lines: [{ package_id: meat.lines[0].package_id, qty_packs: 1 }] });
  assert.equal((await E.submitPO(small)).status, 'sent');
  assert.ok((await get('SELECT last_ordered_at t FROM packages WHERE id=?', meat.lines[0].package_id)).t);
  await E.deletePO(small);
  globalThis.meatPO = po;
});

await section('收货：可分多次；实付价可回写包装价并留历史；发票差额 = 发票 − 实收', async () => {
  const po = globalThis.meatPO, o = await E.getPO(po), l0 = o.lines[0];
  const before = await E.onHand(CK, 'ingredient', l0.ingredient_id);
  await E.receivePO(po, { close: false, lines: o.lines.map((l, i) => (i === 0 ? { id: l.id, state: 'part', packs: 1, price: l.price + 500 } : { id: l.id, state: 'none' })) });
  assert.equal((await E.getPO(po)).status, 'partial');
  near(await E.onHand(CK, 'ingredient', l0.ingredient_id), before + l0.pack_qty, 'partial delivery adds stock');
  near((await get('SELECT price FROM packages WHERE id=?', l0.package_id)).price, l0.price + 500, 'price written back');
  assert.ok(await get("SELECT id FROM package_prices WHERE package_id=? AND source=?", l0.package_id, `PO${po}`), 'price history row');
  // 第二次：剩下的全到；发票比实收多 1000
  await E.receivePO(po, { invoice_no: 'INV-1', invoice_amount: 0 });
  const done = await E.getPO(po);
  assert.equal(done.status, 'delivered');
  assert.ok(done.lines.every((l) => l.received_packs === l.qty_packs));
  await E.saveInvoice(po, { invoice_amount: done.received_total + 1000 });
  near((await E.getPO(po)).invoice_diff, 1000, 'invoice difference');
  // 收货批次带上供应商，追溯时能查到
  assert.equal((await get("SELECT supplier_id s FROM lots WHERE ref=? LIMIT 1", `PO${po}`)).s, o.supplier_id);
});

await section('需求预测：同星期几的历史销量 → × 缩放 → 展开成用料 → 减库存和在途', async () => {
  const a = await E.forecastSuggestions(R1, { days: 1, source: 'last_week', scale: 100, use_stock: false, use_outstanding: false });
  const d = E.dayAdd(a.start, -7);
  const ramen = (await get('SELECT COALESCE(SUM(qty),0) q FROM sales WHERE outlet_id=? AND day=? AND recipe_id=?', R1, d, rid('Chashu ramen'))).q;
  near(a.dishes.find((x) => x.recipe_id === rid('Chashu ramen')).qty, ramen, 'same weekday last week');
  const b = await E.forecastSuggestions(R1, { days: 1, source: 'last_week', scale: 130, use_stock: false, use_outstanding: false });
  near(b.dishes.find((x) => x.recipe_id === rid('Chashu ramen')).qty, ramen * 1.3, 'scaled 130%');
  // 高汤的预测用量 = 拉面份数 × 400 ml
  near(a.internal.lines.find((l) => l.name_en === 'Pork bone broth').forecast, ramen * 400, 'exploded through recipe');
});

await section('生产计划：自动带出子配方 → 看板 → 完成时按计划量领料、按实际产出入库', async () => {
  // 做 400 只饺子需要 6000 g 馅 (可入库的子配方)
  const subs = await E.subRecipeNeeds(CK, rid('Pork dumplings (raw)'), 400);
  near(subs.find((s) => s.name_en === 'Dumpling filling').qty, 6000, 'sub-recipe need');
  const plan = await E.savePlan({ outlet_id: CK, name: 'test', tasks: [
    { recipe_id: rid('Pork dumplings (raw)'), qty: 200 }, { recipe_id: rid('Dumpling filling'), qty: 3000 }, { title: '清洁' }] });
  // 计划的 BoM 里不应该再出现馅 (本计划自己会做)，但有面粉和馅的原料
  const bomKeys = (await E.getPlan(plan)).bom.map((b) => b.name_en);
  assert.ok(!bomKeys.includes('Dumpling filling') && bomKeys.includes('Wheat flour') && bomKeys.includes('Minced pork'));
  await assert.rejects(() => E.finishPlan(plan), /not active/);
  await E.activatePlan(plan);
  await assert.rejects(() => E.finishPlan(plan), /must be done/);
  await E.markAllDone(plan);
  const mince0 = await E.onHand(CK, 'ingredient', iid('Minced pork')), fill0 = await E.onHand(CK, 'recipe', rid('Dumpling filling'));
  const dTask = (await E.getPlan(plan)).tasks.find((t) => t.name_en === 'Pork dumplings (raw)');
  const out = await E.finishPlan(plan, [{ task_id: dTask.id, produced_qty: 180 }]);
  near(await E.onHand(CK, 'ingredient', iid('Minced pork')), mince0 - 1500, 'ingredients drawn for planned qty');
  near(await E.onHand(CK, 'recipe', rid('Dumpling filling')), fill0, 'filling made then fully used by dumplings');
  const d = out.find((x) => x.recipe_id === rid('Pork dumplings (raw)'));
  // 出成率：计划 200 只的投入只出了 180 只 → 单位成本 = 投入 ÷ 180
  const input = E.recipeCost(rid('Pork dumplings (raw)')).total;
  near(d.unit_cost, input / 180, 'yield-adjusted unit cost', 1e-6);
  // 效期 = 生产日 + 保质期 30 天；批次有父批次 (馅)
  assert.equal(d.expiry, E.dayAdd(E.today(), 30));
  const lot = (await get('SELECT id FROM lots WHERE lot_no=?', d.lot_no)).id;
  assert.ok((await all('SELECT * FROM lot_links WHERE child_lot_id=?', lot)).length >= 2, 'output lot linked to its input lots');
  globalThis.dumplingLot = d.lot_no;
});

await section('内部订货：下单 → 拣货(可少拣) → 发货扣厨房 → 收货加门店，批号跟着走', async () => {
  await assert.rejects(() => E.createInternalOrder({ outlet_id: R1, supplier_outlet_id: CK, lines: [{ item_id: rid('Dumpling dip'), qty: 1 }] }), /stockable/);
  const dump = rid('Pork dumplings (raw)');
  const ck0 = await E.onHand(CK, 'recipe', dump), r0 = await E.onHand(R2, 'recipe', dump);
  const io = await E.createInternalOrder({ outlet_id: R2, supplier_outlet_id: CK, lines: [{ item_id: dump, qty: 120 }] });
  near((await E.onOrder(R2))[`recipe:${dump}`], 120 + 300, 'counts as on order for the buyer (plus the seeded order)');
  const line = (await E.getInternalOrder(io)).lines[0];
  await E.pickInternalOrder(io, { lines: [{ id: line.id, picked_qty: 100 }] });
  near(await E.onHand(CK, 'recipe', dump), ck0, 'picking alone does not move stock');
  await E.shipInternalOrder(io);
  near(await E.onHand(CK, 'recipe', dump), ck0 - 100, 'shipping depletes the kitchen');
  near(await E.onHand(R2, 'recipe', dump), r0, 'in transit: not yet at the outlet');
  await E.receiveInternalOrder(io);
  near(await E.onHand(R2, 'recipe', dump), r0 + 100, 'receiving adds to the outlet');
  // 汇总新订单 = 中央厨房今天的生产需求
  const demand = await E.incomingDemand(CK);
  near(demand.find((x) => x.name_en === 'Pork bone broth').qty, 30000, 'aggregated incoming demand');
});

await section('追溯：从成品批号向上查到原料和供应商，向下查到门店和销售', async () => {
  const t = await E.trace(globalThis.dumplingLot);
  const flat = (nodes) => nodes.flatMap((x) => [x, ...flat(x.children)]);
  const up = flat(t.backward).map((x) => x.name_en), down = flat(t.forward);
  assert.ok(up.includes('Dumpling filling') && up.includes('Minced pork'), 'backward: filling → minced pork');
  assert.ok(down.some((x) => x.outlet_en === 'Restaurant 2'), 'forward: reached Restaurant 2');
  // 种子数据里一号店那批饺子已经卖掉了一部分
  const seeded = (await get("SELECT lot_no FROM lots WHERE outlet_id=? AND source='receive_internal' ORDER BY id LIMIT 1", R1)).lot_no;
  assert.ok(flat((await E.trace(seeded)).forward).some((x) => x.usage.some((u) => u.reason === 'sale')), 'forward: sold');
});

await section('调拨与报损：调拨总量守恒；报废一道菜 = 扣掉它用的东西', async () => {
  const noodles = rid('Fresh noodles');
  const a = await E.onHand(CK, 'recipe', noodles), b = await E.onHand(R1, 'recipe', noodles);
  await E.transfer({ from_outlet: CK, to_outlet: R1, item_type: 'recipe', item_id: noodles, qty: 1000 });
  near(await E.onHand(CK, 'recipe', noodles) + await E.onHand(R1, 'recipe', noodles), a + b, 'conserved');
  await assert.rejects(() => E.waste({ outlet_id: R1, item_type: 'recipe', item_id: noodles, qty: 1 }), /reason/);
  const egg0 = await E.onHand(R1, 'ingredient', iid('Eggs')), n0 = await E.onHand(R1, 'recipe', noodles);
  await E.waste({ outlet_id: R1, item_type: 'recipe', item_id: rid('Chashu ramen'), qty: 3, reason: '做错/退菜 Mistake' });
  near(await E.onHand(R1, 'ingredient', iid('Eggs')), egg0 - 3, 'wasting a dish depletes its ingredients');
  near(await E.onHand(R1, 'recipe', noodles), n0 - 450, '3 × 150 g noodles');
  const rep = await E.wasteReport(R1, ...ALL);
  near(rep.by_reason.reduce((s, r) => s + r.value, 0), rep.total, 'waste report adds up');
});

await section('POS 关联：未关联的只记营业额；关联后补扣库存；健康度 = 已关联营业额占比', async () => {
  const before = await E.posItems(R1);
  assert.ok(before.health < 1 && before.health > 0.9);
  const tea = before.items.find((i) => i.name === '冻柠茶');
  assert.ok(tea.pending > 0 && !tea.recipe_id);
  const cola0 = await E.onHand(R1, 'ingredient', iid('Cola 330ml'));
  const sold = (await get('SELECT SUM(qty) q FROM sales WHERE pos_item_id=?', tea.id)).q;
  const r = await E.linkPos(tea.id, rid('Cola'));          // 演示用：把它关联到"可乐"这个配方
  assert.equal(r.depleted, tea.pending);
  near(await E.onHand(R1, 'ingredient', iid('Cola 330ml')), cola0 - sold, 'backlog depleted on linking');
  near((await E.posItems(R1)).health, 1, 'linking health 100%');
  // 新 PLU 自动建成"未关联"
  const imp = await E.importPosSales(R1, [{ plu: '777', name: '新品', qty: 2, revenue: 5000 }]);
  assert.deepEqual([imp.created, imp.unlinked], [1, 1]);
});

await section('管理报表：期初 + 各项变动 = 期末；实际成本 = 理论 + 报损 − 净差异', async () => {
  for (const O of [CK, R1, R2]) {
    const { movement: m, profit: p, variance: v } = await E.managementFigures(O, E.dayAdd(E.today(), -14), E.today());
    const sum = m.opening + m.goods_received + m.created_in + m.transfers_in + m.sold + m.created_out + m.transfers_out + m.shipped_out + m.wasted + m.net_variance;
    near(sum, m.closing, `movement identity (outlet ${O})`, 0.5);
    near(p.actual_cost, p.theoretical_cost - m.wasted - v.net, 'actual cost');
  }
  // 逐品项也成立
  for (const r of (await E.stockPeriod(R1, E.dayAdd(E.today(), -14), E.today())).rows)
    near(r.opening + r.ordered + r.created_in + r.moved_in + r.sold + r.created_out + r.moved_out + r.shipped_out + r.wasted + r.gain + r.loss, r.closing, `item identity (${r.name_en})`, 1e-6);
});

await section('菜单 (套餐)：整套成本 = 各道一份相加；套餐价去税后算毛利', async () => {
  const m = (await E.listMenus())[0];
  near(m.food, m.items.reduce((s, i) => s + i.food, 0), 'menu food cost');
  near(m.net_price, 4990 / 1.05, 'menu net price');
  near(m.margin_pct, (m.net_price - m.prime) / m.net_price, 'menu margin', 1e-9);
});

await section('菜单工程：四象限门槛', async () => {
  const me = await E.menuEngineering(null, ...ALL);
  near(me.pop_threshold, (me.totals.qty / me.rows.length) * 0.7, 'popularity threshold');
  near(me.margin_threshold, me.totals.margin / me.totals.qty, 'margin threshold');
});

await section('HACCP：按频率生成待办；超限 = 异常，且必须写处理措施', async () => {
  const mon = '2026-10-05', tue = '2026-10-06';             // 周一、周二
  const weekly = { frequency: 'weekly', weekdays: [1], start_date: '2026-01-01' };
  assert.equal(E.isDue(weekly, mon), true);
  assert.equal(E.isDue(weekly, tue), false);
  assert.equal(E.isDue({ frequency: 'monthly', month_day: 1, start_date: '2026-01-01' }, '2026-11-01'), true);
  assert.equal(E.isDue({ frequency: 'daily', start_date: '2026-01-01', end_date: '2026-06-30' }, mon), false);
  const fridge = (await E.listTasks(R2)).find((t) => t.type === 'temperature');
  await assert.rejects(() => E.completeTask(fridge.id, { value: 9 }), /corrective action/);
  assert.equal((await E.completeTask(fridge.id, { value: 9, remarks: '报修，食材转移到 2 号柜' })).ok, false);
  assert.equal((await E.completeTask(fridge.id, { value: 4 })).ok, true);     // 同一天重做会覆盖
  const rep = await E.taskReport(R1, E.dayAdd(E.today(), -4), E.dayAdd(E.today(), -1));
  assert.equal(rep.irregular, 1);                             // 种子数据里一号店有一次超温
  assert.ok(rep.done <= rep.due);
});

await section('循环引用会被拒绝', async () => {
  await run('INSERT INTO recipe_lines (recipe_id,sub_recipe_id,qty,unit) VALUES (?,?,?,?)', rid('Dumpling filling'), rid('Pork dumplings (raw)'), 1, 'pc');
  await E.refresh();
  assert.throws(() => E.recipeCost(rid('Pork dumplings (raw)')), /circular/);
});

console.log(`\n全部通过 ✔  ${n} 组核对`);
await disconnect();
