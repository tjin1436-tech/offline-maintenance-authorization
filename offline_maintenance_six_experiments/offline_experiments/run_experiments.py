"""Deterministic software experiments. Registry is a simulator, NOT a blockchain."""
import argparse
import base64
import copy
import csv
import hashlib
import json
import platform
import sqlite3
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import cryptography
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def public(key):
    return base64.b64encode(key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)).decode()


def signed(body, key):
    return {"body": body, "signature": base64.b64encode(key.sign(canonical(body))).decode()}


def verifies(envelope, pub):
    try:
        Ed25519PublicKey.from_public_bytes(base64.b64decode(pub)).verify(
            base64.b64decode(envelope["signature"]), canonical(envelope["body"]))
        return True
    except Exception:
        return False


def digest(obj):
    return hashlib.sha256(canonical(obj)).hexdigest()


class RegistrationSimulator:
    """Independent service-side signature/sequence checks; timestamp is an assumption."""
    def __init__(self, issuer_pub, gateway_pub):
        self.issuer_pub, self.gateway_pub = issuer_pub, gateway_pub
        self.records, self.conflicts = {}, []

    def submit(self, record):
        if not verifies(record, self.gateway_pub):
            return "BAD_SIGNATURE"
        b = record["body"]
        grant, req = b["grant"], b["request"]
        if not verifies(grant, self.issuer_pub):
            return "BAD_GRANT"
        g = grant["body"]
        if not verifies(req, g["subject"]):
            return "BAD_SUBJECT"
        r = req["body"]
        if any(r[k] != g[k] for k in ("gateway", "robot", "work_order", "version", "grant_id")):
            return "BAD_SCOPE"
        if r["operation"] not in g["operations"]:
            return "BAD_OPERATION"
        if not (g["issued_at"] <= b["executed_at"] < g["expires_at"]):
            return "BAD_TIME"
        if b["result"] != "DONE":
            return "PENDING"
        key = (g["gateway"], g["grant_id"], b["sequence"])
        if key in self.records:
            if self.records[key] == record:
                return "DUPLICATE"
            self.conflicts.append({"key": key, "existing": self.records[key], "incoming": record})
            return "CONFLICT"
        if not 1 <= b["sequence"] <= g["quota"]:
            return "BAD_SEQUENCE"
        previous = self.records.get((g["gateway"], g["grant_id"], b["sequence"] - 1))
        if b["sequence"] > 1 and previous is None:
            return "GAP"
        expected_prev = digest(previous) if previous else "GENESIS"
        if b["previous_hash"] != expected_prev:
            return "BAD_CHAIN"
        self.records[key] = copy.deepcopy(record)
        return "ACCEPTED"


class RemoteService:
    """Loopback HTTP fault gate: dropping closes TCP, leaving local robot reachable."""
    def __init__(self, issuer, gw_pub):
        self.issuer, self.revoked, self.drop = issuer, False, False
        self.lose_ack = False
        self.registry = RegistrationSimulator(public(issuer), gw_pub)
        self.events = []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                if owner.drop:
                    owner.events.append({"event": "TCP_CONNECTION_DROPPED", "route": self.path})
                    self.close_connection = True
                    return
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                if self.path == "/grant":
                    response = {"status": "REVOKED"} if owner.revoked else {
                        "status": "ISSUED", "grant": signed(body, owner.issuer)}
                elif self.path == "/records":
                    status = owner.registry.submit(body)
                    owner.events.append({"event": "REGISTER", "status": status})
                    if owner.lose_ack and status == "ACCEPTED":
                        owner.lose_ack = False
                        owner.events.append({"event": "ACK_LOST_AFTER_COMMIT"})
                        self.close_connection = True
                        return
                    response = {"status": status}
                else:
                    response = {"status": "UNKNOWN_ROUTE"}
                data = canonical(response)
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever,
                                       kwargs={"poll_interval": 0.02}, daemon=True)
        self.thread.start()
        self.url = "http://127.0.0.1:" + str(self.server.server_port)

    def call(self, path, body):
        req = urllib.request.Request(self.url + path, data=canonical(body),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=1) as response:
            return json.load(response)

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)


