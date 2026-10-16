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
#   GET  ?a=wlanw&f=K&v=V  write a Realtek driver knob (log_level, country_code, change_bss_chbw)
#   GET  ?a=flag&f=N&v=V   write /mnt/UDISK/t2c_N (hostapd_debug, country, vht_off, vht80, hostapd_extra, adb; empty deletes)
#   GET  ?a=hostapd_restart kill hostapd and run the wrapper again (experiments)
#   GET  ?a=top&v=SECONDS  per-process/thread CPU share over a window, RSS, CPU split, Wi-Fi/PAN throughput
#   GET  ?a=usbmode&v=adb   USB device mode via setusbconfig (adb | rndis | none); ?a=cat&f=usb shows the state

A=''; F=''; V=''
OLDIFS=$IFS; IFS='&'
for kv in $QUERY_STRING; do
  case "$kv" in
    a=*) A=${kv#a=} ;;
    f=*) F=${kv#f=} ;;
    v=*) V=$(printf '%s' "${kv#v=}" | sed 's/%20/ /g; s/+/ /g') ;;
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
  hap=0; ps 2>/dev/null | grep -q "[h]ostapd .*-B " && hap=1   # not pidof: the wrapper script is also called hostapd
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
wlanw)
  # write one of a few Realtek driver knobs: ?a=wlanw&f=log_level&v=4, f=country_code&v=KR,
  # f=change_bss_chbw&v=161%2080%201 (channel, bandwidth, offset as the driver expects)
  json_hdr
  n=''
  case "$F" in
    log_level)        n=/proc/net/rtl8821cs/log_level ;;
    country_code)     n=/proc/net/rtl8821cs/wlan0/country_code ;;
    change_bss_chbw)  n=/proc/net/rtl8821cs/wlan0/change_bss_chbw ;;
  esac
  case "$V" in ''|*[!A-Za-z0-9_,.\ -]*) printf '{"code":2,"msg":"bad value"}'; exit 0 ;; esac
  [ -n "$n" ] || { printf '{"code":3,"msg":"unknown knob"}'; exit 0; }
  if printf '%s\n' "$V" > "$n" 2>/dev/null; then printf '{"code":0,"knob":"%s","value":"%s"}' "$F" "$(je "$V")"; else printf '{"code":1,"msg":"write failed"}'; fi
  ;;
flag)
  # ?a=flag&f=NAME&v=VALUE writes /mnt/UDISK/t2c_NAME (empty value deletes it): hostapd_debug,
  # country (two letters), vht_off. Read by the hostapd wrapper at its next launch.
  json_hdr
  case "$F" in hostapd_debug|country|vht_off|vht80|hostapd_extra|adb) ;; *) printf '{"code":3,"msg":"unknown flag"}'; exit 0 ;; esac
  case "$V" in *[!A-Za-z0-9_=\;\[\]-]*) printf '{"code":2,"msg":"bad value"}'; exit 0 ;; esac
  if [ -z "$V" ]; then rm -f "/mnt/UDISK/t2c_$F"; printf '{"code":0,"flag":"%s","value":""}' "$F"
  elif printf '%s\n' "$V" > "/mnt/UDISK/t2c_$F" 2>/dev/null; then sync; printf '{"code":0,"flag":"%s","value":"%s"}' "$F" "$(je "$V")"
  else printf '{"code":1,"msg":"write failed"}'; fi
  ;;
hostapd_restart)
  # stop the running hostapd (by PID, see the wrapper) and run the wrapper again, as lylinkui would
  json_hdr
  p=$(ps 2>/dev/null | grep -v grep | grep "[h]ostapd .*/tmp/hostapd" | awk '{print $1}' | head -n 1)
  [ -n "$p" ] && kill "$p" 2>/dev/null
  ( sleep 2; PATH=/mnt/customer/app:$PATH /mnt/customer/app/hostapd -B /tmp/hostapd.conf ) </dev/null >/dev/null 2>&1 &
  printf '{"code":0,"killed":"%s"}' "$p"
  ;;
