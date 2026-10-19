#!/usr/bin/env bash
# Bench loop for the Rust UI server on the adapter (needs the t2c_shell flag):
#   rust/t2cui/run.sh start [extra t2cui args]   push helper + binary, stop lylinkui, run t2cui on 0.0.0.0:8081, start lylinkapp
#   rust/t2cui/run.sh log                        tail /tmp/t2cui.log and /health
#   rust/t2cui/run.sh stop                       kill t2cui, put lylinkui back (hostapd restarts: rejoin the Wi-Fi)
# Then on the Mac: open http://192.168.3.1:8081/ in a browser, or
#   tools/cdp.py --port 9333 --metrics 773x601x1.53 --goto http://192.168.3.1:8081/ --wait 15 --shot /tmp/t2cui.png --console
set -uo pipefail
cd "$(dirname "$0")/../.."
DEV=/tmp/t2c_dev.sh
B=rust/t2cui/target/armv7-unknown-linux-musleabihf/release/t2cui
HOST=${T2C_HOST:-192.168.3.1}
case "${1:-start}" in
  start)
    shift || true
    python3 tools/shell.py --put src/app/t2c_dev.sh t2c_dev.sh || exit 1
    python3 tools/shell.py --put "$B" t2cui || exit 1
    python3 tools/shell.py -c "killall t2cui 2>/dev/null; sleep 1; $DEV stop-ui; rm -f /tmp/t2cui.log; ($DEV run sh -c '/tmp/t2cui --bind 0.0.0.0 --port 8081 --log /tmp/t2cui.log --debug $*; echo \"[exit \$?]\" >> /tmp/t2cui.log' >/tmp/t2cui.out 2>&1 &); sleep 2; $DEV start-app; sleep 6; echo \"t2cui=\$(pidof t2cui) lylinkapp=\$(pidof lylinkapp)\"; tail -n 6 /tmp/t2cui.log; cat /tmp/t2cui.out"
    ;;
  log)
    python3 tools/shell.py -c 'tail -n 30 /tmp/t2cui.log; cat /tmp/t2cui.out'
    curl -s -m 5 "http://$HOST:8081/health"; echo
    ;;
  stop)
    python3 tools/shell.py -c "killall t2cui 2>/dev/null; sleep 1; $DEV stop-ui; $DEV start-ui" | tail -n 2
    ;;
  *) echo "usage: $0 start|log|stop"; exit 1 ;;
esac
