"""Trace-driven authorization simulation. No EVM, cryptographic or robot latency claims."""
import math
import random

PATTERNS = ("short", "mixed", "long", "shift", "recover")
RISKS = {"low": 3600, "moderate": 900}
POLICIES = ("online", "fixed_5m", "fixed_15m", "fixed_30m", "fixed_60m", "adaptive_q50", "adaptive_q90", "adaptive_q95")
SUITES = ("availability", "revocation_offline", "revocation_online")
DEFAULT = {"horizon_s": 14400, "step_s": 10, "task_deadline_s": 120, "retry_s": 30,
           "quota": 100, "history_window": 20, "history_count": 40, "minimum_ttl_s": 60,
           "margin_s": 30, "task_mean_interval_s": 90}


def quantile(values, alpha):
    """Nearest rank empirical quantile; no interpolation or unseen future duration."""
    values = sorted(values)
    return values[max(0, math.ceil(alpha * len(values)) - 1)]


def choose_ttl(policy, history, cap, config):
    if policy.startswith("fixed_"):
        nominal = int(policy.split("_")[1][:-1]) * 60
        return min(nominal, cap)
    if policy.startswith("adaptive_"):
        alpha = int(policy.split("q")[1]) / 100
        q = quantile([x["duration_s"] for x in history[-config["history_window"]:]], alpha)
        target = 2 * (q + config["margin_s"])
        rounded = math.ceil(target / config["step_s"]) * config["step_s"]
        return min(cap, max(config["minimum_ttl_s"], rounded))
    raise ValueError("Online-only strategy does not issue offline leases")


def offline_duration(rng, pattern, time, horizon):
    if pattern == "shift":
        pattern = "short" if time < horizon // 2 else "long"
    if pattern == "recover":
        pattern = "long" if time < horizon // 2 else "short"
    if pattern == "short":
        return rng.randint(3, 18) * 10
    if pattern == "long":
        return rng.randint(90, 240) * 10
    return rng.randint(6, 30) * 10 if rng.random() < .7 else rng.randint(60, 180) * 10


