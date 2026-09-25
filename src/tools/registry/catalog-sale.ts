/**
 * Инструменты группы: Каталог, цены, склады и остатки, заказы магазина (ТЗ §9.6).
 */
import type { ToolDefinition } from '../types.js';
import { catalogPriceSetTool } from '../catalog/price-set.js';
import { catalogProductCreateTool, catalogProductUpdateTool } from '../catalog/product-write.js';
import {
  catalogListTool,
  catalogProductsListTool,
  warehouseListTool,
  warehouseStockListTool,
} from '../catalog/read.js';
import { storeOrderGetTool, storeOrdersListTool } from '../orders/orders.js';

export const catalogSaleTools: readonly ToolDefinition[] = [
  catalogListTool,
  catalogProductsListTool,
  catalogProductCreateTool,
  catalogProductUpdateTool,
  catalogPriceSetTool,
  warehouseListTool,
  warehouseStockListTool,
  storeOrderGetTool,
  storeOrdersListTool,
];
