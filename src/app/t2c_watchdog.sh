#!/bin/sh
# T2C firmware: keeps the adapter reachable and leaves a trail. Started by app/blink.sh (build hook)
# right after gocsdk, with the Bluetooth name as $1. Every 15 s:
#   * gocsdk (Bluetooth: pairing, the A2DP/HFP bridge, the PAN) missing on two checks in a row ->
#     bt_rst + relaunch exactly as blink.sh started it. Without gocsdk the iPhone can never come back
#     (wireless CarPlay starts over Bluetooth) until the adapter is power-cycled.
#   * no hostapd daemon on three checks in a row while lylinkui runs and /tmp/hostapd.conf exists ->
#     run the wrapper (app/hostapd) the way lylinkui does. The patched lylinkui no longer puts the
#     access point to sleep when idle, so a missing daemon is a failure, not a nap; lylinkui's own
#     restarts (channel or password change) finish within seconds and are left alone.
#   Both relaunches are limited to 6 per hour. /mnt/UDISK/t2c_watchdog_off disables them (the health
#   log stays on).
#   * t2cd (rust/t2cd: the DNS forwarder the car's port-53 traffic is redirected to) missing ->
#     relaunch at the next check (/tmp/t2cd, an uploaded bench build, wins over the firmware's
#     app/t2cd); while it is not running the nat REDIRECT rule it maintains is removed so the
#     car's DNS is not sent into a closed port. t2cd in turn restarts this script if it dies.
#   * /mnt/UDISK/t2c_shell present -> t2cd serves a root shell on tcp/2323 (no password: the
#     hotspot is the only way in; bench/debug use only, remove the flag afterwards).
#   * every 30 s the Wi-Fi chip is asked whether it is alive: its TSF timer (MAC register 0x560,
#     read through the driver's read_reg proc entry, i.e. over the SDIO bus) must advance while
#     hostapd runs. Three stuck reads in a row (90 s), or a bus read that returns the driver's error
#     value or hangs, means the RTL8821CS combo chip is gone -- the 2026-10-18 hang took Wi-Fi and
#     Bluetooth down together with the LEDs frozen "green", unreachable until a power cycle. Then:
#     evidence to /mnt/UDISK/t2c_crash.log (health lines, probe values, irq counters, dmesg and log
#     tails; kept under 16 KB) and a clean reboot, at most 3 in a row (/mnt/UDISK/t2c_crash_count,
#     reset after 30 min of health); /mnt/UDISK/t2c_autoreboot_off keeps the evidence but not the
#     reboot. kernel.panic is set to 20 s so a kernel panic also reboots instead of sitting there.
#   * once a minute a health line to /tmp/t2c_health.log (last 400 lines) and every 10 minutes to
#     /mnt/UDISK/t2c_health.log (kept under 48 KB), so the state before a failure survives a power
#     cycle: uptime, MemAvailable, load, SoC temperature, process ids, associated stations, wlan0 and
#     bt-pan byte counters, OOM kills seen in dmesg, SDIO (irq 305) / BT UART (irq 295) interrupt
#     counters, the last TSF probe.
# Its own actions go to /tmp/t2c_watchdog.log. Phone page: diagnostics "health", "health_saved",
# "watchdog". Never killall/pidof "hostapd" here (the wrapper script shares that comm name).
BT_NAME=$1
HERE=$(cd "$(dirname "$0")" 2>/dev/null && pwd)
LOG=/tmp/t2c_watchdog.log
HEALTH=/tmp/t2c_health.log
SAVED=/mnt/UDISK/t2c_health.log
OFF=/mnt/UDISK/t2c_watchdog_off
STA=/proc/net/rtl8821cs/wlan0/all_sta_info
CONF=/tmp/hostapd.conf
T2CD_PORT=5300
SHELLFLAG=/mnt/UDISK/t2c_shell
RREG=/proc/net/rtl8821cs/wlan0/read_reg
CRASH=/mnt/UDISK/t2c_crash.log
CRASHCOUNT=/mnt/UDISK/t2c_crash_count
NOREBOOT=/mnt/UDISK/t2c_autoreboot_off
PERIOD=15
MAX_PER_HOUR=6

