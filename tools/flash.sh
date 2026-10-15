#!/usr/bin/env bash
# Pre-flight checks, flash, and recovery monitoring for the T2C over its Wi-Fi hotspot.
#
#   tools/flash.sh IMAGE.img            # checks only (version, partition size, memory, image)
#   tools/flash.sh IMAGE.img --yes      # checks, then upload and wait for the adapter to return
#
# Environment: T2C_HOST (default 192.168.3.1); T2C_SSID + T2C_PSK let the script rejoin the
# adapter's Wi-Fi on macOS if the Mac roams away while the adapter reboots. Logs go to work/flash-<timestamp>/.
set -euo pipefail
cd "$(dirname "$0")/.."
IMG="${1:?usage: flash.sh IMAGE.img [--yes]}"
YES="${2:-}"
HOST="${T2C_HOST:-192.168.3.1}"
BASE="http://$HOST/cgi-bin/index.cgi"
LOG="work/flash-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$LOG"
fail() { echo "ABORT: $*" >&2; exit 1; }

echo "== 1. adapter reachable?"
HOSTJSON=$(curl -s -m 8 "$BASE?id=host") || fail "no answer from $HOST (join the adapter's Wi-Fi first)"
[ -n "$HOSTJSON" ] || fail "empty answer from $BASE?id=host"
echo "$HOSTJSON" > "$LOG/host.json"
echo "   $(echo "$HOSTJSON" | sed -E 's/("uuid"|"imei"|"ICCD"|"iccid"|"wifi"|"mac")[[:space:]]*:[[:space:]]*"[^"]*"/\1:"***"/g')"
SW=$(echo "$HOSTJSON" | sed -nE 's/.*"appver"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p')
UPD=$(echo "$HOSTJSON" | sed -nE 's/.*"update"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/p')
echo "   appver=$SW update_state=$UPD"
case "$SW" in *.1508.*) ;; *) echo "   WARNING: appver does not look like the 1508 branch" ;; esac
[ "${UPD:-0}" = 0 ] || echo "   WARNING: adapter reports an update in progress (state $UPD)"

echo "== 2. image sanity"
tools/verify.sh "$IMG" | tail -4
python3 tools/swu.py unpack "$IMG" "$LOG/swu" > /dev/null
CUST=$(stat -f %z "$LOG/swu/customer" 2>/dev/null || stat -c %s "$LOG/swu/customer")
KERN=$(stat -f %z "$LOG/swu/kernel" 2>/dev/null || stat -c %s "$LOG/swu/kernel")
echo "   customer=$CUST bytes kernel=$KERN bytes"

echo "== 3. device log (dmesg + logcat) for partition table and memory"
if curl -s -m 90 "$BASE?id=logcat" -o "$LOG/log.bin" && python3 tools/logcat.py "$LOG/log.bin" "$LOG/log.txt"; then
  echo "   log lines: $(wc -l < "$LOG/log.txt")"
  FIRST_TS=$(grep -oEm1 '^\[ *[0-9]+' "$LOG/log.txt" | tr -d '[ ')
  echo "   oldest dmesg line is from ${FIRST_TS:-?} s after boot"
  if [ "${FIRST_TS:-0}" -gt 120 ]; then
    echo "   WARNING: boot messages have rotated out of the kernel ring buffer;"
    echo "            power-cycle the adapter and re-run within ~2 minutes to see the partition table"
  fi
  grep -iE 'mtd|partition|nand|customer|boot[^a-z]|recovery|rootfs|UDISK' "$LOG/log.txt" | grep -viE 'lylink|hostapd|wpa' | head -40 | sed 's/^/   /'
  echo "   memory:"; grep -iE '^Memory:|Memory: [0-9]+K' "$LOG/log.txt" | head -2 | sed 's/^/   /'
  # Try to read the customer partition size from "0x... - 0x... : "customer"" style lines
  if python3 - "$LOG/log.txt" "$CUST" "$KERN" <<'EOF'
import re, sys
txt = open(sys.argv[1], errors='replace').read()
cust, kern = int(sys.argv[2]), int(sys.argv[3])
found = {}
for m in re.finditer(r'0x([0-9a-f]+)-0x([0-9a-f]+)\s*:\s*"([^"]+)"', txt):
    a, b, name = int(m.group(1), 16), int(m.group(2), 16), m.group(3)
    found[name] = b - a
