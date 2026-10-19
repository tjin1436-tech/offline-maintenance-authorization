"""Offline artifact audit; exported public keys are assumed trusted test inputs."""
import argparse
import base64
import csv
import hashlib
import json
from pathlib import Path
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def verify_signature(envelope, pub):
    try:
        Ed25519PublicKey.from_public_bytes(base64.b64decode(pub, validate=True)).verify(
            base64.b64decode(envelope["signature"], validate=True), canonical(envelope["body"]))
        return True
    except Exception:
        return False


def inspect_record(record, keys):
    b = record["body"]
    grant, req = b["grant"], b["request"]
    g, r = grant["body"], req["body"]
    return {
        "gateway_signature": verify_signature(record, keys["gateway"]),
        "issuer_signature": verify_signature(grant, keys["issuer"]),
        "subject_signature": verify_signature(req, keys["subject"]),
        "subject_binding": g["subject"] == keys["subject"],
        "scope_binding": all(r[k] == g[k] for k in ("gateway", "robot", "work_order", "version", "grant_id")),
        "operation_scope": r["operation"] in g["operations"],
        "time_bounds": g["issued_at"] <= b["executed_at"] < g["expires_at"],
        "quota_bounds": 1 <= b["sequence"] <= g["quota"],
    }


def audit(directory):
    directory = Path(directory)
    rows = json.loads((directory / "results.json").read_text(encoding="utf-8"))
    evidence = json.loads((directory / "evidence.json").read_text(encoding="utf-8"))
    scope = json.loads((directory / "scope.json").read_text(encoding="utf-8"))
    failures, verified, invalid_attempts = [], 0, 0
    identities = lambda r: (r.get("group"), r["case"], r.get("repeat"))
    if len(rows) != len(evidence) or len({identities(r) for r in rows}) != len(rows):
        failures.append("Case count/uniqueness mismatch")
    if {identities(r) for r in rows} != {identities(e) for e in evidence}:
        failures.append("Result/evidence identities mismatch")
    if scope["passed"] != sum(r["pass"] is True for r in rows):
        failures.append("Scope passed count mismatch")
    if any(r["pass"] is not True or r["actual"] != r["expected"] for r in rows):
        failures.append("Functional failures or inconsistent pass flags")
    with (directory / "results.csv").open(encoding="utf-8-sig", newline="") as f:
        csv_rows = list(csv.DictReader(f))
    if len(csv_rows) != len(rows):
        failures.append("CSV row count mismatch")
    for row, csv_row in zip(rows, csv_rows):
        if csv_row["case"] != row["case"] or csv_row["pass"] != str(row["pass"]):
            failures.append("CSV identity/pass mismatch: " + row["case"])
        for field in ("expected", "actual"):
            value = json.loads(csv_row[field]) if isinstance(row[field], (dict, list)) else csv_row[field]
            if value != row[field]:
                failures.append("CSV content mismatch: " + row["case"])
    for e in evidence:
        name = e["case"] + ":" + str(e.get("repeat", ""))
        keys = e.get("public_keys")
        if not keys or any(k not in keys for k in ("issuer", "gateway", "subject")):
            failures.append(name + " missing issuer/gateway/subject public keys; rerun enhanced exporter")
            continue
        records = e.get("local_records")
        if records is None:
            records = [x["record"] for x in e["snapshot"]["records"]]
        previous = None
        for index, record in enumerate(records, 1):
            checks = inspect_record(record, keys)
            if not all(checks.values()):
                failures.append({"case": name, "local_sequence": index, "checks": checks})
            else:
                verified += 1
            expected_prev = hashlib.sha256(canonical(previous)).hexdigest() if previous else "GENESIS"
            if record["body"]["sequence"] != index or record["body"]["previous_hash"] != expected_prev:
                failures.append(name + " local hash chain/sequence mismatch")
            previous = record
        registered = e.get("registered_records", [])
        for record in registered:
            if record["body"]["result"] != "DONE" or not all(inspect_record(record, keys).values()):
                failures.append(name + " invalid accepted registry record")
        for conflict in e.get("conflicts", []):
            a, b = conflict["existing"], conflict["incoming"]
            if not all(inspect_record(a, keys).values()) or not all(inspect_record(b, keys).values()):
                failures.append(name + " conflict signatures invalid")
            if a == b or a["body"]["sequence"] != b["body"]["sequence"]:
                failures.append(name + " malformed conflict pair")
        for event in e.get("remote_events", e.get("registry_events", [])):
            if "record" not in event:
                continue
            checks = inspect_record(event["record"], keys)
            if event["status"] == "BAD_SIGNATURE":
                if checks["gateway_signature"]:
                    failures.append(name + " BAD_SIGNATURE attempt verifies unexpectedly")
                else:
                    invalid_attempts += 1
            elif event["status"] in ("ACCEPTED", "DUPLICATE", "CONFLICT") and not all(checks.values()):
                failures.append(name + " invalid record in registration event")
    return {"audit_success": not failures, "cases_checked": len(rows), "local_records_verified": verified,
            "expected_invalid_signature_attempts": invalid_attempts, "failures": failures,
            "limits": ["public keys are exported test identities, not externally certified trust anchors",
                       "signatures prove content integrity under these keys, not true execution time or physical repair",
                       "this audit does not replace independent runtime/network/chain observations"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    args = parser.parse_args()
    try:
        result = audit(args.input)
    except Exception as exc:
        result = {"audit_success": False, "failures": [repr(exc)]}
    output = Path(args.input) / "audit.json"
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(0 if result["audit_success"] else 1)


if __name__ == "__main__":
    main()
