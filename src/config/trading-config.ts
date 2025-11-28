/**
 * Trading Configuration
 * ВАЖНО: Никогда не коммитьте приватные ключи и API credentials в git!
 */

export interface TradingConfig {
  // Wallet credentials
  privateKey: string;
  address?: string;      // Optional - derived from private key if not provided

  // API credentials (optional - will be auto-derived if not provided)
  apiKey?: string;
  secret?: string;
  passphrase?: string;

  // Optional funder address
  funder?: string;

  // Network configuration
  chainId: number;
  clobApiUrl: string;
  signatureType: number; // 0 = EOA, 1 = POLY_PROXY, 2 = POLY_GNOSIS_SAFE
}

// По умолчанию используется Polygon (chainId: 137)
export const defaultTradingConfig: TradingConfig = {
  privateKey: process.env.PK ? `0x${process.env.PK}` : '',
  address: process.env.WALLET_ADDRESS,
  // API credentials from .env (tested and working)
  apiKey: process.env.CLOB_API_KEY,
  secret: process.env.CLOB_SECRET,
  passphrase: process.env.CLOB_PASS_PHRASE,
  funder: process.env.FUNDER,
  chainId: parseInt(process.env.CHAIN_ID || '137'),
  clobApiUrl: process.env.CLOB_API_URL || 'https://clob.polymarket.com',
  signatureType: 2, // POLY_PROXY (matching working bot)
};

// Валидация конфигурации
export function validateTradingConfig(config: TradingConfig): boolean {
  const errors: string[] = [];

  // Validate private key (ONLY required field)
  if (!config.privateKey || config.privateKey.length === 0) {
    errors.push('PK not set');
  } else {
    if (!config.privateKey.startsWith('0x')) {
      errors.push('PK must start with 0x (automatically added from .env)');
    }
    if (config.privateKey.length !== 66) {
      errors.push('PK must be 64 characters (0x prefix added automatically)');
    }
  }

  if (errors.length > 0) {
    console.error('❌ Trading configuration errors:');
    errors.forEach(err => console.error(`   - ${err}`));
    console.error('\n   Please set required environment variable in .env file:');
    console.error('   - PK (wallet private key WITHOUT 0x prefix)');
    console.error('\n   Optional:');
    console.error('   - FUNDER (funder address, defaults to wallet address)');
    return false;
  }

  return true;
}
