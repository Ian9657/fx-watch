# FX Watch

GBP→CNY and USD→CNY rates on iPhone and Mac, with a Telegram alert when a rate drops below a floor you set.

One Cloudflare Worker does everything:

- serves the web app from `public/`
- `/api/*` fetches live rates from Yahoo Finance and stores your floors in KV
- a cron trigger checks both rates every 10 minutes and sends a Telegram message on a drop below the floor (once per drop; it re-arms when the rate climbs back above)

## Develop

```sh
echo 'EDIT_PASSWORD=localtest' > .dev.vars
npm run dev     # http://localhost:8787
npm test
```

## Deploy

Pushing to `main` deploys through Cloudflare Workers Builds.

Secrets (Cloudflare dashboard → Worker → Settings → Variables and Secrets):

| Name | What |
|---|---|
| `EDIT_PASSWORD` | Password for changing floors in the app |
| `TELEGRAM_BOT_TOKEN` | From @BotFather |
| `TELEGRAM_CHAT_ID` | Your chat ID with the bot |

## Install

- **iPhone:** open the site in Safari → Share → Add to Home Screen
- **Mac:** open the site in Safari → File → Add to Dock

Rates are market mid rates; your bank's rate will differ.
