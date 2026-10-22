"""Daily reference-rate monitor. Python standard library only; never logs secrets."""
import argparse
import json
import os
import sys
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from urllib.request import Request, urlopen

API = 'https://api.frankfurter.dev/v2/rates?base=CNY&quotes=GBP,USD'


def positive(value):
    number = Decimal(str(value))
    if not number.is_finite() or not 0 < number <= 1000:
        raise ValueError('Rate/target must be finite, positive and at most 1000')
    return number


def observation(rows, today, quote):
    if not isinstance(rows, list) or not rows:
        raise ValueError('Missing observations')
    valid = []
    for row in rows:
        if row.get('base') != 'CNY' or row.get('quote') != quote:
            raise ValueError('Unexpected currency pair')
        observed = date.fromisoformat(row['date'])
        if observed > today:
            raise ValueError('Future observation')
        valid.append((observed, positive(row['rate'])))
    return max(valid, key=lambda item: item[0])


def decision(rate, observed, today, target, max_age, previous):
    if (today - observed).days > max_age:
        raise ValueError('Stale observation: no alert or state change')
    if previous.get('date') and observed < date.fromisoformat(previous['date']):
        raise ValueError('Observation went backwards: no state change')
    below = rate < target
    same_target = previous.get('target') == str(target)
    # Equality does not re-arm: recovery must be strictly above the target.
    latched = bool(previous.get('latched', False)) if same_target else False
    notify = below and not latched
    if rate > target:
        latched = False
    if notify:
        latched = True
    return notify, {'target': str(target), 'latched': latched,
                    'date': observed.isoformat(), 'rate': str(rate)}


def get_json(url):
    with urlopen(Request(url, headers={'User-Agent': 'GBP-CNY-Watcher/1.0'}), timeout=25) as response:
        return json.load(response, parse_float=Decimal)


def send_telegram(message):
    token = os.environ.get('TELEGRAM_BOT_TOKEN')
    chat = os.environ.get('TELEGRAM_CHAT_ID')
    if not token or not chat:
        raise ValueError('Missing TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID')
    payload = json.dumps({'chat_id': chat, 'text': message}).encode()
    request = Request('https://api.telegram.org/bot' + token + '/sendMessage',
                      data=payload, headers={'Content-Type': 'application/json'}, method='POST')
    # Do not blindly retry sends: a timeout may occur after Telegram accepted a message.
    with urlopen(request, timeout=25) as response:
        result = json.load(response)
    if not result.get('ok'):
        raise RuntimeError('Telegram did not confirm delivery')


def run(state_path, config, test=False, dry_run=False, quote='GBP'):
    if test:
        send_telegram('【测试通知】GBP/CNY Watcher 通知通道测试。未判断汇率条件，不代表目标价已触发。')
        print('Test notification confirmed; threshold state unchanged.')
        return
    target = positive(config['targets'][quote])
    max_age = config['max_age_days']
    if type(max_age) is not int or not 0 <= max_age <= 7:
        raise ValueError('max_age_days must be an integer from 0 to 7')
    today = datetime.now(timezone.utc).date()
    observed, rate = observation(get_json(API), today, quote)
    previous = json.loads(state_path.read_text()) if state_path.exists() else {}
    if not isinstance(previous, dict):
        raise ValueError('Invalid persisted state')
    notify, state = decision(rate, observed, today, target, max_age, previous)
    if dry_run:
        print(f'DRY RUN: date={observed} rate={rate} target={target} would_notify={notify}; no delivery or state write.')
        return
    if notify:
        send_telegram(f'英镑购汇参考价已低于目标\n参考价：¥{rate} / £1\n观察日期：{observed}\n目标：低于 ¥{target}\n低于目标：¥{target-rate}\n来源：Frankfurter API v2（公开市场参考中间价）\nhttps://frankfurter.dev/\n非中信银行实际购汇报价；请在银行 App 核实。')
    state_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = state_path.with_suffix('.tmp')
    temporary.write_text(json.dumps(state, indent=2) + '\n')
    temporary.replace(state_path)
    print(f'Checked observation {observed}; notification={notify}; state saved.')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--state', type=Path, default=Path('monitor-state.json'))
    parser.add_argument('--config', type=Path, default=Path('config.json'))
    parser.add_argument('--pair', choices=['GBP','USD'], default=os.environ.get('MONITOR_PAIR','GBP'))
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--test-notification', action='store_true')
    mode.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    try:
        config = json.loads(args.config.read_text())
        if os.environ.get('TARGET_RATE'):
            config.setdefault('targets', {})[args.pair] = os.environ['TARGET_RATE']
        run(args.state, config, args.test_notification, args.dry_run, args.pair)
    except Exception as error:
        # Network errors can embed the bot-token URL: report type, never raw error text.
        print(f'Monitor failed ({type(error).__name__}); no new threshold state saved. Check data freshness, config, network and Secrets.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
