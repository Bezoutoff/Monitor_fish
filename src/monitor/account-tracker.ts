/**
 * Account Tracker
 *
 * Monitors a specific wallet's trading activity on Polymarket
 * Sends alerts for new trades and logs all activity to file
 *
 * Features:
 * - Polls activity API every 200ms (within rate limits)
 * - Filters similar trades (same outcome, price within 5%, within 5 minutes)
 * - Logs all trades to JSON file
 * - Sends Telegram alerts for new trades
 */

import * as fs from 'fs';
import * as path from 'path';
import { TradeActivity } from './types';
import { AlertManager } from './alert-manager';

interface ActivityApiResponse {
    transactionHash: string;
    timestamp: string;
    side: 'BUY' | 'SELL';
    size: string;
    usdcSize: string;
    price: string;
    title: string;
    outcome: string;
    slug: string;
    pseudonym: string;
    asset: string;  // Token ID
}

interface LoggedTrade extends TradeActivity {
    alerted: boolean;
    loggedAt: string;
}

export class AccountTracker {
    private wallet: string;
    private alertManager: AlertManager;
    private checkInterval: number;
    private intervalId: NodeJS.Timeout | null = null;

    // Tracking state
    private lastSeenTxHash: string | null = null;
    private recentTrades: Array<{ trade: TradeActivity; seenAt: number }> = [];  // For duplicate filtering
    private isChecking: boolean = false;

    // Logging
    private logDir: string;
    private logFile: string;

    // API
    private readonly apiUrl = 'https://data-api.polymarket.com/activity';

    // Sports/esports prefixes (only alert for these)
    private readonly sportsPrefixes = [
        'nba-', 'nhl-', 'nfl-', 'cbb-', 'cfb-', 'mls-',  // American sports
        'epl-', 'elc-', 'lal-', 'es2-', 'bun-', 'bl2-',  // Soccer - Europe
        'sea-', 'itsb-', 'ere-', 'por-', 'tur-', 'rus-', 'den-', 'nor-', 'scop-',
        'arg-', 'bra-', 'mex-', 'lib-', 'cde-',          // Soccer - Americas
        'kor-', 'jap-', 'ja2-',                          // Soccer - Asia
        'val-', 'lol-', 'csgo-', 'cs2-', 'dota-', 'dota2-'  // Esports
    ];

    constructor(wallet: string, alertManager: AlertManager, checkInterval: number = 200) {
        this.wallet = wallet;
        this.alertManager = alertManager;
        this.checkInterval = checkInterval;

        // Setup logging directory
        this.logDir = 'account-tracker-logs';
        this.logFile = path.join(this.logDir, `${wallet}.json`);
        this.ensureLogDirectory();

        // Load last seen transaction
        this.loadState();

        console.log('');
        console.log('👤 ═══════════════════════════════════════════════════════════');
        console.log('👤  ACCOUNT TRACKER - Копирование сделок');
        console.log('👤 ═══════════════════════════════════════════════════════════');
        console.log('');
        console.log('⚙️  Конфигурация:');
        console.log(`   👛 Кошелек: ${wallet.substring(0, 10)}...${wallet.substring(wallet.length - 6)}`);
        console.log(`   ⏱️  Интервал: ${checkInterval}ms`);
        console.log(`   📝 Лог файл: ${this.logFile}`);
        console.log('');
    }

    /**
     * Start tracking
     */
    start(): void {
        if (this.intervalId) {
            console.log('⚠️  Account tracker already running');
            return;
        }

        console.log('🚀 Starting Account Tracker...');

        // Initial check
        this.checkActivity();

        // Start interval
        this.intervalId = setInterval(() => {
            this.checkActivity();
        }, this.checkInterval);

        console.log('✅ Account Tracker running\n');
    }

