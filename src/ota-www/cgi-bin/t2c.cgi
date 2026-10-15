#!/bin/sh
# Helper CGI for the phone-facing page (busybox httpd on 192.168.3.1:80).
# The stock index.cgi stays in charge of settings/upload; this script only adds a few
# fixed actions. Nothing from the request is ever passed to a shell command.
#
#   GET  ?a=info          JSON: uptime, memory, storage, access-point summary, versions
#   GET  ?a=reboot        reply, then reboot two seconds later
#   GET  ?a=log           plain-text dmesg + logcat (not obfuscated like id=logcat)
#   GET  ?a=cat&f=NAME    one of a fixed list of diagnostic files / listings
#   POST ?a=wifi          change SSID / password (only when info.wifi_edit is 1)

A=''; F=''
OLDIFS=$IFS; IFS='&'
for kv in $QUERY_STRING; do
  case "$kv" in
    a=*) A=${kv#a=} ;;
    f=*) F=${kv#f=} ;;
  esac
done
IFS=$OLDIFS

json_hdr() { printf 'Content-Type: application/json\r\nCache-Control: no-store\r\n\r\n'; }
text_hdr() { printf 'Content-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\n\r\n'; }
je() { printf '%s' "$1" | tr -d '\r\n' | sed 's/\\/\\\\/g; s/"/\\"/g'; }
num() { case "$1" in ''|*[!0-9]*) printf '0' ;; *) printf '%s' "$1" ;; esac; }

HOSTAPD=/tmp/hostapd.conf

case "$A" in
info)
  up=$(cut -d' ' -f1 /proc/uptime 2>/dev/null)
  load=$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)
  memt=$(awk '/^MemTotal/{print $2}' /proc/meminfo 2>/dev/null)
  mema=$(awk '/^MemAvailable/{print $2}' /proc/meminfo 2>/dev/null)
  [ -n "$mema" ] || mema=$(awk '/^MemFree/{print $2}' /proc/meminfo 2>/dev/null)
  ud=$(df -k /mnt/UDISK 2>/dev/null | awk 'NR==2{print $2" "$3" "$4}')
  tp=$(df -k /tmp 2>/dev/null | awk 'NR==2{print $2" "$3" "$4}')
  ssid=$(sed -n 's/^ssid=//p' $HOSTAPD 2>/dev/null | head -1)
  psk=$(sed -n 's/^wpa_passphrase=//p' $HOSTAPD 2>/dev/null | head -1)
  ch=$(sed -n 's/^channel=//p' $HOSTAPD 2>/dev/null | head -1)
  hap=0; pidof hostapd >/dev/null 2>&1 && hap=1
  cl=$(awk '$6=="wlan0" && $3=="0x2"' /proc/net/arp 2>/dev/null | wc -l | tr -d ' ')
  appver=$(sed -n 's/.*"appver"[^"]*"\([^"]*\)".*/\1/p' /mnt/customer/app/system.json 2>/dev/null | head -1)
  lycfg=0; [ -f /mnt/UDISK/lycfg.txt ] && lycfg=1
  json_hdr
  printf '{"code":0,"uptime":%s,"load":"%s","mem_total_kb":%s,"mem_avail_kb":%s' \
    "$(num "${up%%.*}")" "$(je "$load")" "$(num "$memt")" "$(num "$mema")"
  set -- $ud; printf ',"udisk":{"total_kb":%s,"used_kb":%s,"avail_kb":%s}' "$(num "$1")" "$(num "$2")" "$(num "$3")"
  set -- $tp; printf ',"tmp":{"total_kb":%s,"used_kb":%s,"avail_kb":%s}' "$(num "$1")" "$(num "$2")" "$(num "$3")"
  printf ',"ssid":"%s","psk":"%s","channel":%s,"hostapd":%s,"clients":%s,"appver":"%s","lycfg":%s,"wifi_edit":0,"cgi":1}' \
    "$(je "$ssid")" "$(je "$psk")" "$(num "$ch")" "$hap" "$(num "$cl")" "$(je "$appver")" "$lycfg"
  ;;
reboot)
  json_hdr; printf '{"code":0}'
  ( sleep 2; sync; reboot || /sbin/reboot || busybox reboot ) </dev/null >/dev/null 2>&1 &
  ;;
log)
  printf 'Content-Type: text/plain; charset=utf-8\r\nContent-Disposition: attachment; filename="t2c-log.txt"\r\nCache-Control: no-store\r\n\r\n'
  echo "# T2C log, uptime $(cut -d' ' -f1 /proc/uptime 2>/dev/null) s"
  echo "# $(sed -n 's/.*"appver"[^"]*"\([^"]*\)".*/\1/p' /mnt/customer/app/system.json 2>/dev/null | head -1)"
  echo "## dmesg"; dmesg 2>&1
  echo; echo "## logcat"; logcat -v threadtime -d 2>&1
  ;;
cat)
  f=''; cmd=''
  case "$F" in
    hostapd)         f=$HOSTAPD ;;
    hostapd_default) f=/etc/wifi/hostapd.conf ;;
    lycfg)           f=/mnt/UDISK/lycfg.txt ;;
    system)          f=/mnt/customer/app/system.json ;;
    mtd)             f=/proc/mtd ;;
    cmdline)         f=/proc/cmdline ;;
    mounts)          f=/proc/mounts ;;
    meminfo)         f=/proc/meminfo ;;
    udisk)           cmd='ls -la /mnt/UDISK /mnt/UDISK/app /mnt/UDISK/lylink' ;;
    etc_wifi)        cmd='ls -la /etc/wifi' ;;
    ps)              cmd='ps' ;;
    env)             cmd='fw_printenv' ;;
    ifconfig)        cmd='ifconfig' ;;
    private)         cmd="tr -c '[:print:]\n' '\n' < /dev/mtdblock6 | grep -v '^$' | head -300" ;;
    *) printf 'Status: 404 Not Found\r\nContent-Type: text/plain\r\n\r\nunknown file\n'; exit 0 ;;
  esac
  text_hdr
  if [ -n "$f" ]; then
    if [ -r "$f" ]; then cat "$f"; else echo "(missing: $f)"; fi
  else
    sh -c "$cmd" 2>&1
  fi
  ;;
wifi)
  json_hdr; printf '{"code":2,"msg":"not supported by this build"}'
  ;;
*)
  printf 'Status: 400 Bad Request\r\nContent-Type: application/json\r\n\r\n{"code":1,"msg":"unknown action"}'
  ;;
esac
exit 0