top)
  # ?a=top&v=SECONDS (1-10, default 3): per-process and per-thread CPU share over the window, RSS,
  # CPU time split, Wi-Fi/BT-PAN bytes. One awk pass per snapshot so the sampling itself stays cheap.
  text_hdr
  n=$(num "$V"); { [ "$n" -ge 1 ] && [ "$n" -le 10 ]; } 2>/dev/null || n=3
  snap() {   # pid|tid|name|utime+stime|state|prio|nice ; tid=P for the process line (sum of its threads)
    awk '{
      n = split($0, a, ")"); rest = a[n]; split(rest, f, " ");
      name = substr($0, index($0, "(") + 1, length($0) - index($0, "(") - length(rest) - 1);
      split(FILENAME, q, "/"); pid = q[3]; tid = (q[4] == "task") ? q[5] : "P";
      print pid "|" tid "|" name "|" (f[12] + f[13]) "|" f[1] "|" f[16] "|" f[17]
    }' /proc/[0-9]*/stat /proc/[0-9]*/task/[0-9]*/stat 2>/dev/null
  }
  c1=$(head -n 1 /proc/stat); d1=$(grep -E '^ *(wlan0|bt-pan):' /proc/net/dev 2>/dev/null); i1=$(grep -E '^ *[0-9]+:' /proc/interrupts); s1=$(snap)
  sleep "$n"
  c2=$(head -n 1 /proc/stat); d2=$(grep -E '^ *(wlan0|bt-pan):' /proc/net/dev 2>/dev/null); i2=$(grep -E '^ *[0-9]+:' /proc/interrupts); s2=$(snap)
  echo "# window ${n}s  uptime $(cut -d' ' -f1 /proc/uptime) s  load $(cut -d' ' -f1-3 /proc/loadavg)  $(awk '/^MemTotal|^MemAvailable|^MemFree/{printf "%s %s kB  ", $1, $2}' /proc/meminfo)"
  echo "$c1"; echo "$c2" | awk -v c1="$c1" '{ split(c1, a, " "); t = 0; for (i = 2; i <= 11; i++) t += $i - a[i]; if (t < 1) t = 1;
    printf "# cpu%%: user %.1f nice %.1f sys %.1f idle %.1f iowait %.1f irq %.1f softirq %.1f  (total jiffies %d)\n", ($2-a[2])*100/t, ($3-a[3])*100/t, ($4-a[4])*100/t, ($5-a[5])*100/t, ($6-a[6])*100/t, ($7-a[7])*100/t, ($8-a[8])*100/t, t }'
  { echo "$d1"; echo "$d2"; } | awk -v n="$n" '{ gsub(":", " "); if (!($1 in r)) { r[$1] = $2; tx[$1] = $10 } else printf "# %s: rx %.0f kB/s  tx %.0f kB/s\n", $1, ($2 - r[$1]) / 1024 / n, ($10 - tx[$1]) / 1024 / n }'
  { echo "$i1"; echo "$i2"; } | awk -v n="$n" '{ k = $1; if (!(k in c)) { c[k] = $2; nm[k] = ""; for (i = 4; i <= NF; i++) nm[k] = nm[k] " " $i } else d[k] = $2 - c[k] }
    END { for (k in d) if (d[k] > 0) printf "# irq %s %6.0f/s %s\n", k, d[k] / n, nm[k] }' | sort -k3 -rn | head -n 6
  tot=$(echo "$c2" | awk -v c1="$c1" '{ split(c1, a, " "); t = 0; for (i = 2; i <= 11; i++) t += $i - a[i]; print (t < 1 ? 1 : t) }')
  echo "# processes (cpu% of one core over the window = all threads, rss kB, state, prio/nice), then threads >= 0.5%"
  { echo "$s1"; echo "$s2"; } | awk -F'|' -v tot="$tot" '
    { k = $1 "|" $2; if (!(k in j)) { j[k] = $4; next } d[k] = $4 - j[k]; st[k] = $5; nm[k] = $3; pr[k] = $6 "/" $7 }
    END { for (k in d) { split(k, q, "|"); if (q[2] == "P") printf "P %s %6.1f %s %s %s\n", q[1], d[k] * 100 / tot, st[k], pr[k], nm[k]; else if (d[k] * 100 / tot >= 0.5) printf "T %s/%s %6.1f %s %s\n", q[1], q[2], d[k] * 100 / tot, pr[k], nm[k] } }' > /tmp/t2c_top.$$
  for pid in $(grep '^P ' /tmp/t2c_top.$$ | sort -k3 -rn | head -n 20 | awk '{print $2}'); do
    rss=$(awk '/^VmRSS/{print $2}' /proc/$pid/status 2>/dev/null)
    grep "^P $pid " /tmp/t2c_top.$$ | awk -v rss="${rss:-0}" '{ printf "%-5s %6s%%  rss %6s kB  %s  %-7s %s\n", $2, $3, rss, $4, $5, $6 }'
    grep "^T $pid/" /tmp/t2c_top.$$ | sort -k3 -rn | awk '{ printf "      thread %-10s %6s%%  %-7s %s\n", $2, $3, $4, $5 }'
  done
  rm -f /tmp/t2c_top.$$
  ;;