log() { echo "$(date '+%m-%d %H:%M:%S') $*" >> "$LOG" 2>/dev/null; }
uptime_s() { cut -d' ' -f1 /proc/uptime 2>/dev/null | cut -d. -f1; }
hostapd_alive() { ps 2>/dev/null | grep -v -e grep -e '/bin/sh' -e 'sh -c' -e '--monitor' | grep -q 'hostapd .*-B /tmp/hostapd'; }
lylinkui_alive() { ps 2>/dev/null | grep -q -e '[t]esla -s' -e '[t]2cui'; }   # the Rust UI (default) or the vendor UI (/mnt/UDISK/t2c_ui_stock)
STOCKUI=/mnt/UDISK/t2c_ui_stock
t2cui_alive() { [ -n "$(pidof t2cui 2>/dev/null)" ]; }
gocsdk_alive() { [ -n "$(pidof gocsdk 2>/dev/null)" ]; }
pids() { pidof "$1" 2>/dev/null | tr ' ' ','; }

# t2cd: the forwarder binary to run (uploaded build first), its pid, and the nat rule it owns
t2cd_bin() { if [ -x /tmp/t2cd ]; then echo /tmp/t2cd; elif [ -x "$HERE/t2cd" ]; then echo "$HERE/t2cd"; fi; }
t2cd_alive() { [ -n "$(pidof t2cd 2>/dev/null)" ]; }
t2cd_rule_drop() { n=0; while iptables -t nat -D PREROUTING -i wlan0 -p udp --dport 53 -j REDIRECT --to-ports $T2CD_PORT >/dev/null 2>&1 && [ $n -lt 8 ]; do n=$((n + 1)); done; }

# debug shell: served by t2cd (pty + raw TCP on 2323, tools/shell.py) while /mnt/UDISK/t2c_shell
# exists. The rootfs busybox has no telnetd/nc applet, so there is no fallback without t2cd.
shell_warned=''
shell_check() {
	[ -f "$SHELLFLAG" ] || { shell_warned=''; return 0; }
	t2cd_alive && return 0
	[ -n "$shell_warned" ] || { log "t2c_shell: flag set but t2cd is not running (no telnetd in this busybox)"; shell_warned=1; }
}

irq_counts() { awk '/uart3/{u=$2} /sunxi-mmc1/{m=$2} END{print m"/"u}' /proc/interrupts 2>/dev/null; }

# TSF low word of the Wi-Fi MAC (register 0x560, microseconds, runs while the AP is up), read over
# the SDIO bus by the driver. Prints 8 hex digits, "err" (the driver's bus-error values eaeaeaea /
# ffffffff), "hang" (the read did not return in 8 s) or "none" (no driver entry).
tsf_probe() {
	[ -w "$RREG" ] || { echo none; return 0; }
	rm -f /tmp/t2c_probe
	( echo "0x560 4" > "$RREG" 2>/dev/null; cat "$RREG" > /tmp/t2c_probe 2>/dev/null ) &
	p=$!; n=0
	while kill -0 $p 2>/dev/null && [ $n -lt 8 ]; do sleep 1; n=$((n + 1)); done
	if kill -0 $p 2>/dev/null; then kill -9 $p 2>/dev/null; echo hang; return 0; fi
	v=$(sed -n 's/.*=0x//p' /tmp/t2c_probe 2>/dev/null | head -n 1)
	case "$v" in ''|eaeaeaea|ffffffff|EAEAEAEA|FFFFFFFF) echo err ;; *) echo "$v" ;; esac
}

