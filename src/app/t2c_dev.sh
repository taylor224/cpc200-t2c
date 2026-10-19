#!/bin/sh
# T2C firmware: bench helper for the lylinkui rewrite. Stops / starts the vendor UI stack with the
# exact environment the boot scripts use (the exports of /etc/profile -- WIFI_NAME, BT_NAME,
# LY_PLATFORM, LY_VERSION, IPADDR -- and lyLink.sh's library path). Relaunching `tesla -s` without
# WIFI_NAME writes an empty ssid= into /tmp/hostapd.conf and the access point comes up with no name.
#
#   t2c_dev.sh stop-ui              kill lylinkui (tesla) and lylinkapp
#   t2c_dev.sh start-ui             lylinkui + lylinkapp as lyLoadModule.sh starts them (restarts hostapd)
#   t2c_dev.sh start-app            lylinkapp only (for a replacement UI server that is already running)
#   t2c_dev.sh env                  print the environment
#   t2c_dev.sh run CMD...           run CMD with that environment (e.g. /tmp/lyshim --secs 60)
# NEVER source /etc/profile here: its last line is `ly_boot.sh &`, i.e. sourcing it boots a second
# copy of the whole vendor stack (did exactly that on 2026-10-19: two lylinkui, hostapd flapping,
# nameless AP, power cycle needed). Reproduce only the exports lylinkui/lylinkapp read.
export PATH="/usr/sbin:/usr/bin:/sbin:/bin"
export HOME=/root
CUSTOM_NAME=$(fw_printenv -n custom_name= 2>/dev/null)
product_id=$(cat /sys/devices/virtual/misc/ly_misc_dev/ly/product_number 2>/dev/null | tr '[a-z]' '[A-Z]')
export PRODUCT_NAME=${CUSTOM_NAME}_$product_id BT_NAME=${CUSTOM_NAME}_$product_id WIFI_NAME=${CUSTOM_NAME}_$product_id
export WIFI_NAME_UDP=${CUSTOM_NAME}_${product_id}_UDP WIFI_MODULE=8821cs
export LY_CHIPID=$(cat /sys/class/misc/ly_misc_dev/ly/chipid 2>/dev/null)
export LY_HW_ENCRY=$(cat /sys/devices/virtual/misc/ly_misc_dev/ly/ly_hw_encry 2>/dev/null)
export ly_4g_module=$(cat /sys/devices/virtual/misc/ly_misc_dev/ly/ly_4g_module 2>/dev/null)
export ly_rt8761_module=$(cat /sys/devices/virtual/misc/ly_misc_dev/ly/ly_rt8761_module 2>/dev/null)
VERSION=$(cut -d '"' -f 12 /mnt/customer/app/system.json 2>/dev/null | cut -d '"' -f 1)
[ "${#VERSION}" -eq 15 ] && [ "ly${VERSION:9:4}" = "$(fw_printenv -n ly_project_name 2>/dev/null)" ] && export LY_VERSION=$VERSION
export model_mode=normal LY_BOOT_MODE=$(fw_printenv -n ly_boot_mode= 2>/dev/null) LY_DEBUG_MODE=$(fw_printenv -n ly_debug_mode= 2>/dev/null)
export update_reboot_time=$(fw_printenv -n update_reboot_time 2>/dev/null) UPDATE_SAVE_BT_DATA=yes
export WORKDIR=/mnt/customer/app
export LD_LIBRARY_PATH=/tmp/lylink/lib:/tmp/lylink/eyesee-mpp:$WORKDIR:/usr/lib/eyesee-mpp
export PATH=/tmp/bin:$WORKDIR:$PATH
export LY_PLATFORM=${LY_PLATFORM:-v831}
IPADDR=${IPADDR:-192.168.3.1}

case "$1" in
	stop-ui)
		killall tesla 2>/dev/null; sleep 1; killall lylinkapp 2>/dev/null; sleep 1
		killall -9 tesla lylinkapp 2>/dev/null
		echo "tesla=$(pidof tesla) lylinkapp=$(pidof lylinkapp)" ;;
	start-ui)
		[ -n "$WIFI_NAME" ] || { echo "WIFI_NAME is empty: refusing (the AP would lose its name)"; exit 1; }
		cd /tmp/lylink || exit 1
		(/tmp/lylink/tesla -s </dev/null >/dev/null 2>&1 &)
		sleep 1
		(env LOCAL_IP_ADDRESS=$IPADDR "$WORKDIR/lylinkapp" </dev/null >/dev/null 2>&1 &)
		sleep 2; echo "tesla=$(pidof tesla) lylinkapp=$(pidof lylinkapp) ssid=$WIFI_NAME" ;;
	start-app)
		(env LOCAL_IP_ADDRESS=$IPADDR "$WORKDIR/lylinkapp" </dev/null >/dev/null 2>&1 &)
		sleep 2; echo "lylinkapp=$(pidof lylinkapp)" ;;
	env)
		env | grep -E '^(WIFI_NAME|BT_NAME|LY_|IPADDR|WORKDIR|LD_LIBRARY_PATH|PATH|HOME)' ;;
	run)
		shift; cd /tmp/lylink 2>/dev/null; exec "$@" ;;
	*)
		echo "usage: $0 stop-ui|start-ui|start-app|env|run CMD..."; exit 1 ;;
esac