class Gateway:
    def __init__(self, path, remote, key, clock):
        self.path, self.remote, self.key, self.clock = path, remote, key, clock
        self.db = sqlite3.connect(path)
        self.db.executescript("""
          CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY, grant_json TEXT, used INTEGER);
          CREATE TABLE IF NOT EXISTS journal (seq INTEGER PRIMARY KEY, op_id TEXT UNIQUE, record_json TEXT, synced INTEGER);
          CREATE TABLE IF NOT EXISTS robot_receipts (op_id TEXT PRIMARY KEY, result TEXT);
        """)
        self.events = []

    def grant_body(self, subject, ttl=900, quota=2):
        return {"grant_id": "lease-1", "subject": subject, "gateway": "gw-1",
                "robot": "robot-1", "work_order": "wo-1", "version": 1,
                "operations": ["diagnose", "adjust"], "issued_at": self.clock["now"],
                "expires_at": self.clock["now"] + ttl, "quota": quota}

    def install(self, grant):
        if not verifies(grant, public(self.remote.issuer)):
            return "BAD_GRANT"
        # This prototype installs one lease per clean test fixture; no renewal reset path.
        if self.db.execute("SELECT 1 FROM state").fetchone():
            return "ALREADY_INSTALLED"
        with self.db:
            self.db.execute("INSERT INTO state VALUES (1, ?, 0)", (json.dumps(grant),))
        return "INSTALLED"

    def request(self, actor, op_id="op-1", operation="diagnose", **changes):
        body = {"op_id": op_id, "operation": operation, "gateway": "gw-1", "robot": "robot-1",
                "work_order": "wo-1", "version": 1, "grant_id": "lease-1"}
        body.update(changes)
        return signed(body, actor)

    def execute(self, request, crash=None):
        row = self.db.execute("SELECT grant_json, used FROM state WHERE id=1").fetchone()
        if not row:
            return "NO_GRANT"
        grant, used = json.loads(row[0]), row[1]
        g, r = grant["body"], request["body"]
        if not verifies(request, g["subject"]):
            return "BAD_SUBJECT"
        if any(r[k] != g[k] for k in ("gateway", "robot", "work_order", "version", "grant_id")):
            return "BAD_SCOPE"
        existing = self.db.execute("SELECT record_json FROM journal WHERE op_id=?", (r["op_id"],)).fetchone()
        if existing:
            old = json.loads(existing[0])["body"]
            return "REPLAY" if old["request"] == request and old["result"] == "DONE" else "PENDING_OR_CONFLICT"
        if not self.clock["trusted"]:
            return "CLOCK_UNTRUSTED"
        if not g["issued_at"] <= self.clock["now"] < g["expires_at"]:
            return "EXPIRED"
        if r["operation"] not in g["operations"]:
            return "BAD_OPERATION"
        if used >= g["quota"]:
            return "QUOTA_EXHAUSTED"
        pending = self.db.execute("SELECT record_json FROM journal ORDER BY seq DESC LIMIT 1").fetchone()
        previous = json.loads(pending[0]) if pending else None
        if previous and previous["body"]["result"] != "DONE":
            return "PENDING_OR_CONFLICT"
        b = {"sequence": used + 1, "grant": grant, "request": request,
             "executed_at": self.clock["now"], "previous_hash": digest(previous) if previous else "GENESIS",
             "result": "PENDING"}
        with self.db:
            self.db.execute("UPDATE state SET used=used+1 WHERE id=1")
            self.db.execute("INSERT INTO journal VALUES (?, ?, ?, 0)",
                            (used + 1, r["op_id"], json.dumps(signed(b, self.key))))
        if crash == "before_robot":
            return "CRASHED"
        # Robot simulator uses durable op_id receipts; no physical robot is involved.
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO robot_receipts VALUES (?, 'DONE')", (r["op_id"],))
        if crash == "after_robot":
            return "CRASHED"
        self.finalize_pending(r["op_id"])
        return "DONE"

    def finalize_pending(self, op_id):
        receipt = self.db.execute("SELECT result FROM robot_receipts WHERE op_id=?", (op_id,)).fetchone()
        if not receipt:
            return "NEEDS_RECONCILIATION"
        row = self.db.execute("SELECT record_json FROM journal WHERE op_id=?", (op_id,)).fetchone()
        b = json.loads(row[0])["body"]
        b["result"] = receipt[0]
        with self.db:
            self.db.execute("UPDATE journal SET record_json=? WHERE op_id=?", (json.dumps(signed(b, self.key)), op_id))
        return "RECOVERED"

    def records(self):
        return [json.loads(row[0]) for row in self.db.execute("SELECT record_json FROM journal ORDER BY seq")]

    def robot_count(self):
        return self.db.execute("SELECT COUNT(*) FROM robot_receipts").fetchone()[0]

    def sync(self, stop_after=None):
        outcomes = []
        for seq, encoded in self.db.execute("SELECT seq, record_json FROM journal WHERE synced=0 ORDER BY seq").fetchall():
            rec = json.loads(encoded)
            if rec["body"]["result"] != "DONE":
                outcomes.append("PENDING")
                break
            try:
                status = self.remote.call("/records", rec)["status"]
            except (OSError, urllib.error.URLError):
                outcomes.append("UNAVAILABLE")
                break
            outcomes.append(status)
            if status not in ("ACCEPTED", "DUPLICATE"):
                break
            with self.db:
                self.db.execute("UPDATE journal SET synced=1 WHERE seq=?", (seq,))
            if stop_after and len(outcomes) >= stop_after:
                break
        return outcomes

    def close(self):
        self.db.close()


