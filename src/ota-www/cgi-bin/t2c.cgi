#!/bin/sh
# Helper CGI for the phone-facing page (busybox httpd on 192.168.3.1:80).
# The stock index.cgi stays in charge of settings/upload; this script only adds a few
# fixed actions. Nothing from the request is ever passed to a shell command.
#
#   GET  ?a=info          JSON: uptime, load, CPU busy %, memory, storage, access-point summary, versions
#   GET  ?a=reboot        reply, then reboot two seconds later
#   GET  ?a=log           plain-text dmesg + logcat (not obfuscated like id=logcat)
#   GET  ?a=cat&f=NAME    one of a fixed list of diagnostic files / listings
#   POST ?a=wifi          body "psk=<new password>": store it in the adapter's config
#                         (/mnt/UDISK/lycfg.txt, 12-byte field at offset 8 = max 11 chars,
#                         exactly what the Tesla page's type-9 message writes) and reboot.
#                         The network name is derived by the firmware and cannot be set.
#   POST ?a=channel       body "ch=<n>": hotspot channel (byte 5 of lycfg.txt) and reboot
#   POST ?a=name          body "name=<device name>": Bluetooth name (/mnt/UDISK/t2c_name, read by
#                         blink.sh before it starts gocsdk) and CarPlay car name (12-byte field
#                         at offset 20 of lycfg.txt, what the Tesla page's type-10 message
#                         writes), then reboot. 1-12 of A-Z a-z 0-9 space _ . -
#   GET  ?a=unname        forget the device name (no reboot; used before a factory reset)

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
NAMEFILE=/mnt/UDISK/t2c_name

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
  devname=''; [ -s $NAMEFILE ] && devname=$(head -c 12 $NAMEFILE)
  carname=''; [ $lycfg = 1 ] && carname=$(tail -c +21 /mnt/UDISK/lycfg.txt | head -c 12 | tr -d '\000')
  # CPU busy share over a short window (/proc/stat: user nice system idle iowait irq softirq ...)
  c1=$(head -1 /proc/stat); usleep 300000 2>/dev/null || sleep 1; c2=$(head -1 /proc/stat)
  cpu=$(printf '%s\n%s\n' "$c1" "$c2" | awk 'NR==1{for(i=2;i<=NF;i++)t1+=$i; i1=$5+$6} NR==2{for(i=2;i<=NF;i++)t2+=$i; i2=$5+$6} END{d=t2-t1; if(d>0) printf "%d", (d-(i2-i1))*100/d; else printf "0"}')
  btname=''; gp=$(pidof gocsdk 2>/dev/null | cut -d' ' -f1)
  [ -n "$gp" ] && btname=$(tr '\000' '\n' < /proc/$gp/cmdline 2>/dev/null | sed -n 's/^-N//p' | head -1)
  json_hdr
  printf '{"code":0,"uptime":%s,"load":"%s","mem_total_kb":%s,"mem_avail_kb":%s' \
    "$(num "${up%%.*}")" "$(je "$load")" "$(num "$memt")" "$(num "$mema")"
  set -- $ud; printf ',"udisk":{"total_kb":%s,"used_kb":%s,"avail_kb":%s}' "$(num "$1")" "$(num "$2")" "$(num "$3")"
  set -- $tp; printf ',"tmp":{"total_kb":%s,"used_kb":%s,"avail_kb":%s}' "$(num "$1")" "$(num "$2")" "$(num "$3")"
  printf ',"ssid":"%s","psk":"%s","channel":%s,"hostapd":%s,"clients":%s,"appver":"%s","lycfg":%s,"wifi_edit":%s' \
    "$(je "$ssid")" "$(je "$psk")" "$(num "$ch")" "$hap" "$(num "$cl")" "$(je "$appver")" "$lycfg" "$lycfg"
  printf ',"devname":"%s","carname":"%s","btname":"%s","cpu_pct":%s,"cgi":4}' "$(je "$devname")" "$(je "$carname")" "$(je "$btname")" "$(num "$cpu")"
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
    bt_conf)         f=/mnt/UDISK/bt_conf.ini ;;
    dns)             cmd='for n in carplay.internal setting.internal tespush.com tesla.com; do echo "## $n"; nslookup "$n" 127.0.0.1 2>&1 | tail -n +3; done' ;;
    private)         cmd="tr -c '[:print:]\n' '\n' < /dev/mtdblock6 | grep -v '^$' | head -300" ;;
    *) printf 'HTTP/1.0 404 Not Found\r\nContent-Type: text/plain\r\n\r\nunknown file\n'; exit 0 ;;
  esac
  text_hdr
  if [ -n "$f" ]; then
    if [ -r "$f" ]; then cat "$f"; else echo "(missing: $f)"; fi
  else
    sh -c "$cmd" 2>&1
  fi
  ;;
