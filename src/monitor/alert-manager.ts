/**
 * Alert Manager
 *
 * Handles alerts for long-lived orders:
 * - Console output with colors and beep
 * - JSON logging to daily files
 */

import * as fs from 'fs';
import * as path from 'path';
import { OrderAlert } from './types';

export class AlertManager {
    private logDir: string;
    private currentLogFile: string | null = null;

    // Telegram bot config
    private telegramToken = '7622763223:AAEccNTlepJ1YmfMCT5IC1DNEaNAL8bhu-8';
    private telegramChatId = '218227095';

    constructor(logDir: string = 'order-monitor-logs') {
        this.logDir = logDir;
        this.ensureLogDirectory();
    }

    /**
     * Handle an alert
     */
    async handleAlert(alert: OrderAlert): Promise<void> {
        // Console output with beep
        this.logToConsole(alert);

        // JSON logging
        await this.logToFile(alert);

        // Telegram notification
        await this.sendTelegram(alert);
    }

    /**
     * Log alert to console with color and beep
     */
    private logToConsole(alert: OrderAlert): void {
        // ANSI color codes
        const colors = {
            red: '\x1b[31m',
            green: '\x1b[32m',
            yellow: '\x1b[33m',
            blue: '\x1b[34m',
            magenta: '\x1b[35m',
            cyan: '\x1b[36m',
            white: '\x1b[37m',
            reset: '\x1b[0m',
            bright: '\x1b[1m'
        };

        // Format alert message
        const timestamp = new Date(alert.timestamp).toLocaleString();
        const ageMinutes = (alert.ageSeconds / 60).toFixed(1);
        const sideColor = alert.side === 'BUY' ? colors.green : colors.red;

        console.log('');
        console.log(colors.bright + colors.yellow + '🚨 LONG-LIVED ORDER ALERT 🚨' + colors.reset);
        console.log(colors.cyan + '─'.repeat(60) + colors.reset);
        console.log(`${colors.bright}Time:${colors.reset}     ${timestamp}`);
        console.log(`${colors.bright}Match:${colors.reset}    ${colors.magenta}${alert.match}${colors.reset}`);
        console.log(`${colors.bright}Market:${colors.reset}   ${colors.blue}${alert.market}${colors.reset}`);
        console.log(`${colors.bright}Order:${colors.reset}    ${sideColor}${alert.side}${colors.reset} ${alert.size.toLocaleString()} shares @ $${alert.price.toFixed(2)}`);
        console.log(`${colors.bright}Age:${colors.reset}      ${colors.yellow}${ageMinutes} minutes${colors.reset} (${alert.ageSeconds}s)`);
        console.log(`${colors.bright}Token ID:${colors.reset} ${alert.tokenId.substring(0, 20)}...`);
        console.log(`${colors.bright}URL:${colors.reset}      ${colors.cyan}https://polymarket.com/event/${alert.match}${colors.reset}`);
        console.log(colors.cyan + '─'.repeat(60) + colors.reset);
        console.log('');

        // Beep sound
        process.stdout.write('\x07');
    }

    /**
     * Log alert to JSON file
     */
    private async logToFile(alert: OrderAlert): Promise<void> {
        try {
            const logFile = this.getCurrentLogFile();

            // Read existing logs
            let logs: OrderAlert[] = [];
            if (fs.existsSync(logFile)) {
                const content = await fs.promises.readFile(logFile, 'utf-8');
                if (content.trim()) {
                    logs = JSON.parse(content);
                }
            }

            // Append new alert
            logs.push(alert);

            // Write back to file
            await fs.promises.writeFile(
                logFile,
                JSON.stringify(logs, null, 2),
                'utf-8'
            );

        } catch (error) {
            console.error('❌ Error logging to file:', error);
        }
    }

    /**
     * Get current log file path (daily rotation)
     */
    private getCurrentLogFile(): string {
        const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        const filename = `${today}.json`;
        const filepath = path.join(this.logDir, filename);

        // Update current log file if date changed
        if (this.currentLogFile !== filepath) {
            this.currentLogFile = filepath;
            console.log(`📝 Logging to: ${filepath}`);
        }

        return filepath;
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
     * Send alert to Telegram
     */
    private async sendTelegram(alert: OrderAlert): Promise<void> {
        try {
            const ageMinutes = (alert.ageSeconds / 60).toFixed(1);
            const text = `🚨 *ALERT*

*Match:* ${alert.match}
*Market:* ${alert.market}
*Order:* ${alert.side} ${alert.size.toLocaleString()} @ $${alert.price.toFixed(2)}
*Age:* ${ageMinutes} min

[Open on Polymarket](https://polymarket.com/event/${alert.match})`;

            const url = `https://api.telegram.org/bot${this.telegramToken}/sendMessage`;
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: this.telegramChatId,
                    text,
                    parse_mode: 'Markdown',
                    disable_web_page_preview: true
                })
            });

            if (!response.ok) {
                console.error('❌ Telegram error:', await response.text());
            }
        } catch (error) {
            console.error('❌ Failed to send Telegram:', error);
        }
    }

    /**
     * Get statistics from log files
     */
    async getStats(): Promise<{ totalAlerts: number; todayAlerts: number }> {
        try {
            const today = new Date().toISOString().split('T')[0];
            const todayFile = path.join(this.logDir, `${today}.json`);

            let todayAlerts = 0;
            if (fs.existsSync(todayFile)) {
                const content = await fs.promises.readFile(todayFile, 'utf-8');
                if (content.trim()) {
                    const logs = JSON.parse(content);
                    todayAlerts = logs.length;
                }
            }

            // Count total alerts from all log files
            let totalAlerts = 0;
            if (fs.existsSync(this.logDir)) {
                const files = await fs.promises.readdir(this.logDir);
                for (const file of files) {
                    if (file.endsWith('.json')) {
                        const filepath = path.join(this.logDir, file);
                        const content = await fs.promises.readFile(filepath, 'utf-8');
                        if (content.trim()) {
                            const logs = JSON.parse(content);
                            totalAlerts += logs.length;
                        }
                    }
                }
            }

            return { totalAlerts, todayAlerts };

        } catch (error) {
            console.error('❌ Error getting stats:', error);
            return { totalAlerts: 0, todayAlerts: 0 };
        }
    }
}
