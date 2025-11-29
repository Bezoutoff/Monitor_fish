/**
 * Type definitions for Order Monitor
 */

export interface MonitorConfig {
    minSize: number;              // Minimum order size (shares) - 10000
    minPrice: number;             // Minimum price (0.05)
    maxPrice: number;             // Maximum price (0.95)
    alertAgeSeconds: number;      // Alert after N seconds (120)
    matchCheckInterval: number;   // Check for new matches every N ms (300000 = 5 min)
    deltaTolerance: number;       // Allowed size decrease without reset (0.10 = 10%)
    minImpactPercent: number;     // Min impact on total size to track (0.60 = 60%)
}

export interface LiveMatch {
    slug: string;                 // e.g., "nba-hou-mil-2025-11-09"
    question: string;             // e.g., "Who will win: Houston Rockets vs Milwaukee Bucks?"
    markets: MarketInfo[];        // Can be multiple markets per match
}

export interface MarketInfo {
    tokenId: string;              // CLOB token ID
    outcome: string;              // e.g., "Houston Rockets" or "Yes"/"No"
    question: string;             // e.g., "Will Bristol City FC win?"
    conditionId: string;          // Market condition ID
}

export interface TrackedOrder {
    orderId: string;              // Unique order identifier (price_tokenId_side)
    tokenId: string;              // Token ID
    matchSlug: string;            // Match slug for reference
    marketOutcome: string;        // e.g., "Houston Rockets"
    price: number;                // Order price (0.05-0.95)
    size: number;                 // Order size (shares)
    side: 'BUY' | 'SELL';         // Order side
    firstSeen: Date;              // When order was first detected
    lastSeen: Date;               // Last update timestamp
    alerted: boolean;             // Whether alert was already sent
}

export interface OrderAlert {
    timestamp: string;            // ISO timestamp
    match: string;                // Match slug
    market: string;               // Market outcome (e.g., "Lakers" or "Yes")
    question: string;             // Market question (e.g., "Will Bristol City win?")
    tokenId: string;              // Token ID
    orderId: string;              // Order ID
    price: number;                // Order price
    size: number;                 // Order size
    side: 'BUY' | 'SELL';        // Order side
    ageSeconds: number;           // Age in seconds
}

export interface GammaEvent {
    id: string;
    slug: string;
    title: string;
    description: string;
    markets: GammaMarket[];
    active: boolean;
    closed: boolean;
    archived: boolean;
    new: boolean;
    featured: boolean;
    restricted: boolean;
    liquidityNum: number;
    commentCount: number;
    createdAt: string;
    resolving: boolean;
    volume: number;
    volumeNum: number;
    enableOrderBook: boolean;
    orderPriceMinTickSize: number;
    orderMinSize: number;
}

export interface GammaMarket {
    id: string;
    question: string;
    conditionId: string;
    slug: string;
    resolutionSource: string;
    endDate: string;
    liquidity: string;
    startDate: string;
    image: string;
    icon: string;
    description: string;
    outcomes: string;              // JSON string: ["Outcome 1", "Outcome 2"]
    outcomePrices: string;         // JSON string: ["0.52", "0.48"]
    volume: string;
    active: boolean;
    closed: boolean;
    marketSlug: string;
    questionID: string;
    enableOrderBook: boolean;
    orderPriceMinTickSize: number;
    orderMinSize: number;
    acceptingOrders: boolean;
    acceptingOrderTimestamp: string | null;
    negRisk: boolean;
    clobTokenIds: string;          // JSON string: ["tokenId1", "tokenId2"]
    rewards: any;
    spread: number;
    volumeNum: number;
    liquidityNum: number;
}

/**
 * Trade activity from account tracker
 */
export interface TradeActivity {
    transactionHash: string;
    timestamp: number;
    side: 'BUY' | 'SELL';
    size: number;
    usdcSize: number;
    price: number;
    title: string;
    outcome: string;
    eventSlug: string;
    pseudonym: string;
}
