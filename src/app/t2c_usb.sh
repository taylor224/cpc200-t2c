#!/bin/sh
# T2C firmware: USB device mode for bench work. The stock boot runs `setusbconfig none` (host role);
# its configfs route (ffs.adb) does not work on this kernel, so this tries the legacy
# /sys/class/android_usb gadget plus the sunxi OTG role switch and starts /bin/adbd.
#   t2c_usb.sh adb | none | status
A=/sys/class/android_usb/android0
R=/sys/devices/platform/soc/usbc0/otg_role
LOG=/tmp/t2c_usb.log
log() { echo "$(date '+%H:%M:%S') $*" >> "$LOG" 2>/dev/null; }
w() { if echo "$2" > "$1" 2>/dev/null; then :; else log "write $2 > $1 failed"; fi; }
case "$1" in
status)
	echo "otg_role: $(cat $R 2>/dev/null)   udc: $(cat /sys/class/udc/*/state 2>/dev/null)"
	for f in enable functions idVendor idProduct state; do echo "android0/$f: $(cat $A/$f 2>/dev/null)"; done
	echo "android0 entries: $(ls $A 2>/dev/null | tr '\n' ' ')"
	echo "usbc0 entries: $(ls /sys/devices/platform/soc/usbc0 2>/dev/null | tr '\n' ' ')"
	echo "dev: $(ls -d /dev/android_adb /dev/usb-ffs /dev/usb-ffs/adb 2>/dev/null | tr '\n' ' ')"
	echo "filesystems: $(grep -iE 'configfs|functionfs' /proc/filesystems 2>/dev/null | tr '\n' ' ')"
	echo "adbd: $(pidof adbd 2>/dev/null)"
	[ -f "$LOG" ] && { echo "-- log"; cat "$LOG"; }
	;;
adb)
	log "adb: role was $(cat $R 2>/dev/null)"
	w "$A/enable" 0
	w "$R" usb_device
	w "$A/idVendor" 18d1
	w "$A/idProduct" 4ee7
	w "$A/iManufacturer" TesPush
	w "$A/iProduct" T2C
	w "$A/iSerial" t2c-$(cat /sys/class/net/wlan0/address 2>/dev/null | tr -d ':' | tail -c 7)
	w "$A/functions" adb
	w "$A/enable" 1
	if ! pidof adbd > /dev/null 2>&1; then
		mkdir -p /dev/usb-ffs/adb 2>/dev/null
		mount -t functionfs adb /dev/usb-ffs/adb 2>/dev/null || log "functionfs mount failed (legacy /dev/android_adb expected instead)"
		( /bin/adbd < /dev/null > /dev/null 2>&1 & )
	fi
	sleep 1
	log "adb: role=$(cat $R 2>/dev/null) enable=$(cat $A/enable 2>/dev/null) functions=$(cat $A/functions 2>/dev/null) state=$(cat $A/state 2>/dev/null) udc=$(cat /sys/class/udc/*/state 2>/dev/null) adbd=$(pidof adbd 2>/dev/null)"
	;;
none)
	w "$A/enable" 0
	killall adbd 2>/dev/null
	w "$R" usb_host
	log "none: role=$(cat $R 2>/dev/null)"
	;;
*) echo "usage: $0 adb|none|status"; exit 1 ;;
esac
exit 0
