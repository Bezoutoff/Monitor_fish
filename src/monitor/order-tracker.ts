/**
 * Order Tracker
 *
 * Tracks NEW large orders by detecting significant size increases (delta ≥ minSize)
 * on price levels. Alerts when the increased size remains for configured duration.
 *
 * Key insight: Aggregated orderbook shows total size at each price level.
 * We detect new large orders by monitoring SIZE CHANGES, not absolute values.
 */

import { TrackedOrder, MonitorConfig, OrderAlert } from './types';

interface PriceLevel {
    tokenId: string;
    price: number;
    side: 'BUY' | 'SELL';
    previousSize: number;      // Last known aggregated size
    trackedDelta: number;      // Delta being tracked (≥ minSize)
    deltaFirstSeen: Date | null;  // When delta first appeared
    alerted: boolean;          // Whether alert was sent for this delta
}

export class OrderTracker {
    private priceLevels: Map<string, PriceLevel> = new Map();
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
     * Detects significant size INCREASES as new large orders
     */
    processOrderLevel(
        tokenId: string,
        price: number,
        newSize: number,
        side: 'BUY' | 'SELL'
    ): void {
        // Check price range filter
        if (price < this.config.minPrice || price > this.config.maxPrice) {
            return;
        }

        // Get match info from token map
        const matchInfo = this.tokenMap.get(tokenId);
        if (!matchInfo) {
            return;  // Token not in our tracked matches
        }

        const levelId = this.generateLevelId(tokenId, price, side);
        const now = new Date();

        let level = this.priceLevels.get(levelId);

        if (!level) {
            // First observation - record as baseline, no tracking yet
            level = {
                tokenId,
                price,
                side,
                previousSize: newSize,
                trackedDelta: 0,
                deltaFirstSeen: null,
                alerted: false
            };
            this.priceLevels.set(levelId, level);
            return;  // Don't trigger on initial load
        }

        // Calculate size change
        const delta = newSize - level.previousSize;

        if (delta >= this.config.minSize) {
            // Significant increase detected - new large order!
            if (level.trackedDelta === 0) {
                // Start tracking this new delta
                level.trackedDelta = delta;
                level.deltaFirstSeen = now;
                level.alerted = false;

                console.log(`   📈 NEW LARGE ORDER: ${matchInfo.slug} | ${matchInfo.outcome} | ${side} +${delta.toLocaleString()} @ $${price.toFixed(2)}`);
            } else {
                // Update existing tracked delta
                level.trackedDelta += delta;
            }
        } else if (delta < -this.config.minSize / 2) {
            // Significant decrease - order likely removed
            if (level.trackedDelta > 0 && !level.alerted) {
                console.log(`   📉 Order removed before alert: ${matchInfo.slug} | ${side} @ $${price.toFixed(2)}`);
            }
            level.trackedDelta = 0;
            level.deltaFirstSeen = null;
            level.alerted = false;
        }

        // Update baseline
        level.previousSize = newSize;
    }

    /**
     * Check all tracked levels for age and trigger alerts
     */
    checkOrderAges(): void {
        const now = new Date();
        const alertThreshold = this.config.alertAgeSeconds * 1000;

        for (const [levelId, level] of this.priceLevels.entries()) {
            // Skip if no active tracking or already alerted
            if (level.trackedDelta === 0 || level.alerted || !level.deltaFirstSeen) {
                continue;
            }

            // Calculate age of the delta
            const ageMs = now.getTime() - level.deltaFirstSeen.getTime();
            const ageSeconds = Math.floor(ageMs / 1000);

            // Check if delta is old enough
            if (ageMs >= alertThreshold) {
                const matchInfo = this.tokenMap.get(level.tokenId);
                if (!matchInfo) continue;

                // Trigger alert
                const alert: OrderAlert = {
                    timestamp: now.toISOString(),
                    match: matchInfo.slug,
                    market: matchInfo.outcome,
                    tokenId: level.tokenId,
                    orderId: levelId,
                    price: level.price,
                    size: level.trackedDelta,  // Report the delta, not total
                    side: level.side,
                    ageSeconds
                };

                this.onAlert(alert);

                // Mark as alerted
                level.alerted = true;
            }
        }
    }

    /**
     * Remove order from tracking (when size becomes 0)
     */
    removeOrder(tokenId: string, price: number, side: 'BUY' | 'SELL'): void {
        const levelId = this.generateLevelId(tokenId, price, side);
        const level = this.priceLevels.get(levelId);

        if (level) {
            // Size dropped to 0 - clear tracking
            if (level.trackedDelta > 0 && !level.alerted) {
                const matchInfo = this.tokenMap.get(tokenId);
                if (matchInfo) {
                    console.log(`   📤 Order cleared: ${matchInfo.slug} | ${side} @ $${price.toFixed(2)}`);
                }
            }
            level.previousSize = 0;
            level.trackedDelta = 0;
            level.deltaFirstSeen = null;
            level.alerted = false;
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
        let tracking = 0;
        let alerted = 0;

        for (const level of this.priceLevels.values()) {
            if (level.trackedDelta > 0) {
                tracking++;
                if (level.alerted) {
                    alerted++;
                }
            }
        }

        return {
            total: tracking,
            alerted
        };
    }

    /**
     * Clean up levels from completed matches
     */
    cleanup(activeTokenIds: Set<string>): void {
        const toRemove: string[] = [];

        for (const [levelId, level] of this.priceLevels.entries()) {
            if (!activeTokenIds.has(level.tokenId)) {
                toRemove.push(levelId);
            }
        }

        if (toRemove.length > 0) {
            console.log(`   🧹 Cleaning up ${toRemove.length} levels from completed matches`);
            for (const levelId of toRemove) {
                this.priceLevels.delete(levelId);
            }
        }
    }

    /**
     * Generate unique level ID
     */
    private generateLevelId(tokenId: string, price: number, side: 'BUY' | 'SELL'): string {
        return `${tokenId}_${price.toFixed(2)}_${side}`;
    }
}
