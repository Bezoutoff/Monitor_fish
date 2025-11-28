# CLAUDE.md - Контекст проекта

## О проекте

**Monitor Fish** — система мониторинга крупных ордеров ("китов") на Polymarket для спортивных и киберспортивных матчей.

## Как работает

1. **LiveMatchFinder** (`src/monitor/live-match-finder.ts`)
   - Каждые 5 минут запрашивает Gamma API Polymarket
   - Фильтрует только LIVE матчи (начался + acceptingOrders=true + не старше 6 часов)
   - Поддерживает: NBA, NHL, NFL, CBB, CFB, Valorant, CS2, Dota 2, футбол (EPL, La Liga и др.)

2. **PolymarketWebSocketParser** (`src/parsers/polymarket-websocket.ts`)
   - Подключается к CLOB WebSocket
   - Подписывается на изменения orderbook для token IDs матчей
   - Требует API ключи (POLY_API_KEY, POLY_API_SECRET, POLY_PASSPHRASE)

3. **OrderTracker** (`src/monitor/order-tracker.ts`)
   - Отслеживает только BUY ордера (SELL игнорируются - они дублируют BUY на противоположном outcome)
   - Использует delta detection - отслеживает новые крупные ордера
   - Фильтры: minSize, minPrice, maxPrice, deltaTolerance, minImpactPercent

4. **AlertManager** (`src/monitor/alert-manager.ts`)
   - Отправляет алерты в Telegram группу
   - Дедупликация по tokenId+price (хранится в sent-alerts.json, очищается каждые 48ч)
   - Атомарная запись логов (temp file + rename)

## Ключевые файлы

| Файл | Назначение |
|------|------------|
| `src/monitor/order-monitor.ts` | Главный модуль, точка входа |
| `src/monitor/live-match-finder.ts` | Поиск LIVE матчей через Gamma API |
| `src/monitor/order-tracker.ts` | Delta detection для ордеров |
| `src/monitor/alert-manager.ts` | Telegram алерты + логи |
| `src/parsers/polymarket-websocket.ts` | WebSocket клиент CLOB |

## API Polymarket

### Gamma API (REST)
```
GET https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=500&order=gameStartTime
```

Ключевые поля:
- `gameStartTime` — время начала матча (только спорт)
- `acceptingOrders` — true=LIVE, false=finished
- `closed` — рынок закрыт
- `clobTokenIds` — JSON массив token IDs
- `slug` — идентификатор матча (nba-lal-bos-2025-11-28)

### CLOB WebSocket
- URL: wss://ws-subscriptions-clob.polymarket.com/ws/market
- Требует аутентификацию (API key, secret, passphrase)
- Topic: `clob_market`, Type: `price_change`

## Конфигурация (.env)

```env
POLY_API_KEY=...
POLY_API_SECRET=...
POLY_PASSPHRASE=...

MONITOR_MIN_SIZE=10000        # Минимум shares
MONITOR_MIN_PRICE=0.10        # 10¢
MONITOR_MAX_PRICE=0.90        # 90¢
MONITOR_ALERT_AGE=120         # Секунд для алерта
MONITOR_MATCH_CHECK_INTERVAL=300000  # 5 минут
```

## Telegram

- Bot: @PolyFishAlert_bot
- Token: в alert-manager.ts
- Chat ID: -5052080545 (группа Monitor Fish)

## Частые задачи

### Изменить Telegram группу
`src/monitor/alert-manager.ts` → `telegramChatId`

### Добавить новый спорт
`src/monitor/live-match-finder.ts` → `matchPrefixes` массив

### Изменить формат алерта
`src/monitor/alert-manager.ts` → `sendTelegram()` метод

### Изменить фильтры ордеров
Через .env или `src/monitor/order-monitor.ts` → config defaults

## Деплой

```bash
# Сборка
npm run build

# Запуск через PM2
pm2 start dist/monitor/order-monitor.js --name monitor-fish

# Логи
pm2 logs monitor-fish
```

## Известные особенности

1. **Только BUY ордера** — SELL игнорируются, т.к. BUY на Team A = SELL на Team B
2. **6-часовое окно** — матчи старше 6 часов от gameStartTime игнорируются (защита от "зомби" рынков)
3. **Дедупликация алертов** — по tokenId+price, очищается каждые 48 часов
4. **Атомарная запись** — логи пишутся через temp file чтобы избежать corruption
