#!/usr/bin/env bash
# Build a patched T2C firmware image: base image -> replace app/www with src/www and the
# phone-facing ota/www page with src/ota-www (keeping the stock index.cgi and lan/) -> repack.
#
#   tools/build.sh [BASE_IMG] [OUT_IMG]
#
# Defaults: BASE_IMG=test.img (falls back to update.img), OUT_IMG=build/T2C-tesla-ui.img
# T2C_VERSION=YYMMDDNN replaces the date part of appver/tsl in app/system.json (the
# version both pages compare against updates/<branch>/version.json); unset keeps the
# vendor's version.
# Requires: python3, unsquashfs, mksquashfs (brew install squashfs), cpio not needed.
set -euo pipefail
cd "$(dirname "$0")/.."

BASE="${1:-}"
if [ -z "$BASE" ]; then
  if [ -f test.img ]; then BASE=test.img; elif [ -f update.img ]; then BASE=update.img; else
    echo "no base image: put the official update.img (or test.img) in the repo root" >&2; exit 1; fi
fi
OUT="${2:-build/T2C-tesla-ui.img}"
WORK=work
rm -rf "$WORK" && mkdir -p "$WORK" build

echo "== base: $BASE"
python3 tools/swu.py unpack "$BASE" "$WORK/swu"

echo "== unsquash customer"
# The image contains /dev/console (char 5,1); unsquashfs cannot create device nodes
# without root, so tolerate that and recreate every special inode via a pseudo-file.
unsquashfs -q -n -d "$WORK/customer" "$WORK/swu/customer" >/dev/null 2>"$WORK/unsquash.err" || true
grep -v 'could not create character device\|could not create block device\|^$' "$WORK/unsquash.err" | grep -q . && { cat "$WORK/unsquash.err" >&2; exit 1; }
[ -f "$WORK/customer/app/lylinkui" ] || { echo "unsquashfs failed" >&2; exit 1; }
unsquashfs -lln "$WORK/swu/customer" 2>/dev/null | awk '$1 ~ /^[cb]/ {
  mode=$1; sub(/,$/,"",$3); maj=$3; min=$4; path=$NF; sub(/^squashfs-root\//,"",path);
  split($2,ug,"/"); perm=0;
  for(i=2;i<=10;i++){ c=substr(mode,i,1); perm=perm*2+(c!="-"); }
  printf "%s %s %o %s %s %s %s\n", path, substr(mode,1,1), perm, ug[1], ug[2], maj, min }' > "$WORK/pseudo.txt"
echo "   special inodes:"; sed 's/^/     /' "$WORK/pseudo.txt"

echo "== overlay src/www -> app/www"
rm -rf "$WORK/customer/app/www"
mkdir -p "$WORK/customer/app/www"
# Copy only what the adapter needs; drop editor/OS junk.
rsync -a --exclude '.DS_Store' --exclude '*.map' src/www/ "$WORK/customer/app/www/"
# The adapter serves index.html generated from index.in; ship a pre-rendered copy too
# so the very first page load (before the template runs) is already the new UI.
python3 - "$WORK/customer/app/www" <<'EOF'
import sys, os
www = sys.argv[1]
src = open(os.path.join(www, 'index.in'), encoding='utf-8').read()
assert '|' not in src, 'index.in must not contain "|" (template token character)'
open(os.path.join(www, 'index.html'), 'w', encoding='utf-8').write(src)
for n in range(3):
    p = os.path.join(www, 'lan', '%d.txt' % n)
    assert os.path.exists(p), p
    lines = open(p, encoding='utf-8').read().split('\n')
    assert len(lines) <= 128, '%s has more than 128 lines (template table overflow)' % p
EOF
find "$WORK/customer/app/www" -type f -exec chmod 755 {} +   # match original image (all 0755)
find "$WORK/customer/app/www" -type d -exec chmod 755 {} +

echo "== patch app/lylinkui (DNS for *.internal, access-unit leak fix, one WebSocket message per access unit, session survives the page, no AP sleep; T2C_WS_PATCH=0 drops the WebSocket one)"
python3 tools/patch_lylinkui.py "$WORK/customer/app/lylinkui"
chmod 755 "$WORK/customer/app/lylinkui"

