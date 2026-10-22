import importlib.util
import json
import tempfile
import unittest
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('monitor', Path(__file__).resolve().parents[1] / 'scripts/monitor.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class MonitorTests(unittest.TestCase):
    def setUp(self):
        self.today = date(2026, 1, 7)
        self.target = Decimal('9.20')

    def decide(self, rate, state=None, age=0):
        return m.decision(Decimal(rate), self.today-timedelta(days=age), self.today, self.target, 4, state or {})

    def test_crossing_duplicate_equality_recovery(self):
        send, state = self.decide('9.19')
        self.assertTrue(send)
        for rate in ['9.18', '9.20', '9.19']:
            send, state = self.decide(rate, state)
            self.assertFalse(send)
        send, state = self.decide('9.21', state)
        self.assertFalse(send)
        self.assertTrue(self.decide('9.19', state)[0])
        self.assertFalse(self.decide('9.20')[0])

    def test_stale_weekend_future_and_rollback(self):
        self.assertTrue(self.decide('9.1', age=3)[0])
        with self.assertRaises(ValueError): self.decide('9.1', age=5)
        with self.assertRaises(ValueError): self.decide('9.1', {'date':'2026-01-08'})
        with self.assertRaises(ValueError): m.observation([{'base':'CNY','quote':'GBP','date':'2099-01-01','rate':9}],self.today,'GBP')

    def test_changed_target_rearms(self):
        self.assertTrue(self.decide('9.1', {'target':'9.10','latched':True})[0])

    def test_invalid_rates(self):
        for n in ['NaN', 'Infinity', '-1', '0']:
            with self.assertRaises(ValueError): m.positive(n)

    def test_delivery_failure_does_not_write_state(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)/'state.json'
            initial = '{"target":"9.20","latched":false}'
            state.write_text(initial)
            row = {'base':'CNY','quote':'GBP','date':date.today().isoformat(),'rate':9.1}
            with patch.object(m,'get_json',return_value=[row]), patch.object(m,'send_telegram',side_effect=RuntimeError('failed')):
                with self.assertRaises(RuntimeError): m.run(state,{'targets':{'GBP':'9.20'},'max_age_days':4})
            self.assertEqual(state.read_text(),initial)

    def test_dry_run_and_test_mode_do_not_change_state(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)/'state.json'
            row={'base':'CNY','quote':'GBP','date':date.today().isoformat(),'rate':9.1}
            with patch.object(m,'get_json',return_value=[row]), patch.object(m,'send_telegram') as send:
                m.run(state,{'targets':{'GBP':'9.20'},'max_age_days':4},dry_run=True)
                send.assert_not_called()
                m.run(state,{},test=True)
                self.assertIn('测试',send.call_args.args[0])
            self.assertFalse(state.exists())

if __name__ == '__main__': unittest.main()