# evidence of a dead radio, then a clean reboot (unless disabled or looping)
radio_dead() {
	reason=$1
	cnt=$(cat "$CRASHCOUNT" 2>/dev/null); case "$cnt" in ''|*[!0-9]*) cnt=0 ;; esac
	{
		echo "=== $(date '+%m-%d %H:%M:%S') up=$now radio dead: $reason (auto-reboots so far: $cnt)"
		echo "probe: $tsf_prev -> $tsf_now  irq(mmc1/uart3): $irq_prev -> $(irq_counts)  hostapd=$hap sta=$(grep -c 'aid=[1-9]' "$STA" 2>/dev/null)"
		echo "--- health"; tail -n 4 "$HEALTH" 2>/dev/null
		echo "--- dmesg"; dmesg 2>/dev/null | tail -n 25
		echo "--- log"; logcat -d -t 400 2>/dev/null | grep -E 'lygoc|uiwif|hostapd|applk|E/' | tail -n 20
	} >> "$CRASH" 2>/dev/null
	sz=$(wc -c < "$CRASH" 2>/dev/null); case "$sz" in ''|*[!0-9]*) sz=0 ;; esac
	[ "$sz" -gt 16384 ] && { tail -c 8192 "$CRASH" > "$CRASH.tmp" 2>/dev/null && mv "$CRASH.tmp" "$CRASH"; }
	if [ -f "$NOREBOOT" ]; then log "radio dead ($reason): evidence saved, auto-reboot disabled by flag"; sync; return 0; fi
	if [ "$cnt" -ge 3 ]; then log "radio dead ($reason): evidence saved, not rebooting again ($cnt in a row)"; sync; return 0; fi
	echo $((cnt + 1)) > "$CRASHCOUNT" 2>/dev/null
	log "radio dead ($reason): rebooting (auto-reboot $((cnt + 1)) of 3)"
	sync
	( sleep 2; reboot; sleep 40; reboot -f; sleep 20; echo b > /proc/sysrq-trigger ) </dev/null >/dev/null 2>&1 &
}

# the chip must keep its TSF running while hostapd is up; 3 bad checks in a row (90 s) = dead
tsf_prev=''; tsf_bad=0; irq_prev=''; tsf_now=''
radio_check() {
	hap=0; hostapd_alive && hap=1
	tsf_now=$(tsf_probe)
	if [ -f /tmp/t2c_test_dead ]; then
		tsf_bad=$((tsf_bad + 1)); log "wifi probe: test flag ($tsf_bad)"
	else
		case "$tsf_now" in
			none) tsf_bad=0 ;;
			err|hang) tsf_bad=$((tsf_bad + 1)); log "wifi probe: $tsf_now ($tsf_bad)" ;;
			*) if [ "$hap" = 1 ] && [ "$tsf_now" = "$tsf_prev" ]; then tsf_bad=$((tsf_bad + 1)); log "wifi probe: TSF stuck at $tsf_now ($tsf_bad)"; else tsf_bad=0; fi ;;
		esac
	fi
	if [ $tsf_bad -ge 3 ]; then tsf_bad=0; radio_dead "$tsf_now"; fi
	tsf_prev=$tsf_now; irq_prev=$(irq_counts)
}

health() {
	mem=$(awk '/^MemAvailable/{print $2}' /proc/meminfo 2>/dev/null)
	load=$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)
	temp=$(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null)
	sta=$(grep -c 'aid=[1-9]' "$STA" 2>/dev/null)
	wl=$(sed -n 's/^ *wlan0: *//p' /proc/net/dev 2>/dev/null | awk '{print $1"/"$9}')
	pan=$(sed -n 's/^ *bt-pan: *//p' /proc/net/dev 2>/dev/null | awk '{print $1"/"$9}')
	oom=$(dmesg 2>/dev/null | grep -c 'Out of memory')
	hap=0; hostapd_alive && hap=1
	line="$(date '+%m-%d %H:%M:%S') up=$now mem=${mem:-?}k load=${load:-?} temp=${temp:--} ui=$(pids tesla)$(pids t2cui) app=$(pids lylinkapp) bt=$(pids gocsdk) hostapd=$hap sta=${sta:-?} wlan=${wl:-?} pan=${pan:--} oom=${oom:-0} t2cd=$(pids t2cd) irq=$(irq_counts) tsf=${tsf_now:--}"
	echo "$line" >> "$HEALTH" 2>/dev/null
	lines=$((lines + 1))
	if [ $lines -ge 50 ]; then
		lines=0
		tail -n 400 "$HEALTH" > "$HEALTH.tmp" 2>/dev/null && mv "$HEALTH.tmp" "$HEALTH"
	fi
	if [ $((tick % 40)) -eq 0 ]; then
		echo "$line" >> "$SAVED" 2>/dev/null
		sz=$(wc -c < "$SAVED" 2>/dev/null)
		case "$sz" in ''|*[!0-9]*) sz=0 ;; esac
		[ "$sz" -gt 49152 ] && { tail -c 24576 "$SAVED" > "$SAVED.tmp" 2>/dev/null && mv "$SAVED.tmp" "$SAVED"; }
	fi
}

