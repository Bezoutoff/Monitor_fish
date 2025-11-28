/**
 * Trading types for Polymarket orders
 */

import { OrderType } from '@polymarket/clob-client';

export { OrderType };  // Re-export OrderType from clob-client
export type OrderSide = 'BUY' | 'SELL';
export type TickSize = '0.1' | '0.01' | '0.001' | '0.0001';

export interface CreateOrderRequest {
  tokenId: string;        // Token ID из Polymarket
  side: OrderSide;        // BUY или SELL
  price: number;          // Цена (0-1)
  size: number;           // Количество контрактов
  outcome: string;        // Название исхода (например, "Houston Rockets")

  // Дополнительные параметры
  orderType?: string | OrderType;  // Тип ордера: GTC/GTD (limit orders), FOK/FAK (market orders)
  tickSize?: TickSize;             // Шаг цены (по умолчанию: 0.01)
  negRisk?: boolean;               // Для взаимоисключающих исходов
  expiration?: number;             // Количество минут (только для GTD)

  // Авто-отмена ордеров
  isAutoOrder?: boolean;           // Флаг авто-ордера (отменится через N секунд)
  autoCancelSeconds?: number;      // Через сколько секунд отменить (для авто-ордеров)

  // Тайминг
  bwinParseTimestamp?: number;     // Timestamp парсинга Bwin для измерения латенси
}

export interface Order {
  orderId: string;
  tokenId: string;
  side: OrderSide;
  price: number;
  size: number;
  filledSize: number;
  outcome: string;
  status: 'PENDING' | 'OPEN' | 'MATCHED' | 'CANCELLED' | 'FAILED';
  timestamp: Date;
  orderType?: 'GTC' | 'GTD' | 'FOK' | 'FAK';  // Тип ордера
  expirationTime?: Date;  // Время экспирации для GTD
  market?: string;        // Condition ID или market identifier (для отображения)
  marketQuestion?: string; // Название рынка (например, "Rockets vs Bucks")
}

export interface CancelOrderRequest {
  orderId: string;
}

export interface CancelAllOrdersRequest {
  marketId?: string;      // Опционально - только для конкретного маркета
}

export interface OrderUpdate {
  orderId: string;
  status: Order['status'];
  filledSize?: number;
  message?: string;
}

/**
 * User order update from Polymarket RTDS (clob_user topic)
 */
export interface UserOrderUpdate {
  orderId: string;           // Order hash identifier
  status: string;            // RTDS status (OPEN, MATCHED, CANCELLED, etc.)
  side: string;              // BUY or SELL
  price: string;             // Decimal price string
  originalSize: string;      // Original order size
  sizeMatched: string;       // Amount matched so far
  outcome?: string;          // YES or NO
  market: string;            // Condition ID
  assetId: string;           // ERC1155 token ID
  createdAt: string;         // UNIX timestamp string
  expiration?: string;       // UNIX timestamp string (for GTD orders)
  orderType?: string;        // GTC, GTD, FOK, FAK
  makerAddress: string;      // Funder's wallet address
}

/**
 * Trade execution update from Polymarket RTDS (clob_user topic)
 */
export interface UserTradeUpdate {
  id: string;                // Unique trade identifier
  orderId?: string;          // Order ID from maker_orders array
  market: string;            // Condition ID
  assetId: string;           // ERC1155 token ID
  price: string;             // Execution price
  size: string;              // Matched size
  side: string;              // BUY or SELL
  transactionHash?: string;  // Blockchain transaction hash
  matchTime: string;         // UNIX timestamp string
  status: string;            // MINED, PENDING, etc.
  feeRateBps?: string;       // Fee rate in basis points
}
