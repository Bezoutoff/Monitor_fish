/**
 * Order Tracker
 *
 * Tracks lifetime of large orders that meet filter criteria
 * Alerts when orders remain active for configured duration
 */

import { TrackedOrder, MonitorConfig, OrderAlert } from './types';

export class OrderTracker {
    private trackedOrders: Map<string, TrackedOrder> = new Map();
    private config: MonitorConfig;
    private tokenMap: Map<string, { slug: string; outcome: string }>;
    private onAlert: (alert: OrderAlert) => void;

    constructor(
        config: MonitorConfig,
        tokenMap: Map<string, { slug: string; outcome: string }>,
        onAlert: (alert: OrderAlert) => void
    ) {
        this.config = config;
        this.tokenMap = tokenMap;
        this.onAlert = onAlert;
    }

    /**
     * Process an order book level update
     */
    processOrderLevel(
        tokenId: string,
        price: number,
        size: number,
        side: 'BUY' | 'SELL'
    ): void {
        // Generate unique order ID
        const orderId = this.generateOrderId(tokenId, price, side);

        // Check if order meets filter criteria
        if (!this.meetsFilters(price, size)) {
            // If order exists but no longer meets filters, remove it
            if (this.trackedOrders.has(orderId)) {
                this.trackedOrders.delete(orderId);
            }
            return;
        }

        // Get match info from token map
        const matchInfo = this.tokenMap.get(tokenId);
        if (!matchInfo) {
            // Token not in our tracked matches
            return;
        }

        const now = new Date();

        // Check if order already exists
        if (this.trackedOrders.has(orderId)) {
            // Update existing order
            const order = this.trackedOrders.get(orderId)!;
            order.size = size;
            order.lastSeen = now;
        } else {
            // Add new order
            const order: TrackedOrder = {
                orderId,
                tokenId,
                matchSlug: matchInfo.slug,
                marketOutcome: matchInfo.outcome,
                price,
                size,
                side,
                firstSeen: now,
                lastSeen: now,
                alerted: false
            };

            this.trackedOrders.set(orderId, order);
            console.log(`   📥 Tracking new order: ${matchInfo.slug} | ${matchInfo.outcome} | ${side} ${size.toLocaleString()} @ $${price.toFixed(2)}`);
        }
    }

    /**
     * Check all tracked orders for age and trigger alerts
     */
    checkOrderAges(): void {
        const now = new Date();
        const alertThreshold = this.config.alertAgeSeconds * 1000; // Convert to ms

        for (const [orderId, order] of this.trackedOrders.entries()) {
            // Skip if already alerted
            if (order.alerted) {
                continue;
            }

            // Calculate age
            const ageMs = now.getTime() - order.firstSeen.getTime();
            const ageSeconds = Math.floor(ageMs / 1000);

            // Check if order is old enough
            if (ageMs >= alertThreshold) {
                // Double-check size still meets criteria
                if (order.size >= this.config.minSize) {
                    // Trigger alert
                    const alert: OrderAlert = {
                        timestamp: now.toISOString(),
                        match: order.matchSlug,
                        market: order.marketOutcome,
                        tokenId: order.tokenId,
                        orderId: order.orderId,
                        price: order.price,
                        size: order.size,
                        side: order.side,
                        ageSeconds
                    };

                    this.onAlert(alert);

                    // Mark as alerted
                    order.alerted = true;
                }
            }
        }
    }

    /**
     * Remove order from tracking (when size becomes 0)
     */
    removeOrder(tokenId: string, price: number, side: 'BUY' | 'SELL'): void {
        const orderId = this.generateOrderId(tokenId, price, side);
        if (this.trackedOrders.has(orderId)) {
            const order = this.trackedOrders.get(orderId)!;
            console.log(`   📤 Order removed: ${order.matchSlug} | ${order.marketOutcome} | ${side} @ $${price.toFixed(2)}`);
            this.trackedOrders.delete(orderId);
        }
    }

    /**
     * Update token map when new matches are found
     */
    updateTokenMap(tokenMap: Map<string, { slug: string; outcome: string }>): void {
        this.tokenMap = tokenMap;
    }

    /**
     * Get statistics
     */
    getStats(): { total: number; alerted: number } {
        let alerted = 0;
        for (const order of this.trackedOrders.values()) {
            if (order.alerted) {
                alerted++;
            }
        }

        return {
            total: this.trackedOrders.size,
            alerted
        };
    }

    /**
     * Clean up orders from completed matches
     */
    cleanup(activeTokenIds: Set<string>): void {
        const toRemove: string[] = [];

        for (const [orderId, order] of this.trackedOrders.entries()) {
            if (!activeTokenIds.has(order.tokenId)) {
                toRemove.push(orderId);
            }
        }

        if (toRemove.length > 0) {
            console.log(`   🧹 Cleaning up ${toRemove.length} orders from completed matches`);
            for (const orderId of toRemove) {
                this.trackedOrders.delete(orderId);
            }
        }
    }

    /**
     * Generate unique order ID from token, price, and side
     */
    private generateOrderId(tokenId: string, price: number, side: 'BUY' | 'SELL'): string {
        return `${tokenId}_${price.toFixed(2)}_${side}`;
    }

    /**
     * Check if order meets filter criteria
     */
    private meetsFilters(price: number, size: number): boolean {
        return (
            size >= this.config.minSize &&
            price >= this.config.minPrice &&
            price <= this.config.maxPrice
        );
    }
}
