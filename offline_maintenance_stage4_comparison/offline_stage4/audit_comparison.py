import argparse
import csv
import hashlib
import json
import math
from pathlib import Path
from policy_model import RISKS, simulate
from run_comparison import summaries


def is_online(trace, now):
    return not any(x["start"] <= now < x["end"] for x in trace["outages"])


def audit(path):
    path = Path(path)
    read = lambda name: json.loads((path / name).read_text(encoding="utf-8"))
    config, traces, rows, witnesses = read("config.json"), read("traces.json"), read("run_metrics.json"), read("witnesses.json")
    trace_map = {(t["pattern"], t["seed"]): t for t in traces}
    identity = lambda r: tuple(r[k] for k in ("pattern", "seed", "risk", "suite", "policy"))
    row_map = {identity(r): r for r in rows}
    failures = []
    if len(row_map) != len(rows):
        failures.append("Duplicate run identities")
    scope = read("scope.json")
    if scope["trace_hash"] != hashlib.sha256((path / "traces.json").read_bytes()).hexdigest():
        failures.append("Trace hash mismatch")
    if len(rows) != scope["policy_runs"] or len(traces) != scope["network_traces"]:
        failures.append("Scope count mismatch")
    for row in rows:
        expected, _ = simulate(trace_map[(row["pattern"], row["seed"])], row["policy"], row["risk"], row["suite"], config)
        if expected != row:
            failures.append("Replay mismatch: " + str(identity(row)))
    summary, pairs = summaries(rows, config["bootstrap_reps"])
    if summary != read("summary.json") or pairs != read("paired_differences.json"):
        failures.append("Summary or paired bootstrap mismatch")
    for name, values in (("run_metrics.csv", rows), ("summary.csv", summary), ("paired_differences.csv", pairs)):
        with (path / name).open(encoding="utf-8-sig", newline="") as f:
            csv_rows = list(csv.DictReader(f))
        if len(csv_rows) != len(values):
            failures.append(name + " count mismatch")
        for exported, value in zip(csv_rows, values):
            if any(exported[k] != ("" if v is None else str(v)) for k, v in value.items()):
                failures.append(name + " JSON/CSV mismatch")
                break
    for witness in witnesses:
        ident = witness["identity"]
        row = row_map[identity(ident)]
        trace = trace_map[(ident["pattern"], ident["seed"])]
        tau = witness["revocation_time"]
        grants = {g["grant_id"]: g for g in witness["grants"]}
        used, completed = {}, {}
        for grant in grants.values():
            issue, ttl = grant["issued_at"], grant["ttl_s"]
            assert is_online(trace, issue) and (tau is None or issue < tau), "Issuance without online/current authorization"
            assert grant["expires_at"] == issue + ttl and ttl <= RISKS[ident["risk"]], "Expiry/cap error"
            available = trace["history"] + [{"duration_s": e["end"] - e["start"], "observed_at": e["end"]}
                for e in trace["outages"] if e["end"] <= issue and not e.get("censored", False)]
            expected_history = available[-config["history_window"]:]
            assert grant["history"] == expected_history, "Future/missing historical observations"
            if ident["policy"].startswith("adaptive_"):
                alpha = int(ident["policy"].split("q")[1]) / 100
                history = sorted(h["duration_s"] for h in expected_history)
                q = history[math.ceil(alpha * len(history)) - 1]
                target = math.ceil(2 * (q + config["margin_s"]) / config["step_s"]) * config["step_s"]
                assert ttl == min(RISKS[ident["risk"]], max(config["minimum_ttl_s"], target)), "Adaptive formula mismatch"
        tasks = {t["task_id"]: t for t in trace["tasks"]}
        accepted = []
        for attempt in witness["attempts"]:
            now = attempt["time"]
            assert attempt["online"] == is_online(trace, now), "Network oracle mismatch"
            assert attempt["revoked"] == (tau is not None and now >= tau), "Revocation oracle mismatch"
            if ident["policy"] == "online":
                permitted = is_online(trace, now) and (tau is None or now < tau)
            else:
                before = attempt["lease_before"]
                latest = max((g for g in grants.values() if g["issued_at"] <= now), key=lambda g: g["issued_at"], default=None)
                assert (before is None) == (latest is None), "Missing/spurious lease snapshot"
                if latest is not None:
                    assert before["grant_id"] == latest["grant_id"], "Wrong active lease"
                    assert before["expires_at"] == latest["expires_at"], "Lease TTL reset"
                    assert before["remaining_quota"] == config["quota"] - used.get(before["grant_id"], 0), "Quota mismatch"
                permitted = before is not None and now < before["expires_at"] and before["remaining_quota"] > 0
            assert permitted == attempt["accepted"], "Wrong permit/deny decision"
            task = tasks[attempt["task_id"]]
            assert task["arrival"] <= now <= task["deadline"], "Attempt outside task deadline"
            if permitted:
                assert task["task_id"] not in completed, "Task executed twice"
                completed[task["task_id"]] = now
                accepted.append(attempt)
                if ident["policy"] != "online":
                    gid = attempt["lease_before"]["grant_id"]
                    used[gid] = used.get(gid, 0) + 1
        eligible = [t for t in trace["tasks"] if tau is None or t["arrival"] < tau]
        assert sum(t["task_id"] in completed for t in eligible) == row["completed_tasks"], "Completion numerator mismatch"
        assert len(eligible) == row["eligible_tasks"], "Completion denominator mismatch"
        assert sum(tau is not None and a["time"] >= tau for a in accepted) == row["post_revocation_executions"], "Post-revocation count mismatch"
        wait = sum(next(e["end"] - a["time"] for e in trace["outages"] if e["start"] <= a["time"] < e["end"])
                   for a in accepted if not a["online"])
        assert (wait / len(accepted) if accepted else None) == row["mean_deferred_upload_wait_s"], "Deferred wait mismatch"
        peak = max([sum(e["start"] <= a["time"] < e["end"] for a in accepted) for e in trace["outages"]] or [0])
        assert peak == row["max_backlog_records"], "Backlog mismatch"
        exposure = 0
        if tau is not None and ident["policy"] != "online":
            old = max((g for g in grants.values() if g["issued_at"] < tau), key=lambda g: g["issued_at"], default=None)
            if old:
                remaining = config["quota"] - sum(a["time"] < tau and a["lease_before"]["grant_id"] == old["grant_id"] for a in accepted)
                end = old["expires_at"]
                if remaining <= 0:
                    end = tau
                else:
                    for a in accepted:
                        if a["time"] >= tau and a["lease_before"]["grant_id"] == old["grant_id"]:
                            remaining -= 1
                            if remaining == 0:
                                end = min(end, a["time"])
                                break
                exposure = max(0, min(end, config["horizon_s"]) - tau)
        assert exposure == row["capability_exposure_s"], "Exposure integration mismatch"
        upper = 0 if tau is None or ident["policy"] == "online" else max(0,
            min(max((g["expires_at"] for g in grants.values()), default=tau), config["horizon_s"]) - tau)
        assert upper == row["issued_lease_upper_exposure_s"], "All-issued lease upper bound mismatch"
    return {"audit_success": not failures, "policy_runs_replayed": len(rows), "witness_runs_checked": len(witnesses),
            "paired_intervals_checked": len(pairs), "failures": failures,
            "limits": ["replay uses the same simulator; witness checks independently derive guards and selected metrics",
                       "synthetic traces and idealized service assumptions do not prove deployed-system behavior"]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default="stage4_results")
    args = parser.parse_args()
    try:
        result = audit(args.input)
    except Exception as exc:
        result = {"audit_success": False, "failures": [repr(exc)]}
    (Path(args.input) / "audit.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result, indent=2))
    raise SystemExit(0 if result["audit_success"] else 1)


if __name__ == "__main__":
    main()
