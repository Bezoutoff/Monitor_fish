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
     * Uses /events API with tag_slug=games and pagination
     */
    async findLiveMatches(): Promise<LiveMatch[]> {
        try {
            console.log('🔍 Searching for live matches (NBA, NHL, NFL, Valorant, CS2...)');

            // Fetch sports events with pagination (NBA/NHL are often in later pages)
            const allMarkets: GammaMarketResponse[] = [];
            const eventsUrl = 'https://gamma-api.polymarket.com/events';

            // Fetch multiple pages to get all sports events
            for (const offset of [0, 500, 1000]) {
                const url = `${eventsUrl}?tag_slug=games&active=true&closed=false&limit=500&offset=${offset}`;
                const response = await fetch(url);

                if (!response.ok) {
                    console.error(`   ⚠️ API error at offset ${offset}: ${response.status}`);
                    continue;
                }

                const events = await response.json() as any[];
                let skippedEnded = 0;

                // Extract markets from events
                for (const event of events) {
                    // Skip finished events
                    if (event.ended === true) {
                        skippedEnded++;
                        continue;
                    }

                    if (event.markets && Array.isArray(event.markets)) {
                        for (const market of event.markets) {
                            // Add event slug to market for matching
                            market.slug = event.slug;
                            market.gameStartTime = event.startTime;
                            allMarkets.push(market);
                        }
                    }
                }

                if (skippedEnded > 0) {
                    console.log(`   Skipped ${skippedEnded} finished events at offset ${offset}`);
                }
            }

            const markets = allMarkets;
            console.log(`   Found ${markets.length} sports markets from ${[0, 500, 1000].length} API pages`);

            // Debug: count by sport
            const sportCounts: Record<string, number> = {};
            for (const m of markets) {
                const prefix = m.slug?.split('-')[0] || 'unknown';
                sportCounts[prefix] = (sportCounts[prefix] || 0) + 1;
            }
            console.log(`   By sport: ${Object.entries(sportCounts).map(([k,v]) => `${k}:${v}`).join(', ')}`);

            // Filter and group markets by slug
            const matchMap = new Map<string, LiveMatch>();
            let marketsProcessed = 0;

            for (const market of markets) {
                // Check if this is a real match (not a meta-event)
                if (!this.isRealMatch(market.slug)) {
                    continue;
                }

                // Only LIVE matches: started recently AND not finished
                // Extract date from slug (e.g., "nba-cle-atl-2025-11-28" -> "2025-11-28")
                const dateMatch = market.slug.match(/(\d{4}-\d{2}-\d{2})/);
                if (dateMatch) {
                    const matchDate = new Date(dateMatch[1] + 'T00:00:00Z');
                    const now = new Date();
                    const today = new Date(now.toISOString().split('T')[0] + 'T00:00:00Z');

                    // Skip matches from future dates
                    if (matchDate > today) {
                        continue;
                    }

                    // Skip matches older than 1 day (postponed games, etc.)
                    const oneDayAgo = new Date(today.getTime() - 24 * 60 * 60 * 1000);
                    if (matchDate < oneDayAgo) {
                        continue;
                    }
                }

                // Additional check with gameStartTime if available
                if (market.gameStartTime) {
                    const gameStart = new Date(market.gameStartTime);
                    const now = new Date();

                    // Skip matches that haven't started yet
                    if (gameStart > now) {
                        continue;
                    }

                    // Skip matches that started more than 6 hours ago (max match duration)
                    const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);
                    if (gameStart < sixHoursAgo) {
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
                                question: market.question || '',
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
    createTokenMap(matches: LiveMatch[]): Map<string, { slug: string; outcome: string; question: string }> {
        const tokenMap = new Map<string, { slug: string; outcome: string; question: string }>();

        for (const match of matches) {
            for (const market of match.markets) {
                tokenMap.set(market.tokenId, {
                    slug: match.slug,
                    outcome: market.outcome,
                    question: market.question
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
