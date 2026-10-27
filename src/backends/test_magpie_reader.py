import datetime as dt
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from decimal import Decimal
from pathlib import Path

import magpie_reader as q


class QuotaTests(unittest.TestCase):
    def setUp(self):
        self.now = dt.datetime(2026, 10, 27, 12, tzinfo=dt.timezone.utc)
        self.quotas = {"claude/person@example.com": {"quota": {"provider": "claude", "plan": "max", "readAt": "2026-10-27T12:00:00Z", "windows": [
            {"name": "5 hours", "used": 20, "resetsAt": "2026-10-27T14:00:00Z"},
            {"name": "7 days", "used": 40, "resetsAt": "2026-11-01T00:00:00Z"}]}}}
        self.models = {"sonnet": {"cost": {"input": 2, "output": 10, "cache_read": 0.1, "cache_write": 2.5}}}
        self.base = {"t": "2026-10-27T10:00:00Z", "provider": "claude", "providerAccount": "person@example.com", "served": "sonnet"}

    def test_cache_split_and_cost(self):
        row = {**self.base, "in": 100, "out": 10, "cache_read": 50, "cache_write": 80, "cache_write_1h": 30}
        expected = (Decimal(100)*2 + Decimal(10)*10 + Decimal(50)*Decimal('0.1') + Decimal(50)*Decimal('2.5') + Decimal(30)*4) / Decimal(1000000)
        self.assertEqual(q.record_cost(row, self.models), expected)

    def test_account_window_keys_unattributed_and_snapshot_boundary(self):
        rows = [
            {**self.base, "callerKeyId": "a", "callerKeyName": "A", "in": 100},
            {**self.base, "callerKeyId": "b", "callerKeyName": "B", "in": 300},
            {**self.base, "in": 100},
            {**self.base, "callerKeyId": "a", "in": 900, "t": "2026-10-27T12:01:00Z"},
            {**self.base, "callerKeyId": "a", "in": 900, "providerAccount": "other@example.com"},
            {**self.base, "callerKeyId": "a", "in": 100, "t": "2026-10-27T08:30:00Z"},
        ]
        account = q.report(self.quotas, rows, self.models, [{"id":"z", "name":"unused"}], now=self.now)["accounts"][0]
        five, week = account["windows"]
        by_id = {x["key_id"]: x for x in five["keys"]}
        self.assertEqual(by_id['a']['share_of_recorded_cost_percent'], 20)
        self.assertEqual(by_id['b']['share_of_recorded_cost_percent'], 60)
        self.assertEqual(by_id['unattributed']['share_of_recorded_cost_percent'], 20)
        self.assertEqual(by_id['z']['share_of_recorded_cost_percent'], 0)
        self.assertEqual(by_id['b']['estimated_account_quota_percentage_points'], 12)
        self.assertEqual({x['key_id']:x for x in week['keys']}['a']['share_of_recorded_cost_percent'], 33.3333)

    def test_missing_price_never_fabricates_ratio(self):
        rows = [{**self.base, 'callerKeyId':'a', 'in':1}, {**self.base, 'callerKeyId':'b', 'in':1, 'served':'missing'}]
        window = q.report(self.quotas, rows, self.models, now=self.now)['accounts'][0]['windows'][0]
        self.assertEqual(window['unpriced_calls'], 1)
        self.assertTrue(all(x['share_of_recorded_cost_percent'] is None for x in window['keys']))

    def test_empty_usage_has_undefined_share(self):
        window = q.report(self.quotas, [], self.models, [{'id':'a','name':'A'}], now=self.now)['accounts'][0]['windows'][0]
        self.assertIsNone(window['keys'][0]['share_of_recorded_cost_percent'])

    def test_missing_utilization_is_unknown_not_zero(self):
        self.quotas['claude/person@example.com']['quota']['windows'][0].pop('used')
        row = {**self.base, 'callerKeyId': 'a', 'in': 1}
        window = q.report(self.quotas, [row], self.models, now=self.now)['accounts'][0]['windows'][0]
        self.assertIsNone(window['account_used_percent_snapshot'])
        self.assertIsNone(window['keys'][0]['estimated_account_quota_percentage_points'])

    def test_tier_price_and_unknown_cache(self):
        model = {'sonnet': {'cost': {'input':2, 'output':10, 'cache_read':0.1, 'cache_write':2.5,
                    'tiers':[{'tier':{'size':100}, 'input':4, 'output':20}]}}}
        self.assertEqual(q.record_cost({**self.base,'in':101},model), Decimal(404)/1000000)
        self.assertIsNone(q.record_cost({**self.base,'in':1,'cache_write':1,'cache_write_1h':2},model))


if __name__ == "__main__":
    unittest.main()
