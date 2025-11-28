/**
 * Order Monitor
 *
 * Main entry point for monitoring large long-lived orders on live sports matches
 *
 * Features:
 * - Discovers live sports matches automatically (all sports)
 * - Subscribes to real-time order book updates
 * - Tracks orders meeting filter criteria (size ≥ 10k, price 0.05-0.95)
 * - Alerts when orders remain active for 2+ minutes
 * - Logs alerts to JSON files
 *
 * Usage: npm run monitor
 */

import dotenv from 'dotenv';
import { ClobClient } from '@polymarket/clob-client';
import { PolymarketWebSocketParser } from '../parsers/polymarket-websocket';
import { LiveMatchFinder } from './live-match-finder';
import { OrderTracker } from './order-tracker';
import { AlertManager } from './alert-manager';
import { MonitorConfig } from './types';
import { TradingConfig } from '../config/trading-config';

// Load environment variables
dotenv.config();

export class OrderMonitor {
    private config: MonitorConfig;
    private matchFinder: LiveMatchFinder;
    private orderTracker: OrderTracker | null = null;
    private alertManager: AlertManager;
    private wsParser: PolymarketWebSocketParser | null = null;
    private matchCheckInterval: NodeJS.Timeout | null = null;
    private ageCheckInterval: NodeJS.Timeout | null = null;
    private tokenMap: Map<string, { slug: string; outcome: string }> = new Map();

    constructor() {
        // Load configuration from environment
        this.config = {
            minSize: parseInt(process.env.MONITOR_MIN_SIZE || '10000'),
            minPrice: parseFloat(process.env.MONITOR_MIN_PRICE || '0.05'),
            maxPrice: parseFloat(process.env.MONITOR_MAX_PRICE || '0.95'),
            alertAgeSeconds: parseInt(process.env.MONITOR_ALERT_AGE_SECONDS || '120'),
            matchCheckInterval: parseInt(process.env.MONITOR_MATCH_CHECK_INTERVAL || '300000'),
            deltaTolerance: parseFloat(process.env.MONITOR_DELTA_TOLERANCE || '0.10'),
            minImpactPercent: parseFloat(process.env.MONITOR_MIN_IMPACT || '0.60')
        };

        this.matchFinder = new LiveMatchFinder();
        this.alertManager = new AlertManager();

        console.log('');
        console.log('🐋 ═══════════════════════════════════════════════════════════');
        console.log('🐋  WHALE ALERT MONITOR - Мониторинг крупных ордеров');
        console.log('🐋 ═══════════════════════════════════════════════════════════');
        console.log('');
        console.log('⚙️  Конфигурация:');
        console.log(`   📦 Мин. размер: ${this.config.minSize.toLocaleString()} shares`);
        console.log(`   💵 Диапазон цен: ${(this.config.minPrice * 100).toFixed(0)}¢ - ${(this.config.maxPrice * 100).toFixed(0)}¢`);
        console.log(`   ⏱️  Время алерта: ${this.config.alertAgeSeconds} сек (${(this.config.alertAgeSeconds / 60).toFixed(1)} мин)`);
        console.log(`   📉 Толерантность: ${(this.config.deltaTolerance * 100).toFixed(0)}% (допустимое уменьшение)`);
        console.log(`   📈 Мин. импакт: ${(this.config.minImpactPercent * 100).toFixed(0)}% (рост от предыдущего)`);
        console.log(`   🔄 Проверка матчей: каждые ${(this.config.matchCheckInterval / 1000 / 60).toFixed(1)} мин`);
        console.log(`   🎯 Только BUY ордера`);
        console.log('');
    }

    /**
     * Start monitoring
     */
    async start(): Promise<void> {
        try {
            console.log('🚀 Starting Order Monitor...\n');

            // Initialize order tracker
            this.orderTracker = new OrderTracker(
                this.config,
                this.tokenMap,
                (alert) => this.alertManager.handleAlert(alert)
            );

            // Find initial matches and subscribe
            await this.updateMatches();

            // Start periodic match checking
            this.matchCheckInterval = setInterval(() => {
                this.updateMatches().catch(error => {
                    console.error('❌ Error updating matches:', error);
                });
            }, this.config.matchCheckInterval);

            // Start periodic age checking (every second)
            this.ageCheckInterval = setInterval(() => {
                if (this.orderTracker) {
                    this.orderTracker.checkOrderAges();
                }
            }, 1000);

            // Print status every 30 seconds
            setInterval(() => {
                this.printStatus();
            }, 30000);

            console.log('✅ Order Monitor running! Press Ctrl+C to stop.\n');

        } catch (error) {
            console.error('❌ Fatal error starting monitor:', error);
            process.exit(1);
        }
    }