    /**
     * Stop tracking
     */
    stop(): void {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
            console.log('🛑 Account Tracker stopped');
        }
    }

    /**
     * Check for new activity
     */
    private async checkActivity(): Promise<void> {
        // Prevent concurrent checks
        if (this.isChecking) {
            return;
        }

        this.isChecking = true;

        try {
            const url = `${this.apiUrl}?user=${this.wallet}&limit=10&sortBy=TIMESTAMP&sortDirection=DESC`;
            const response = await fetch(url);

            if (!response.ok) {
                console.error(`❌ Activity API error: ${response.status}`);
                return;
            }

            const activities = await response.json() as ActivityApiResponse[];

            if (activities.length === 0) {
                return;
            }

            // First run - just save last tx hash without alerting
            if (this.lastSeenTxHash === null) {
                this.lastSeenTxHash = activities[0].transactionHash;
                this.saveState();
                console.log(`👤 First run - saved last tx: ${this.lastSeenTxHash.substring(0, 10)}...`);
                return;
            }

            // Process new activities (stop when we reach last seen)
            const newTrades: TradeActivity[] = [];

            for (const activity of activities) {
                // Stop if we've seen this transaction
                if (activity.transactionHash === this.lastSeenTxHash) {
                    break;
                }

                // Parse activity into TradeActivity
                const trade: TradeActivity = {
                    transactionHash: activity.transactionHash,
                    timestamp: new Date(activity.timestamp).getTime(),
                    side: activity.side,
                    size: parseFloat(activity.size),
                    usdcSize: parseFloat(activity.usdcSize),
                    price: parseFloat(activity.price),
                    title: activity.title,
                    outcome: activity.outcome,
                    eventSlug: activity.slug,
                    pseudonym: activity.pseudonym,
                    asset: activity.asset
                };

                newTrades.push(trade);
            }

            // Update last seen (first in list is newest)
            if (activities.length > 0 && this.lastSeenTxHash !== activities[0].transactionHash) {
                this.lastSeenTxHash = activities[0].transactionHash;
                this.saveState();
            }

            // Process new trades (oldest first for correct order)
            for (const trade of newTrades.reverse()) {
                // Skip non-sports events
                if (!this.isSportsEvent(trade.eventSlug)) {
                    continue;
                }

                const isDuplicate = this.isDuplicate(trade);

                // Add to recent trades BEFORE alert (so next trade in batch sees it)
                this.recentTrades.push({ trade, seenAt: Date.now() });

                // Log all trades
                this.logTrade(trade, !isDuplicate);

                // Alert only non-duplicates
                if (!isDuplicate) {
                    await this.alertManager.sendTraderAlert(trade, this.wallet);
                }
            }

            // Cleanup old recent trades (older than 5 minutes)
            this.cleanupRecentTrades();

        } catch (error) {
            // Silent fail for network errors (frequent polling)
            if (error instanceof Error && !error.message.includes('fetch')) {
                console.error('❌ Activity check error:', error);
            }
        } finally {
            this.isChecking = false;
        }
    }

    /**
     * Check if trade is for a sports/esports event
     */
    private isSportsEvent(slug: string): boolean {
        const lowerSlug = slug.toLowerCase();
        return this.sportsPrefixes.some(prefix => lowerSlug.startsWith(prefix));
    }

    /**
     * Check if trade is similar to recent ones
     * Similar = same outcome + price within 5% + seen within 5 minutes
     */
    private isDuplicate(trade: TradeActivity): boolean {
        const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;

        const similar = this.recentTrades.find(r =>
            r.trade.outcome === trade.outcome &&
            Math.abs(r.trade.price - trade.price) / Math.max(r.trade.price, 0.01) < 0.05 &&
            r.seenAt > fiveMinutesAgo
        );

        return !!similar;
    }

    /**
     * Cleanup trades seen more than 5 minutes ago
     */
    private cleanupRecentTrades(): void {
        const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
        this.recentTrades = this.recentTrades.filter(r => r.seenAt > fiveMinutesAgo);
    }

    /**
     * Log trade to file
     */
    private logTrade(trade: TradeActivity, alerted: boolean): void {
        try {
            // Read existing logs
            let logs: LoggedTrade[] = [];
            if (fs.existsSync(this.logFile)) {
                const content = fs.readFileSync(this.logFile, 'utf-8');
                if (content.trim()) {
                    logs = JSON.parse(content);
                }
            }

            // Cleanup old logs (older than 2 days)
            const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
            const oldCount = logs.length;
            logs = logs.filter(l => new Date(l.loggedAt).getTime() > twoDaysAgo);
            if (logs.length < oldCount) {
                console.log(`🧹 Cleaned ${oldCount - logs.length} old trades from log`);
            }

            // Add new trade
            const logEntry: LoggedTrade = {
                ...trade,
                alerted,
                loggedAt: new Date().toISOString()
            };
            logs.push(logEntry);

            // Write back
            fs.writeFileSync(this.logFile, JSON.stringify(logs, null, 2));

            // Console output
            const sizeStr = trade.size >= 1000
                ? `${(trade.size / 1000).toFixed(1)}k`
                : trade.size.toFixed(0);
            const priceStr = (trade.price * 100).toFixed(0);

            if (alerted) {
                console.log(`👤 NEW TRADE: ${trade.side} ${sizeStr} ${trade.outcome} @ ${priceStr}¢`);
            } else {
                console.log(`   ⏭️ Similar trade skipped: ${trade.side} ${sizeStr} ${trade.outcome} @ ${priceStr}¢`);
            }

        } catch (error) {
            console.error('❌ Error logging trade:', error);
        }
    }

    /**
     * Ensure log directory exists
     */
    private ensureLogDirectory(): void {
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
            console.log(`📁 Created log directory: ${this.logDir}`);
        }
    }

    /**
     * Load state (last seen tx hash)
     */
    private loadState(): void {
        try {
            const stateFile = path.join(this.logDir, `${this.wallet}-state.json`);
            if (fs.existsSync(stateFile)) {
                const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
                this.lastSeenTxHash = state.lastSeenTxHash;
                console.log(`📋 Loaded state: last tx ${this.lastSeenTxHash?.substring(0, 10)}...`);
            }
        } catch (error) {
            console.error('❌ Error loading state:', error);
        }
    }

    /**
     * Save state (last seen tx hash)
     */
    private saveState(): void {
        try {
            const stateFile = path.join(this.logDir, `${this.wallet}-state.json`);
            const state = {
                lastSeenTxHash: this.lastSeenTxHash,
                updatedAt: new Date().toISOString()
            };
            fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
        } catch (error) {
            console.error('❌ Error saving state:', error);
        }
    }

    /**
     * Get stats
     */
    getStats(): { totalTrades: number; alertedTrades: number } {
        try {
            if (fs.existsSync(this.logFile)) {
                const content = fs.readFileSync(this.logFile, 'utf-8');
                if (content.trim()) {
                    const logs: LoggedTrade[] = JSON.parse(content);
                    return {
                        totalTrades: logs.length,
                        alertedTrades: logs.filter(t => t.alerted).length
                    };
                }
            }
        } catch (error) {
            console.error('❌ Error getting stats:', error);
        }
        return { totalTrades: 0, alertedTrades: 0 };
    }
}
