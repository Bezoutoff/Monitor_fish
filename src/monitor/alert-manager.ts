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
    private telegramChatId = '-5052080545';  // Group: Monitor Fish

    // Deduplication - store sent alerts to avoid duplicates
    private sentAlertsFile: string;
    private sentAlerts: Set<string> = new Set();
    private lastCleanup: Date = new Date();

    // Write queue to prevent race conditions
    private writeQueue: OrderAlert[] = [];
    private isWriting: boolean = false;

    // Full team names mapping
    private readonly teamNames: Record<string, string> = {
        // NBA (30 teams)
        'Hawks': 'Atlanta Hawks',
        'Celtics': 'Boston Celtics',
        'Nets': 'Brooklyn Nets',
        'Hornets': 'Charlotte Hornets',
        'Bulls': 'Chicago Bulls',
        'Cavaliers': 'Cleveland Cavaliers',
        'Mavericks': 'Dallas Mavericks',
        'Nuggets': 'Denver Nuggets',
        'Pistons': 'Detroit Pistons',
        'Warriors': 'Golden State Warriors',
        'Rockets': 'Houston Rockets',
        'Pacers': 'Indiana Pacers',
        'Clippers': 'LA Clippers',
        'Lakers': 'Los Angeles Lakers',
        'Grizzlies': 'Memphis Grizzlies',
        'Heat': 'Miami Heat',
        'Bucks': 'Milwaukee Bucks',
        'Timberwolves': 'Minnesota Timberwolves',
        'Pelicans': 'New Orleans Pelicans',
        'Knicks': 'New York Knicks',
        'Thunder': 'Oklahoma City Thunder',
        'Magic': 'Orlando Magic',
        '76ers': 'Philadelphia 76ers',
        'Suns': 'Phoenix Suns',
        'Trail Blazers': 'Portland Trail Blazers',
        'Kings': 'Sacramento Kings',
        'Spurs': 'San Antonio Spurs',
        'Raptors': 'Toronto Raptors',
        'Jazz': 'Utah Jazz',
        'Wizards': 'Washington Wizards',

        // NHL (32 teams)
        'Ducks': 'Anaheim Ducks',
        'Coyotes': 'Arizona Coyotes',
        'Bruins': 'Boston Bruins',
        'Sabres': 'Buffalo Sabres',
        'Flames': 'Calgary Flames',
        'Hurricanes': 'Carolina Hurricanes',
        'Blackhawks': 'Chicago Blackhawks',
        'Avalanche': 'Colorado Avalanche',
        'Blue Jackets': 'Columbus Blue Jackets',
        'Stars': 'Dallas Stars',
        'Red Wings': 'Detroit Red Wings',
        'Oilers': 'Edmonton Oilers',
        'Panthers': 'Florida Panthers',
        'Kings (NHL)': 'Los Angeles Kings',
        'Wild': 'Minnesota Wild',
        'Canadiens': 'Montreal Canadiens',
        'Predators': 'Nashville Predators',
        'Devils': 'New Jersey Devils',
        'Islanders': 'New York Islanders',
        'Rangers': 'New York Rangers',
        'Senators': 'Ottawa Senators',
        'Flyers': 'Philadelphia Flyers',
        'Penguins': 'Pittsburgh Penguins',
        'Sharks': 'San Jose Sharks',
        'Kraken': 'Seattle Kraken',
        'Blues': 'St. Louis Blues',
        'Lightning': 'Tampa Bay Lightning',
        'Maple Leafs': 'Toronto Maple Leafs',
        'Canucks': 'Vancouver Canucks',
        'Golden Knights': 'Vegas Golden Knights',
        'Capitals': 'Washington Capitals',
        'Jets': 'Winnipeg Jets',

        // NFL (32 teams)
        'Cardinals': 'Arizona Cardinals',
        'Falcons': 'Atlanta Falcons',
        'Ravens': 'Baltimore Ravens',
        'Bills': 'Buffalo Bills',
        'Panthers (NFL)': 'Carolina Panthers',
        'Bears': 'Chicago Bears',
        'Bengals': 'Cincinnati Bengals',
        'Browns': 'Cleveland Browns',
        'Cowboys': 'Dallas Cowboys',
        'Broncos': 'Denver Broncos',
        'Lions': 'Detroit Lions',
        'Packers': 'Green Bay Packers',
        'Texans': 'Houston Texans',
        'Colts': 'Indianapolis Colts',
        'Jaguars': 'Jacksonville Jaguars',
        'Chiefs': 'Kansas City Chiefs',
        'Raiders': 'Las Vegas Raiders',
        'Chargers': 'Los Angeles Chargers',
        'Rams': 'Los Angeles Rams',
        'Dolphins': 'Miami Dolphins',
        'Vikings': 'Minnesota Vikings',
        'Patriots': 'New England Patriots',
        'Saints': 'New Orleans Saints',
        'Giants': 'New York Giants',
        'Jets (NFL)': 'New York Jets',
        'Eagles': 'Philadelphia Eagles',
        'Steelers': 'Pittsburgh Steelers',
        '49ers': 'San Francisco 49ers',
        'Seahawks': 'Seattle Seahawks',
        'Buccaneers': 'Tampa Bay Buccaneers',
        'Titans': 'Tennessee Titans',
        'Commanders': 'Washington Commanders',
    };

    constructor(logDir: string = 'order-monitor-logs') {
        this.logDir = logDir;
        this.sentAlertsFile = path.join(logDir, 'sent-alerts.json');
        this.ensureLogDirectory();
        this.loadSentAlerts();
    }

    /**
     * Handle an alert
     */
    async handleAlert(alert: OrderAlert): Promise<void> {
        const key = this.getAlertKey(alert);

        // Check for duplicate
        if (this.sentAlerts.has(key)) {
            console.log(`   ⏭️ Duplicate alert skipped: ${alert.market} @ $${alert.price.toFixed(2)}`);
            return;
        }

        // Save to deduplication set
        this.sentAlerts.add(key);
        this.saveSentAlerts();

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
     * Add alert to write queue (prevents race conditions)
     */
    private async logToFile(alert: OrderAlert): Promise<void> {
        this.writeQueue.push(alert);
        await this.processWriteQueue();
    }

    /**
     * Process write queue sequentially
     */
    private async processWriteQueue(): Promise<void> {
        // If already writing, queue will be processed by current writer
        if (this.isWriting) {
            return;
        }

        this.isWriting = true;

        try {
            while (this.writeQueue.length > 0) {
                // Take all pending alerts
                const alertsToWrite = [...this.writeQueue];
                this.writeQueue = [];

                const logFile = this.getCurrentLogFile();

                // Read existing logs
                let logs: OrderAlert[] = [];
                if (fs.existsSync(logFile)) {
                    const content = await fs.promises.readFile(logFile, 'utf-8');
                    if (content.trim()) {
                        try {
                            logs = JSON.parse(content);
                        } catch (e) {
                            console.error('❌ Corrupted JSON file, starting fresh');
                            logs = [];
                        }
                    }
                }

                // Append all new alerts
                logs.push(...alertsToWrite);

                // Write back to file atomically
                const tempFile = logFile + '.tmp';
                await fs.promises.writeFile(
                    tempFile,
                    JSON.stringify(logs, null, 2),
                    'utf-8'
                );
                await fs.promises.rename(tempFile, logFile);
            }
        } catch (error) {
            console.error('❌ Error logging to file:', error);
        } finally {
            this.isWriting = false;
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
     * Load sent alerts from file (for deduplication)
     */
    private loadSentAlerts(): void {
        try {
            if (fs.existsSync(this.sentAlertsFile)) {
                const data = JSON.parse(fs.readFileSync(this.sentAlertsFile, 'utf-8'));
                this.lastCleanup = new Date(data.lastCleanup);
                this.sentAlerts = new Set(data.alerts || []);

                // Check if cleanup needed (48 hours = 2 days)
                const hoursSinceCleanup = (Date.now() - this.lastCleanup.getTime()) / (1000 * 60 * 60);
                if (hoursSinceCleanup >= 48) {
                    console.log('🧹 Clearing old sent alerts (2 days passed)');
                    this.sentAlerts.clear();
                    this.lastCleanup = new Date();
                    this.saveSentAlerts();
                }

                console.log(`📋 Loaded ${this.sentAlerts.size} sent alerts for deduplication`);
            }
        } catch (error) {
            console.error('❌ Error loading sent alerts:', error);
            this.sentAlerts = new Set();
            this.lastCleanup = new Date();
        }
    }

    /**
     * Save sent alerts to file
     */
    private saveSentAlerts(): void {
        try {
            const data = {
                lastCleanup: this.lastCleanup.toISOString(),
                alerts: Array.from(this.sentAlerts)
            };
            fs.writeFileSync(this.sentAlertsFile, JSON.stringify(data, null, 2));
        } catch (error) {
            console.error('❌ Error saving sent alerts:', error);
        }
    }

    /**
     * Generate unique key for deduplication (tokenId + price)
     */
    private getAlertKey(alert: OrderAlert): string {
        return `${alert.tokenId}_${alert.price.toFixed(2)}`;
    }

    /**
     * Get full team name from short name
     */
    private getFullTeamName(shortName: string): string {
        return this.teamNames[shortName] || shortName;
    }

    /**
     * Get sport emoji based on match slug
     */
    private getSportEmoji(matchSlug: string): string {
        const prefix = matchSlug.split('-')[0].toLowerCase();
        const sportEmojis: Record<string, string> = {
            'nba': '🏀',
            'cbb': '🏀',
            'nhl': '🏒',
            'nfl': '🏈',
            'cfb': '🏈',
            'mlb': '⚾',
            'dota2': '🎮',
            'val': '🎮',
            'cs2': '🎮',
            'lol': '🎮',
            'tur': '⚽',
            'bl2': '⚽',
            'epl': '⚽',
            'laliga': '⚽',
            'ucl': '⚽',
        };
        return sportEmojis[prefix] || '🎯';
    }

    /**
     * Send alert to Telegram
     */
    private async sendTelegram(alert: OrderAlert): Promise<void> {
        try {
            // Calculate dollar value
            const dollarValue = alert.size * alert.price;
            const dollarStr = dollarValue >= 1000
                ? `$${(dollarValue / 1000).toFixed(1)}k`
                : `$${dollarValue.toFixed(0)}`;

            // Calculate $ signs based on value (1 sign per $2k, min 1, max 10)
            // $2k = 1, $4k = 2, ... $20k+ = 10
            const dollarSigns = Math.min(10, Math.max(1, Math.ceil(dollarValue / 2000)));
            const dollarSignsStr = '💵'.repeat(dollarSigns);

            // Format size
            const sizeStr = alert.size >= 1000
                ? `${(alert.size / 1000).toFixed(1)}k`
                : alert.size.toFixed(0);

            // Get sport emoji and market name
            const sportEmoji = this.getSportEmoji(alert.match);

            // For Yes/No outcomes, use the question instead
            let marketName: string;
            if (alert.market === 'Yes' || alert.market === 'No') {
                // Extract meaningful part from question like "Will Bristol City FC win on 2025-11-29?"
                // -> "Bristol City FC win: Yes"
                const questionClean = alert.question
                    .replace(/^Will\s+/i, '')
                    .replace(/\s+on\s+\d{4}-\d{2}-\d{2}\??$/i, '')
                    .replace(/\?$/, '');
                marketName = `${questionClean}: ${alert.market}`;
            } else {
                marketName = this.getFullTeamName(alert.market);
            }

            const polymarketUrl = `https://polymarket.com/event/${alert.match}`;
            const text = `🐋 *WHALE ALERT* ${sportEmoji}

📊 *${marketName}*
💰 \`${sizeStr} shares @ ${(alert.price * 100).toFixed(0)}¢\`
${dollarSignsStr} *${dollarStr}*

${polymarketUrl}`;

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
