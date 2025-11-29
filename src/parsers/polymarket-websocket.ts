import { RealTimeDataClient } from '@polymarket/real-time-data-client';
import { ClobClient } from '@polymarket/clob-client';
import { TradingConfig } from '../config/trading-config';

interface OrderBookEntry {
  price: number;
  size: number;
  lastUpdate?: Date;  // Track when this level was last updated
}

interface OrderBook {
  bids: OrderBookEntry[];
  asks: OrderBookEntry[];
  marketId: string;
  timestamp: Date;
}

export interface PolymarketWebSocketUpdate {
  orderBooks: {
    outcome1?: OrderBook;
    outcome2?: OrderBook;
  };
  marketQuestion?: string;
  outcomes?: string[];
}

/**
 * Polymarket WebSocket Parser
 * Subscribes to real-time order book updates via Polymarket RTDS
 */
export class PolymarketWebSocketParser {
  private client: RealTimeDataClient | null = null;
  private onUpdate: (data: PolymarketWebSocketUpdate) => void;
  private subscribedTokenIds: string[] = [];
  private allMarketsTokenIds: string[] = []; // Track "all markets" tokens separately
  private orderBookState: Map<string, OrderBook> = new Map();
  private config: TradingConfig;

  constructor(
    onUpdate: (data: PolymarketWebSocketUpdate) => void,
    config: TradingConfig
  ) {
    this.onUpdate = onUpdate;
    this.config = config;

    // Note: Cleanup disabled - inactive markets don't send WebSocket updates
    // which caused mass deletion of valid orderbook data
  }

  /**
   * Connect to Polymarket RTDS WebSocket
   * Returns a Promise that resolves when connection is established
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.client) {
        console.log('⚠️  WebSocket already connected');
        resolve();
        return;
      }

      console.log('🔌 Connecting to Polymarket RTDS...');

      const clobAuth = {
        key: this.config.apiKey || '',
        secret: this.config.secret || '',
        passphrase: this.config.passphrase || ''
      };

      // Verify credentials
      if (!clobAuth.key || !clobAuth.secret || !clobAuth.passphrase) {
        reject(new Error('Missing CLOB API credentials (key, secret, passphrase)'));
        return;
      }

      const onMessage = (client: RealTimeDataClient, message: any): void => {
        this.handleMessage(message);
      };

      const onConnect = (client: RealTimeDataClient): void => {
        console.log('✅ Polymarket WebSocket connected');

        // Auto-subscribe to previously subscribed tokens if any
        if (this.subscribedTokenIds.length > 0) {
          this.subscribeToTokens(this.subscribedTokenIds);
        }

        resolve();  // Connection established!
      };

      const onStatusChange = (status: string): void => {
        if (status === 'DISCONNECTED') {
          console.log('⚠️  WebSocket disconnected, auto-reconnecting...');
        } else if (status === 'CONNECTING') {
          console.log('🔄 WebSocket reconnecting...');
        }
      };

      this.client = new RealTimeDataClient({ onMessage, onConnect, onStatusChange });
      this.client.connect();
    });
  }

  /**
   * Subscribe to order book updates for specific token IDs
   * Merges new token IDs with existing subscriptions
   */
  subscribe(tokenIds: string[]): void {
    if (!tokenIds || tokenIds.length === 0) {
      console.warn('⚠️  No token IDs provided for subscription');
      return;
    }

    // Merge new token IDs with existing ones (avoid duplicates)
    const existingIds = new Set(this.subscribedTokenIds);
    const newIds = tokenIds.filter(id => !existingIds.has(id));

    if (newIds.length === 0) {
      console.log('📝 All token IDs already subscribed, skipping');
      return;
    }

    console.log(`📝 Adding ${newIds.length} new token IDs to subscription`);
    this.subscribedTokenIds = [...this.subscribedTokenIds, ...newIds];
    console.log(`   Total subscribed tokens: ${this.subscribedTokenIds.length}`);

    // If client already connected, subscribe immediately
    if (this.client) {
      console.log('✅ WebSocket already connected, subscribing to new tokens...');
      this.subscribeToTokens(this.subscribedTokenIds); // Re-subscribe to ALL tokens
    } else {
      console.log('⏳ WebSocket not connected yet, will subscribe after connection');
    }
  }

