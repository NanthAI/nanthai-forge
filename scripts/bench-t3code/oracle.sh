#!/usr/bin/env bash
# B1.5d oracle (harness-only; pushed as .bench/ci.sh on an ephemeral grading branch, never in
# agent source): same toolchain as ci.sh, full suites of the four packages. Prints per file
# `ORACLE status path passed/total`, per case `ORACLE-CASE status path b64(fullName)
# b64(first failure line)` and per package `ORACLE-PACKAGE name status passed/total`.
set -uo pipefail
cd "$(dirname "$0")/.."
export VP_VERSION=1.4.0 VITE_PLUS_VERSION=1.4.0 CI=true
for attempt in 1 2 3; do
  curl -fsSL --connect-timeout 10 --max-time 120 https://viteplus.dev/install.sh | bash && break
  [ "$attempt" = 3 ] && exit 1; sleep 5
done
export PATH="$HOME/.local/share/vite-plus/bin:$HOME/.vite-plus/bin:$PATH"
[ -f "$HOME/.config/vite-plus/env" ] && . "$HOME/.config/vite-plus/env"
vp env use "$(sed -nE 's/.*"node": "([0-9.]+)".*/\1/p' package.json | head -1)"
packages="shared provider-pi client-runtime source-control-forgejo"
filters=(); for p in $packages; do filters+=(--filter "@t3tools/$p..."); done
vp install "${filters[@]}" || { echo "ORACLE install-failed"; exit 1; }
status=0
for p in $packages; do
  out="$RUNNER_TEMP/oracle-$p.json"
  if [ "$p" = client-runtime ]; then (cd "packages/$p" && vp test run --reporter=default --reporter=json --outputFile="$out") || status=1
  else (cd "packages/$p" && vp test run --config ../../vite.config.ts --dir . --reporter=default --reporter=json --outputFile="$out") || status=1; fi
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")), root = process.cwd() + "/";
    const b64 = s => Buffer.from(String(s ?? "")).toString("base64");
    for (const f of r.testResults) {
      const name = f.name.replace(root, "");
      console.log("ORACLE", f.status, name, f.assertionResults.filter(a => a.status === "passed").length + "/" + f.assertionResults.length);
      for (const a of f.assertionResults)
        console.log("ORACLE-CASE", a.status, name, b64(a.fullName), b64((a.failureMessages?.[0] ?? "").split("\n")[0].slice(0, 300)));
    }
    console.log("ORACLE-PACKAGE", process.argv[2], r.numFailedTestSuites + r.numFailedTests === 0 ? "passed" : "failed", r.numPassedTests + "/" + r.numTotalTests);
  ' "$out" "$p" || { echo "ORACLE-PACKAGE $p no-report"; status=1; }
done
exit $status
