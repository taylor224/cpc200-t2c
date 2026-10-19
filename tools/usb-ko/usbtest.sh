#!/bin/sh
# Staged USB gadget test. Each step writes a marker to UDISK first, so a hang tells which step did it.
# usage: usbtest.sh STEP   (1 insmod, 2 mkdir function, 3 link into config, 4 otg_role usb_device, 5 bind UDC, 6 unbind, 7 role host)
G=/sys/kernel/config/usb_gadget/g1
M=/mnt/UDISK/t2c_usbtest.log
step() { echo "$(cat /proc/uptime | cut -d' ' -f1) step $1 start" >> $M; sync; }
done_() { echo "$(cat /proc/uptime | cut -d' ' -f1) step $1 ok: $2" >> $M; sync; dmesg | tail -4 > /tmp/dmesg-step$1; }
case "$1" in
  1) step 1; insmod /tmp/usb_f_acm.ko; rc=$?; done_ 1 "insmod rc=$rc"; cat /proc/modules; ls $G/functions ;;
  2) step 2; mkdir $G/functions/acm.usb0; rc=$?; done_ 2 "mkdir rc=$rc port=$(cat $G/functions/acm.usb0/port_num 2>&1)"; ls /dev/ttyGS* 2>&1 ;;
  3) step 3; ln -s $G/functions/acm.usb0 $G/configs/c.1/acm.usb0; rc=$?; done_ 3 "ln rc=$rc"; ls -la $G/configs/c.1/ ;;
  4) step 4; echo usb_device > /sys/devices/platform/soc/usbc0/otg_role; rc=$?; sleep 1; done_ 4 "role rc=$rc now=$(cat /sys/devices/platform/soc/usbc0/otg_role) udc=$(cat /sys/class/udc/*/state 2>&1)" ;;
  5) step 5; echo 5100000.udc-controller > $G/UDC; rc=$?; sleep 1; done_ 5 "bind rc=$rc UDC=$(cat $G/UDC) state=$(cat /sys/class/udc/*/state 2>&1)" ;;
  6) step 6; echo "" > $G/UDC; rc=$?; done_ 6 "unbind rc=$rc" ;;
  7) step 7; echo usb_host > /sys/devices/platform/soc/usbc0/otg_role; rc=$?; done_ 7 "host rc=$rc" ;;
  log) cat $M; echo ==dmesg; dmesg | tail -15 ;;
  *) echo "usage: $0 1..7|log" ;;
esac
tail -2 $M
