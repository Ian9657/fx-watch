> GitHub 仓库须保持 Private。网页部署默认关闭；仅在确认网站访问权限后才设置 ENABLE_PAGES=true。后台通知也默认关闭，需另行配置和联调。

# 人民币汇率观察器 · 英镑购汇观察器

可直接部署到 GitHub Pages 的中文个人工具。采用原生 HTML / CSS / JavaScript + Python 标准库，无第三方运行依赖。当前为本地交付，尚未关联 GitHub 仓库、部署网站或启用通知。

## 可行性与边界

- Frankfurter v2 提供免密钥日参考汇率与历史序列，支持 CNY/GBP 与 CNY/USD。默认使用多来源混合参考中间价。不是实时行情，也不是中信银行实际购汇价。
- GitHub Pages 托管静态页面；GitHub Actions 每日检查；Telegram 发手机消息。无需常驻服务器。
- 日频数据无法捕捉日内低价；定时任务可能延迟甚至错过，不能作为交易系统。
- 网页保存的目标仅存于浏览器，**不会改变后台通知目标**。第一版用仓库配置管理后台目标，不在前端暴露写仓库权限或密钥。
- 网页不声称通知已启用：后台状态未接入页面。

## 本地运行

进入本项目目录，安装 Python 3.9+；测试还需 Node.js 18+（推荐 22+）。

```sh
npm start
```

打开 http://localhost:4173 。不需要 npm install。页面必须通过 HTTP 服务打开，不能直接双击 HTML。

```sh
npm test
```

页面从 Frankfurter 获取真实数据，无模拟行情。支持 30 / 90 / 365 天趋势、目标线、数据表、目标持久保存、失败重试和本机最新值缓存。超过 4 个 UTC 自然日的观察标记过期，缓存始终单独标注。远端来源暂时失败时不会将缓存称为最新行情。历史请求失败时不绘制虚构曲线。

## 部署到 GitHub Pages

1. 在 GitHub 创建独立空仓库，例如 `gbp-cny-watcher`。将**本目录内容（包括 .github）**作为仓库根目录上传；不要只上传 site 文件夹。
2. 使用 `main` 作为默认分支。Settings → Pages → Build and deployment → Source 选择 **GitHub Actions**。
3. 推送 main，或在 Actions 中手动运行 `Deploy GitHub Pages`。
4. 成功后从工作流的 github-pages 环境打开网站。相对资源路径兼容 `https://用户名.github.io/gbp-cny-watcher/`。

工作流仅发布 `site/`，不会发布 Python 脚本、配置或监测状态。已有仓库应先审阅合并，不要覆盖已有工作流。如默认分支不是 main，修改 pages.yml 中的 branches。

## 配置 Telegram（请在 GitHub Secrets 中保存，勿在聊天里发送 Token）

1. 在 Telegram 官方机器人 [@BotFather](https://t.me/BotFather) 使用 `/newbot` 创建机器人，取得 Bot Token。
2. 打开新建的机器人，点击 Start，发送一条消息。机器人不能在你未开始对话前主动联系你。
3. 在个人可信终端运行下面的 Python 小段，Token 通过隐藏输入读取，结果只打印聊天 ID。不要打开包含 Token 的网页地址或把 Token 放进命令参数。

```sh
python3 - <<'PY'
import getpass, json, urllib.request
key = getpass.getpass('Bot token: ')
try:
    with urllib.request.urlopen('https://api.telegram.org/bot'+key+'/getUpdates', timeout=20) as response:
        result = json.load(response)
    for update in result.get('result', []):
        message = update.get('message', {})
        chat = message.get('chat', {})
        if chat.get('type') == 'private':
            print('Chat ID:', chat['id'])
except Exception:
    print('读取失败，请核实 Token、网络和是否已向机器人发消息。')
PY
```

无结果时再次给机器人发消息，然后重试。若机器人已配置 webhook，getUpdates 不能同时使用；建议为本项目新建专用 Bot。

4. 仓库 Settings → Secrets and variables → Actions → Secrets，新增：
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
5. 编辑根目录 `config.json` 中 `target`（如 `"9.20"`），或在 Actions Variables 设置 `TARGET_RATE`。Variable 优先。只接受大于 0 且不超过 1000 的有限值。
6. 手动运行 `Daily GBP-CNY monitor`，先选择 `dry-run`（只读取真实数据、不发送、不修改状态）；再选 `test-notification`，确认手机收到标明“测试通知”的消息。最后选 `monitor` 测试实际检查：若此时已低于目标，会发送真实提醒。
7. 确认运行成功后，设置 Actions Variable `ENABLE_MONITORING` 为字符串 `true`，启用每日任务；删除它或改为其他值即停用每日检查。手动运行不受此开关影响。

### 时间与可靠性

- 每日 **17:17 UTC**：伦敦冬令时 17:17、夏令时 18:17；北京时间次日 01:17。不是精确调度保证。
- 定时工作流须在默认分支。公开仓库长时间（GitHub 当前规则为 60 天）无活动可能被停用定时任务；应定期检查 Actions。状态分支写入不保证防止停用。额度与费用以账户方案为准。
- 数据允许滞后 4 个自然日，以覆盖通常的周末；超过时工作流失败，不发达标提醒、不更改去重状态。长假可能触发这个保护，需要手动核查，不自动放宽。
- 首次有效检查已低于目标时通知；持续低于时抑制重复；**严格高于**目标重新布防；等于目标既不触发也不重新布防。更改后台目标会重置触发判断。
- 状态写入独立的 `monitor-state` 分支。首次不存在时视为首次检查；后续损坏状态会失败，避免静默重置。勿删除该分支，否则可能重新通知。
- Actions 使用 contents:write 写状态，需允许 GitHub Actions 写入该分支。分支保护或组织规则禁止写入时，请调整对应规则。并发组串行执行，避免并行覆盖。
- Telegram 拒绝、网络错误、过期/未来日期、数据倒退均失败。Telegram 发送成功才保存“已提醒”；发送失败下次仍可尝试。
- **不保证恰好一次**：消息已送达但响应丢失，或发送后状态推送失败，下次可能重复。不会盲目重试 Telegram 请求；请在失败后检查手机及 Actions 日志。
- 测试通知只验证 Telegram API 接受发送；手机是否显示推送取决于系统和 Telegram 通知设置。
- 前端缓存和目标仅在本设备。清理浏览器数据会清除它们。没有账户、银行登录、自动交易或 Web Push。

## 结构与扩展

- `site/data.js`：前端数据提供者边界，替换 API 时从这里修改。
- `site/app.js`：页面、目标价、趋势图和缓存。
- `scripts/monitor.py`：独立后台检查器，`API` 与 `observation()` 是数据提供者边界。
- `.github/workflows/pages.yml`：静态部署。
- `.github/workflows/monitor.yml`：定时检查、手动测试、去重状态持久化。
- `tests/`：数据校验、阈值比较、重复抑制、恢复、过期处理、发送失败与测试模式隔离。

后续若需网页修改后台目标，应增加有身份验证的后台 API；不能把 GitHub Token 放到浏览器里。接入银行真实购汇价前，应先找到可用且允许使用的正式接口。

## 官方资料

- [Frankfurter v2](https://frankfurter.dev/)：参数、数据来源和日频中间价说明。
- [GitHub Actions schedule](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)：默认分支、延迟与停用规则。
- [GitHub Pages 自定义工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)：部署权限和环境。
- [Telegram Bot API](https://core.telegram.org/bots/api#sendmessage)：sendMessage / getUpdates。