wifi)
  CFG=/mnt/UDISK/lycfg.txt
  body=''
  [ "${REQUEST_METHOD:-GET}" = POST ] && [ "${CONTENT_LENGTH:-0}" -gt 0 ] && [ "${CONTENT_LENGTH:-0}" -le 256 ] && body=$(head -c "$CONTENT_LENGTH" | tr -d '\r\n')
  psk=${body#psk=}
  json_hdr
  if [ "$psk" = "$body" ] || [ -z "$psk" ]; then printf '{"code":3,"msg":"no psk"}'; exit 0; fi
  n=$(printf '%s' "$psk" | wc -c | tr -d ' ')
  if [ "$n" -lt 8 ] || [ "$n" -gt 11 ]; then printf '{"code":4,"msg":"password must be 8-11 characters"}'; exit 0; fi
  bad=$(printf '%s' "$psk" | tr -d 'A-Za-z0-9!@#$^*()_.,:;?~-' | wc -c | tr -d ' ')
  if [ "$bad" -ne 0 ]; then printf '{"code":5,"msg":"unsupported character"}'; exit 0; fi
  if [ ! -f "$CFG" ] || [ "$(wc -c < "$CFG" | tr -d ' ')" -ne 556 ]; then printf '{"code":6,"msg":"config file missing; set a password from the Tesla screen first"}'; exit 0; fi
  { head -c 8 "$CFG"; printf '%s' "$psk"; i=$n; while [ "$i" -lt 12 ]; do printf '\000'; i=$((i+1)); done; tail -c +21 "$CFG"; } > "$CFG.new"
  if [ "$(wc -c < "$CFG.new" | tr -d ' ')" -ne 556 ]; then rm -f "$CFG.new"; printf '{"code":7,"msg":"write failed"}'; exit 0; fi
  mv "$CFG.new" "$CFG" && sync
  # Also patch the live hostapd config so the file on disk and in RAM agree; the reboot applies it.
  [ -f $HOSTAPD ] && sed -i "s/^wpa_passphrase=.*/wpa_passphrase=$psk/" $HOSTAPD 2>/dev/null
  printf '{"code":0}'
  ( sleep 2; sync; reboot || /sbin/reboot || busybox reboot ) </dev/null >/dev/null 2>&1 &
  ;;
channel)
  CFG=/mnt/UDISK/lycfg.txt
  body=''
  [ "${REQUEST_METHOD:-GET}" = POST ] && [ "${CONTENT_LENGTH:-0}" -gt 0 ] && [ "${CONTENT_LENGTH:-0}" -le 16 ] && body=$(head -c "$CONTENT_LENGTH" | tr -d '\r\n')
  ch=${body#ch=}
  json_hdr
  case "$ch" in 6|36|40|44|48|149|153|157|161|165) ;; *) printf '{"code":4,"msg":"unsupported channel"}'; exit 0 ;; esac
  if [ ! -f "$CFG" ] || [ "$(wc -c < "$CFG" | tr -d ' ')" -ne 556 ]; then printf '{"code":6,"msg":"config file missing; set a password from the Tesla screen first"}'; exit 0; fi
  { head -c 5 "$CFG"; printf "\\$(printf '%03o' "$ch")"; tail -c +7 "$CFG"; } > "$CFG.new"
  if [ "$(wc -c < "$CFG.new" | tr -d ' ')" -ne 556 ]; then rm -f "$CFG.new"; printf '{"code":7,"msg":"write failed"}'; exit 0; fi
  mv "$CFG.new" "$CFG" && sync
  printf '{"code":0}'
  ( sleep 2; sync; reboot || /sbin/reboot || busybox reboot ) </dev/null >/dev/null 2>&1 &
  ;;
name)
  CFG=/mnt/UDISK/lycfg.txt
  body=''
  [ "${REQUEST_METHOD:-GET}" = POST ] && [ "${CONTENT_LENGTH:-0}" -gt 0 ] && [ "${CONTENT_LENGTH:-0}" -le 64 ] && body=$(head -c "$CONTENT_LENGTH" | tr -d '\r\n')
  name=${body#name=}
  json_hdr
  if [ "$name" = "$body" ] || [ -z "$name" ]; then printf '{"code":3,"msg":"no name"}'; exit 0; fi
  case "$name" in *[!-A-Za-z0-9_.\ ]*) printf '{"code":5,"msg":"unsupported character"}'; exit 0 ;; esac
  case "$name" in ' '*|*' ') printf '{"code":5,"msg":"leading or trailing space"}'; exit 0 ;; esac
  n=$(printf '%s' "$name" | wc -c | tr -d ' ')
  if [ "$n" -gt 12 ]; then printf '{"code":4,"msg":"name must be 1-12 characters"}'; exit 0; fi
  printf '%s' "$name" > $NAMEFILE.new && mv $NAMEFILE.new $NAMEFILE || { printf '{"code":7,"msg":"write failed"}'; exit 0; }
  car=0
  if [ -f "$CFG" ] && [ "$(wc -c < "$CFG" | tr -d ' ')" -eq 556 ]; then
    { head -c 20 "$CFG"; printf '%s' "$name"; i=$n; while [ "$i" -lt 12 ]; do printf '\000'; i=$((i+1)); done; tail -c +33 "$CFG"; } > "$CFG.new"
    if [ "$(wc -c < "$CFG.new" | tr -d ' ')" -eq 556 ]; then mv "$CFG.new" "$CFG" && car=1; else rm -f "$CFG.new"; fi
  fi
  sync
  printf '{"code":0,"car":%s}' "$car"
  ( sleep 2; sync; reboot || /sbin/reboot || busybox reboot ) </dev/null >/dev/null 2>&1 &
  ;;
unname)
  rm -f $NAMEFILE; sync
  json_hdr; printf '{"code":0}'
  ;;
*)
  printf 'HTTP/1.0 400 Bad Request\r\nContent-Type: application/json\r\n\r\n{"code":1,"msg":"unknown action"}'
  ;;
esac
exit 0
