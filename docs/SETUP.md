# Setup

**English** | [简体中文](SETUP.zh-CN.md)

From nothing to a running copy with Telegram alerts, in about 15 minutes. You need a GitHub account, a Cloudflare account (the free plan is enough) and Telegram.

## 1. Create a Telegram bot

1. In Telegram, open [@BotFather](https://t.me/BotFather) and send `/newbot`.
2. Give it a name, then a username ending in `bot`.
3. BotFather replies with a token like `123456789:AA…`. This is `TELEGRAM_BOT_TOKEN`.

## 2. Find your chat ID

1. Open your new bot and send it any message, e.g. `/start`.
2. In a browser, open `https://api.telegram.org/bot<token>/getUpdates`, with your token in place of `<token>`.
3. Find `"chat":{"id":…}`. That number is `TELEGRAM_CHAT_ID`.

If `result` is empty, send the bot another message and reload.

## 3. Choose a password

The page asks for it once per device, and every API request carries it. Use something long, e.g. the output of `openssl rand -base64 18`. This is `EDIT_PASSWORD`.

## 4. Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Ian9657/fx-watch)

1. Sign in to Cloudflare and connect your GitHub account when asked.
2. Keep or change the repository name, the Worker name and the KV namespace name.
3. Fill in the three secrets from steps 1–3.
4. Select **Create and deploy**. The first build takes a minute or two.

The new repository is yours, and Workers Builds redeploys it on every push to its `main`.

## 5. First run

1. Open the Worker's address, `https://<worker-name>.<subdomain>.workers.dev`. It is shown on the Worker's page in the dashboard.
2. Enter the password.
3. Select **Set floor & ceiling**, then **Send test message**. A message listing the current prices should arrive in Telegram.
4. Set a floor and ceiling, and select **Save**.

The status line reads `ALERTS NOT CHECKED YET` until the first scheduled check, at most 10 minutes later.

To show other currencies on the knob, turn the wheel in the sheet's title to the currency and switch **KNOB** on. The knob takes one to four.

## 6. Install on a phone

Open the address in Safari, then Share → Add to Home Screen. On a Mac, File → Add to Dock.

## Optional: a custom domain

If the domain's DNS is on Cloudflare, add it under the Worker's Settings → Domains & Routes.

## Updating

Your repository is a copy, not a fork. To bring in later changes:

```sh
git remote add upstream https://github.com/Ian9657/fx-watch.git
git pull upstream main
git push
```

The push redeploys. Saved limits and history are kept, since they live in KV.

## Troubleshooting

| What you see | Cause |
|---|---|
| `Wrong password.` | The password doesn't match `EDIT_PASSWORD`. Secrets can be changed under Settings → Variables and Secrets. |
| `Too many requests. Try again in a minute.` | More than 60 API requests in a minute from one address. Wait a minute; the limit is in `wrangler.jsonc` under `ratelimits`. |
| `TELEGRAM FAILED AT …` | Telegram rejected the message: check the token and chat ID, and that you have messaged the bot at least once. |
| `ALERTS LAST CHECKED …` | The Cron Trigger hasn't run for over 25 minutes. Check the Worker's Settings → Trigger Events. |
| A build stuck at "Initializing build environment" | A Cloudflare-side delay. Retry the build from the Worker's Deployments tab. |

## Free plan usage

Each 10-minute check writes at most two KV records (today's history and the alert state), plus one hourly rollup a day: under 300 writes a day against the free plan's 1,000. Chart requests use about 4 ms of CPU against a 10 ms limit.
