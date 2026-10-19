"""Actual gateway process termination tests; robot and registry remain simulators."""
import argparse
import base64
import csv
import json
import os
import platform
import queue
import sqlite3
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import cryptography
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PrivateFormat, NoEncryption
from run_experiments import Gateway, RemoteService, canonical, public


class RobotService:
    """Independent HTTP simulator with its own SQLite, outside the worker process."""
    def __init__(self, path):
        self.path, self.events = str(path), []
        with sqlite3.connect(self.path) as db:
            db.execute("CREATE TABLE receipts (op_id TEXT PRIMARY KEY, result TEXT)")
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                op_id = body["op_id"]
                with sqlite3.connect(owner.path) as db:
                    if self.path == "/execute":
                        existed = db.execute("SELECT 1 FROM receipts WHERE op_id=?", (op_id,)).fetchone()
                        db.execute("INSERT OR IGNORE INTO receipts VALUES (?, 'DONE')", (op_id,))
                        response = {"status": "DONE"}
                        owner.events.append({"event": "EXECUTE", "op_id": op_id, "new_execution": not bool(existed)})
                    elif self.path == "/receipt":
                        found = db.execute("SELECT 1 FROM receipts WHERE op_id=?", (op_id,)).fetchone()
                        response = {"status": "DONE" if found else "UNKNOWN"}
                        owner.events.append({"event": "QUERY_RECEIPT", "op_id": op_id, "status": response["status"]})
                    else:
                        response = {"status": "UNKNOWN_ROUTE"}
                data = canonical(response)
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": .02}, daemon=True)
        self.thread.start()
        self.url = "http://127.0.0.1:" + str(self.server.server_port)

    def count(self):
        with sqlite3.connect(self.path) as db:
            return db.execute("SELECT COUNT(*) FROM receipts").fetchone()[0]

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)