echo "== app/blink.sh: Bluetooth name from the phone page (/mnt/UDISK/t2c_name)"
# gocsdk gets its Bluetooth name from BT_NAME (set by the rootfs init). blink.sh already
# waits for /mnt/UDISK, so the name saved by t2c.cgi?a=name can replace it right there.
python3 - "$WORK/customer/app/blink.sh" <<'EOF'
import sys
p = sys.argv[1]
s = open(p).read()
hook = """# T2C firmware: device name chosen on the phone page (t2c.cgi?a=name)
if [ -s /mnt/UDISK/t2c_name ]; then
	T2C_NAME=`head -c 12 /mnt/UDISK/t2c_name | tr -cd 'A-Za-z0-9 _.-'`
	[ -n "$T2C_NAME" ] && BT_NAME="$T2C_NAME"
fi
"""
anchor = 'echo "run gocsdk BT_NAME=$BT_NAME"\n'
assert s.count(anchor) == 1 and s.count('-N$BT_NAME') == 2, 'unexpected blink.sh'
s = s.replace(anchor, hook + anchor).replace('-N$BT_NAME', '-N"$BT_NAME"')
# The watchdog starts right after gocsdk (src/app/t2c_watchdog.sh): gocsdk/hostapd relaunch, health log.
assert s.rstrip('\n').endswith('\nfi'), 'unexpected blink.sh tail'
s = s.rstrip('\n') + ('\n\n# T2C firmware: watchdog (gocsdk / hostapd relaunch, health log) -- src/app/t2c_watchdog.sh\n'
                       '[ -x "$WORKDIR/t2c_watchdog.sh" ] && "$WORKDIR/t2c_watchdog.sh" "$BT_NAME" </dev/null >/dev/null 2>&1 &\n'
                       '# T2C firmware: DNS forwarder for the car (rust/t2cd); an uploaded /tmp/t2cd wins over the firmware copy\n'
                       'T2CD="$WORKDIR/t2cd"; [ -x /tmp/t2cd ] && T2CD=/tmp/t2cd\n'
                       '[ -x "$T2CD" ] && "$T2CD" </dev/null >/dev/null 2>&1 &\n')
open(p, 'w').write(s)
EOF
sh -n "$WORK/customer/app/blink.sh"
chmod 755 "$WORK/customer/app/blink.sh"

if [ -n "${T2C_VERSION:-}" ]; then
  echo "== version: $T2C_VERSION (app/system.json)"
  [[ "$T2C_VERSION" =~ ^[0-9]{8}$ ]] || { echo "T2C_VERSION must be 8 digits (YYMMDDNN)" >&2; exit 1; }
  python3 - "$WORK/customer/app/system.json" "$T2C_VERSION" <<'EOF'
import json, re, sys
p, v = sys.argv[1], sys.argv[2]
j = json.load(open(p))
for k in ('appver', 'tsl'):
    j[k] = re.sub(r'^\d{8}', v, j[k])
open(p, 'w').write(json.dumps(j, separators=(', ', ' : ')))
print('   ' + open(p).read())
EOF
fi

echo "== app/lyLoadModule.sh: pass rtw_country_code=XX to the Wi-Fi driver when /mnt/UDISK/t2c_country holds two letters"
python3 - "$WORK/customer/app/lyLoadModule.sh" <<'EOF'
import sys
p = sys.argv[1]; s = open(p).read()
old = "insmod /mnt/customer/modules/$WIFI_MODULE.ko rtw_vht_enable=2\n"
assert s.count(old) == 1, "lyLoadModule.sh insmod line not found"
new = ("CC=$(head -c 2 /mnt/UDISK/t2c_country 2>/dev/null); case \"$CC\" in [A-Z][A-Z]) CC=\"rtw_country_code=$CC\" ;; *) CC='' ;; esac\n"
       "\t\tinsmod /mnt/customer/modules/$WIFI_MODULE.ko rtw_vht_enable=2 $CC\n")
