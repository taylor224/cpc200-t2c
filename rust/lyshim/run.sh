#!/usr/bin/env bash
# Shim round trip on the adapter: push the build, swap it in for lylinkui (lylinkapp restarted as
# lyLoadModule.sh does), collect its log, put lylinkui back (which restarts hostapd: rejoin Wi-Fi).
#   rust/lyshim/run.sh [SECS] [shim args...]
set -uo pipefail
cd "$(dirname "$0")/../.."
SECS=${1:-90}; shift || true
# the helper is pushed fresh every time (the flashed copy may be older than the repo)
DEV=/tmp/t2c_dev.sh
B=rust/lyshim/target/armv7-unknown-linux-musleabihf/release/lyshim
python3 tools/shell.py --put src/app/t2c_dev.sh t2c_dev.sh || exit 1
python3 tools/shell.py --put "$B" lyshim || exit 1
python3 tools/shell.py -c "$DEV stop-ui; rm -f /tmp/lyshim.log; ($DEV run sh -c '/tmp/lyshim --secs $SECS $*; echo \"[exit \$?]\"' >/tmp/lyshim.log 2>&1 &); sleep 2; $DEV start-app; sleep 3; echo \"shim=\$(pidof lyshim) lylinkapp=\$(pidof lylinkapp)\""
echo "== running for $SECS s"; sleep $((SECS + 6))
python3 tools/shell.py -c 'cat /tmp/lyshim.log; echo "== shim exit; lylinkapp=$(pidof lylinkapp)"; logcat -d -t 300 2>/dev/null | grep -E "uiapi|lysvr|ly_mw|applk|appcp|CarPlay session|VIDEO|display|Bonjour|OnNotify" | tail -n 30 | cut -c1-150'
echo "== restoring lylinkui (hostapd restarts; rejoin the Wi-Fi afterwards)"
python3 tools/shell.py -c "$DEV stop-ui; $DEV start-ui" 2>&1 | tail -n 2
