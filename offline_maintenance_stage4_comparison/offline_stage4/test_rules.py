import unittest
from policy_model import DEFAULT, choose_ttl, simulate
from run_comparison import MEASURES, summaries


def trace(times, outage=(100, 500), revoke=None):
    return {"pattern": "test", "seed": 1, "history": [{"duration_s": 100, "observed_at": -1}],
        "outages": [{"start": outage[0], "end": outage[1], "censored": False}],
        "tasks": [{"task_id": str(i), "arrival": t, "deadline": t} for i, t in enumerate(times)],
        "revocations": {"availability": None, "revocation_offline": revoke, "revocation_online": revoke}}


class Rules(unittest.TestCase):
    def setUp(self):
        self.config = {**DEFAULT, "horizon_s": 600, "step_s": 1}

    def test_expiry_exact_boundary(self):
        row, _ = simulate(trace([299, 300, 301]), "fixed_5m", "low", "availability", self.config)
        self.assertEqual(row["completed_tasks"], 1)

    def test_disconnect_does_not_reset_ttl(self):
        row, _ = simulate(trace([399]), "fixed_5m", "low", "availability", self.config)
        self.assertEqual(row["completed_tasks"], 0)

    def test_revocation_honors_old_lease_but_no_renewal(self):
        t = trace([120, 300], outage=(400, 500), revoke=100)
        row, witness = simulate(t, "fixed_5m", "low", "revocation_online", self.config, True)
        self.assertEqual(row["post_revocation_executions"], 1)
        self.assertEqual(row["capability_exposure_s"], 200)
        self.assertEqual(len(witness["grants"]), 1)

    def test_quota_not_reset_in_outage(self):
        row, _ = simulate(trace([120, 130]), "fixed_5m", "low", "availability", {**self.config, "quota": 1})
        self.assertEqual(row["completed_tasks"], 1)
        self.assertEqual(row["quota_blocked_attempts"], 1)

    def test_adaptive_cannot_see_future_outage(self):
        a, b = trace([90], outage=(100, 200)), trace([90], outage=(100, 500))
        _, wa = simulate(a, "adaptive_q90", "low", "availability", self.config, True)
        _, wb = simulate(b, "adaptive_q90", "low", "availability", self.config, True)
        prefix = lambda w: [g for g in w["grants"] if g["issued_at"] < 100]
        self.assertEqual(prefix(wa), prefix(wb))
        for g in wa["grants"]:
            self.assertTrue(all(h["observed_at"] <= g["issued_at"] for h in g["history"]))

    def test_shared_risk_cap_collapses_nominal_baselines(self):
        self.assertEqual(choose_ttl("fixed_60m", [], 900, self.config), 900)
        a, _ = simulate(trace([90, 120]), "fixed_15m", "moderate", "availability", self.config)
        b, _ = simulate(trace([90, 120]), "fixed_60m", "moderate", "availability", self.config)
        a.pop("policy"); b.pop("policy")
        self.assertEqual(a, b)

    def test_online_has_zero_revocation_exposure(self):
        row, _ = simulate(trace([90, 120], outage=(400, 500), revoke=100), "online", "low", "revocation_online", self.config)
        self.assertEqual(row["capability_exposure_s"], 0)
        self.assertEqual(row["post_revocation_executions"], 0)

    def test_shorter_new_lease_does_not_erase_old_deadline(self):
        t = trace([], outage=(100, 200), revoke=1100)
        t["history"] = [{"duration_s": 1000, "observed_at": -1}]
        config = {**self.config, "horizon_s": 2500, "history_window": 1}
        row, _ = simulate(t, "adaptive_q90", "low", "revocation_online", config)
        self.assertEqual(row["capability_exposure_s"], 190)
        self.assertEqual(row["issued_lease_upper_exposure_s"], 960)

    def test_empty_eligible_denominator_is_not_zero_success(self):
        rows = []
        for policy in ("fixed_15m", "adaptive_q90"):
            row = {"pattern": "unit", "seed": 1, "risk": "low", "suite": "revocation_online", "policy": policy,
                   **{m: 0 for m in MEASURES}}
            row["completion_rate"] = None
            rows.append(row)
        summary, pairs = summaries(rows, 100)
        self.assertTrue(all(r["completion_rate_n"] == 0 for r in summary))
        self.assertEqual(pairs[0]["completion_rate_n_pairs"], 0)
        self.assertIsNone(pairs[0]["completion_rate_difference_mean"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
