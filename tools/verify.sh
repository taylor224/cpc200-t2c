#!/usr/bin/env bash
# Verify a built image: outer MD5, CPIO CRC entries, squashfs integrity, new UI present.
set -euo pipefail
cd "$(dirname "$0")/.."
IMG="${1:?usage: verify.sh IMAGE.img}"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
python3 tools/swu.py unpack "$IMG" "$TMP/swu" | tee "$TMP/unpack.log"
grep -q 'MISMATCH' "$TMP/unpack.log" && { echo "FAIL: md5 mismatch" >&2; exit 1; }
grep -q 'chk=BAD' "$TMP/unpack.log" && { echo "FAIL: cpio checksum" >&2; exit 1; }
for f in sw-description customer kernel; do [ -f "$TMP/swu/$f" ] || { echo "FAIL: missing $f" >&2; exit 1; }; done
unsquashfs -q -n -d "$TMP/fs" "$TMP/swu/customer" >/dev/null 2>/dev/null || true
[ -f "$TMP/fs/app/lylinkui" ] || { echo "FAIL: squashfs" >&2; exit 1; }
unsquashfs -lln "$TMP/swu/customer" 2>/dev/null | grep -q '^crw------- 0/0 .* 5, *1 .*dev/console' || { echo "FAIL: /dev/console node missing" >&2; exit 1; }
echo "   inodes: $(unsquashfs -lln "$TMP/swu/customer" 2>/dev/null | wc -l | tr -d ' ') (original 151)"
for f in app/www/index.in app/www/index.html app/www/js/app.js app/www/js/protocol.js app/www/js/video.js app/www/js/i18n.js app/www/js/boot.js app/www/css/styles.css app/www/lan/0.txt app/www/lan/1.txt app/www/lan/2.txt app/lylinkui app/ui/liblylinkui.so ota/www/cgi-bin/index.cgi ota/www/cgi-bin/t2c.cgi ota/www/index.html ota/www/js/ota.js ota/www/css/ota.css ota/www/lan/en-US.json; do
  [ -f "$TMP/fs/$f" ] || { echo "FAIL: $f not in image" >&2; exit 1; }
done
grep -q '|' "$TMP/fs/app/www/index.in" && { echo "FAIL: index.in contains '|'" >&2; exit 1; }
python3 tools/patch_lylinkui.py "$TMP/fs/app/lylinkui" | grep -q 'already patched' || { echo "FAIL: app/lylinkui is not the patched build" >&2; exit 1; }
# the stock OTA CGI must be the shipped binary (ELF), the page ours
head -c 4 "$TMP/fs/ota/www/cgi-bin/index.cgi" | grep -q 'ELF' || { echo "FAIL: ota/www/cgi-bin/index.cgi is not the stock binary" >&2; exit 1; }
grep -q 't2c.cgi' "$TMP/fs/ota/www/index.html" || { echo "FAIL: new phone page not in image" >&2; exit 1; }
[ -f "$TMP/fs/ota/www/js/aliyun-oss-sdk.min.js" ] && { echo "FAIL: stock OSS SDK still in ota/www" >&2; exit 1; }
echo "   ota/www index.cgi sha256: $(shasum -a 256 "$TMP/fs/ota/www/cgi-bin/index.cgi" | cut -c1-16)"
echo "   customer sha256: $(shasum -a 256 "$TMP/swu/customer" | cut -c1-16)"
echo "VERIFY OK: $IMG ($(stat -f %z "$IMG" 2>/dev/null || stat -c %s "$IMG") bytes)"