for m in re.finditer(r'\[\s*([0-9a-f]{8,})\s*-\s*([0-9a-f]{8,})\s*\]\s*:?\s*"?([a-zA-Z0-9_]+)', txt):
    a, b, name = int(m.group(1), 16), int(m.group(2), 16), m.group(3)
    if name not in found and b > a: found[name] = b - a
if not found:
    print('   partition sizes: NOT FOUND in log; verify manually before flashing'); sys.exit(2)
for n, s in sorted(found.items()):
    print('   %-12s %10d bytes (%.2f MB)' % (n, s, s / 1048576))
ok = True
if 'customer' in found:
    print('   customer image %d <= partition %d : %s' % (cust, found['customer'], 'OK' if cust <= found['customer'] else 'TOO BIG'))
    ok = ok and cust <= found['customer']
if 'boot' in found:
    print('   kernel image %d <= boot partition %d : %s' % (kern, found['boot'], 'OK' if kern <= found['boot'] else 'TOO BIG'))
    ok = ok and kern <= found['boot']
sys.exit(0 if ok else 3)
EOF
  then PART_RC=0; else PART_RC=$?; fi
else
  echo "   could not fetch the log"; PART_RC=2
fi

echo "== 4. current UI server"
curl -s -m 5 -o /dev/null -w "   http://$HOST/ (OTA page) -> %{http_code}\n" "http://$HOST/" || true
# The Tesla UI vhost answers on the AP address too; 101.200.208.6 would be routed to the public internet.
curl -sk -m 5 -o "$LOG/ui-before.html" -w "   https://tespush.com/ via $HOST (Tesla UI) -> %{http_code} %{size_download}B\n" --resolve "tespush.com:443:$HOST" 'https://tespush.com/' || true

if [ "$YES" != "--yes" ]; then
  echo "== dry run complete (partition check rc=$PART_RC). Re-run with --yes to flash."
  exit 0
fi
[ "$PART_RC" = 0 ] || fail "partition size check did not pass (rc=$PART_RC)"

echo "== 5. upload"
RESP=$(curl -s -m 300 -F "file=@$IMG;filename=update.img" "$BASE?id=upload")
echo "   $RESP" | tee "$LOG/upload.json"
echo "$RESP" | grep -q '"code": *0' || fail "upload rejected"

echo "== 6. waiting for reboot (adapter goes down, then comes back; keep it powered)"
T0=$(date +%s); DOWN=0
while :; do
  if curl -s -m 2 -o /dev/null "$BASE?id=host"; then
    if [ $DOWN = 1 ]; then echo "   back online after $(( $(date +%s) - T0 ))s"; break; fi
  else
    if [ $DOWN = 0 ]; then echo "   adapter went offline after $(( $(date +%s) - T0 ))s (installing)"; DOWN=1; fi
    if [ -n "${T2C_SSID:-}" ] && command -v networksetup >/dev/null; then
      networksetup -setairportnetwork en0 "$T2C_SSID" "${T2C_PSK:-}" >/dev/null 2>&1 || true
    fi
  fi
  [ $(( $(date +%s) - T0 )) -gt 900 ] && fail "no answer for 15 minutes; power-cycle the adapter and check $BASE?id=host manually"
  sleep 3
done
sleep 15
echo "== 7. after"
curl -s -m 20 "$BASE?id=host" | sed -E 's/("uuid"|"imei"|"ICCD"|"iccid"|"wifi"|"mac")[[:space:]]*:[[:space:]]*"[^"]*"/\1:"***"/g'; echo
for i in 1 2 3 4 5 6; do
  curl -sk -m 10 -o "$LOG/ui-after.html" -w "   Tesla UI via $HOST -> %{http_code} %{size_download}B\n" --resolve "tespush.com:443:$HOST" 'https://tespush.com/' && break
  echo "   UI server not up yet, retrying"; sleep 10
done
grep -q 'h264worker\|cp-canvas' "$LOG/ui-after.html" 2>/dev/null && echo "   new UI is being served" || echo "   WARNING: new UI not detected"
echo "== done. logs in $LOG"