class Experiment:
    def __init__(self, case_dir):
        self.directory = case_dir
        case_dir.mkdir(parents=True, exist_ok=False)
        self.issuer, self.actor, self.gwkey = [Ed25519PrivateKey.generate() for _ in range(3)]
        self.remote = RemoteService(self.issuer, public(self.gwkey))
        self.robot = RobotService(case_dir / "robot.sqlite")
        self.db_path = str(case_dir / "gateway.sqlite")
        self.key_dir = tempfile.TemporaryDirectory(prefix="offline_test_key_")
        self.key_path = Path(self.key_dir.name) / "ephemeral_gateway_key"
        raw = self.gwkey.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())
        self.key_path.write_bytes(base64.b64encode(raw))
        try:
            os.chmod(self.key_path, 0o600)
        except OSError:
            pass
        self.clock = {"now": 0, "trusted": True}
        self.events = []
        self.gw = Gateway(self.db_path, self.remote, self.gwkey, self.clock)

    def ready(self, quota=1):
        issued = self.remote.call("/grant", self.gw.grant_body(public(self.actor), quota=quota))
        if self.gw.install(issued["grant"]) != "INSTALLED":
            raise RuntimeError("Grant installation failed")
        self.gw.close()

    def req(self, op_id="op-1"):
        return self.gw.request(self.actor, op_id=op_id)

    def call(self, action, kill_phase=None, **extra):
        config = {"action": action, "kill_phase": kill_phase, "key_path": str(self.key_path),
                  "db_path": self.db_path, "registry_url": self.remote.url,
                  "robot_url": self.robot.url, "clock": dict(self.clock), **extra}
        proc = subprocess.Popen([sys.executable, str(Path(__file__).with_name("worker.py"))],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, encoding="utf-8")
        inbox = queue.Queue()
        reader = threading.Thread(target=lambda: inbox.put(proc.stdout.readline()), daemon=True)
        reader.start()
        try:
            proc.stdin.write(json.dumps(config) + "\n")
            proc.stdin.flush()
            try:
                line = inbox.get(timeout=15)
            except queue.Empty:
                raise RuntimeError("Worker did not reach result/checkpoint within 15 seconds")
            if not line:
                raise RuntimeError("Worker exited without a result: " + proc.stderr.read())
            message = json.loads(line)
            if message["type"] == "CHECKPOINT":
                if message["phase"] != kill_phase:
                    raise RuntimeError("Unexpected checkpoint")
                proc.kill()  # SIGKILL on POSIX; TerminateProcess on Windows.
                code = proc.wait(timeout=5)
                if code == 0:
                    raise RuntimeError("Killed worker reported clean exit")
                self.events.append({"event": "FORCED_TERMINATION", "pid": proc.pid,
                                    "phase": kill_phase, "return_code": code})
                return "KILLED"
            if message["type"] != "RESULT":
                raise RuntimeError("Unknown worker response")
            proc.stdin.close()
            code = proc.wait(timeout=5)
            if code != 0:
                raise RuntimeError("Worker failed: " + proc.stderr.read())
            self.events.append({"event": "WORKER_RESULT", "pid": proc.pid, "action": action,
                                "result": message["result"], "clock": dict(self.clock)})
            return message["result"]
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)
            for stream in (proc.stdin, proc.stdout, proc.stderr):
                if stream and not stream.closed:
                    stream.close()
            reader.join(timeout=1)

    def snapshot(self):
        with sqlite3.connect(self.db_path) as db:
            state = db.execute("SELECT used FROM state WHERE id=1").fetchone()
            records = [{"sequence": seq, "record": json.loads(body), "synced": bool(synced)}
                       for seq, body, synced in db.execute("SELECT seq, record_json, synced FROM journal ORDER BY seq")]
        return {"used": state[0], "records": records, "robot_count": self.robot.count(),
                "registry_count": len(self.remote.registry.records)}

    def evidence(self):
        return {"public_keys": {"issuer": public(self.issuer), "gateway": public(self.gwkey), "subject": public(self.actor)},
                "process_events": self.events, "robot_events": self.robot.events,
                "registry_events": self.remote.events, "snapshot": self.snapshot(),
                "registered_records": list(self.remote.registry.records.values())}

    def close(self):
        self.robot.close()
        self.remote.close()
        self.key_dir.cleanup()


def before_robot(e):
    e.ready()
    req = e.req()
    return [e.call("execute", "before_robot", request=req),
            e.call("execute", request=req), e.call("recover", op_id="op-1"),
            e.call("sync"), e.call("execute", request=e.req("op-2")), e.snapshot()["robot_count"]]


def after_robot(e):
    e.ready()
    req = e.req()
    return [e.call("execute", "after_robot", request=req), e.call("recover", op_id="op-1"),
            e.call("execute", request=req), e.call("sync"), e.snapshot()["robot_count"]]


def after_log(e):
    e.ready()
    req = e.req()
    return [e.call("execute", "after_log", request=req), e.call("execute", request=req),
            e.call("execute", request=e.req("op-2")), e.call("sync"), e.snapshot()["robot_count"]]


def registry_before_local_mark(e):
    e.ready()
    e.call("execute", request=e.req())
    killed = e.call("sync", "after_registry_ack")
    before = e.snapshot()
    retried = e.call("sync")
    after = e.snapshot()
    return [killed, before["registry_count"], before["records"][0]["synced"],
            retried, after["registry_count"], after["records"][0]["synced"]]


def lost_ack(e):
    e.ready()
    e.call("execute", request=e.req())
    e.remote.lose_ack = True
    return [e.call("sync"), e.call("sync"), e.snapshot()["registry_count"]]


def untrusted_restart(e):
    e.ready(quota=2)
    e.call("execute", "after_log", request=e.req())
    e.clock["trusted"] = False
    return [e.call("execute", request=e.req("op-2")), e.snapshot()["robot_count"], e.snapshot()["used"]]


def two_record_resume(e):
    e.ready(quota=2)
    e.call("execute", request=e.req())
    e.call("execute", request=e.req("op-2"))
    return [e.call("sync", "after_registry_ack"), e.call("sync"), e.snapshot()["registry_count"],
            [r["synced"] for r in e.snapshot()["records"]]]


