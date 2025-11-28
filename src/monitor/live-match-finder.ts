/**
 * Live Match Finder
 *
 * Discovers live sports/esports matches from Polymarket Gamma API
 * Uses /markets endpoint with gameStartTime sorting for efficient sports discovery
 * Checks every 5 minutes for new matches
 */

import { LiveMatch, MarketInfo } from './types';

// Response from /markets endpoint
interface GammaMarketResponse {
    id: string;
    slug: string;
    question: string;
    conditionId: string;
    gameStartTime?: string;  // Only sports markets have this
    clobTokenIds: string;    // JSON string: ["token1", "token2"]
    outcomes: string;        // JSON string: ["Team A", "Team B"]
    active: boolean;
    closed: boolean;
    acceptingOrders?: boolean;  // true = LIVE, false = finished
}

export class LiveMatchFinder {
    private readonly marketsApiUrl = 'https://gamma-api.polymarket.com/markets';
    private knownMatches: Set<string> = new Set();

    // Sports/esports prefixes for actual matches
    private readonly matchPrefixes = [
        // American sports
        'nba-',   // NBA basketball
        'nhl-',   // NHL hockey
        'nfl-',   // NFL football
        'cbb-',   // College basketball (NCAA)
        'cfb-',   // College football (NCAA)
        'mls-',   // MLS (USA soccer)

        // Soccer - Europe
        'epl-',   // English Premier League
        'elc-',   // EFL Championship (England)
        'lal-',   // La Liga (Spain)
        'es2-',   // La Liga 2 (Spain)
        'bun-',   // Bundesliga (Germany)
        'bl2-',   // Bundesliga 2 (Germany)
        'sea-',   // Serie A (Italy)
        'itsb-',  // Italy Serie B
        'ere-',   // Eredivisie (Netherlands)
        'por-',   // Portugal
        'tur-',   // Turkey
        'rus-',   // Russia
        'den-',   // Denmark
        'nor-',   // Norway
        'scop-',  // Scottish Cup

        // Soccer - Americas
        'arg-',   // Argentina
        'bra-',   // Brazil
        'mex-',   // Mexico
        'lib-',   // Libertadores
        'cde-',   // Copa del Rey

        // Soccer - Asia
        'kor-',   // K-League (Korea)
        'jap-',   // Japan
        'ja2-',   // J2 League (Japan)

        // Esports
        'val-',   // Valorant
        'lol-',   // League of Legends
        'csgo-',  // Counter-Strike
        'cs2-',   // Counter-Strike 2
        'dota-',  // Dota 2
        'dota2-', // Dota 2 (alternative)
    ];

    // Date pattern to identify real matches (YYYY-MM-DD)
    private readonly datePattern = /\d{4}-\d{2}-\d{2}/;

    /**
     * Check if slug represents a real match (not a meta-event)
     */
    private isRealMatch(slug: string): boolean {
        const lowerSlug = slug.toLowerCase();

        // Must start with one of our prefixes
        const hasPrefix = this.matchPrefixes.some(prefix => lowerSlug.startsWith(prefix));
        if (!hasPrefix) return false;

        // Must contain a date pattern (YYYY-MM-DD) - real matches have dates
        const hasDate = this.datePattern.test(slug);

        return hasDate;
    }

    /**
     * Find all live sports/esports matches
     * Uses /markets API with gameStartTime sorting - only sports have this field
     */
    async findLiveMatches(): Promise<LiveMatch[]> {
        try {
            console.log('🔍 Searching for live matches (NBA, NHL, NFL, Valorant, CS2...)');

            // Fetch markets sorted by gameStartTime (only sports markets have this)
            const url = `${this.marketsApiUrl}?active=true&closed=false&limit=500&order=gameStartTime&ascending=true`;
            const response = await fetch(url);

            if (!response.ok) {
                throw new Error(`Gamma API error: ${response.status} ${response.statusText}`);
            }

            const markets = await response.json() as GammaMarketResponse[];
            console.log(`   Found ${markets.length} markets with gameStartTime`);

            // Filter and group markets by slug
            const matchMap = new Map<string, LiveMatch>();
            let marketsProcessed = 0;

            for (const market of markets) {
                // Check if this is a real match (not a meta-event)
                if (!this.isRealMatch(market.slug)) {
                    continue;
                }

                // Only LIVE matches: started (gameStartTime <= now) AND not finished (acceptingOrders = true)
                if (market.gameStartTime) {
                    const gameStart = new Date(market.gameStartTime);
                    const now = new Date();

                    // Skip matches that haven't started yet
                    if (gameStart > now) {
                        continue;
                    }
                }

                // Skip markets not accepting orders (match finished)
                if (market.acceptingOrders === false) {
                    continue;
                }

                // Skip markets without tokens
                if (!market.clobTokenIds) {
                    continue;
                }

                marketsProcessed++;

                try {
                    // Parse JSON strings
                    const tokenIds: string[] = JSON.parse(market.clobTokenIds);
                    const outcomes: string[] = JSON.parse(market.outcomes);

                    // Get or create match entry
                    let match = matchMap.get(market.slug);
                    if (!match) {
                        match = {
                            slug: market.slug,
                            question: market.question,
                            markets: []
                        };
                        matchMap.set(market.slug, match);
                    }

                    // Add each token/outcome pair
                    for (let i = 0; i < tokenIds.length; i++) {
                        // Check if token already exists (avoid duplicates)
                        const tokenExists = match.markets.some(m => m.tokenId === tokenIds[i]);
                        if (!tokenExists) {
                            match.markets.push({
                                tokenId: tokenIds[i],
                                outcome: outcomes[i] || `Outcome ${i + 1}`,
                                conditionId: market.conditionId
                            });
                        }
                    }
                } catch (error) {
                    console.error(`   ⚠️  Failed to parse market tokens for ${market.slug}:`, error);
                    continue;
                }
            }

            // Convert map to array and log new matches
            const liveMatches: LiveMatch[] = [];
            for (const match of matchMap.values()) {
                if (match.markets.length > 0) {
                    liveMatches.push(match);

                    // Track new matches
                    if (!this.knownMatches.has(match.slug)) {
                        this.knownMatches.add(match.slug);
                        console.log(`   ✅ NEW MATCH: ${match.slug}`);
                        console.log(`      Question: ${match.question}`);
                        console.log(`      Markets: ${match.markets.length} (${match.markets.map(m => m.outcome).join(', ')})`);
                    }
                }
            }

            console.log(`   🎮 Sports markets processed: ${marketsProcessed}`);
            console.log(`   📊 Unique matches found: ${liveMatches.length}`);
            return liveMatches;

        } catch (error) {
            console.error('❌ Error finding live matches:', error);
            return [];
        }
    }

    /**
     * Get all unique token IDs from matches
     */
    extractTokenIds(matches: LiveMatch[]): string[] {
        const tokenIds = new Set<string>();

        for (const match of matches) {
            for (const market of match.markets) {
                tokenIds.add(market.tokenId);
            }
        }

        return Array.from(tokenIds);
    }

    /**
     * Create a lookup map: tokenId -> match info
     */
    createTokenMap(matches: LiveMatch[]): Map<string, { slug: string; outcome: string }> {
        const tokenMap = new Map<string, { slug: string; outcome: string }>();

        for (const match of matches) {
            for (const market of match.markets) {
                tokenMap.set(market.tokenId, {
                    slug: match.slug,
                    outcome: market.outcome
                });
            }
        }

        return tokenMap;
    }

    /**
     * Clear known matches (useful for testing)
     */
    clearKnownMatches(): void {
        this.knownMatches.clear();
    }
}