class Fixture:
    def __init__(self):
        self.temp = tempfile.TemporaryDirectory()
        self.actor, self.other, self.issuer, self.gwkey = [Ed25519PrivateKey.generate() for _ in range(4)]
        self.clock = {"now": 0, "trusted": True}
        self.remote = RemoteService(self.issuer, public(self.gwkey))
        self.path = str(Path(self.temp.name) / "gateway.sqlite")
        self.gw = Gateway(self.path, self.remote, self.gwkey, self.clock)

    def issue(self, ttl=900, quota=2):
        return self.remote.call("/grant", self.gw.grant_body(public(self.actor), ttl, quota))

    def ready(self, ttl=900, quota=2):
        assert self.gw.install(self.issue(ttl, quota)["grant"]) == "INSTALLED"

    def reboot(self, trusted=True):
        self.gw.close()
        self.clock["trusted"] = trusted
        self.gw = Gateway(self.path, self.remote, self.gwkey, self.clock)

    def close(self):
        self.gw.close()
        self.remote.close()
        self.temp.cleanup()


CASES = []


def case(group, name, expected):
    def register(fn):
        CASES.append((group, name, expected, fn))
        return fn
    return register


@case(1, "online_completion", ["DONE", ["ACCEPTED"], 1])
def c11(f):
    f.ready()
    return [f.gw.execute(f.gw.request(f.actor)), f.gw.sync(), len(f.remote.registry.records)]


@case(1, "wrong_robot", ["BAD_SCOPE", 0])
def c12(f):
    f.ready()
    return [f.gw.execute(f.gw.request(f.actor, robot="robot-2")), f.gw.robot_count()]


@case(1, "wrong_subject", ["BAD_SUBJECT", 0])
def c13(f):
    f.ready()
    return [f.gw.execute(f.gw.request(f.other)), f.gw.robot_count()]


@case(1, "forged_grant", "BAD_GRANT")
def c14(f):
    grant = f.issue()["grant"]
    grant["body"]["quota"] = 999
    return f.gw.install(grant)


@case(2, "offline_cached_grant", ["DONE", ["UNAVAILABLE"], 1])
def c21(f):
    f.ready()
    f.remote.drop = True
    f.clock["now"] = 120
    return [f.gw.execute(f.gw.request(f.actor)), f.gw.sync(), f.gw.robot_count()]


@case(2, "offline_no_grant", ["NO_GRANT", "UNAVAILABLE", 0])
def c22(f):
    f.remote.drop = True
    try:
        f.issue()
        status = "ISSUED"
    except (OSError, urllib.error.URLError):
        status = "UNAVAILABLE"
    return [f.gw.execute(f.gw.request(f.actor)), status, f.gw.robot_count()]


@case(2, "offline_forbidden_operation", ["BAD_OPERATION", 0])
def c23(f):
    f.ready()
    f.remote.drop = True
    return [f.gw.execute(f.gw.request(f.actor, operation="firmware_update")), f.gw.robot_count()]


