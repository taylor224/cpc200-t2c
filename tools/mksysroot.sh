#!/usr/bin/env bash
# Build rust/sysroot (git-ignored) for the dynamic-musl Rust builds (rust/lyshim and the rewrite):
# the device's own libc/libgcc_s/libstdc++/liblog from the rootfs dump plus the vendor UI libraries
# from the stock image. Needs: unsquashfs, build/rootfs/rootfs-mtd4-*.bin (t2c.cgi?a=rootfs),
# work/customer/app/ui (tools/build.sh unpacks it).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOTFS=$(ls build/rootfs/rootfs-mtd4-*.bin 2>/dev/null | tail -n 1)
[ -n "$ROOTFS" ] || { echo "no build/rootfs/rootfs-mtd4-*.bin (dump it: curl -o build/rootfs/rootfs-mtd4-DATE.bin 'http://192.168.3.1/cgi-bin/t2c.cgi?a=rootfs')" >&2; exit 1; }
[ -d work/customer/app/ui ] || { echo "no work/customer/app/ui (run tools/build.sh once)" >&2; exit 1; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
unsquashfs -n -d "$TMP/fs" "$ROOTFS" lib >/dev/null 2>&1 || true
[ -f "$TMP/fs/lib/libc.so" ] || { echo "unsquashfs did not produce lib/libc.so" >&2; exit 1; }
rm -rf rust/sysroot; mkdir -p rust/sysroot/lib rust/sysroot/vendor
cp "$TMP/fs/lib/libc.so" "$TMP/fs/lib/liblog.so" "$TMP/fs/lib/libgcc_s.so.1" "$TMP/fs/lib/libstdc++.so.6.0.22" "$TMP/fs/lib/libubox.so" "$TMP/fs/lib/libubus.so" rust/sysroot/lib/
(cd rust/sysroot/lib && ln -sf libstdc++.so.6.0.22 libstdc++.so.6 && ln -sf libstdc++.so.6.0.22 libstdc++.so && ln -sf libgcc_s.so.1 libgcc_s.so && ln -sf libc.so ld-musl-armhf.so.1)
cp work/customer/app/ui/*.so rust/sysroot/vendor/
cp rust/sysroot/lib/liblog.so rust/sysroot/vendor/
echo "rust/sysroot: $(ls rust/sysroot/lib | wc -l | tr -d ' ') lib files, $(ls rust/sysroot/vendor | wc -l | tr -d ' ') vendor files (from $ROOTFS)"

# Import stubs: the device's libc.so and libgcc_s.so.1 have no section headers (sstrip), lld cannot
# read them, and without them the link silently fell back to rustc's static musl libc.a -- a second
# malloc inside a binary that also loads /lib/libc.so (free() of a libc.so chunk -> musl a_crash ->
# SIGILL; 2026-10-19). tools/mkstub.py emits one empty symbol per export, clang assembles it, and
# rust-lld makes a .so with the right SONAME. Link with `-L native=rust/sysroot/stub` first.
CLANG=${CLANG:-/opt/homebrew/opt/llvm/bin/clang}
SR=$(rustc --print sysroot); HOST=$(rustc -vV | awk '/^host:/ {print $2}')
LLD="$SR/lib/rustlib/$HOST/bin/rust-lld"
mkdir -p rust/sysroot/stub
for lib in libc.so libgcc_s.so.1; do
  python3 tools/mkstub.py "rust/sysroot/lib/$lib" > "$TMP/$lib.s"
  "$CLANG" --target=armv7-unknown-linux-musleabihf -c "$TMP/$lib.s" -o "$TMP/$lib.o"
  DYLD_FALLBACK_LIBRARY_PATH="$SR/lib" "$LLD" -flavor gnu -shared -soname "$lib" "$TMP/$lib.o" -o "rust/sysroot/stub/$lib"
  echo "rust/sysroot/stub/$lib: $(sed -n 2p "$TMP/$lib.s" | tr -d '@')"
done
