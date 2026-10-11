// 业务引擎入口。所有"原理"都在 engine/ 目录里，按模块分文件：
//   core.js         设置、单位换算、配方成本、配方展开
//   stock.js        库存台账、批次 (FEFO)、报损、调拨、盘点、追溯
//   procurement.js  订货建议 (par / 预测)、订单与审批、收货、发票核对、内部订货、BoM
//   production.js   生产计划、任务看板、完成入库
//   haccp.js        关键控制点、周期任务、执行记录
//   sales.js        POS 关联、销售扣库存、菜单、销售看板、菜单工程
//   reports.js      期间库存、管理报表、盘点差异、报损报表
export * from './engine/core.js';
export * from './engine/stock.js';
export * from './engine/procurement.js';
export * from './engine/production.js';
export * from './engine/haccp.js';
export * from './engine/sales.js';
export * from './engine/reports.js';
