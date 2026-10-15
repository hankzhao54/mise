# Apicbase 功能对照

这份文档回答三个问题：Apicbase 到底有哪些功能、每个功能的规则是什么、Mise 里做到了哪一步。

**资料来源**：Apicbase 公开的帮助中心（[support.apicbase.com/help](https://support.apicbase.com/help)，15 个分类、几百篇操作文章）和开发者文档（[developers.apicbase.com](https://developers.apicbase.com/docs/welcome)）。
我读了其中约 50 篇讲具体机制的文章，每一节末尾列出了出处，想深入可以直接看原文。

**没用到的资料**：它的网络研讨会（The Pass）需要报名观看，产品演示视频我也无法观看内容，所以这里**完全基于文字资料**。界面长什么样、点哪里，以原文截图为准；Mise 的界面是自己设计的。

**三种标记**

| 标记 | 含义 |
| --- | --- |
| ✅ | 按文档里写明的规则实现 |
| ◐ | 做了，但有简化，或者文档没写清楚、我按合理推断补的（会说明哪部分是推断） |
| ✗ | 没做 |

---

## 0. 基本概念

| Apicbase 的概念 | 含义 | Mise 里对应 |
| --- | --- | --- |
| Library（库） | 一个企业的全部主数据：原料、配方、菜单、供应商、设置。一个库只有一种货币 | 整个数据库 |
| Outlet（门店） | 一个实体地点。**库存、订单、盘点、销售都挂在门店上**；配方、原料属于库 | `outlets` 表，右上角切换 |
| Stock item（库存品） | 能入库的东西：原料的某个包装，或「可入库」的配方 | `(item_type, item_id)` |
| Event（事件） | 任何改变库存的动作：count / create / waste / transfer / sale / delivery | `stock_moves` 里的一行 |

出处：[Listing Outlets](https://developers.apicbase.com/docs/listing-outlets)

---

## 1. Menu Engineering（产品：原料、配方、菜单）

在 Apicbase 里，"Menu Engineering" 是原料 + 配方 + 菜单 + 成本这一整块的名字，不是指四象限矩阵。

### 1.1 原料与包装

| 功能 | Apicbase 的规则 | Mise |
| --- | --- | --- |
| 一个原料多个包装 | 每个包装单独录入（一瓶 1.5 L、一箱 6 瓶…），各自可以挂供应商、货号、价格 | ✅ `packages` |
| Is orderable | 勾了才会出现在订货页。可订货性不会从大包装传给小包装 | ✅ `orderable` |
| Is stockable / Is active | 不可入库的包装不出现在盘点里、销售不扣它；停用的包装不能再用但保留历史 | ✗（所有包装都可入库） |
| 包装层级 | 没有供应商的小包装，库存价值 = 大包装价 ÷ 包含数量 | ◐ Mise 不做层级：库存直接按基础单位（g/ml/个）记，包装只在订货和收货时出现 |
| 按包装盘点 | 盘点时按包装数，零头用 "Part" 按单位填，系统换算成包装 | ✗ 直接按基础单位盘 |
| 价格历史 | 可以查看每个原料的价格演变 | ✅ `package_prices`，原料编辑页底部 |
| 批量导入 / 导出（Excel） | 原料、包装价格、库存设置都有 Excel 模板 | ✗ |
| 原料合并、归档、替换 | 重复原料可以合并；不用的归档而不是删除 | ✗ |
| 称重商品（Weighted articles） | 按实际重量结算的包装 | ✗ |
| Stock variants | 同一原料的不同品牌/规格当作可互换的库存 | ✗ |

出处：[包装与价格](https://support.apicbase.com/help/adding-and-editing-packages-and-pricing)、[Menu Engineering 目录](https://support.apicbase.com/help/menu-engineering)

### 1.2 配方成本（Financial 标签页）

这是整个产品最核心的一页，分三块。Mise 的「配方 → 财务」按同样的三块排版。

**① 一份的成本**

| 项 | Apicbase 的规则 | Mise |
| --- | --- | --- |
| 永远按 1 份显示 | 即使配方产出多份 | ✅ 每单位成本 |
| Food cost | 原料成本 + 损耗 | ✅ |
| Personnel cost | 工时 × 时薪。三种时薪：备料 / 烹饪 / 装盘，在库设置里填；设为 0 就不计入。只算**主动**工时，被动时间（炖着不用管）不算 | ◐ 三种时薪和工时都有；公式「分钟 × 时薪 ÷ 60」是我的推断（文档只说 time × cost per hour）。子配方的人工按用量折算进上层，这也是推断 |
| Prime cost | Food + Personnel | ✅ |
| 取哪个包装的价 | 默认最便宜的包装；每个门店可改成「最近一次订的」(Last ordered) | ◐ 两种都有，但是全局开关，不是每店一个 |
| 用料明细表 | 用量、价格、每份/整批的原料成本、损耗成本、成本占比，可排序 | ◐ 有前几列，没有占比和排序 |

**② 按现售价的实际利润**

- 售价录入的是**含税价**，系统自己去税。✅
- Profit = 售价（去税）− prime cost；Actual profit margin = profit ÷ 去税售价。✅
- 设了目标毛利率就显示是否达标、差多少。✅
- 每个门店可以有不同售价（Add outlet price）。✗

**③ 按目标毛利率反推**

- Calculate Target Prime Cost：价格不变，成本要压到多少。✅
- Calculate Target Sell Price：成本不变，价格要定到多少。✅
- 税率、目标毛利率在库设置里有默认值，配方上可以覆盖。✅

出处：[Food cost calculation](https://support.apicbase.com/help/food-cost-calculation)、[生产时间与成本](https://support.apicbase.com/help/how-to-add-production-time-and-costs-to-your-recipes)

### 1.3 备料损耗（Preparation waste）

| 规则 | Mise |
| --- | --- |
| 三级设置，优先级：**配方行 > 原料 > 库默认** | ✅ 财务页的损耗列会标出这个值来自哪一级 |
| 子配方行上也能加损耗，叠加在子配方内部原料各自的损耗之上 | ✅ |
| 扣库存按毛用量扣（文档原话：用 100 g 糖会扣 105 g） | ✅ |
| 毛用量 = 净用量 × (1 + 损耗%) | ◐ 文档没有写公式，这是从「100 g → 105 g」这个例子推出来的。注意它和「净用量 ÷ (1 − 损耗%)」是两种不同的算法，结果不一样 |

出处：[Setting a preparation waste percentage](https://support.apicbase.com/help/setting-a-preparation-waste-percentage)

### 1.4 子配方与可入库配方（Stockable recipes）

| 规则 | Mise |
| --- | --- |
| 产品类型设成 Semi-finished 才能被别的配方当子配方用，列表里标 [R]，原料标 [I] | ✅ `kind = prep` |
| 子配方要设净重/净容量；不设的话系统把原料重量加起来（按个计的不算进去，1 L 当 1 kg） | ✗ 产出量必须手填 |
| 配方可以设为「可入库」：提前做好放着的才设 | ✅ `stockable` |
| 可入库的配方通过 Create 事件入库：填产出量 → 库存增加，用掉的原料减少；自动带出批号和效期 | ✅ 通过生产计划完成时入库（没有单独的 Create 页面） |
| 不可入库的子配方，卖出时怎么扣库存 | ◐ 文档没有明说。Mise 的做法：继续往下拆到原料或可入库的半成品（`explode`） |

出处：[How to use sub-recipes](https://support.apicbase.com/help/how-to-use-sub-recipes)、[Stockable recipes](https://support.apicbase.com/help/everything-you-need-to-know-about-stockable-recipes)、[Create 事件](https://support.apicbase.com/help/adding_semifinished_product_to_stock)

### 1.5 物料清单（Bill of Materials）

配方页点 "Bill of Materials" → 选门店 → 填份数（或导入某段时间的销量）→ 得到：需要量、库存量、订货量、订哪个包装（默认最近订的，可切最便宜的）、金额 → 一键生成订单（每个供应商一张）。

Mise：✅ 配方 → 物料清单。没做「导入销量」这个入口（需求预测里有同样的逻辑）。

出处：[Generate a BoM for a recipe](https://support.apicbase.com/help/generate_bom_recipe)

### 1.6 菜单（Menus）

菜单 = 分道次（course）的一组配方，有套餐价、税率、目标毛利率。保存后有几个标签页：
Total Menu Cost（整套成本，只适用于固定套餐）、Recipe Comparison（各配方成本和目标利润并排比）、Allergens（过敏原卡）、Outlets。

Mise：✅ 「菜单」页，三块都有。没做：按门店启用、季节/生效期、QR 码分享。

出处：[Create a new menu](https://support.apicbase.com/help/create-a-new-menu-2)

### 1.7 过敏原与营养

Apicbase：可接入过敏原/营养数据库自动带出、过敏原需要有权限的人「验证」、营养标签打印、Nutri-Score、按地区的参考摄入量、菜单过敏原卡和 QR 码。

Mise：◐ 只做了过敏原从原料汇总到配方和菜单。✗ 营养成分、数据库、验证流程、标签。

出处：[Allergens, Dietary and Nutritions](https://support.apicbase.com/help/allergens-dietary-and-nutritions)

---

## 2. Procurement（采购）

### 2.1 Par 和最低量

- **PAR** = 订货后希望达到的库存量；**Minimum** = 低于它就发邮件提醒。
- 按「原料 × 门店 × 包装」设置，可以 Excel 批量导入。
- 订货页 More → **Order All to Par**：自动把所有低于 Par 的补到 Par。

Mise：◐ 按「库存品 × 门店」设置（不分包装）。触发条件用的是「现存 + 在途 < 最低量」，补到 Par，按包装向上取整 —— 触发条件和取整规则文档没有写，是我的设计。

出处：[Par and minimum levels](https://support.apicbase.com/help/what-is-par-and-how-to-use-it-in-apicbase)

### 2.2 需求预测（Demand Forecasting / Suggest Order）

不看 Par，从销售历史自上而下推：

| 参数 | 含义 |
| --- | --- |
| Order for (duration) | 订几天的量 |
| Sales period | 上周同期，或近 4 周的滚动平均。**按星期几分别统计**（用过去 4 个周一预测下一个周一） |
| Scale up/down | 缩放百分比：130% 用于旺季，105% 相当于 5% 安全余量 |
| Current stock / Outstanding ordered quantities | 两个开关：是否减去现存、是否减去在途 |

Mise：✅ 订货 → 需求预测，四个参数都有。◐ 文档没有给具体公式和取整规则，「历史不足 4 周时只在有数据的周上取平均」是我的处理。

出处：[Demand Forecasting / Order Suggestion](https://support.apicbase.com/help/demand-forecasting)

### 2.3 订单审批

- 触发：这家店**当天**已发给**同一供应商**的金额 + 本单 > 限额 → 不发送，等审批。正好等于限额不用审批。只有已发送的订单计入当日金额。
- 限额三级，取最具体的一层：门店+供应商 > 供应商 > 库。
- 状态：In progress → Waiting for approval → Rejected / Sent。
- 批准时可以改交货日期、加备注；拒绝必须给原因；提交人可以 Recall and edit。
- 审批人按角色配置，没人可通知时落到库管理员。

Mise：◐ 规则和状态都按文档做了；限额只有两级（供应商、库），没有「门店+供应商」这一级，也没有角色和邮件通知（没有用户系统）。

出处：[How does order approval work?](https://support.apicbase.com/help/how-does-order-approval-work)

### 2.4 收货

| 字段 / 行为 | Mise |
| --- | --- |
| 每行到货状态：All / Part / None；Part 才能填数量 | ✅ |
| Price paid 可以和预期价不同；**Update price** 勾了才回写到库里（一次性促销别勾） | ✅ 并写价格历史 |
| **Update Stock** 开关：货已经在盘点里数过了就别勾，避免重复入库 | ✅ |
| Save Delivery（订单保持打开，可以多次收货）/ Save Delivery & Close Order | ✅ |
| 发票状态：Not yet received / Received / Payable / Paid；发票号；上传发票文件 | ◐ 没有文件上传 |
| 备注下拉：迟到（已接受）、多送（已接受）、价格问题（已接受） | ✗ |
| 添加订单上没有的品项；可回收物（空瓶、周转箱）进出数量；整单折扣 | ✗ |
| 收货时登记效期（开启追溯后还会打印标签） | ◐ 可填效期，自动生成批号，不打印 |

出处：[How can I receive orders](https://support.apicbase.com/help/receive_order)

### 2.5 发票核对（Invoice Reconciliation）

三步：导入（PDF/XML，可以转发到门店邮箱）→ AI 匹配到已到货的订单（匹配分 ≥ 60% 自动关联）→ 比较。
**差额 = 发票金额 − 订单实收货值**（都不含税）。有差异就走供应商结算/红字发票流程。

Mise：◐ 只做了最后一步：手工填发票金额，显示差额。✗ 文件导入、AI 匹配、红字发票。

出处：[Invoice Reconciliation](https://support.apicbase.com/help/invoice-reconciliation)

### 2.6 内部订货（Internal ordering）

给有中央厨房的企业用：

1. 把中央厨房这个门店设成 **Supplier Outlet**（它就出现在供应商列表里）。
2. 门店像对外部供应商一样下单。
3. 中央厨房的 Internal Orders 分三个列表：**Incoming → Picked → Shipped**。
4. 拣货时填每行实拣数量（Partial / None），可以加订单上没有的品项；Pick and Ship 或 Pick and Save。
5. 门店收货。
6. 只有可入库的配方能内部订货。
7. 多张订单可以合并拣货、合并成一张 BoM、合并成一个生产计划。

Mise：✅ 「内部订货」页，1–6 都有，7 做了「汇总需求 → 生成生产计划」。◐ 库存在「发货」时扣中央厨房、「收货」时加门店，这个时点文档没有写明，是我的设计；内部结算价（加价）没做。

出处：[Internal ordering](https://support.apicbase.com/help/internal-ordering)、[生产模块配合内部订货](https://support.apicbase.com/help/how-can-i-use-the-production-module-with-internal-ordering/production-kitchen)

### 2.7 其他

| 功能 | Apicbase | Mise |
| --- | --- | --- |
| 最低起订额 | 每个供应商设一个，低于它**只提醒不拦截** | ✅ |
| 运费 | 供应商默认运费，可按门店覆盖，收货时可改。**不摊进原料成本**，只在采购报表里出现 | ◐ 没有按门店覆盖 |
| 订货清单（Order lists） | 把常订的东西存成模板，一键载入购物车 | ✗ |
| 外部订单 | 登记没通过系统发的订单 | ✗ |
| 供应商对接 | 三十多家批发商：目录自动同步、电子下单 | ✗ |
| 动态定价、按门店限定供应商、订单邮件自定义 | 有 | ✗ |

出处：[Procurement 目录](https://support.apicbase.com/help/procurement)、[Minimum purchase amounts](https://support.apicbase.com/help/minimum-purchase-amounts)、[Order delivery costs](https://support.apicbase.com/help/order-delivery-costs)、[Order lists](https://support.apicbase.com/help/order_lists)

---

## 3. Inventory（库存）

### 3.1 盘点

| 规则 | Mise |
| --- | --- |
| Start count 后自动建第一个 sub-count，可以改名 | ✅ |
| 多人同时盘：各自 Start partial count，"Count Total" 列是所有人数量之和 | ✅ 分盘 |
| **实盘数覆盖库存**，不是累加 | ✅ |
| **没盘的品项保持不变**；想清零必须盘成 0 | ✅ |
| Save Count 时弹出理论 vs 实盘的差异汇总，确认后不能再改 | ✅ 两步：查看差异 → 确认 |
| Blind Count（库设置）：隐藏账面数 | ✅ |
| 储位（Storage location）：每个门店自己定义，盘点时按储位筛选 | ✅ |
| 盘点期间不要做别的库存动作；POS 出票时不要盘点 | 页面上有提示 |
| 按包装盘、Part 按钮、Excel 盘点、条码枪 App | ✗ |
| 补录过去的事件（180 天内）、重开/编辑已关闭的事件 | ✗ |

出处：[Counting your inventory](https://support.apicbase.com/help/counting-your-inventory)、[Storage locations](https://support.apicbase.com/help/create-storage-locations-per-outlet)、[Library settings](https://support.apicbase.com/help/library-settings)、[Registering past events](https://support.apicbase.com/help/registering-past-events)

### 3.2 报损

- 选品项（配方或原料）→ 填数量 → **必须选事件描述**（原因），报损报表按它汇总。
- 分两种：库存品的报损，和配方的报损。

Mise：✅ 原因必选，可在设置里维护原因列表。◐ 「报废一道菜 = 按配方扣掉它用的东西」是我对第二种的理解，文档那篇没有展开。

出处：[How to register waste](https://support.apicbase.com/help/register_waste)

### 3.3 调拨

选调出门店 → 调入门店 → 选品项（可入库配方或原料）填数量 → 保存时才真正动库存。调出减、调入加。盘点前要把调拨都登记完。

Mise：✅，并且批号跟着走（这一点是 Mise 自己加的）。

出处：[Transfer stock](https://support.apicbase.com/help/transfer-stock)

---

## 4. Sales（销售）

| 规则 | Mise |
| --- | --- |
| POS 商品按 **PLU** 识别。一个 PLU 关联一个配方；多个 PLU 可以指向同一个配方 | ✅ |
| 已关联的每卖一份就自动扣配方的用料 | ✅ |
| 未关联的 PLU 列在 Unlinked 里；**POS Linking Health** = 已关联营业额 ÷ 全部营业额（近 30 天），目标 100% | ✅ |
| 可以 Ignore：折扣、小费、配送费等 | ✅ |
| 简单商品（瓶装饮料）可以直接关联到原料 + 份量，系统在背后建一个单原料配方 | ✗ 需要自己建配方 |
| 手工销售（没有 POS 时）、Excel 批量导入 | ◐ 手工录入 + 粘贴 CSV |
| 三十多种 POS 对接、自动关联（Auto-linking） | ✗ |
| 关联之后，之前没扣的销售怎么办 | ◐ 文档没写。Mise 的做法：关联时补扣 |

出处：[Linking POS data](https://support.apicbase.com/help/linking-pos-data-to-apicbase-data)、[Sales 目录](https://support.apicbase.com/help/sales)

---

## 5. Planning（计划）

### 5.1 生产计划

1. **建计划**：把配方/菜单拖进 Planned Tasks，填数量、负责人、工位。**用到的子配方按需要量自动加进来**，可以取消勾选（库存里已经有的）。还能加自定义任务（清洁、倒垃圾）。
2. **激活并开始**。
3. **管理**：每个任务 Start（开始计时）→ Done；也可以 Mark all as done（那样就没有耗时）。可按人、按工位筛选。任务详情里有配方步骤和用料。
4. **完成**：所有任务 Done 之后才能 Finish Plan → 弹窗里选哪些可入库的配方要入库、改实际产出量 → 批号和效期自动填好（可改）→ 确认后原料扣减、成品入库。可打印标签、下载报告（谁做了什么、用了多久）。
5. 可以从汇总的内部订单直接生成计划。

Mise：✅ 1–5 都做了（看板三列、计时、完成时入库）。◐ 「按计划量领料、按实际产出入库，所以出成率低单位成本就高」这个成本处理是我的设计，文档没有说明成本怎么算。✗ 拖拽、计划排期（Scheduling runs）、标签打印、复制计划。

出处：[Make a production plan](https://support.apicbase.com/help/how-can-i-make-a-production-plan)、[Manage a production plan](https://support.apicbase.com/help/how-to-manage-a-production-plan)、[Complete a plan](https://support.apicbase.com/help/how-to-complete-existing-plan)

### 5.2 任务与 HACCP

- 先定义 **CCP**（关键控制点）：名称、编号、负责人、类型（收货、储存、备料、加工、烹制、复热、出品、陈列、废弃物、设施、其他）、说明。CCP 是库级的。
- 再建**任务**并挂到 CCP 上，任务是门店级的。字段：名称、类型、CCP、说明、门店、负责人、开始日期/时间、结束日期、频率（停用 / 一次 / 每天 / 每周选星期几 / 每月选几号 / 每年）。
- **任务类型**：温度检查（要填最低和最高温度）、一般任务、清单任务（多个子项）、清洁消毒、包装、维护、废弃物管理、虫害控制、设施管理、库存管理、化学品管控、培训、追溯与召回，以及两个带快捷按钮的：**Order**（给负责人一个去订货的按钮）和 **Count**（去盘点的按钮）。
- 执行：点任务 → 填测量值、备注、照片、执行人 → Complete，任务显示 Done。
- 报告：已完成的任务和「异常」(irregularities)，用于 HACCP 检查。

Mise：✅ CCP、任务、全部频率（除了每年）、全部类型、每日待办、报告。◐ 「读数超出限值 = 异常，且必须写处理措施」的强制规则是我加的，文档只提到会跟踪异常。✗ 照片、文件上传、日历视图。

出处：[Tasks & HACCP 指南](https://support.apicbase.com/help/guide-to-the-tasks/haccp-module)、[Define CCPs](https://support.apicbase.com/help/how-to-define-critical-control-points)、[Add HACCP tasks](https://support.apicbase.com/help/how-can-i-add-haccp-tasks)、[Manage tasks](https://support.apicbase.com/help/how-to-manage-tasks-in-the-task-module)

### 5.3 菜单排期（Menu Planning）

给食堂、养老院这类按周期供餐的场景：Menu Cycle = 若干周 × 每天 × 每道次的配方和份数，可重复执行（instance）；选一段日期就能把计划份数汇总成订单、生产计划，或直接登记成销售。

Mise：✗ 没做。它依赖的三个下游（BoM 订货、生产计划、销售扣减）Mise 都有，只缺排期这一层。

出处：[Introduction to Menu Planning](https://support.apicbase.com/help/introduction-to-menu-planning)、[Ordering and production from a menu plan](https://support.apicbase.com/help/ordering-and-production-planning-from-a-menu-plan)

---

## 6. Traceability（追溯）

- 靠**相互关联的批号**：每张标签有唯一批号，把供应商、到货日期、加工、去向串成一条链。
- 四步：**收货**（打印标签：品名、供应商、到货日、效期、批号）→ **备料**（扫原料批次，记录哪些批次进了哪个半成品）→ **生产**（打印成品标签，带着上游所有批次）→ **销售/发货**（扫成品标签，记录发到了哪家店）。
- 扫任一标签可以向前查（哪些成品用了它、去了哪）和向后查（它来自哪些供应商批次）。对应欧盟 EC 178/2002 的「上一步、下一步」要求。
- 硬件：标签打印机 + NiceLabel。

Mise：◐ 「批次追溯」页能输入批号做向上/向下追溯。但机制不同：Apicbase 靠人**扫码**确定用了哪一批；Mise 没有硬件，改成系统按**先到期先出 (FEFO)** 自动分配批次。所以 Mise 的追溯结果是「按规则推定的」，不是「实际扫到的」。✗ 标签打印。

出处：[Traceability overview](https://support.apicbase.com/help/traceability-overview)

---

## 7. Insights Hub（报表）

### 7.1 Management Figures（管理报表）—— 最值得细读的一篇

**库存变动**：Opening Value、Goods Received、Created In、Transfers In、Sold、Created Out、Transfers Out、Shipped Out、Wasted、Closing Value。
公式：`Closing = Opening + 所有变动列 + Net Variance`。

**差异**：Positive Variance（盘盈合计）、Negative Variance（盘亏合计，显示为正数）、Net = Positive − Negative。

**销售与毛利**：

```
Theoretical Cost   = Sold (销售按配方消耗的货值)
Theoretical Cost % = Theoretical Cost ÷ Net Sales
Actual Cost        = Theoretical Cost + Wasted − Net Variance
Actual Cost %      = Actual Cost ÷ Net Sales
GP %               = 100 − Cost %
```

文档里的例子：净营业额 33,000，理论成本 10,000，报损 400，净差异 −600 → 实际成本 11,000；理论成本率 30.3%，实际 33.3%。

Mise：✅ 「管理报表 → 毛利报告」完全按这组公式；`npm test` 里有逐门店、逐品项的恒等式校验。◐ 金额按**当前**单位成本折算（真实系统按当时成本）；期初/期末没有「实盘值 ✅ / 推算值 ⚠️」的区分。

出处：[Management Figures Dashboard](https://support.apicbase.com/help/the-management-figures-dashboard-guide)

### 7.2 其他报表

| 报表 | Apicbase | Mise |
| --- | --- | --- |
| Stock over a period / between two counts | 每个品项：期初、Ordered、Created In、Moved In、Sold、Uncontrolled Gain、Created Out、Moved Out、Shipped Out、Wasted、Uncontrolled Stock Count、期末；数量和金额各一张表 | ✅ 「期间库存」，同样的列。没有「两次盘点之间」这个选项 |
| Count Variance | 净差异、按门店/会计科目、随时间变化、负差异 Top 15、正差异 Top 15 | ◐ 每次盘点的差异金额 + 按品项排序 |
| CoGS Dashboard | 理论 CoGS（按 PLU）、实际 CoGS = 理论 + 报损 + 盘点差异、进货金额、POS 关联覆盖率 | ◐ 这些数字分散在销售看板和毛利报告里 |
| Sales Dashboard | 营业额（含/不含税）、折扣、Prime Cost、Profit、平均毛利率；每日趋势；Sales Mix Detail 表 | ✅ 「销售看板」。没有折扣、按类别/按门店的图 |
| Waste report | 按事件描述汇总 | ✅ |
| 采购报表、收货看板、库存快照、库存演变 | 有 | ✗ |
| 会计科目（Accounting category） | 很多报表按它分组 | ✗ |

出处：[Inventory reports](https://support.apicbase.com/help/how-to-make-inventory-reports)、[Count variance](https://support.apicbase.com/help/how-can-i-analyze-my-inventory-count-variance)、[CoGS Dashboard](https://support.apicbase.com/help/cogs-dashboard)、[Sales Dashboard](https://support.apicbase.com/help/the-sales-dashboard-guide)

---

## 8. Settings & Users（设置与用户）

**库设置的 10 个标签页**：General（货币、公制/英制、盲盘、订单邮件隐藏价格）、Costing Defaults（默认税率、默认损耗、目标毛利率、三种时薪）、营养与过敏原数据库、供应商对接、Apicbase Assistant、自定义字段、翻译、API、NiceLabel、认证（强制两步验证）。

Mise：◐ 「设置」页有 Costing Defaults 全部四项、盲盘、成本取价方式、审批限额、报损原因、工位。
✓ 用户与角色：管理员 / 管理人员；管理人员可限定门店，审批订单、修改主数据是单独的开关（服务端逐个请求检查）。
✓ 审计日志：每次成功的写操作和登录记一条（谁、何时、哪个接口、请求内容，密码除外）。
✗ SSO、两步验证、按库 (library) 隔离、自定义角色、自定义字段、多语言内容翻译。

出处：[Library settings](https://support.apicbase.com/help/library-settings)、[Settings & Users 目录](https://support.apicbase.com/help/settings-users)

---

## 9. 完全没做的模块

| 模块 | 是什么 |
| --- | --- |
| 条码枪 App | 手机扫码盘点、收货 |
| Media / APIC Studio | 菜品照片管理和拍摄 |
| AI / Apicbase Assistant | 数据问题提醒（比如卖了却没关联配方的商品）、发票识别 |
| API / MCP Server | 对外接口。开发者文档里有完整的端点分类，是了解它数据模型的另一个好入口 |
| ESG / 碳足迹 | 原料和配方的排放数据 |
| 各类对接 | POS（三十多种）、供应商（三十多家）、排班（Planday） |

出处：[帮助中心首页](https://support.apicbase.com/help)、[开发者文档](https://developers.apicbase.com/docs/welcome)

---

## 10. 接下来想继续做的话

按「对理解原理帮助大、且资料足够」排序：

1. **菜单排期**（5.3）—— 文档写得很清楚，下游都已具备。
2. **包装层级与按包装盘点**（1.1、3.1）—— 这是 Apicbase 和 Mise 在库存模型上最大的区别。
3. **会计科目** —— 加一个字段，很多报表就能按食品/酒水分组。
4. **按门店的售价和成本取价** —— 目前都是全局的。
5. ~~用户与权限~~ —— 已做（见第 8 节）。下一步可以把 HACCP 任务的负责人、盲盘也和账号关联起来。
