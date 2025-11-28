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
            matchCheckInterval: parseInt(process.env.MONITOR_MATCH_CHECK_INTERVAL || '300000')
        };

        this.matchFinder = new LiveMatchFinder();
        this.alertManager = new AlertManager();

        console.log('');
        console.log('🎯 ═══════════════════════════════════════════════════════════');
        console.log('🎯  POLYMARKET ORDER MONITOR - NBA/NHL Live Matches');
        console.log('🎯 ═══════════════════════════════════════════════════════════');
        console.log('');
        console.log('⚙️  Configuration:');
        console.log(`   Min Size: ${this.config.minSize.toLocaleString()} shares`);
        console.log(`   Price Range: $${this.config.minPrice.toFixed(2)} - $${this.config.maxPrice.toFixed(2)}`);
        console.log(`   Alert Age: ${this.config.alertAgeSeconds} seconds (${(this.config.alertAgeSeconds / 60).toFixed(1)} minutes)`);
        console.log(`   Match Check: Every ${(this.config.matchCheckInterval / 1000 / 60).toFixed(1)} minutes`);
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

            // Show subscribed matches
            console.log(`\n📋 Subscribed to ${matches.length} matches:`);
            for (const match of matches) {
                console.log(`   ${match.slug} (${match.markets.length} markets)`);
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

                // Process bids
                for (const [price, level] of Object.entries(book.bids || {})) {
                    const bid = level as any;
                    const tokenId = bid.tokenId;
                    const priceNum = parseFloat(price);
                    const size = parseFloat(bid.size || '0');

                    if (size > 0) {
                        this.orderTracker?.processOrderLevel(tokenId, priceNum, size, 'BUY');
                    } else {
                        this.orderTracker?.removeOrder(tokenId, priceNum, 'BUY');
                    }
                }

                // Process asks
                for (const [price, level] of Object.entries(book.asks || {})) {
                    const ask = level as any;
                    const tokenId = ask.tokenId;
                    const priceNum = parseFloat(price);
                    const size = parseFloat(ask.size || '0');

                    if (size > 0) {
                        this.orderTracker?.processOrderLevel(tokenId, priceNum, size, 'SELL');
                    } else {
                        this.orderTracker?.removeOrder(tokenId, priceNum, 'SELL');
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
