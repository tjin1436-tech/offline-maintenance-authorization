import argparse
import csv
import hashlib
import json
import platform
import random
import statistics
import sys
from collections import defaultdict
from pathlib import Path
from policy_model import DEFAULT, PATTERNS, RISKS, POLICIES, SUITES, make_trace, simulate

MEASURES = ("completion_rate", "capability_exposure_s", "issued_lease_upper_exposure_s", "post_revocation_executions", "authorization_calls", "mean_deferred_upload_wait_s", "max_backlog_records", "mean_issued_ttl_s")


def write_csv(path, rows):
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def summaries(rows, bootstrap_reps):
    groups = defaultdict(list)
    for row in rows:
        groups[(row["pattern"], row["risk"], row["suite"], row["policy"])].append(row)
    summary = []
    for key, values in sorted(groups.items()):
        out = dict(zip(("pattern", "risk", "suite", "policy"), key))
        out["n_traces"] = len(values)
        for measure in MEASURES:
            valid = [v[measure] for v in values if v[measure] is not None]
            out[measure + "_n"] = len(valid)
            out[measure + "_mean"] = statistics.mean(valid) if valid else None
        summary.append(out)
    pairs = []
    for key, values in sorted(groups.items()):
        pattern, risk, suite, policy = key
        if policy == "fixed_15m":
            continue
        baseline = {v["seed"]: v for v in groups[(pattern, risk, suite, "fixed_15m")]}
        assert set(baseline) == {v["seed"] for v in values}
        out = {"pattern": pattern, "risk": risk, "suite": suite, "policy": policy,
               "baseline": "fixed_15m", "n_pairs": len(values)}
        token = "|".join(key).encode()
        rng = random.Random(int.from_bytes(hashlib.sha256(token).digest()[:8], "big"))
        for measure in ("completion_rate", "capability_exposure_s", "issued_lease_upper_exposure_s", "authorization_calls"):
            differences = [v[measure] - baseline[v["seed"]][measure] for v in values
                           if v[measure] is not None and baseline[v["seed"]][measure] is not None]
            out[measure + "_n_pairs"] = len(differences)
            if not differences:
                for suffix in ("difference_mean", "difference_ci_low", "difference_ci_high"):
                    out[measure + "_" + suffix] = None
                continue
            indices = [[rng.randrange(len(differences)) for _ in differences] for _ in range(bootstrap_reps)]
            resamples = sorted(statistics.mean(differences[i] for i in sample) for sample in indices)
            out[measure + "_difference_mean"] = statistics.mean(differences)
            out[measure + "_difference_ci_low"] = resamples[int(.025 * (len(resamples) - 1))]
            out[measure + "_difference_ci_high"] = resamples[int(.975 * (len(resamples) - 1))]
        pairs.append(out)
    return summary, pairs


def main():
    parser = argparse.ArgumentParser(description="Paired synthetic-trace policy comparison, not system performance")
    parser.add_argument("--seeds", type=int, default=30)
    parser.add_argument("--seed-start", type=int, default=1000)
    parser.add_argument("--bootstrap", type=int, default=500)
    parser.add_argument("--output", default="stage4_results")
    args = parser.parse_args()
    if not 2 <= args.seeds <= 200 or not 100 <= args.bootstrap <= 5000:
        parser.error("--seeds must be 2..200; --bootstrap must be 100..5000")
    output = Path(args.output)
    if output.exists() and any(output.iterdir()):
        parser.error("Output directory is not empty; choose a new --output")
    output.mkdir(parents=True, exist_ok=True)
    config = {**DEFAULT, "seed_start": args.seed_start, "seeds": args.seeds, "bootstrap_reps": args.bootstrap,
              "primary_policy": "adaptive_q90", "primary_baseline": "fixed_15m"}
    rows, witnesses, traces = [], [], []
    for pattern in PATTERNS:
        for seed in range(args.seed_start, args.seed_start + args.seeds):
            trace = make_trace(pattern, seed, config)
            traces.append(trace)
            for risk in RISKS:
                for suite in SUITES:
                    for policy in POLICIES:
                        row, witness = simulate(trace, policy, risk, suite, config, capture=seed == args.seed_start)
                        rows.append(row)
                        if witness:
                            witnesses.append(witness)
        print("Completed pattern:", pattern, flush=True)
    summary, pairs = summaries(rows, args.bootstrap)
    for name, value in (("config.json", config), ("traces.json", traces), ("witnesses.json", witnesses),
                        ("run_metrics.json", rows), ("summary.json", summary), ("paired_differences.json", pairs)):
        (output / name).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    for name, values in (("run_metrics.csv", rows), ("summary.csv", summary), ("paired_differences.csv", pairs)):
        write_csv(output / name, values)
    scope = {"stage": "synthetic_trace_policy_simulation", "python": sys.version, "platform": platform.platform(),
             "network_traces": len(traces), "risks": len(RISKS), "policies": len(POLICIES), "suites": len(SUITES),
             "policy_runs": len(rows), "witness_runs": len(witnesses), "trace_hash": hashlib.sha256((output / "traces.json").read_bytes()).hexdigest(),
             "limitations": ["synthetic network/tasks, not deployed-system observations", "discrete 10-second logical clock",
                "no EVM gas or consensus timing measured", "instantaneous connectivity knowledge and zero service latency",
                "online upload clears all backlog immediately; final reconnection imposed at horizon",
                "issued old lease honored until original deadline/quota even after revocation notice",
                "requester uses current cached grant; conservative all-issued upper bound ignores quota and supersession",
                "bootstrap unit is a whole trace; pointwise exploratory intervals, not corrected multiple tests"]}
    (output / "scope.json").write_text(json.dumps(scope, indent=2), encoding="utf-8")
    print("\nPolicy runs:", len(rows), "; output:", output.resolve())


if __name__ == "__main__":
    main()
