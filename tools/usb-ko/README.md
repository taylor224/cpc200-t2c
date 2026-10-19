# Kernel modules for the adapter (recipe)

The vendor kernel (4.9.118, sun8iw19p1 / V831, Thumb-2, no kallsyms, no module unload) ships no
USB gadget function modules except the built-in CDC-ACM one that `t2cd --usb` uses. This is the
recipe that produced loadable modules (verified: `hello.ko` ran; `usb_f_acm/serial/fs`, `u_ether`,
`usb_f_ecm/rndis/mass_storage` build and resolve all imports). Details and the caveats in
`docs/NOTES.md` › USB device mode.

```
docker run -d --name t2c-kbuild --platform linux/arm64 -v /tmp/t2c-kbuild:/work ubuntu:18.04 sleep infinity
docker exec t2c-kbuild bash -c 'apt-get update -qq && apt-get install -y -qq --no-install-recommends \
   gcc-arm-linux-gnueabihf build-essential make bc bison flex libssl-dev libelf-dev git python3 kmod'
git clone --depth 1 https://github.com/HandsomeMod/linux-allwinner-4.9 /tmp/t2c-kbuild/linux
docker exec t2c-kbuild bash -c 'cd /work/linux && touch .scmversion && \
   make ARCH=arm CROSS_COMPILE=arm-linux-gnueabihf- sun8iw19p1smp_defconfig && \
   scripts/kconfig/merge_config.sh -m .config /work/frag.cfg && make ARCH=arm CROSS_COMPILE=arm-linux-gnueabihf- olddefconfig && \
   make -j10 ARCH=arm CROSS_COMPILE=arm-linux-gnueabihf- prepare scripts && \
   make -j10 ARCH=arm CROSS_COMPILE=arm-linux-gnueabihf- M=drivers/usb/gadget modules'
```

Checks before an insmod: `strings X.ko | grep vermagic` must read `4.9.118 preempt ARMv7 thumb2
p2v8`; `readelf -r X.ko` must put the `init_module` relocation of `.rel.gnu.linkonce.this_module`
at offset 0xd8 (the vendor `8821cs.ko` does); every `nm -u` import must appear in the device
kernel's export strings (`strings vmlinux | grep -w SYMBOL`; the vmlinux is the xz piggy at
0x3be9 of `work/swu/kernel`). On the adapter set `echo 1 > /proc/sys/kernel/panic_on_oops` first
and use `usbtest.sh` (markers in UDISK) so a hang tells which step did it.