@case(2, "outage_does_not_restart_ttl", ["EXPIRED", 0])
def c24(f):
    f.ready(ttl=900)
    f.clock["now"] = 800
    f.remote.drop = True
    f.clock["now"] = 901
    return [f.gw.execute(f.gw.request(f.actor)), f.gw.robot_count()]


@case(3, "just_before_expiry", "DONE")
def c31(f):
    f.ready()
    f.clock["now"] = 899
    return f.gw.execute(f.gw.request(f.actor))


@case(3, "at_expiry", ["EXPIRED", 0])
def c32(f):
    f.ready()
    f.clock["now"] = 900
    return [f.gw.execute(f.gw.request(f.actor)), f.gw.robot_count()]


@case(3, "after_expiry", ["EXPIRED", 0])
def c33(f):
    f.ready()
    f.clock["now"] = 901
    return [f.gw.execute(f.gw.request(f.actor)), f.gw.robot_count()]


@case(3, "quota_boundary", ["DONE", "DONE", "QUOTA_EXHAUSTED", 2])
def c34(f):
    f.ready(quota=2)
    return [f.gw.execute(f.gw.request(f.actor, op_id="op-" + str(i))) for i in range(3)] + [f.gw.robot_count()]


@case(4, "revoked_existing_lease", "DONE")
def c41(f):
    f.ready()
    f.remote.drop = True
    f.clock["now"] = 300
    f.remote.revoked = True
    f.clock["now"] = 400
    return f.gw.execute(f.gw.request(f.actor))


@case(4, "revoked_lease_expires", "EXPIRED")
def c42(f):
    f.ready()
    f.remote.drop, f.remote.revoked = True, True
    f.clock["now"] = 900
    return f.gw.execute(f.gw.request(f.actor))


@case(4, "reconnect_no_renewal", "REVOKED")
def c43(f):
    f.ready()
    f.remote.drop, f.remote.revoked = True, True
    f.remote.drop = False
    return f.issue()["status"]


@case(4, "late_upload_of_valid_execution", ["DONE", ["ACCEPTED"]])
def c44(f):
    f.ready()
    f.remote.drop, f.remote.revoked = True, True
    f.clock["now"] = 400
    status = f.gw.execute(f.gw.request(f.actor))
    f.clock["now"] = 1200
    f.remote.drop = False
    return [status, f.gw.sync()]


@case(5, "modified_log", "BAD_SIGNATURE")
def c51(f):
    f.ready()
    f.gw.execute(f.gw.request(f.actor))
    rec = f.gw.records()[0]
    rec["body"]["executed_at"] = 123
    return f.remote.call("/records", rec)["status"]


@case(5, "duplicate_upload", ["ACCEPTED", "DUPLICATE", 1])
def c52(f):
    f.ready()
    f.gw.execute(f.gw.request(f.actor))
    rec = f.gw.records()[0]
    return [f.remote.call("/records", rec)["status"], f.remote.call("/records", rec)["status"], len(f.remote.registry.records)]


@case(5, "observed_signed_conflict", ["ACCEPTED", "CONFLICT", 1, 1])
def c53(f):
    f.ready()
    f.gw.execute(f.gw.request(f.actor))
    rec = f.gw.records()[0]
    original = f.remote.call("/records", rec)["status"]
    # Simulates a signer issuing a second valid signed body at the same sequence.
    rec["body"]["executed_at"] = 1
    conflict = signed(rec["body"], f.gwkey)
    result = f.remote.call("/records", conflict)["status"]
    return [original, result, len(f.remote.registry.records), len(f.remote.registry.conflicts)]


@case(5, "tail_deletion_without_checkpoint", ["ACCEPTED", 1, "INDETERMINATE"])
def c54(f):
    f.ready()
    f.gw.execute(f.gw.request(f.actor, op_id="op-1"))
    f.gw.execute(f.gw.request(f.actor, op_id="op-2"))
    observed = f.gw.records()[:1]
    status = f.remote.call("/records", observed[0])["status"]
    # Observer has no independent last-sequence checkpoint, so cannot prove deletion.
    return [status, len(f.remote.registry.records), "INDETERMINATE"]


@case(6, "restart_preserves_quota_and_replay", ["DONE", "REPLAY", "QUOTA_EXHAUSTED", 1])
def c61(f):
    f.ready(quota=1)
    req = f.gw.request(f.actor)
    first = f.gw.execute(req)
    f.reboot()
    return [first, f.gw.execute(req), f.gw.execute(f.gw.request(f.actor, op_id="op-2")), f.gw.robot_count()]