CASES = [
    ("P1_before_robot", ["KILLED", "PENDING_OR_CONFLICT", "NEEDS_RECONCILIATION", ["PENDING"], "QUOTA_EXHAUSTED", 0], before_robot),
    ("P2_after_robot", ["KILLED", "RECOVERED", "REPLAY", ["ACCEPTED"], 1], after_robot),
    ("P3_after_log", ["KILLED", "REPLAY", "QUOTA_EXHAUSTED", ["ACCEPTED"], 1], after_log),
    ("P4_registry_before_local_mark", ["KILLED", 1, False, ["DUPLICATE"], 1, True], registry_before_local_mark),
    ("P5_lost_ack", [["UNAVAILABLE"], ["DUPLICATE"], 1], lost_ack),
    ("P6_untrusted_restart", ["CLOCK_UNTRUSTED", 1, 1], untrusted_restart),
    ("P7_two_record_resume", ["KILLED", ["DUPLICATE", "ACCEPTED"], 2, [True, True]], two_record_resume),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--output", default="stage2_results")
    args = parser.parse_args()
    if not 1 <= args.repeats <= 100:
        parser.error("--repeats must be 1..100")
    output = Path(args.output).resolve()
    if output.exists() and any(output.iterdir()):
        parser.error("Output directory is not empty; use a new --output to preserve previous evidence")
    output.mkdir(parents=True, exist_ok=True)
    rows, evidence = [], []
    for repeat in range(1, args.repeats + 1):
        for name, expected, fn in CASES:
            experiment = Experiment(output / "cases" / (name + "_r" + str(repeat)))
            try:
                actual = fn(experiment)
                passed = actual == expected
                ev = experiment.evidence()
                ev.update({"case": name, "repeat": repeat})
                evidence.append(ev)
            except Exception as exc:
                actual, passed = {"exception": repr(exc)}, False
                evidence.append({"case": name, "repeat": repeat, "process_events": experiment.events,
                                 "error": repr(exc)})
            finally:
                experiment.close()
            rows.append({"case": name, "repeat": repeat, "expected": expected, "actual": actual, "pass": passed})
            print(f"{'PASS' if passed else 'FAIL'} repeat={repeat} {name}", flush=True)
    (output / "results.json").write_text(json.dumps(rows, indent=2), encoding="utf-8")
    (output / "evidence.json").write_text(json.dumps(evidence, indent=2), encoding="utf-8")
    with (output / "results.csv").open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["case", "repeat", "expected", "actual", "pass"])
        writer.writeheader()
        for row in rows:
            writer.writerow({k: json.dumps(v) if isinstance(v, (list, dict)) else v for k, v in row.items()})
    scope = {"stage": "actual_gateway_process_termination_with_simulated_services", "python": sys.version,
             "platform": platform.platform(), "cryptography": cryptography.__version__,
             "case_types": len(CASES), "repeats": args.repeats, "runs": len(rows),
             "passed": sum(r["pass"] for r in rows),
             "forced_terminations": sum(ev.get("event") == "FORCED_TERMINATION" for e in evidence for ev in e.get("process_events", [])),
             "limitations": ["robot is HTTP/SQLite simulation", "registry is in-memory HTTP simulation, not EVM",
                             "only gateway worker killed; controller/services remain alive", "injected logical time",
                             "checkpoint-targeted SIGKILL/TerminateProcess, not power failure", "single gateway, sequential requests",
                             "test keys temporarily stored in local temp directory and removed normally; not production key custody"]}
    (output / "scope.json").write_text(json.dumps(scope, indent=2), encoding="utf-8")
    print(f"\n{scope['passed']}/{len(rows)} passed; forced terminations={scope['forced_terminations']}; output={output}")
    raise SystemExit(0 if all(r["pass"] for r in rows) else 1)


if __name__ == "__main__":
    main()