def make_trace(pattern, seed, config):
    pattern_index = PATTERNS.index(pattern)
    rng = random.Random(seed * 1009 + pattern_index * 9173)
    horizon, step = config["horizon_s"], config["step_s"]
    prior = [{"duration_s": offline_duration(rng, pattern, 0, horizon),
              "observed_at": -(config["history_count"] - i) * 4000}
             for i in range(config["history_count"])]
    outages = []
    time = 0
    while time < horizon:
        online_length = max(60, min(3600, math.ceil(rng.expovariate(1 / 900) / step) * step))
        start = time + online_length
        if start >= horizon:
            break
        duration = offline_duration(rng, pattern, start, horizon)
        end = min(start + duration, horizon)
        outages.append({"start": start, "end": end, "censored": start + duration > horizon})
        time = end
    task_rng = random.Random(seed * 3571 + pattern_index * 7307)
    tasks, now = [], 0
    while True:
        now += max(step, math.ceil(task_rng.expovariate(1 / config["task_mean_interval_s"]) / step) * step)
        if now > horizon - config["task_deadline_s"]:
            break
        tasks.append({"task_id": "task-" + str(len(tasks) + 1), "arrival": now,
                      "deadline": now + config["task_deadline_s"]})
    states = [not any(x["start"] <= t < x["end"] for x in outages)
              for t in range(0, horizon + step, step)]
    # Keep revocation <= H-3600 to avoid right-censoring any shared maximum lease.
    limit = horizon - max(RISKS.values())
    rev_rng = random.Random(seed * 181 + pattern_index * 487)
    offline_candidates = [t for t in range(step, limit + step, step) if not states[t // step]]
    online_candidates = [t for t in range(step, limit + step, step) if states[t // step]]
    if not offline_candidates or not online_candidates:
        raise ValueError("Trace has no suitable revocation stratum; change the horizon or seed")
    revocations = {"availability": None, "revocation_offline": rev_rng.choice(offline_candidates),
                   "revocation_online": rev_rng.choice(online_candidates)}
    return {"pattern": pattern, "seed": seed, "history": prior, "outages": outages,
            "tasks": tasks, "revocations": revocations}


def simulate(trace, policy, risk, suite, config, capture=False):
    cap, step, horizon = RISKS[risk], config["step_s"], config["horizon_s"]
    revocation = trace["revocations"][suite]
    history = [dict(x) for x in trace["history"]]
    lease, lease_id, notice, auth_calls, auth_denials = None, 0, False, 0, 0
    pending, arrivals, finished, backlog = [], 0, {}, []
    max_backlog, upload_wait_sum, uploaded = 0, 0, 0
    exposure, post_revocations, quota_blocks, ttl_sum, cap_hits, issued_deadline_max = 0, 0, 0, 0, 0, 0
    outages, outage_index, history_added = trace["outages"], 0, set()
    witness = {"grants": [], "attempts": []} if capture else None
    for now in range(0, horizon + step, step):
        while outage_index < len(outages) and outages[outage_index]["end"] <= now:
            episode = outages[outage_index]
            if not episode.get("censored", False):
                history.append({"duration_s": episode["end"] - episode["start"], "observed_at": episode["end"]})
                history_added.add(outage_index)
            outage_index += 1
        online = not (outage_index < len(outages) and outages[outage_index]["start"] <= now < outages[outage_index]["end"])
        revoked = revocation is not None and now >= revocation
        if policy != "online" and online and not notice:
            renew = lease is None or lease["expires_at"] - now <= lease["ttl_s"] // 2
            if renew:
                auth_calls += 1
                if revoked:
                    auth_denials += 1
                    notice = True  # No new grants; issued lease still honored until expiry/quota.
                else:
                    ttl = choose_ttl(policy, history, cap, config)
                    lease_id += 1
                    lease = {"grant_id": lease_id, "issued_at": now, "expires_at": now + ttl,
                             "ttl_s": ttl, "remaining_quota": config["quota"]}
                    ttl_sum += ttl
                    issued_deadline_max = max(issued_deadline_max, now + ttl)
                    cap_hits += ttl == cap
                    if capture:
                        witness["grants"].append({**lease, "history": [dict(x) for x in history[-config["history_window"]:]]})
        while arrivals < len(trace["tasks"]) and trace["tasks"][arrivals]["arrival"] == now:
            task = trace["tasks"][arrivals]
            pending.append({**task, "next_try": now})
            arrivals += 1
        remaining = []
        for task in pending:
            if task["next_try"] > now:
                remaining.append(task)
                continue
            before = dict(lease) if lease else None
            if policy == "online":
                if online:
                    auth_calls += 1
                    if revoked:
                        auth_denials += 1
                    accepted = not revoked
                    reason = "CENTRAL_REVOKED" if revoked else "ONLINE_ALLOWED"
                else:
                    accepted, reason = False, "NETWORK_UNAVAILABLE"
            elif lease is None:
                accepted, reason = False, "NO_GRANT"
            elif now >= lease["expires_at"]:
                accepted, reason = False, "EXPIRED"
            elif lease["remaining_quota"] <= 0:
                accepted, reason = False, "QUOTA_EXHAUSTED"
                quota_blocks += 1
            else:
                accepted, reason = True, "LEASE_ALLOWED"
            if capture:
                witness["attempts"].append({"time": now, "task_id": task["task_id"], "online": online,
                    "revoked": revoked, "accepted": accepted, "reason": reason, "lease_before": before})
            if accepted:
                if policy != "online":
                    lease["remaining_quota"] -= 1
                finished[task["task_id"]] = now
                if revoked:
                    post_revocations += 1
                if online:
                    uploaded += 1
                else:
                    backlog.append(now)
                    max_backlog = max(max_backlog, len(backlog))
            elif now < task["deadline"]:
                task["next_try"] = min(task["deadline"], now + config["retry_s"])
                remaining.append(task)
        pending = remaining
        if online and backlog:
            upload_wait_sum += sum(now - created for created in backlog)
            uploaded += len(backlog)
            backlog.clear()
        if now < horizon and revoked and policy != "online" and lease is not None:
            if now < lease["expires_at"] and lease["remaining_quota"] > 0:
                exposure += step
    if pending or backlog:
        raise AssertionError("Unresolved tasks/backlog at end; simulation contract violated")
    eligible = [t for t in trace["tasks"] if revocation is None or t["arrival"] < revocation]
    completed = sum(t["task_id"] in finished for t in eligible)
    all_completed = len(finished)
    result = {"pattern": trace["pattern"], "seed": trace["seed"], "risk": risk, "suite": suite, "policy": policy,
        "risk_cap_s": cap, "revocation_time": revocation, "eligible_tasks": len(eligible), "completed_tasks": completed,
        "completion_rate": completed / len(eligible) if eligible else None,
        "mean_task_wait_s": sum(finished[t["task_id"]] - t["arrival"] for t in eligible if t["task_id"] in finished) / completed if completed else None,
        "post_revocation_executions": post_revocations, "capability_exposure_s": exposure,
        "issued_lease_upper_exposure_s": max(0, min(issued_deadline_max, horizon) - revocation) if revocation is not None and policy != "online" else 0,
        "authorization_calls": auth_calls, "authorization_denials": auth_denials,
        "leases_issued": lease_id, "mean_issued_ttl_s": ttl_sum / lease_id if lease_id else 0,
        "risk_cap_hit_fraction": cap_hits / lease_id if lease_id else 0, "quota_blocked_attempts": quota_blocks,
        "max_backlog_records": max_backlog, "completed_all_tasks": all_completed,
        "mean_deferred_upload_wait_s": upload_wait_sum / all_completed if all_completed else None}
    if capture:
        witness.update({"identity": {k: result[k] for k in ("pattern", "seed", "risk", "suite", "policy")},
                        "revocation_time": revocation})
    return result, witness
