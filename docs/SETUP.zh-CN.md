# 配置教程

[English](SETUP.md) | **简体中文**

从零开始部署一份带 Telegram 提醒的副本，大约 15 分钟。需要 GitHub 账号、Cloudflare 账号（免费套餐即可）和 Telegram。

## 1. 创建 Telegram 机器人

1. 在 Telegram 中打开 [@BotFather](https://t.me/BotFather)，发送 `/newbot`。
2. 先起一个名字，再起一个以 `bot` 结尾的用户名。
3. BotFather 会回复一个形如 `123456789:AA…` 的 token，这就是 `TELEGRAM_BOT_TOKEN`。

## 2. 获取 chat ID

1. 打开刚创建的机器人，随便发一条消息，例如 `/start`。
2. 在浏览器中打开 `https://api.telegram.org/bot<token>/getUpdates`，把 `<token>` 换成你的 token。
3. 找到 `"chat":{"id":…}`，这个数字就是 `TELEGRAM_CHAT_ID`。

如果 `result` 为空，再给机器人发一条消息后刷新。

## 3. 设置密码

每台设备第一次打开页面时输入一次，之后每个 API 请求都会带上它。建议用较长的随机字符串，例如 `openssl rand -base64 18` 的输出。这就是 `EDIT_PASSWORD`。

## 4. 部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Ian9657/fx-watch)

1. 登录 Cloudflare，按提示关联 GitHub 账号。
2. 仓库名、Worker 名和 KV 命名空间名可以保留默认值，也可以修改。
3. 填入第 1 到 3 步得到的三个密钥。
4. 点击 **Create and deploy**。第一次构建需要一两分钟。

新仓库属于你自己，之后每次推送到它的 `main`，Workers Builds 都会重新部署。

## 5. 第一次使用

1. 打开 Worker 的地址 `https://<worker-name>.<subdomain>.workers.dev`，可以在 Cloudflare 控制台的 Worker 页面找到。
2. 输入密码。
3. 点 **Set floor & ceiling**，再点 **Send test message**。Telegram 应该会收到一条列出当前价格的消息。
4. 设置下限和上限，点 **Save**。

第一次定时检查（最多 10 分钟后）之前，状态栏会显示 `ALERTS NOT CHECKED YET`。

要在旋钮上显示其他货币：在设置面板标题里把币种滚轮转到该货币，打开 **KNOB** 开关。旋钮可放 1 到 4 种货币。

## 6. 安装到手机

用 Safari 打开地址，选 分享 → 添加到主屏幕。Mac 上选 文件 → 添加到程序坞。

## 可选：自定义域名

如果域名的 DNS 托管在 Cloudflare，可在 Worker 的 Settings → Domains & Routes 中添加。

## 更新

你的仓库是一份复制，不是 fork。要获取之后的更新：

```sh
git remote add upstream https://github.com/Ian9657/fx-watch.git
git pull upstream main
git push
```

推送后会自动重新部署。上下限设置和历史记录保存在 KV 中，不受影响。

## 常见问题

| 现象 | 原因 |
|---|---|
| `Wrong password.` | 密码与 `EDIT_PASSWORD` 不一致。密钥可在 Settings → Variables and Secrets 中修改。 |
| `TELEGRAM FAILED AT …` | Telegram 拒绝了消息：检查 token 和 chat ID，并确认至少给机器人发过一条消息。 |
| `ALERTS LAST CHECKED …` | 定时任务超过 25 分钟没有运行。检查 Worker 的 Settings → Trigger Events。 |
| 构建卡在 “Initializing build environment” | Cloudflare 端的延迟。在 Worker 的 Deployments 页面重试构建。 |

## 免费套餐用量

每次 10 分钟检查最多写入两条 KV 记录（当天历史和提醒状态），每天另有一次每小时汇总：每天不到 300 次写入，免费套餐上限为 1,000 次。走势图请求约用 4 ms CPU，上限为 10 ms。
