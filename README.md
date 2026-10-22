# FX Watch

A small web app for buying GBP and USD through China CITIC Bank. It shows CITIC's customer buy price and sends a Telegram message when a price drops below a floor you set.

Live at **[fx.etarc.net](https://fx.etarc.net)**. Works on iPhone and Mac as a home-screen / Dock app.

## What it does

- Shows the CITIC customer buy price (客户购汇价) for GBP→CNY and USD→CNY, refreshed every 30 seconds while open
- Checks both prices every 10 minutes and sends one Telegram alert when a price drops below its floor; it re-arms once the price climbs back above
- Shows the change since yesterday's last price (CITIC publishes no history, so the Worker records it)
- Floors are edited in the app, protected by a password

Prices come from the feed behind the public rate table on citicbank.com. They are for reference only; the price in the CITIC app when you trade is final.

## How it works

One Cloudflare Worker:

| Part | Where |
|---|---|
| Web app | `public/` |
| API (`/api/rates`, `/api/settings`, `/api/test`) | `src/worker.js` |
| Parsing, alert rules, messages | `src/logic.js` |
| Floors, alert state, daily closing prices | Workers KV (`STORE`) |
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
| `EDIT_PASSWORD` | Password for changing floors in the app |
| `TELEGRAM_BOT_TOKEN` | From @BotFather |
| `TELEGRAM_CHAT_ID` | Your chat ID with the bot |

## Install

- **iPhone:** open the site in Safari → Share → Add to Home Screen
- **Mac:** open the site in Safari → File → Add to Dock
