"""Disposable gateway worker. Parent terminates this process at checkpoints."""
import base64
import json
import sys
import threading
import urllib.request
from pathlib import Path
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from run_experiments import Gateway, canonical


class HTTPClient:
    def __init__(self, url):
        self.url = url

    def call(self, path, body):
        req = urllib.request.Request(self.url + path, data=canonical(body),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=2) as response:
            return json.load(response)


class ProcessGateway(Gateway):
    def __init__(self, config):
        key = Ed25519PrivateKey.from_private_bytes(base64.b64decode(Path(config["key_path"]).read_bytes()))
        super().__init__(config["db_path"], HTTPClient(config["registry_url"]), key, config["clock"])
        self.robot = HTTPClient(config["robot_url"])
        self.kill_phase = config.get("kill_phase")

    def checkpoint(self, phase):
        if phase == self.kill_phase:
            print(json.dumps({"type": "CHECKPOINT", "phase": phase}), flush=True)
            threading.Event().wait()

    def robot_apply(self, op_id):
        response = self.robot.call("/execute", {"op_id": op_id})
        if response["status"] != "DONE":
            raise RuntimeError("Robot execution result unknown")

    def robot_receipt(self, op_id):
        response = self.robot.call("/receipt", {"op_id": op_id})
        return ("DONE",) if response["status"] == "DONE" else None


def main():
    config = json.loads(sys.stdin.readline())
    gw = ProcessGateway(config)
    try:
        action = config["action"]
        if action == "execute":
            result = gw.execute(config["request"])
        elif action == "sync":
            result = gw.sync()
        elif action == "recover":
            result = gw.finalize_pending(config["op_id"])
        else:
            raise ValueError("Unknown action")
        print(json.dumps({"type": "RESULT", "result": result}), flush=True)
    finally:
        gw.close()


if __name__ == "__main__":
    main()
