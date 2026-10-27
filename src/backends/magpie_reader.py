#!/usr/bin/env python3
"""Read-only Magpie quota attribution; no outbound network requests."""
import datetime as dt
import json
import os
from collections import defaultdict
from decimal import Decimal, InvalidOperation
from pathlib import Path

UTC = dt.timezone.utc
WINDOWS = {"5 hours": dt.timedelta(hours=5), "7 days": dt.timedelta(days=7)}


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError("missing timestamp")
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timestamp has no timezone")
    return parsed.astimezone(UTC)


def number(value):
    if isinstance(value, bool):
        raise ValueError("invalid number")
    n = Decimal(str(value))
    if not n.is_finite() or n < 0:
        raise ValueError("invalid number")
    return n


def record_cost(row, models):
    """USD API-equivalent estimate; None means a row cannot be priced."""
    try:
        if row.get("cost") is not None:
            return number(row["cost"])
        counts = {k: number(row.get(k, 0)) for k in ("in", "out", "cache_read", "cache_write", "cache_write_1h")}
        if not any(counts.values()):
            return Decimal(0)
        name = row.get("served") or row.get("model")
        if name and name.startswith("claude/"):
            name = name[len("claude/"):]
        model = models.get(name)
        if not isinstance(model, dict) or not isinstance(model.get("cost"), dict):
            return None
        rates = model["cost"].copy()
        prompt = counts["in"] + counts["cache_read"] + counts["cache_write"]
        for tier in sorted(rates.get("tiers", []), key=lambda x: x.get("above", x.get("tier", {}).get("size", 0))):
            above = tier.get("above", tier.get("tier", {}).get("size", 0))
            if above and prompt > number(above):
                for field in ("input", "output", "cache_read", "cache_write", "cache_write_1h"):
                    if field in tier:
                        rates[field] = tier[field]
        hour = counts["cache_write_1h"]
        if hour > counts["cache_write"]:
            return None
        needed = [("input", counts["in"]), ("output", counts["out"]),
                  ("cache_read", counts["cache_read"]), ("cache_write", counts["cache_write"] - hour)]
        total = Decimal(0)
        for field, count in needed:
            if count and field not in rates:
                return None
            total += count * number(rates.get(field, 0))
        if hour:
            if "cache_write_1h" in rates:
                rate = number(rates["cache_write_1h"])
            elif "input" in rates:
                rate = number(rates["input"]) * 2
            else:
                return None
            total += hour * rate
        return total / Decimal(1_000_000)
    except (ValueError, TypeError, InvalidOperation):
        return None


