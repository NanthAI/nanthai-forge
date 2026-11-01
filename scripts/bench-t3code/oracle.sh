#!/usr/bin/env bash
# B1.5d oracle (harness-only; pushed as .bench/ci.sh on an ephemeral grading branch, never in
# agent source): same toolchain, install, browser and scope as ci.sh (five full package
# suites plus apps/server/src/preview), reported per case. Prints per file
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
# Suites (ORACLE-PACKAGE names): package name, or name:dir for a directory of a package.
suites="@t3tools/shared @t3tools/provider-pi @t3tools/client-runtime @t3tools/source-control-forgejo effect-codex-app-server t3:src/preview"
filters=(--filter "t3..."); for p in $suites; do [ "${p%%:*}" = t3 ] || filters+=(--filter "$p..."); done
vp install "${filters[@]}" || { echo "ORACLE install-failed"; exit 1; }
pw=apps/server/node_modules/playwright-core/cli.js
if [ "$(uname)" = Linux ]; then export PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64; fi
for attempt in 1 2 3; do node "$pw" install --only-shell chromium && break
  [ "$attempt" = 3 ] && { echo "ORACLE install-failed browser"; exit 1; }; sleep 5; done
browser=$(find "$HOME/.cache/ms-playwright" -name chrome-headless-shell -type f -print -quit 2>/dev/null)
if [ "$(uname)" = Linux ] && ldd "$browser" | grep -q '=> not found'; then node "$pw" install-deps chromium || { echo "ORACLE install-failed browser-deps"; exit 1; }; fi
dir_of() { case "$1" in t3*) echo apps/server ;; effect-codex-app-server) echo packages/effect-codex-app-server ;; *) echo "packages/${1#@t3tools/}" ;; esac; }
status=0
for p in $suites; do
  name=${p%%:*}; sub=${p#*:}; [ "$sub" = "$p" ] && sub=""
  out="$RUNNER_TEMP/oracle-$(echo "$p" | tr '/@:' '___').json"
  case "$name" in
    @t3tools/client-runtime|t3) (cd "$(dir_of "$name")" && vp test run $sub --reporter=default --reporter=json --outputFile="$out") || status=1 ;;
    *) (cd "$(dir_of "$name")" && vp test run --config ../../vite.config.ts --dir . --reporter=default --reporter=json --outputFile="$out") || status=1 ;;
  esac
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
