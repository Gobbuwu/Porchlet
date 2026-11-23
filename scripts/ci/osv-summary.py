"""Summarise an OSV-Scanner run and cross-check its package count against the lockfile.

Usage: python3 -I scripts/ci/osv-summary.py <osv.json> <osv stderr log> <package-lock.json>
OSV's JSON lists only packages that have vulnerabilities, so the scanned count comes from its
"found N packages" log line. Exits 1 if that count differs from the unique name@version pairs
in the lockfile, so a scanner that silently reads nothing (or the wrong file) cannot pass.
"""

import json
import re
import sys

report = json.load(open(sys.argv[1]))
log = open(sys.argv[2]).read()
lock = json.load(open(sys.argv[3]))

for result in report.get("results", []):
    for pkg in result.get("packages", []):
        info = pkg["package"]
        for v in pkg.get("vulnerabilities", []):
            print(f'VULN {info["name"]}@{info["version"]}: {v["id"]} {v.get("summary", "")}')

in_lock = set()
for path, meta in lock["packages"].items():
    if path == "" or meta.get("link"):
        continue
    name = meta.get("name") or path.rsplit("node_modules/", 1)[-1]
    in_lock.add((name, meta["version"]))

found = re.findall(r"package-lock\.json file and found (\d+) packages", log)
scanned = int(found[-1]) if found else None
print(f"OSV scanned {scanned} packages; the lockfile has {len(in_lock)} unique name@version pairs")
if scanned != len(in_lock):
    print("FAIL: package count mismatch (or no 'found N packages' line in the OSV log)")
    sys.exit(1)
