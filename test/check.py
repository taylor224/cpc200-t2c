#!/usr/bin/env python3
"""Static checks for the web UI (run: python3 test/check.py)."""
import json, os, re, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
WWW = os.path.join(ROOT, 'src', 'www')
fails = 0


def check(cond, msg):
    global fails
    print(('ok   ' if cond else 'FAIL ') + msg)
    if not cond:
        fails += 1


# 1. index.in must not contain '|' (adapter template token character)
src = open(os.path.join(WWW, 'index.in'), encoding='utf-8').read()
check('|' not in src, 'index.in has no "|" characters')

# 2. every id referenced by app.js via $('id') exists in index.in
app = open(os.path.join(WWW, 'js', 'app.js'), encoding='utf-8').read()
ids = set(re.findall(r"\$\('([a-zA-Z0-9_-]+)'\)", app))
dom_ids = set(re.findall(r'id="([^"]+)"', src))
missing = sorted(i for i in ids if i not in dom_ids)
check(not missing, 'all $(id) targets exist in index.in' + ('' if not missing else ': missing ' + ', '.join(missing)))

# 3. every data-i18n key in index.in exists in the English table, and all languages share keys
i18n = open(os.path.join(WWW, 'js', 'i18n.js'), encoding='utf-8').read()
tables = {}
for m in re.finditer(r"T(?:\.(\w+)|\['([\w-]+)'\])\s*=\s*\{(.*?)\n  \};", i18n, re.S):
    name = m.group(1) or m.group(2)
    tables[name] = set(re.findall(r"'([a-z]+\.[a-z0-9_]+)':", m.group(3)))
check(set(tables) == {'en', 'ko', 'ja', 'zh-CN', 'zh-TW'}, 'five language tables present: ' + ', '.join(sorted(tables)))
en = tables.get('en', set())
for name, keys in tables.items():
    diff = sorted(en ^ keys)
    check(not diff, 'keys of %s match en' % name + ('' if not diff else ': ' + ', '.join(diff)))
html_keys = set(re.findall(r'data-i18n="([^"]+)"', src))
missing_keys = sorted(k for k in html_keys if k not in en)
check(not missing_keys, 'all data-i18n keys in index.in exist' + ('' if not missing_keys else ': ' + ', '.join(missing_keys)))
js_keys = set(re.findall(r"t\('([a-z]+\.[a-z0-9_]+)'", app)) | set(re.findall(r"I\.t\('([a-z]+\.[a-z0-9_]+)'", open(os.path.join(WWW, 'js', 'video.js')).read()))
missing_js = sorted(k for k in js_keys if k not in en)
check(not missing_js, 'all t() keys in JS exist' + ('' if not missing_js else ': ' + ', '.join(missing_js)))

# 4. lan files for the adapter's template engine stay within limits
for n in range(3):
    p = os.path.join(WWW, 'lan', '%d.txt' % n)
    lines = open(p, encoding='utf-8').read().split('\n')
    check(len(lines) <= 128, 'lan/%d.txt has %d lines (<= 128)' % (n, len(lines)))

# 5. JS syntax
for f in sorted(os.listdir(os.path.join(WWW, 'js'))):
    if f.endswith('.js'):
        r = subprocess.run(['node', '--check', os.path.join(WWW, 'js', f)], capture_output=True, text=True)
        check(r.returncode == 0, 'node --check js/%s' % f + ('' if r.returncode == 0 else '\n' + r.stderr))

# 5b. phone page (src/ota-www): JS syntax, i18n parity, CGI script syntax, no leftover SDKs
OTA = os.path.join(ROOT, 'src', 'ota-www')
r = subprocess.run(['node', '--check', os.path.join(OTA, 'js', 'ota.js')], capture_output=True, text=True)
check(r.returncode == 0, 'node --check ota-www/js/ota.js' + ('' if r.returncode == 0 else '\n' + r.stderr))
ota_js = open(os.path.join(OTA, 'js', 'ota.js'), encoding='utf-8').read()
ota_tables = {}
for m in re.finditer(r"T(?:\.(\w+)|\['([\w-]+)'\])\s*=\s*\{(.*?)\n  \};", ota_js, re.S):
    ota_tables[m.group(1) or m.group(2)] = set(re.findall(r"'([a-z]+(?:\.[a-z0-9_]+)?)':", m.group(3)))
check(set(ota_tables) == {'en', 'ko', 'ja', 'zh-CN', 'zh-TW'}, 'ota-www: five language tables: ' + ', '.join(sorted(ota_tables)))
ota_en = ota_tables.get('en', set())
for name, keys in ota_tables.items():
    diff = sorted(ota_en ^ keys)
    check(not diff, 'ota-www keys of %s match en' % name + ('' if not diff else ': ' + ', '.join(diff)))
ota_html = open(os.path.join(OTA, 'index.html'), encoding='utf-8').read()
missing_ota = sorted(k for k in set(re.findall(r'data-i18n="([^"]+)"', ota_html)) if k not in ota_en)
check(not missing_ota, 'ota-www: all data-i18n keys exist' + ('' if not missing_ota else ': ' + ', '.join(missing_ota)))
ota_js_keys = set(re.findall(r"\bt\('([a-z]+(?:\.[a-z0-9_]+)?)'", ota_js))
missing_ota_js = sorted(k for k in ota_js_keys if k not in ota_en)
check(not missing_ota_js, 'ota-www: all t() keys exist' + ('' if not missing_ota_js else ': ' + ', '.join(missing_ota_js)))
ota_ids = set(re.findall(r"\$\('([a-zA-Z0-9_-]+)'\)", ota_js)); ota_dom = set(re.findall(r'id="([^"]+)"', ota_html))
missing_ids = sorted(i for i in ota_ids if i not in ota_dom)
check(not missing_ids, 'ota-www: all $(id) targets exist' + ('' if not missing_ids else ': ' + ', '.join(missing_ids)))
cgi = os.path.join(OTA, 'cgi-bin', 't2c.cgi')
r = subprocess.run(['sh', '-n', cgi], capture_output=True, text=True)
check(r.returncode == 0, 'sh -n ota-www/cgi-bin/t2c.cgi' + ('' if r.returncode == 0 else '\n' + r.stderr))
check(open(cgi, 'rb').read().startswith(b'#!/bin/sh\n') and b'\r' not in open(cgi, 'rb').read(), 't2c.cgi: #!/bin/sh shebang, LF line endings')
check(not os.path.exists(os.path.join(OTA, 'js', 'aliyun-oss-sdk.min.js')), 'ota-www: no Aliyun OSS SDK')

# 6. total size budget (the adapter copies www into RAM at boot)
total = 0
for d, _, fs in os.walk(WWW):
    for f in fs:
        total += os.path.getsize(os.path.join(d, f))
check(total < 2200 * 1024, 'src/www total %d KB < 2200 KB (includes the 1.4 MB H.264 decoder)' % (total // 1024))

print('\n%d failure(s)' % fails)
sys.exit(1 if fails else 0)