    /**
     * Update matches and WebSocket subscriptions
     */
    private async updateMatches(): Promise<void> {
        try {
            // Find live matches
            const matches = await this.matchFinder.findLiveMatches();

            if (matches.length === 0) {
                console.log('⚠️  No live NBA/NHL matches found. Will check again in 5 minutes...\n');
                return;
            }

            // Extract token IDs
            const tokenIds = this.matchFinder.extractTokenIds(matches);
            const tokenMap = this.matchFinder.createTokenMap(matches);

            // Update token map in order tracker
            if (this.orderTracker) {
                this.orderTracker.updateTokenMap(tokenMap);
                this.tokenMap = tokenMap;
            }

            // Connect or update WebSocket
            if (!this.wsParser) {
                await this.connectWebSocket(tokenIds);
            } else {
                // Update subscriptions
                await this.wsParser.subscribe(tokenIds);
            }

            // Group matches by base slug (without spread/total/1h suffixes)
            const baseMatchMap = new Map<string, number>();
            for (const match of matches) {
                // Extract base slug: nba-mia-dal-2025-12-03 from nba-mia-dal-2025-12-03-spread-home-5pt5
                const baseSlug = match.slug.replace(/-(spread|total|1h|2h|moneyline).*$/, '');
                const currentCount = baseMatchMap.get(baseSlug) || 0;
                baseMatchMap.set(baseSlug, currentCount + match.markets.length);
            }

            // Show subscribed matches (grouped)
            console.log(`\n📋 Subscribed to ${baseMatchMap.size} matches:`);
            for (const [baseSlug, marketCount] of baseMatchMap) {
                console.log(`   ${baseSlug} (${marketCount} markets)`);
            }

            // Cleanup orders from completed matches
            if (this.orderTracker) {
                this.orderTracker.cleanup(new Set(tokenIds));
            }

        } catch (error) {
            console.error('❌ Error in updateMatches:', error);
        }
    }

    /**
     * Connect to Polymarket WebSocket
     */
    private async connectWebSocket(tokenIds: string[]): Promise<void> {
        console.log('🔌 Connecting to Polymarket WebSocket...\n');

        // Create trading config for WebSocket
        const tradingConfig: TradingConfig = {
            privateKey: process.env.PK ? `0x${process.env.PK}` : '',
            apiKey: process.env.CLOB_API_KEY,
            secret: process.env.CLOB_SECRET,
            passphrase: process.env.CLOB_PASS_PHRASE,
            funder: process.env.FUNDER,
            chainId: parseInt(process.env.CHAIN_ID || '137'),
            clobApiUrl: process.env.CLOB_API_URL || 'https://clob.polymarket.com',
            signatureType: parseInt(process.env.SIGNATURE_TYPE || '2')
        };

        // Create WebSocket parser
        this.wsParser = new PolymarketWebSocketParser(
            (update) => this.handleWebSocketUpdate(update),
            tradingConfig
        );

        // First store token IDs (before connect)
        this.wsParser.subscribe(tokenIds);

        // Connect - onConnect callback will trigger actual subscription
        await this.wsParser.connect();

        console.log('✅ WebSocket connected and subscribed\n');
    }

    /**
     * Handle WebSocket updates
     */
    private handleWebSocketUpdate(update: any): void {
        // Only process order book updates
        if (update.orderBooks) {
            // Iterate through both outcomes
            for (const [outcomeKey, orderBook] of Object.entries(update.orderBooks)) {
                const book = orderBook as any;
                const tokenId = book.marketId;  // tokenId is in orderBook, not in bid/ask

                if (!tokenId) continue;

                // Process only BID orders (BUY side)
                // NOTE: We ignore ASK/SELL orders because in binary markets,
                // BUY on outcome A = SELL on outcome B (same trade, different representation)
                // This prevents duplicate alerts for the same underlying trade
                for (const bid of (book.bids || [])) {
                    if (bid.size > 0) {
                        this.orderTracker?.processOrderLevel(tokenId, bid.price, bid.size, 'BUY');
                    } else {
                        this.orderTracker?.removeOrder(tokenId, bid.price, 'BUY');
                    }
                }
            }
        }
    }

    /**
     * Print status to console
     */
    private async printStatus(): Promise<void> {
        const stats = this.orderTracker?.getStats() || { total: 0, alerted: 0 };
        const alertStats = await this.alertManager.getStats();

        console.log('─'.repeat(60));
        console.log(`📊 Status | Tracked: ${stats.total} orders | Alerted: ${stats.alerted} | Today: ${alertStats.todayAlerts} | Total: ${alertStats.totalAlerts}`);
        console.log('─'.repeat(60));
    }

    /**
     * Stop monitoring
     */
    stop(): void {
        console.log('\n🛑 Stopping Order Monitor...');

        if (this.matchCheckInterval) {
            clearInterval(this.matchCheckInterval);
        }

        if (this.ageCheckInterval) {
            clearInterval(this.ageCheckInterval);
        }

        if (this.wsParser) {
            this.wsParser.disconnect();
        }

        console.log('✅ Order Monitor stopped.\n');
    }
}

// Main execution
async function main() {
    const monitor = new OrderMonitor();

    // Handle graceful shutdown
    process.on('SIGINT', () => {
        console.log('\n\n⚠️  Received SIGINT signal...');
        monitor.stop();
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        console.log('\n\n⚠️  Received SIGTERM signal...');
        monitor.stop();
        process.exit(0);
    });

    // Start monitoring
    await monitor.start();
}

// Run if executed directly
if (require.main === module) {
    main().catch(error => {
        console.error('❌ Fatal error:', error);
        process.exit(1);
    });
}

export default OrderMonitor;