open(p, "w").write(s.replace(old, new))
EOF
sh -n "$WORK/customer/app/lyLoadModule.sh"
grep -q "rtw_country_code" "$WORK/customer/app/lyLoadModule.sh" || { echo "lyLoadModule.sh patch failed" >&2; exit 1; }
echo "== app/hostapd: wrapper that adds the right HT40 side and 802.11ac 80 MHz (src/app/hostapd)"
# lylinkui runs `hostapd -B /tmp/hostapd.conf` through system(); lyLink.sh puts $WORKDIR first in
# PATH, so a script of that name in app/ runs instead of the rootfs daemon (and starts it).
grep -q $'\r' src/app/hostapd && { echo "src/app/hostapd has CRLF line endings" >&2; exit 1; }
head -1 src/app/hostapd | grep -q '^#!/bin/sh' || { echo "src/app/hostapd must start with #!/bin/sh" >&2; exit 1; }
sh -n src/app/hostapd
cp src/app/hostapd "$WORK/customer/app/hostapd"
chmod 755 "$WORK/customer/app/hostapd"
echo "== app/t2c_watchdog.sh: gocsdk/hostapd relaunch and health log (src/app/t2c_watchdog.sh)"
grep -q $'\r' src/app/t2c_watchdog.sh && { echo "src/app/t2c_watchdog.sh has CRLF line endings" >&2; exit 1; }
head -1 src/app/t2c_watchdog.sh | grep -q '^#!/bin/sh' || { echo "src/app/t2c_watchdog.sh must start with #!/bin/sh" >&2; exit 1; }
sh -n src/app/t2c_watchdog.sh
cp src/app/t2c_watchdog.sh "$WORK/customer/app/t2c_watchdog.sh"
chmod 755 "$WORK/customer/app/t2c_watchdog.sh"
T2CD=rust/t2cd/target/armv7-unknown-linux-musleabihf/release/t2cd
if [ "${T2C_NO_T2CD:-0}" = 1 ]; then
  echo "== app/t2cd: left out (T2C_NO_T2CD=1)"
elif [ -f "$T2CD" ]; then
  echo "== app/t2cd: DNS forwarder sidecar ($(stat -f %z "$T2CD" 2>/dev/null || stat -c %s "$T2CD") bytes, static ARMv7 musl)"
  head -c 20 "$T2CD" | xxd -p | grep -q '^7f454c46010101' || { echo "$T2CD is not a 32-bit little-endian ELF" >&2; exit 1; }
  cp "$T2CD" "$WORK/customer/app/t2cd"; chmod 755 "$WORK/customer/app/t2cd"
else
  echo "== app/t2cd: NOT built (cd rust/t2cd && cargo build --release --target armv7-unknown-linux-musleabihf); image goes without the DNS forwarder"
fi
echo "== app/t2c_dev.sh: bench helper (stop/start the vendor UI stack with the boot environment)"
sh -n src/app/t2c_dev.sh
install -m 755 src/app/t2c_dev.sh "$WORK/customer/app/t2c_dev.sh"
T2CUI=rust/t2cui/target/armv7-unknown-linux-musleabihf/release/t2cui
if [ -f "$T2CUI" ] && [ "${T2C_NO_T2CUI:-0}" != 1 ]; then
  echo "== app/t2cui: Rust UI server ($(stat -f %z "$T2CUI" 2>/dev/null || stat -c %s "$T2CUI") bytes, dynamic musl); default UI, /mnt/UDISK/t2c_ui_stock opts out"
  head -c 20 "$T2CUI" | xxd -p | grep -q '^7f454c46010101' || { echo "$T2CUI is not a 32-bit little-endian ELF" >&2; exit 1; }
  cp "$T2CUI" "$WORK/customer/app/t2cui"; chmod 755 "$WORK/customer/app/t2cui"
else
  echo "== app/t2cui: NOT built (cd rust/t2cui && cargo build --release --target armv7-unknown-linux-musleabihf); image goes without the Rust UI"
fi
echo "== app/lyLoadModule.sh: start app/t2cui (the Rust UI) instead of lylinkui unless /mnt/UDISK/t2c_ui_stock exists"
python3 - "$WORK/customer/app/lyLoadModule.sh" <<'EOF2'
import sys
p = sys.argv[1]; s = open(p).read()
old = "/tmp/lylink/tesla -s > /dev/null 2>&1 &\n"
assert s.count(old) == 1, "lyLoadModule.sh tesla line not found"
new = ("if [ ! -e /mnt/UDISK/t2c_ui_stock ] && [ -x $WORKDIR/t2cui ]; then\n"
       "\techo \" run t2cui (Rust UI; touch /mnt/UDISK/t2c_ui_stock for the vendor UI)\"\n"
       "\t$WORKDIR/t2cui --log /tmp/t2cui.log > /dev/null 2>&1 &\n"
       "else\n"
       "\t/tmp/lylink/tesla -s > /dev/null 2>&1 &\n"
       "fi\n")
open(p, "w").write(s.replace(old, new))
EOF2
sh -n "$WORK/customer/app/lyLoadModule.sh"
grep -q "t2c_ui_stock" "$WORK/customer/app/lyLoadModule.sh" || { echo "lyLoadModule.sh t2cui patch failed" >&2; exit 1; }
echo "== app/t2c_usb.sh: USB device mode (adb) helper for bench work"
grep -q $'\r' src/app/t2c_usb.sh && { echo "src/app/t2c_usb.sh has CRLF line endings" >&2; exit 1; }
sh -n src/app/t2c_usb.sh
cp src/app/t2c_usb.sh "$WORK/customer/app/t2c_usb.sh"
chmod 755 "$WORK/customer/app/t2c_usb.sh"

