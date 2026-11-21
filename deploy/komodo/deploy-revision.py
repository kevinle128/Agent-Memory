#!/usr/bin/env python3
"""Deploy one image revision to a Komodo stack and wait until its containers are healthy.

Usage: deploy-revision.py <stack> <revision-variable> <revision>

The stack environment reads the image tag from the Komodo Variable named
<revision-variable> (MEMORY_BUILD_REVISION=[[AGENT_MEMORY_MEMORY_BUILD_REVISION]]), so
this script sets that Variable, runs DeployStack, waits for the Komodo update to
finish, and then waits until every container of the compose project runs the
new tag and reports healthy.

Environment: KOMODO_URL (default http://localhost:9120), KOMODO_API_KEY and
KOMODO_API_SECRET of a Komodo service user that may write Variables and deploy
the stack. It runs on the Komodo host, because the API listens there only.
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

URL = os.environ.get("KOMODO_URL", "http://localhost:9120").rstrip("/")
DEPLOY_TIMEOUT_S = 1200
HEALTH_TIMEOUT_S = 300


def kapi(endpoint: str, typ: str, params: dict) -> dict:
    req = urllib.request.Request(
        f"{URL}/{endpoint}",
        data=json.dumps({"type": typ, "params": params}).encode(),
        headers={
            "content-type": "application/json",
            "x-api-key": os.environ["KOMODO_API_KEY"],
            "x-api-secret": os.environ["KOMODO_API_SECRET"],
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.load(resp)


def wait_update(update: dict) -> bool:
    uid = update["_id"]["$oid"]
    deadline = time.time() + DEPLOY_TIMEOUT_S
    while True:
        u = kapi("read", "GetUpdate", {"id": uid})
        if u.get("status") == "Complete":
            break
        if time.time() > deadline:
            print("DeployStack did not finish in time", file=sys.stderr)
            return False
        time.sleep(5)
    for log in u.get("logs", []):
        text = ((log.get("stdout") or "") + (log.get("stderr") or "")).strip()
        if text and not log.get("success"):
            print(f"[{log.get('stage')}]\n" + "\n".join(text.splitlines()[-20:]))
    return bool(u.get("success"))


def containers(project: str) -> list[dict]:
    out = subprocess.run(
        ["docker", "ps", "-a", "--filter", f"label=com.docker.compose.project={project}",
         "--format", "{{json .}}"],
        capture_output=True, text=True, check=True,
    ).stdout
    rows = [json.loads(line) for line in out.splitlines() if line.strip()]
    for row in rows:
        row["Health"] = subprocess.run(
            ["docker", "inspect", "-f", "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}",
             row["ID"]],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
    return rows


def wait_healthy(project: str, revision: str) -> bool:
    deadline = time.time() + HEALTH_TIMEOUT_S
    while True:
        rows = containers(project)
        ready = rows and all(r["Image"].endswith(f":{revision}") and r["Health"] == "healthy" for r in rows)
        if ready:
            for r in rows:
                print(f"{r['Names']} {r['Image']} {r['Health']}")
            return True
        if time.time() > deadline:
            for r in rows:
                print(f"{r['Names']} {r['Image']} {r['Health']}", file=sys.stderr)
            print("containers did not become healthy on the new revision", file=sys.stderr)
            return False
        time.sleep(5)


def main() -> int:
    if len(sys.argv) != 4:
        print(__doc__, file=sys.stderr)
        return 2
    stack, variable, revision = sys.argv[1:]
    kapi("write", "UpdateVariableValue", {"name": variable, "value": revision})
    print(f"{variable}={revision}")
    if not wait_update(kapi("execute", "DeployStack", {"stack": stack, "services": []})):
        print("DeployStack failed", file=sys.stderr)
        return 1
    return 0 if wait_healthy(stack, revision) else 1


if __name__ == "__main__":
    sys.exit(main())