goc_miss=0; hap_miss=0; goc_n=0; goc_win=0; hap_n=0; hap_win=0; tick=0; lines=0; dns_miss=0; dns_n=0; dns_win=0; ui_miss=0; ui_n=0; ui_win=0
crash_reset=0
log "start bt_name=$BT_NAME dir=$HERE"
echo 20 > /proc/sys/kernel/panic 2>/dev/null
while :; do
	sleep $PERIOD
	tick=$((tick + 1))
	now=$(uptime_s)
	case "$now" in ''|*[!0-9]*) now=0 ;; esac
	if [ ! -f "$OFF" ]; then
		if gocsdk_alive; then goc_miss=0; else
			goc_miss=$((goc_miss + 1))
			if [ $goc_miss -ge 2 ]; then
				[ $((now - goc_win)) -ge 3600 ] && { goc_win=$now; goc_n=0; }
				if [ $goc_n -lt $MAX_PER_HOUR ]; then
					goc_n=$((goc_n + 1)); goc_miss=0
					log "gocsdk gone, relaunch ($goc_n this hour)"
					echo 0 > /sys/devices/virtual/misc/ly_misc_dev/ly/bt_rst 2>/dev/null
					nice -n -16 "$HERE/gocsdk" -T/dev/ttyS3 -N"$BT_NAME" </dev/null >/dev/null 2>&1 &
				fi
			fi
		fi
		# the Rust UI has no parent process to respawn it (stock tesla does): two misses -> relaunch
		if [ ! -e "$STOCKUI" ] && [ -x "$HERE/t2cui" ]; then
			if t2cui_alive; then ui_miss=0; else
				ui_miss=$((ui_miss + 1))
				if [ $ui_miss -ge 2 ]; then
					[ $((now - ui_win)) -ge 3600 ] && { ui_win=$now; ui_n=0; }
					if [ $ui_n -lt $MAX_PER_HOUR ]; then
						ui_n=$((ui_n + 1)); ui_miss=0
						log "t2cui missing for $((2 * PERIOD)) s, relaunch ($ui_n this hour)"
						( "$HERE/t2cui" --log /tmp/t2cui.log </dev/null >/dev/null 2>&1 & )
					fi
				fi
			fi
		fi
		if hostapd_alive || ! lylinkui_alive || [ ! -r "$CONF" ]; then hap_miss=0; else
			hap_miss=$((hap_miss + 1))
			if [ $hap_miss -ge 3 ]; then
				[ $((now - hap_win)) -ge 3600 ] && { hap_win=$now; hap_n=0; }
				if [ $hap_n -lt $MAX_PER_HOUR ]; then
					hap_n=$((hap_n + 1)); hap_miss=0
					log "no hostapd for $((3 * PERIOD)) s, relaunch ($hap_n this hour)"
					PATH="$HERE:$PATH" "$HERE/hostapd" -B "$CONF" </dev/null >>"$LOG" 2>&1
				fi
			fi
		fi
	fi
	bin=$(t2cd_bin)
	if [ -n "$bin" ] && [ ! -f "$OFF" ]; then
		if t2cd_alive; then dns_miss=0; else
			dns_miss=$((dns_miss + 1))
			t2cd_rule_drop
			if [ $dns_miss -ge 1 ]; then
				[ $((now - dns_win)) -ge 3600 ] && { dns_win=$now; dns_n=0; }
				if [ $dns_n -lt $MAX_PER_HOUR ]; then
					dns_n=$((dns_n + 1)); dns_miss=0
					log "t2cd gone, relaunch $bin ($dns_n this hour)"
					"$bin" </dev/null >/dev/null 2>&1 &
				fi
			fi
		fi
	fi
	shell_check
	[ $((tick % 2)) -eq 0 ] && radio_check
	[ $((tick % 4)) -eq 0 ] && health
	if [ $crash_reset -eq 0 ] && [ "$now" -ge 1800 ]; then
		crash_reset=1
		c=$(cat "$CRASHCOUNT" 2>/dev/null); case "$c" in ''|0) ;; *) echo 0 > "$CRASHCOUNT" 2>/dev/null; log "30 min up: auto-reboot count reset" ;; esac
	fi
done