def report(quotas, rows, models, key_inventory=(), now=None):
    now = now or dt.datetime.now(UTC)
    accounts = []
    for account_id, saved in quotas.items():
        quota = saved.get("quota", {})
        if quota.get("provider") != "claude" or not account_id.startswith("claude/"):
            continue
        read_at = timestamp(quota.get("readAt") or saved.get("at"))
        windows = []
        for window in quota.get("windows", []):
            label = window.get("name")
            if label not in WINDOWS:
                continue
            end = timestamp(window.get("resetsAt"))
            start = end - WINDOWS[label]
            until = min(read_at, end)
            groups = defaultdict(lambda: {"cost": Decimal(0), "calls": 0, "unpriced_calls": 0, "name": "未命名", "tokens": {"input": 0, "output": 0, "cacheRead": 0, "cacheCreate": 0, "total": 0}, "hours": set(), "is_active": True})
            for key in key_inventory:
                if key.get("id"):
                    groups[key["id"]]["name"] = key.get("name") or "未命名"
                    groups[key["id"]]["is_active"] = not bool(key.get("off"))
            for row in rows:
                try:
                    when = timestamp(row.get("t"))
                except ValueError:
                    continue
                identity = str(row.get("provider", "")) + "/" + str(row.get("providerAccount", ""))
                if identity.casefold() != account_id.casefold() or not start <= when < until:
                    continue
                key_id = row.get("callerKeyId") or "unattributed"
                g = groups[key_id]
                if key_id == "unattributed":
                    g["name"] = "未归属"
                elif g["name"] == "未命名" and row.get("callerKeyName"):
                    g["name"] = row["callerKeyName"]
                g["calls"] += 1
                g["hours"].add(when.replace(minute=0, second=0, microsecond=0))
                try:
                    for source, dest in (("in", "input"), ("out", "output"), ("cache_read", "cacheRead"), ("cache_write", "cacheCreate")):
                        value = int(number(row.get(source, 0)))
                        g["tokens"][dest] += value
                        g["tokens"]["total"] += value
                except (ValueError, TypeError, InvalidOperation):
                    pass
                amount = record_cost(row, models)
                if amount is None:
                    g["unpriced_calls"] += 1
                else:
                    g["cost"] += amount
            total = sum((g["cost"] for g in groups.values()), Decimal(0))
            unpriced = sum(g["unpriced_calls"] for g in groups.values())
            used = number(window["used"]) if window.get("used") is not None else None
            entries = []
            for key_id, g in sorted(groups.items(), key=lambda item: item[1]["cost"], reverse=True):
                share = g["cost"] / total * 100 if total and not unpriced else None
                entries.append({"key_id": key_id, "key_name": g["name"], "calls": g["calls"],
                    "estimated_cost_usd": float(g["cost"]), "unpriced_calls": g["unpriced_calls"],
                    "tokens": g["tokens"], "active_hours": len(g["hours"]), "is_active": g["is_active"],
                    "share_of_recorded_cost_percent": round(float(share), 4) if share is not None else None,
                    "estimated_account_quota_percentage_points": round(float(used * share / 100), 4) if share is not None and used is not None else None})
            windows.append({"name": label, "start": start.isoformat(), "reset_at": end.isoformat(),
                "account_used_percent_snapshot": float(used) if used is not None else None, "records_through": until.isoformat(),
                "snapshot_outside_window": not start <= read_at < end,
                "snapshot_window_expired": now >= end, "estimated_recorded_cost_usd": float(total),
                "unpriced_calls": unpriced, "keys": entries})
        accounts.append({"account": account_id, "plan": quota.get("plan"), "snapshot_at": read_at.isoformat(),
                         "snapshot_age_seconds": max(0, int((now - read_at).total_seconds())), "windows": windows})
    return {"method": "estimated_api_equivalent_cost", "currency": "USD",
        "scope": "Only locally recorded Magpie gateway usage for this account; excludes unknown outside usage.",
        "disclaimer": "Estimates are not actual subscription charges; quota attribution assumes recorded cost proportions match quota consumption.",
        "price_source": "Magpie locally cached anthropic model catalog, current prices; not historical billing rates.",
        "accounts": accounts}


def load_data(root):
    root = Path(root)
    with (root / "magpie/quotas.json").open() as f:
        quotas = json.load(f)
    with (root / "cache/magpie/models.json").open() as f:
        catalog = json.load(f)
    with (root / "magpie/caller-keys.json").open() as f:
        key_inventory = json.load(f)
    models = catalog.get("anthropic", {}).get("models", {})
    if not isinstance(models, dict):
        raise ValueError("local price catalog unavailable")
    rows = []
    malformed = 0
    with (root / "magpie/usage.jsonl").open() as f:
        for line in f:
            if not line.strip():
                continue
            try:
                row = json.loads(line)
                if not isinstance(row, dict):
                    raise ValueError("not object")
                if row.get("provider") == "claude":
                    timestamp(row.get("t"))
                rows.append(row)
            except (ValueError, json.JSONDecodeError):
                malformed += 1
    data = report(quotas, rows, models, key_inventory)
    data["malformed_usage_rows"] = malformed
    if malformed:
        for account in data["accounts"]:
            for window in account["windows"]:
                for key in window["keys"]:
                    key["share_of_recorded_cost_percent"] = None
                    key["estimated_account_quota_percentage_points"] = None
    return data



if __name__ == "__main__":
    print(json.dumps(load_data(os.environ["MAGPIE_DATA_DIR"]), ensure_ascii=False, allow_nan=False))