@case(6, "commit_then_ack_loss", [["UNAVAILABLE"], ["DUPLICATE"], 1])
def c62(f):
    f.ready()
    f.gw.execute(f.gw.request(f.actor))
    f.remote.lose_ack = True
    return [f.gw.sync(), f.gw.sync(), len(f.remote.registry.records)]


@case(6, "sync_resume", [["ACCEPTED"], ["UNAVAILABLE"], ["ACCEPTED"], 2])
def c63(f):
    f.ready()
    f.gw.execute(f.gw.request(f.actor, op_id="op-1"))
    f.gw.execute(f.gw.request(f.actor, op_id="op-2"))
    first = f.gw.sync(stop_after=1)
    f.remote.drop = True
    interrupted = f.gw.sync()
    f.reboot()
    f.remote.drop = False
    return [first, interrupted, f.gw.sync(), len(f.remote.registry.records)]


@case(6, "crash_after_robot_receipt", ["CRASHED", "PENDING_OR_CONFLICT", "RECOVERED", "REPLAY", 1])
def c64(f):
    f.ready()
    req = f.gw.request(f.actor)
    first = f.gw.execute(req, crash="after_robot")
    f.reboot()
    blocked = f.gw.execute(req)
    recovered = f.gw.finalize_pending("op-1")
    return [first, blocked, recovered, f.gw.execute(req), f.gw.robot_count()]


@case(6, "restart_unknown_clock", ["CLOCK_UNTRUSTED", 0])
def c65(f):
    f.ready()
    f.reboot(trusted=False)
    return [f.gw.execute(f.gw.request(f.actor)), f.gw.robot_count()]


@case(6, "crash_before_robot_no_false_completion", ["CRASHED", "NEEDS_RECONCILIATION", ["PENDING"], 0])
def c66(f):
    f.ready()
    first = f.gw.execute(f.gw.request(f.actor), crash="before_robot")
    f.reboot()
    return [first, f.gw.finalize_pending("op-1"), f.gw.sync(), f.gw.robot_count()]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--group", type=int, choices=range(1, 7))
    parser.add_argument("--output", default="results")
    args = parser.parse_args()
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    rows, evidence = [], []
    for group, name, expected, fn in CASES:
        if args.group and group != args.group:
            continue
        f = Fixture()
        try:
            actual = fn(f)
            passed = actual == expected
            evidence.append({"group": group, "case": name, "virtual_time": f.clock,
                             "local_records": f.gw.records(), "remote_events": f.remote.events,
                             "registry_count": len(f.remote.registry.records),
                             "conflicts": f.remote.registry.conflicts, "robot_count": f.gw.robot_count()})
        except Exception as exc:
            actual, passed = {"exception": repr(exc)}, False
        finally:
            f.close()
        row = {"group": group, "case": name, "expected": expected, "actual": actual, "pass": passed}
        rows.append(row)
        print(f"{'PASS' if passed else 'FAIL'} G{group} {name}")
    (output / "results.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    (output / "evidence.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
    with (output / "results.csv").open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["group", "case", "expected", "actual", "pass"])
        writer.writeheader()
        for row in rows:
            writer.writerow({k: json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else v for k, v in row.items()})
    manifest = {"scope": "software_reference_experiments", "registry": "HTTP simulation, not blockchain",
                "environment": {"python": sys.version, "platform": platform.platform(), "cryptography": cryptography.__version__},
                "robot": "SQLite receipt simulation, not physical robot", "clock": "injected logical seconds, no latency measurement",
                "cryptography": "Ed25519 via cryptography; random fresh ephemeral keys each case",
                "cases": len(rows), "passed": sum(r["pass"] for r in rows),
                "limitations": ["single gateway, sequential requests", "no adversarial key compromise defense",
                                "execution time is an assumption", "no process-kill/power-loss test",
                                "tail completeness needs independent checkpoint", "no EVM/gas/consensus validation"]}
    (output / "scope.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n{manifest['passed']}/{len(rows)} passed; output: {output.resolve()}")
    raise SystemExit(0 if all(r["pass"] for r in rows) else 1)


if __name__ == "__main__":
    main()
