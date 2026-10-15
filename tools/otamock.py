#!/usr/bin/env python3
"""Mock of the adapter's phone-facing HTTP server (busybox httpd + index.cgi + t2c.cgi).

    tools/otamock.py [--port 8792] [--www src/ota-www] [--hw BT_Network] [--branch 1508]

Serves the page and answers the CGI queries the page makes, so the UI can be checked in a
browser without an adapter. Reboot/upload only pretend (a short offline window).
"""
import argparse, json, os, sys, time, urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

STATE = {'pix': 1, 'sig': 161, 'btnet': 0, 'name': 'AutoKit_051E', 'update': 0, 'offline_until': 0,
         'appver': '26090414.1508.1', 'psk': 'mockpass1'}
BOOT = time.time() - 3600 * 5


class H(SimpleHTTPRequestHandler):
    def log_message(self, fmt, *a):
        sys.stdout.write('%s %s\n' % (time.strftime('%H:%M:%S'), fmt % a)); sys.stdout.flush()

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code); self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)

    def _text(self, s, code=200, ctype='text/plain; charset=utf-8'):
        body = s.encode(); self.send_response(code); self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)

    def do_GET(self):
        u = urllib.parse.urlsplit(self.path); q = urllib.parse.parse_qs(u.query)
        if time.time() < STATE['offline_until']:
            self.close_connection = True; return
        if u.path == '/cgi-bin/index.cgi':
            i = q.get('id', [''])[0]
            if i == 'host':
                return self._json({'sys': {'appver': STATE['appver']}, 'update': STATE['update'], 'sn': '08574a01f63c',
                                   'wifi': '08:57:4a:01:f6:3c', 'bt': None, 'sig': STATE['sig'], 'pix': STATE['pix'],
                                   'name': STATE['name'], 'btnet': STATE['btnet'], 'lan': '(null)', 'res': {'txt': [], 'val': []}})
            if i == 'set':
                for k in ('pix', 'wifi', 'btnet', 'icon', 'rst'):
                    if k in q:
                        v = q[k][0]
                        if k == 'pix': STATE['pix'] = int(v)
                        elif k == 'wifi': STATE['sig'] = int(v)
                        elif k == 'btnet': STATE['btnet'] = 2 if v == '1' else 1
                        elif k == 'rst': STATE['offline_until'] = time.time() + 8
                        return self._json({'code': 0})
                return self._json({'code': 1, 'msg': 'unhandled'})
            if i == 'logcat':
                return self._text('obfuscated-log')
            return self._json({'code': 1, 'msg': 'unknown id'})
        if u.path == '/cgi-bin/t2c.cgi':
            a = q.get('a', [''])[0]
            if a == 'info':
                return self._json({'code': 0, 'uptime': int(time.time() - BOOT), 'load': '0.42 0.38 0.35', 'mem_total_kb': 119864, 'mem_avail_kb': 61208,
                                   'udisk': {'total_kb': 1824, 'used_kb': 612, 'avail_kb': 1212}, 'tmp': {'total_kb': 59932, 'used_kb': 4120, 'avail_kb': 55812},
                                   'ssid': STATE['name'], 'psk': STATE['psk'], 'channel': STATE['sig'], 'hostapd': 1, 'clients': 2,
                                   'appver': STATE['appver'], 'lycfg': 1, 'wifi_edit': int(self.server.wifi_edit), 'cgi': 1})
            if a == 'reboot':
                STATE['offline_until'] = time.time() + 10; return self._json({'code': 0})
            if a == 'log':
                return self._text('# mock log\n[    0.000000] Booting Linux\n01-01 00:00:08.070   720   720 D tesla   : main|3916 waitpid 722\n')
            if a == 'cat':
                f = q.get('f', [''])[0]
                return self._text('# mock %s\nssid=%s\nchannel=%d\n' % (f, STATE['name'], STATE['sig']))
            return self._json({'code': 1, 'msg': 'unknown action'}, 400)
        if u.path == '/hw.json':
            return self._json({'hw': self.server.hw, 'imei': ''})
        return SimpleHTTPRequestHandler.do_GET(self)

    def do_POST(self):
        u = urllib.parse.urlsplit(self.path); q = urllib.parse.parse_qs(u.query)
        n = int(self.headers.get('Content-Length') or 0); body = self.rfile.read(n)
        if u.path == '/cgi-bin/index.cgi' and q.get('id', [''])[0] == 'upload':
            STATE['update'] = 2
            STATE['offline_until'] = time.time() + 12
            STATE['appver'] = '26099999.1508.1'
            return self._json({'code': 0, 'msg': 'upload successful', 'size': len(body)})
        if u.path == '/cgi-bin/t2c.cgi' and q.get('a', [''])[0] == 'wifi':
            f = urllib.parse.parse_qs(body.decode())
            if not self.server.wifi_edit: return self._json({'code': 2, 'msg': 'not supported by this build'})
            STATE['name'] = f.get('ssid', [STATE['name']])[0]; STATE['psk'] = f.get('psk', [STATE['psk']])[0]
            STATE['offline_until'] = time.time() + 6
            return self._json({'code': 0})
        return self._json({'code': 1}, 404)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--port', type=int, default=8792)
    p.add_argument('--www', default=os.path.join(os.path.dirname(__file__), '..', 'src', 'ota-www'))
    p.add_argument('--hw', default='BT_Network')
    p.add_argument('--wifi-edit', type=int, default=0)
    a = p.parse_args()
    os.chdir(a.www)
    srv = ThreadingHTTPServer(('127.0.0.1', a.port), H)
    srv.hw = a.hw; srv.wifi_edit = a.wifi_edit
    print('otamock on http://127.0.0.1:%d/ (www=%s hw=%s wifi_edit=%d)' % (a.port, os.getcwd(), a.hw, a.wifi_edit)); sys.stdout.flush()
    srv.serve_forever()


if __name__ == '__main__':
    main()