  /**
   * Update subscriptions - adds new tokens and removes old ones
   * Used to remove finished matches from subscription
   */
  updateSubscriptions(newTokenIds: string[]): void {
    if (!newTokenIds || newTokenIds.length === 0) {
      console.warn('⚠️  No token IDs provided for subscription update');
      return;
    }

    const newSet = new Set(newTokenIds);
    const oldSet = new Set(this.subscribedTokenIds);

    // Find tokens to remove (in old but not in new)
    const toRemove = this.subscribedTokenIds.filter(id => !newSet.has(id));

    // Find tokens to add (in new but not in old)
    const toAdd = newTokenIds.filter(id => !oldSet.has(id));

    if (toRemove.length === 0 && toAdd.length === 0) {
      return; // No changes needed
    }

    if (toRemove.length > 0) {
      console.log(`🗑️  Removing ${toRemove.length} finished markets from subscription`);
      // Clean up orderbook state for removed tokens
      for (const tokenId of toRemove) {
        this.orderBookState.delete(tokenId);
      }
    }

    if (toAdd.length > 0) {
      console.log(`📝 Adding ${toAdd.length} new markets to subscription`);
    }

    // Update subscribed tokens list
    this.subscribedTokenIds = newTokenIds;
    console.log(`   Total subscribed tokens: ${this.subscribedTokenIds.length}`);

    // Re-subscribe with updated list
    if (this.client && this.subscribedTokenIds.length > 0) {
      this.subscribeToTokens(this.subscribedTokenIds);
    }
  }

  /**
   * Internal method to subscribe to tokens
   */
  private async subscribeToTokens(tokenIds: string[]): Promise<void> {
    if (!this.client) return;

    const clobAuth = {
      key: this.config.apiKey || '',
      secret: this.config.secret || '',
      passphrase: this.config.passphrase || ''
    };

    console.log(`📝 Subscribing to ${tokenIds.length} token IDs...`);

    // Split into chunks of 20 tokens to avoid "Invalid request body" error
    const chunkSize = 20;
    for (let i = 0; i < tokenIds.length; i += chunkSize) {
      const chunk = tokenIds.slice(i, i + chunkSize);
      const filterString = JSON.stringify(chunk);

      this.client.subscribe({
        subscriptions: [
          {
            topic: 'clob_market',
            type: 'price_change',
            filters: filterString,
            clob_auth: clobAuth
          }
        ]
      });
    }

    const numChunks = Math.ceil(tokenIds.length / chunkSize);
    console.log(`✅ Subscribed to ${tokenIds.length} tokens (${numChunks} chunk${numChunks > 1 ? 's' : ''})`);

    // Fetch initial orderbook via REST API for instant loading
    this.fetchInitialOrderBooks(tokenIds);
  }

  /**
   * Refresh order books via REST API (public method for manual refresh)
   * Clears old data and fetches fresh order books
   */
  async refreshOrderBooks(): Promise<void> {
    if (this.subscribedTokenIds.length === 0) {
      console.warn('⚠️  No tokens subscribed, cannot refresh');
      return;
    }

    console.log('🔄 Manual refresh requested, clearing old data and fetching fresh orderbooks...');

    // Clear old order book data
    this.orderBookState.clear();
    console.log('✓ Old order book data cleared');

    // Fetch fresh data from REST API
    await this.fetchInitialOrderBooks(this.subscribedTokenIds);
  }

  /**
   * Refresh specific market's order books via REST API
   * Only refreshes the provided tokenIds without clearing other markets
   */
  async refreshSpecificMarket(tokenIds: string[]): Promise<void> {
    if (tokenIds.length === 0) {
      console.warn('⚠️  No tokenIds provided, cannot refresh');
      return;
    }

    console.log(`🔄 Refreshing specific market with ${tokenIds.length} tokens...`);

    // Clear old data for these specific tokens only
    tokenIds.forEach(tokenId => {
      this.orderBookState.delete(tokenId);
    });
    console.log(`✓ Cleared data for ${tokenIds.length} tokens`);

    // Fetch fresh data from REST API for these tokens only
    await this.fetchInitialOrderBooks(tokenIds);
  }

