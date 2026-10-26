# FX Watch

A small web app for buying GBP and USD through China CITIC Bank. It shows CITIC's customer buy price and sends a Telegram message when a price drops below your floor or rises above your ceiling.

Live at **[fx.etarc.net](https://fx.etarc.net)**. Works on iPhone and Mac as a home-screen / Dock app. Styled as a ship's engine order telegraph: the needle shows where the price sits between your floor and ceiling.

## What it does

- Shows the CITIC customer buy price (客户购汇价) for GBP→CNY and USD→CNY, refreshed every 30 seconds while open
- Checks both prices every 10 minutes. Each currency can have a floor (alert when the price drops below it) and a ceiling (alert when it rises above it). Each side alerts once, then re-arms only when the price is back inside by more than 0.1%, so a price wobbling around a limit doesn't alert repeatedly
- Shows the change since yesterday's last price, and a ticker tape of the last few quotes for the currency on the dial (CITIC publishes no history, so the Worker records both)
- Private: the app asks for a password once per device; without it the API returns nothing
- Floors and ceilings are set with number wheels in the app (drag or tap each digit); the dial previews the change before you save

Prices come from the feed behind the public rate table on citicbank.com. They are for reference only; the price in the CITIC app when you trade is final.

## How it works

One Cloudflare Worker:

| Part | Where |
|---|---|
| Web app | `public/` |
| API (`/api/rates`, `/api/history`, `/api/settings`, `/api/test`) | `src/worker.js` |
| Parsing, alert rules, messages | `src/logic.js` |
| Floors, ceilings, alert state, daily closing prices, ticker tape, 90-day price history | Workers KV (`STORE`) |
| 10-minute check | Cron trigger in `wrangler.jsonc` |

## Develop

```sh
echo 'EDIT_PASSWORD=localtest' > .dev.vars
npm run dev     # http://localhost:8787
npm test
```

## Deploy

Pushing to `main` deploys through Cloudflare Workers Builds. The Worker name must stay `fx-watch`.

Secrets (Cloudflare dashboard → fx-watch → Settings → Variables and Secrets):

| Name | What |
|---|---|
| `EDIT_PASSWORD` | Password to open the app (and change floors and ceilings) |
| `TELEGRAM_BOT_TOKEN` | From @BotFather |
| `TELEGRAM_CHAT_ID` | Your chat ID with the bot |

## Install

- **iPhone:** open the site in Safari → Share → Add to Home Screen
- **Mac:** open the site in Safari → File → Add to Dock