echo "== app/Auto.png: default icon of the car's own CarPlay app (Carlinkit)"
# lylinkui copies this to /tmp/lylink/home.png when no icon is chosen (icon ids map to app/www/icon/<id>.png).
cp src/www/icon/ck00.png "$WORK/customer/app/Auto.png"
chmod 755 "$WORK/customer/app/Auto.png"

echo "== app/udhcpd.conf: resolver list for the car"
# Stock hands out 8.8.8.8, 114.114.114.114 (China) and the adapter last. The adapter goes
# first so that carplay.internal / setting.internal resolve while the phone has internet
# (public resolvers say NXDOMAIN and the car takes that); the patched lylinkui answers
# REFUSED for every other name in that state, so the car moves on to 8.8.8.8 at once.
# 114 answers from Korea but 2-3x slower than 1.1.1.1.
python3 - "$WORK/customer/app/udhcpd.conf" <<'EOF'
import sys
p = sys.argv[1]
s = open(p).read()
a = 'opt     dns     8.8.8.8 114.114.114.114 192.168.3.1'
assert s.count(a) == 1, 'unexpected udhcpd.conf'
open(p, 'w').write(s.replace(a, 'opt     dns     192.168.3.1 8.8.8.8 1.1.1.1'))
EOF

echo "== overlay src/ota-www -> ota/www (phone page at http://192.168.3.1/)"
[ -f "$WORK/customer/ota/www/cgi-bin/index.cgi" ] || { echo "stock ota/www/cgi-bin/index.cgi missing" >&2; exit 1; }
rm -rf "$WORK/customer/ota/www/index.html" "$WORK/customer/ota/www/css" "$WORK/customer/ota/www/js"
rsync -a --exclude '.DS_Store' --exclude '*.map' src/ota-www/ "$WORK/customer/ota/www/"
head -1 "$WORK/customer/ota/www/cgi-bin/t2c.cgi" | grep -q '^#!/bin/sh' || { echo "t2c.cgi must start with #!/bin/sh" >&2; exit 1; }
grep -q $'\r' "$WORK/customer/ota/www/cgi-bin/t2c.cgi" && { echo "t2c.cgi has CRLF line endings" >&2; exit 1; }
find "$WORK/customer/ota/www" -type f -exec chmod 755 {} +
find "$WORK/customer/ota/www" -type d -exec chmod 755 {} +

echo "== mksquashfs"
rm -f "$WORK/customer.sqfs"
# Block size: stock uses 256 KB. 1 MB blocks with a matching dictionary pack the same tree ~3 %
# tighter (the customer partition is 0x640000 = 6,553,600 bytes and the Rust binaries pushed the
# 256 KB build over it); the 4.9 kernel's squashfs reads any block size up to 1 MB. T2C_SQFS_BLOCK
# overrides.
SQFS_BLOCK=${T2C_SQFS_BLOCK:-1048576}
mksquashfs "$WORK/customer" "$WORK/customer.sqfs" -comp xz -b "$SQFS_BLOCK" -Xdict-size "$SQFS_BLOCK" -noappend -all-root -no-xattrs -no-progress -quiet -pf "$WORK/pseudo.txt"
CUST_SZ=$(stat -f %z "$WORK/customer.sqfs" 2>/dev/null || stat -c %s "$WORK/customer.sqfs")
echo "   customer squashfs: $CUST_SZ bytes (partition 6553600, block $SQFS_BLOCK)"
[ "$CUST_SZ" -le 6553600 ] || { echo "customer squashfs does not fit the 0x640000 partition" >&2; exit 1; }
ORIG=$(stat -f %z "$WORK/swu/customer" 2>/dev/null || stat -c %s "$WORK/swu/customer")
NEW=$(stat -f %z "$WORK/customer.sqfs" 2>/dev/null || stat -c %s "$WORK/customer.sqfs")
echo "   customer: original $ORIG bytes -> new $NEW bytes"
cp "$WORK/customer.sqfs" "$WORK/swu/customer"

echo "== pack"
python3 tools/swu.py pack "$WORK/swu" "$OUT"
tools/verify.sh "$OUT"
echo "== done: $OUT"
