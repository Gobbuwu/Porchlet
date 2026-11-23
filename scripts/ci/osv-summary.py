"""Summarise an OSV-Scanner JSON report and cross-check its package count against the lockfile.

Usage: python3 scripts/ci/osv-summary.py <osv.json> <package-lock.json>
Exits 1 if OSV scanned a different number of packages than the lockfile holds, so a scanner
that silently reads nothing (or the wrong file) cannot pass.
"""

import json
import sys

report = json.load(open(sys.argv[1]))
lock = json.load(open(sys.argv[2]))

scanned = set()
vulns = []
for result in report.get("results", []):
    for pkg in result.get("packages", []):
        info = pkg["package"]
        scanned.add((info["name"], info["version"]))
        for v in pkg.get("vulnerabilities", []):
            vulns.append(f'{info["name"]}@{info["version"]}: {v["id"]} {v.get("summary", "")}')

in_lock = set()
for path, meta in lock["packages"].items():
    if path == "" or meta.get("link"):
        continue
    name = meta.get("name") or path.rsplit("node_modules/", 1)[-1]
    in_lock.add((name, meta["version"]))

print(f"OSV scanned {len(scanned)} unique packages; the lockfile has {len(in_lock)}")
for line in vulns:
    print("VULN", line)
missing = sorted(in_lock - scanned)
extra = sorted(scanned - in_lock)
if missing or extra:
    print("FAIL: package count mismatch")
    for n, v in missing[:20]:
        print(f"  not scanned: {n}@{v}")
    for n, v in extra[:20]:
        print(f"  not in lockfile: {n}@{v}")
    sys.exit(1)