usbmode)
  # ?a=usbmode&v=adb|none : USB device mode through app/t2c_usb.sh (legacy android_usb gadget + OTG role)
  json_hdr
  case "$V" in adb|none) ;; *) printf '{"code":2,"msg":"bad mode"}'; exit 0 ;; esac
  out=$(/mnt/customer/app/t2c_usb.sh "$V" 2>&1); rc=$?
  printf '{"code":%s,"mode":"%s","out":"%s"}' "$rc" "$V" "$(je "$out")"
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
    hostapd_t2c)     f=/tmp/hostapd-t2c.conf ;;
    t2c_hostapd)     f=/tmp/t2c_hostapd.log ;;
    vht_fail)        f=/mnt/UDISK/t2c_vht_fail ;;
    hostapd_log)     f=/tmp/hostapd-t2c.log ;;
    usb)             cmd='/mnt/customer/app/t2c_usb.sh status; ls -la /bin/adbd /bin/setusbconfig 2>&1; echo "## modules:"; ls -R /lib/modules 2>&1 | head -n 60; echo "## gadget dirs:"; ls /sys/kernel/config/usb_gadget/ /sys/kernel/config/usb_gadget/*/ /sys/kernel/config/usb_gadget/*/functions 2>&1 | head -n 20; echo "## usb-related in /proc/modules + builtin:"; grep -iE "usb|gadget|udc|composite|f_" /proc/modules /lib/modules/*/modules.builtin 2>/dev/null | head -n 20; echo "## setusbconfig:"; cat /bin/setusbconfig' ;;
    maps)            cmd='for p in $(ps 2>/dev/null | awk "/tesla -s/ && !/awk/ {print \$1}"); do echo "## pid $p"; grep -E "^(VmRSS|VmData|VmSize|Threads)" /proc/$p/status; while read -r range perm rest; do case "$perm" in *w*) ;; *) continue ;; esac; a=${range%-*}; b=${range#*-}; sz=$(( (0x$b - 0x$a) / 1024 )); n=${rest##* }; case "$n" in [0-9]*|"") n=anon ;; esac; echo "$sz $n"; done < /proc/$p/maps | awk "{t[\$2]+=\$1; c[\$2]++} END {for (n in t) printf \"%8d kB %4d maps  %s\\n\", t[n], c[n], n}" | sort -rn | head -n 10; done' ;;
    flags)           cmd='for f in /mnt/UDISK/t2c_hostapd_debug /mnt/UDISK/t2c_country /mnt/UDISK/t2c_vht_off /mnt/UDISK/t2c_vht80 /mnt/UDISK/t2c_hostapd_extra /mnt/UDISK/t2c_adb /mnt/UDISK/t2c_vht_fail; do [ -e "$f" ] && printf "%s: %s\\n" "$f" "$(cat "$f" 2>/dev/null)"; done; true' ;;
    wlan_params)     cmd='grep -r . /sys/module/8821cs/parameters/' ;;
    hostapd_caps)    cmd='/usr/sbin/hostapd -v 2>&1 | head -n 3; /usr/sbin/hostapd -h 2>&1 | grep -E "^ +-[a-zA-Z]"; for k in ieee80211ac vht_oper_chwidth vht_capab ieee80211n ht_capab; do printf "%s: %s\n" "$k" "$(grep -c "$k" /usr/sbin/hostapd 2>/dev/null)"; done; ls -la /usr/sbin/hostapd' ;;
    wlan_ls)         cmd='ls -la /proc/net/rtl8821cs/wlan0' ;;
    wlan_*)          n=${F#wlan_}; case "$n" in ''|*[!a-z0-9_]*) cmd='echo bad name' ;; *) f=/proc/net/rtl8821cs/wlan0/$n ;; esac ;;
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