  /**
   * Fetch initial order books via REST API for instant loading
   * Uses batch processing to respect 20 RPS rate limit
   */
  private async fetchInitialOrderBooks(tokenIds: string[]): Promise<void> {
    console.log('📥 Fetching initial order books via REST API...');

    const clobClient = new ClobClient('https://clob.polymarket.com', 137);
    const batchSize = 20;  // Match 20 RPS rate limit

    for (let i = 0; i < tokenIds.length; i += batchSize) {
      const batch = tokenIds.slice(i, i + batchSize);

      // Fetch batch in parallel
      await Promise.all(batch.map(async (tokenId) => {
        try {
          const orderBookData = await clobClient.getOrderBook(tokenId);

          if (orderBookData) {
            const now = new Date();
            const orderBook: OrderBook = {
              bids: orderBookData.bids?.map((b: any) => ({
                price: parseFloat(b.price),
                size: parseFloat(b.size),
                lastUpdate: now
              })) || [],
              asks: orderBookData.asks?.map((a: any) => ({
                price: parseFloat(a.price),
                size: parseFloat(a.size),
                lastUpdate: now
              })) || [],
              marketId: tokenId,
              timestamp: now
            };

            this.orderBookState.set(tokenId, orderBook);
          }
        } catch (error: any) {
          // Ignore 404 - market exists but no orders yet
          if (error?.response?.status !== 404) {
            console.error(`❌ Failed to fetch orderbook for ${tokenId.slice(0, 8)}...`);
          }
        }
      }));

      // Delay between batches to respect rate limit (except for last batch)
      if (i + batchSize < tokenIds.length) {
        console.log(`   Loaded ${Math.min(i + batchSize, tokenIds.length)}/${tokenIds.length} orderbooks...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    console.log(`📊 Loaded ${this.orderBookState.size} orderbooks`);

    // Emit initial updates for ALL token pairs
    // For moneyline: send tokens 0 and 1
    // For all markets: send each pair (0-1, 2-3, 4-5, etc.)
    for (let i = 0; i < tokenIds.length; i += 2) {
      const token1 = tokenIds[i];
      const token2 = tokenIds[i + 1];

      if (!token1) continue; // Skip if no token

      const update: PolymarketWebSocketUpdate = {
        orderBooks: {}
      };

      if (this.orderBookState.has(token1)) {
        update.orderBooks.outcome1 = this.orderBookState.get(token1);
      }

      if (token2 && this.orderBookState.has(token2)) {
        update.orderBooks.outcome2 = this.orderBookState.get(token2);
      }

      // Only send if we have at least one orderbook
      if (update.orderBooks.outcome1 || update.orderBooks.outcome2) {
        this.onUpdate(update);
      }
    }

    console.log('📤 Initial orderbooks sent to browser');

  }

  /**
   * Unsubscribe from order book updates
   */
  unsubscribe(): void {
    if (!this.client) return;

    console.log('🔕 Unsubscribing from order book updates...');

    // Clear subscribed tokens
    this.subscribedTokenIds = [];
    this.orderBookState.clear();
  }

  /**
   * Subscribe to "all markets" tokens (spread, total, etc.)
   * These are tracked separately so they can be unsubscribed independently
   */
  subscribeAllMarkets(tokenIds: string[]): void {
    if (!tokenIds || tokenIds.length === 0) {
      console.warn('⚠️  No token IDs provided for all markets subscription');
      return;
    }

    // Store all markets tokens separately
    this.allMarketsTokenIds = tokenIds;
    console.log(`📝 Subscribing to ${tokenIds.length} ALL MARKETS tokens...`);

    // Add to main subscription list (merge, avoid duplicates)
    const existingIds = new Set(this.subscribedTokenIds);
    const newIds = tokenIds.filter(id => !existingIds.has(id));

    if (newIds.length > 0) {
      console.log(`   Adding ${newIds.length} new tokens to subscription`);
      this.subscribedTokenIds = [...this.subscribedTokenIds, ...newIds];
    }

    // Subscribe via WebSocket
    if (this.client) {
      this.subscribeToTokens(this.subscribedTokenIds);
    }
  }

  /**
   * Unsubscribe from "all markets" tokens only
   * Keeps moneyline subscription active
   */
  unsubscribeAllMarkets(): void {
    if (this.allMarketsTokenIds.length === 0) {
      console.log('📝 No all markets tokens to unsubscribe from');
      return;
    }

    console.log(`🔕 Unsubscribing from ${this.allMarketsTokenIds.length} ALL MARKETS tokens...`);

    // Remove all markets tokens from main subscription list
    const allMarketsSet = new Set(this.allMarketsTokenIds);
    this.subscribedTokenIds = this.subscribedTokenIds.filter(id => !allMarketsSet.has(id));

    // Clear all markets token IDs from order book state
    for (const tokenId of this.allMarketsTokenIds) {
      this.orderBookState.delete(tokenId);
    }

    // Clear all markets tracking
    this.allMarketsTokenIds = [];

    // Re-subscribe with remaining tokens (moneyline only)
    if (this.client && this.subscribedTokenIds.length > 0) {
      console.log(`📝 Re-subscribing to ${this.subscribedTokenIds.length} remaining tokens (moneyline)`);
      this.subscribeToTokens(this.subscribedTokenIds);
    } else if (this.subscribedTokenIds.length === 0) {
      console.log('✓ No remaining tokens, unsubscribed from all');
    }
  }

  /**
   * Disconnect from WebSocket
   */
  disconnect(): void {
    if (!this.client) return;

    console.log('🔌 Disconnecting from Polymarket WebSocket...');

    this.client.disconnect();
    this.client = null;
    this.subscribedTokenIds = [];
    this.orderBookState.clear();

    console.log('✅ Disconnected');
  }

  /**
   * Handle incoming WebSocket message
   */
  private handleMessage(message: any): void {
    // Handle market data only
    if (message.topic === 'clob_market') {
      const payload = message.payload;
      if (!payload) {
        return;
      }

      if (message.type === 'agg_orderbook') {
        this.handleAggOrderbook(payload);
      } else if (message.type === 'price_change') {
        this.handlePriceChange(payload);
      }
    }
  }

  /**
   * Handle price change update (price_change)
   * Structure: { m: "market", pc: [{a, p, s, si, ba, bb}], t: "timestamp" }
   */
  private handlePriceChange(payload: any): void {
    const priceChanges = payload.pc;  // Array of price changes
    if (!priceChanges || !Array.isArray(priceChanges)) {
      return;
    }

    // Process each price change
    for (const change of priceChanges) {
      const assetId = change.a;  // asset_id
      if (!assetId) continue;

      const price = parseFloat(change.p);   // price
      const size = parseFloat(change.s);    // size (NOT si!)
      const side = change.si;               // side: BUY or SELL (NOT s!)

      // Get existing orderbook or create new one
      let orderBook = this.orderBookState.get(assetId);
      if (!orderBook) {
        orderBook = {
          bids: [],
          asks: [],
          marketId: assetId,
          timestamp: new Date()
        };
      }

      const now = new Date();

      if (side === 'BUY') {
        // Update bids
        const existingIndex = orderBook.bids.findIndex(b => b.price === price);
        if (size > 0) {
          if (existingIndex >= 0) {
            orderBook.bids[existingIndex].size = size;
            orderBook.bids[existingIndex].lastUpdate = now;
          } else {
            orderBook.bids.push({ price, size, lastUpdate: now });
          }
          // Always sort and limit to prevent unbounded growth
          orderBook.bids.sort((a, b) => b.price - a.price);
          orderBook.bids = orderBook.bids.slice(0, 50);
        } else if (existingIndex >= 0) {
          orderBook.bids.splice(existingIndex, 1);
        }
        // Silently ignore remove for non-existent level (normal during reconnects)
      } else if (side === 'SELL') {
        // Update asks
        const existingIndex = orderBook.asks.findIndex(a => a.price === price);
        if (size > 0) {
          if (existingIndex >= 0) {
            orderBook.asks[existingIndex].size = size;
            orderBook.asks[existingIndex].lastUpdate = now;
          } else {
            orderBook.asks.push({ price, size, lastUpdate: now });
          }
          // Always sort and limit to prevent unbounded growth
          orderBook.asks.sort((a, b) => a.price - b.price);
          orderBook.asks = orderBook.asks.slice(0, 50);
        } else if (existingIndex >= 0) {
          orderBook.asks.splice(existingIndex, 1);
        }
        // Silently ignore remove for non-existent level (normal during reconnects)
      }

      orderBook.timestamp = new Date();
      this.orderBookState.set(assetId, orderBook);

      // Emit update for this asset
      this.emitUpdate(assetId);
    }
  }

  /**
   * Handle aggregated orderbook update (agg_orderbook)
   * Full orderbook snapshots - replace entire orderbook
   * Structure: { asset_id: "token123", bids: [{price, size}], asks: [{price, size}] }
   */
  private handleAggOrderbook(payload: any): void {
    const assetId = payload.asset_id;

    if (!assetId) {
      console.warn('⚠️  Missing asset_id in agg_orderbook payload');
      return;
    }

    const now = new Date();

    // Convert full orderbook snapshot to our format
    const orderBook: OrderBook = {
      bids: (payload.bids || []).map((b: any) => ({
        price: parseFloat(b.price),
        size: parseFloat(b.size),
        lastUpdate: now
      })),
      asks: (payload.asks || []).map((a: any) => ({
        price: parseFloat(a.price),
        size: parseFloat(a.size),
        lastUpdate: now
      })),
      marketId: assetId,
      timestamp: now
    };

    // Replace entire orderbook with snapshot (no incremental logic needed)
    this.orderBookState.set(assetId, orderBook);

    // Emit update for this asset
    this.emitUpdate(assetId);
  }

  /**
   * Emit update for specific asset
   */
  private emitUpdate(assetId: string): void {
    // Determine which outcome this token belongs to
    const tokenIndex = this.subscribedTokenIds.indexOf(assetId);

    if (tokenIndex === -1) {
      // Not subscribed to this token
      return;
    }

    // Build update with current state for both outcomes
    const update: PolymarketWebSocketUpdate = {
      orderBooks: {}
    };

    // Outcome 1 (first token ID)
    if (tokenIndex === 0 || this.orderBookState.has(this.subscribedTokenIds[0])) {
      const ob1 = this.orderBookState.get(this.subscribedTokenIds[0]);
      if (ob1) {
        update.orderBooks.outcome1 = this.cleanupOrderBook(ob1);
      }
    }

    // Outcome 2 (second token ID)
    if (tokenIndex === 1 || this.orderBookState.has(this.subscribedTokenIds[1])) {
      const ob2 = this.orderBookState.get(this.subscribedTokenIds[1]);
      if (ob2) {
        update.orderBooks.outcome2 = this.cleanupOrderBook(ob2);
      }
    }

    // Emit update
    this.onUpdate(update);
  }

  /**
   * Fallback cleanup - filter out any levels with size === 0
   * Protects against missed delete updates
   */
  private cleanupOrderBook(orderBook: OrderBook): OrderBook {
    const cleaned = {
      ...orderBook,
      bids: orderBook.bids.filter(b => b.size > 0),
      asks: orderBook.asks.filter(a => a.size > 0)
    };

    // Log if we found and removed dead levels
    const removedBids = orderBook.bids.length - cleaned.bids.length;
    const removedAsks = orderBook.asks.length - cleaned.asks.length;
    if (removedBids > 0 || removedAsks > 0) {
      console.log(`🧹 Cleaned up ${removedBids} dead bids, ${removedAsks} dead asks (${orderBook.marketId.slice(0, 8)}...)`);
    }

    return cleaned;
  }

  /**
   * Periodic cleanup of stale order book levels
   * Removes levels that haven't been updated in >5 minutes
   */
  private cleanupStaleOrders(): void {
    const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
    let totalRemoved = 0;

    for (const [assetId, orderBook] of this.orderBookState.entries()) {
      const initialBidsCount = orderBook.bids.length;
      const initialAsksCount = orderBook.asks.length;

      // Filter out stale bids
      orderBook.bids = orderBook.bids.filter(bid => {
        if (!bid.lastUpdate) return true; // Keep if no timestamp (shouldn't happen)
        return bid.lastUpdate.getTime() > fiveMinutesAgo;
      });

      // Filter out stale asks
      orderBook.asks = orderBook.asks.filter(ask => {
        if (!ask.lastUpdate) return true; // Keep if no timestamp (shouldn't happen)
        return ask.lastUpdate.getTime() > fiveMinutesAgo;
      });

      const removedBids = initialBidsCount - orderBook.bids.length;
      const removedAsks = initialAsksCount - orderBook.asks.length;
      totalRemoved += removedBids + removedAsks;

      if (removedBids > 0 || removedAsks > 0) {
        console.log(`🕒 Removed ${removedBids} stale bids, ${removedAsks} stale asks (${assetId.slice(0, 8)}... - not updated in 5+ min)`);

        // Update the state
        this.orderBookState.set(assetId, orderBook);
      }
    }

    if (totalRemoved > 0) {
      console.log(`🧹 Total stale levels removed: ${totalRemoved}`);
    }
  }

  /**
   * Get current state of order books
   */
  getOrderBooks(): Map<string, OrderBook> {
    return new Map(this.orderBookState);
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.client !== null;
  }
}
