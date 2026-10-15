/* First-installation page for the CPC200-T2C firmware (GitHub Pages).
 *
 * The page itself is served over HTTPS, and browsers refuse HTTPS -> HTTP requests
 * (mixed content), so the adapter at http://192.168.3.1 cannot be reached with fetch/XHR
 * from here. The flow is therefore: download the image into the phone/laptop while on
 * normal internet, join the adapter's Wi-Fi, then submit the file with a plain HTML form
 * (form navigations to HTTP are allowed after the browser's "not secure" warning).
 * Once this firmware is installed, the adapter's own page (http://192.168.3.1) updates
 * itself with one tap.
 */
(function () {
  'use strict';
  var BASE = 'https://raw.githubusercontent.com/taylor224/cpc200-t2c/main/updates';
  var BRANCH = '1508';

  var T = {};
  T.en = {
    'sub': 'Tesla UI firmware · first installation',
    'latest': 'Latest firmware', 'version': 'Version', 'file': 'File', 'notes': 'Release notes on GitHub',
    's1.title': 'Download the firmware', 's1.text': 'Do this while your phone or laptop still has internet (home Wi‑Fi or mobile data). The file is about 8 MB and is kept in your Downloads folder.',
    's1.button': 'Download latest firmware', 's1.direct': 'Direct link (if the button does not work)',
    's2.title': 'Join the adapter’s Wi‑Fi', 's2.text': 'Power the T2C (in the car or from any USB charger) and connect your phone or laptop to its network. The name starts with AutoKit_ or TesPush_; the password is printed on the adapter (default 88888888) or set in the Carlinkit app.',
    's2.hint': 'Stay on this page while switching networks. The adapter’s Wi‑Fi has no internet of its own; that is expected.',
    's3.title': 'Install', 's3.text': 'Choose the downloaded file and press Install. The browser will warn that the destination (http://192.168.3.1) is not secure — that is the adapter on your local network; confirm to send.',
    's3.pick': 'Firmware file (T2C-tesla-ui-….img)', 's3.button': 'Install on the adapter',
    's3.warn': 'Only for the Carlinkit T2C / TesPush T2C on firmware branch 1508 (version looks like 2609….1508.x). Keep the adapter powered until it is done.',
    's3.reply': 'A new tab shows the adapter’s reply. {"code": 0, "msg": "upload successful"} means the file was accepted; anything else means it was rejected and nothing was changed.',
    's4.title': 'Wait about five minutes', 's4.text': 'The adapter checks the file, reboots into recovery, writes the firmware and reboots again. Its Wi‑Fi disappears for about half a minute in the middle.',
    's4.after': 'Afterwards http://192.168.3.1 shows the new settings page (reboot, Wi‑Fi password, channel, updates) and the car browser shows the new CarPlay page. Future updates: Settings → About → Check for updates in the car, or Software on the phone page.',
    'alt.title': 'Alternative: command line', 'alt.text': 'On a computer connected to the adapter’s Wi‑Fi, the same upload with curl:',
    'alt.hint': 'The repository also ships tools/flash.sh, which checks the partition sizes on the adapter before uploading and waits for it to come back.',
    'dl.start': 'Downloading…', 'dl.done': 'Saved. Continue with step 2.', 'dl.fail': 'Download failed; use the direct link.'
  };
  T.ko = {
    'sub': '테슬라 UI 펌웨어 · 처음 설치',
    'latest': '최신 펌웨어', 'version': '버전', 'file': '파일', 'notes': 'GitHub 릴리스 노트',
    's1.title': '펌웨어 다운로드', 's1.text': '폰이나 노트북이 아직 인터넷에 연결된 상태(집 Wi‑Fi 또는 모바일 데이터)에서 진행하세요. 파일은 약 8 MB이고 다운로드 폴더에 저장됩니다.',
    's1.button': '최신 펌웨어 다운로드', 's1.direct': '직접 링크(버튼이 안 되면)',
    's2.title': '어댑터 Wi‑Fi에 접속', 's2.text': 'T2C에 전원을 넣고(차 안 또는 아무 USB 충전기) 폰이나 노트북을 어댑터 네트워크에 연결하세요. 이름은 AutoKit_ 또는 TesPush_로 시작하고, 비밀번호는 어댑터에 인쇄돼 있거나(기본 88888888) Carlinkit 앱에서 설정한 값입니다.',
    's2.hint': '네트워크를 바꾸는 동안 이 페이지를 닫지 마세요. 어댑터 Wi‑Fi에는 인터넷이 없는 게 정상입니다.',
    's3.title': '설치', 's3.text': '다운로드한 파일을 선택하고 설치를 누르세요. 브라우저가 목적지(http://192.168.3.1)가 안전하지 않다고 경고합니다 — 로컬 네트워크의 어댑터이니 전송을 확인하세요.',
    's3.pick': '펌웨어 파일 (T2C-tesla-ui-….img)', 's3.button': '어댑터에 설치',
    's3.warn': 'Carlinkit T2C / TesPush T2C 펌웨어 1508 브랜치(버전이 2609….1508.x 형태) 전용입니다. 끝날 때까지 어댑터 전원을 유지하세요.',
    's3.reply': '새 탭에 어댑터 응답이 표시됩니다. {"code": 0, "msg": "upload successful"} 이면 파일이 접수된 것이고, 다른 응답이면 거부된 것이며 아무것도 바뀌지 않습니다.',
    's4.title': '약 5분 대기', 's4.text': '어댑터가 파일을 검사하고 복구 모드로 재부팅해 펌웨어를 쓴 뒤 다시 재부팅합니다. 중간에 Wi‑Fi가 30초 정도 사라집니다.',
    's4.after': '끝나면 http://192.168.3.1 에 새 설정 페이지(재부팅, Wi‑Fi 비밀번호, 채널, 업데이트)가, 차량 브라우저에는 새 CarPlay 페이지가 뜹니다. 이후 업데이트는 차에서 설정 → 정보 → 업데이트 확인, 또는 폰 페이지의 소프트웨어 항목에서.',
    'alt.title': '다른 방법: 명령줄', 'alt.text': '어댑터 Wi‑Fi에 연결된 컴퓨터에서 curl로 같은 업로드:',
    'alt.hint': '저장소의 tools/flash.sh는 업로드 전에 어댑터의 파티션 크기를 확인하고 복귀까지 기다립니다.',
    'dl.start': '다운로드 중…', 'dl.done': '저장됨. 2단계로 진행하세요.', 'dl.fail': '다운로드 실패 — 직접 링크를 사용하세요.'
  };
  T.ja = {
    'sub': 'Tesla UI ファームウェア · 初回インストール',
    'latest': '最新ファームウェア', 'version': 'バージョン', 'file': 'ファイル', 'notes': 'GitHub のリリースノート',
    's1.title': 'ファームウェアをダウンロード', 's1.text': 'スマートフォンや PC がまだインターネットに接続している間（自宅 Wi‑Fi またはモバイルデータ）に行ってください。約 8 MB でダウンロードフォルダーに保存されます。',
    's1.button': '最新ファームウェアをダウンロード', 's1.direct': '直接リンク（ボタンが動かない場合）',
    's2.title': 'アダプターの Wi‑Fi に接続', 's2.text': 'T2C に電源を入れ（車内または USB 充電器）、スマートフォンや PC をそのネットワークに接続します。名前は AutoKit_ または TesPush_ で始まり、パスワードはアダプターに印字（既定 88888888）または Carlinkit アプリで設定したものです。',
    's2.hint': 'ネットワークを切り替える間、このページは開いたままにしてください。アダプターの Wi‑Fi にインターネットがないのは正常です。',
    's3.title': 'インストール', 's3.text': 'ダウンロードしたファイルを選び、インストールを押します。ブラウザーが送信先（http://192.168.3.1）は安全でないと警告しますが、ローカルネットワーク上のアダプターです。送信を確認してください。',
    's3.pick': 'ファームウェアファイル (T2C-tesla-ui-….img)', 's3.button': 'アダプターにインストール',
    's3.warn': 'Carlinkit T2C / TesPush T2C のファームウェア 1508 系（バージョンが 2609….1508.x）専用です。完了までアダプターの電源を切らないでください。',
    's3.reply': '新しいタブにアダプターの応答が表示されます。{"code": 0, "msg": "upload successful"} なら受理、それ以外は拒否され何も変更されません。',
    's4.title': '約 5 分待つ', 's4.text': 'アダプターはファイルを検査し、リカバリーで再起動してファームウェアを書き込み、再度再起動します。途中で Wi‑Fi が 30 秒ほど消えます。',
    's4.after': '完了後、http://192.168.3.1 に新しい設定ページ（再起動、Wi‑Fi パスワード、チャンネル、更新）、車のブラウザーに新しい CarPlay ページが表示されます。以後の更新は車で設定 → 情報 → 更新を確認、またはスマートフォンページのソフトウェアから。',
    'alt.title': '別の方法: コマンドライン', 'alt.text': 'アダプターの Wi‑Fi に接続した PC から curl で同じアップロード:',
    'alt.hint': 'リポジトリの tools/flash.sh はアップロード前にアダプターのパーティションサイズを確認し、復帰まで待ちます。',
    'dl.start': 'ダウンロード中…', 'dl.done': '保存しました。手順 2 へ。', 'dl.fail': 'ダウンロード失敗 — 直接リンクを使ってください。'
  };
  T['zh-CN'] = {
    'sub': 'Tesla UI 固件 · 首次安装',
    'latest': '最新固件', 'version': '版本', 'file': '文件', 'notes': 'GitHub 发布说明',
    's1.title': '下载固件', 's1.text': '请在手机或电脑仍有互联网（家庭 Wi‑Fi 或移动数据）时进行。文件约 8 MB，保存在下载文件夹。',
    's1.button': '下载最新固件', 's1.direct': '直接链接（按钮无效时）',
    's2.title': '连接适配器的 Wi‑Fi', 's2.text': '给 T2C 通电（车内或任意 USB 充电器），把手机或电脑连接到它的网络。名称以 AutoKit_ 或 TesPush_ 开头，密码印在适配器上（默认 88888888）或在 Carlinkit 应用中设置。',
    's2.hint': '切换网络时请保持本页打开。适配器的 Wi‑Fi 没有互联网是正常的。',
    's3.title': '安装', 's3.text': '选择下载的文件并点击安装。浏览器会警告目标（http://192.168.3.1）不安全 — 那是本地网络中的适配器，请确认发送。',
    's3.pick': '固件文件 (T2C-tesla-ui-….img)', 's3.button': '安装到适配器',
    's3.warn': '仅适用于 Carlinkit T2C / TesPush T2C 固件 1508 分支（版本形如 2609….1508.x）。完成前请保持适配器供电。',
    's3.reply': '新标签页显示适配器的回复。{"code": 0, "msg": "upload successful"} 表示已接受；其他回复表示被拒绝，未作任何更改。',
    's4.title': '等待约五分钟', 's4.text': '适配器检查文件，重启进入恢复模式写入固件，然后再次重启。中间 Wi‑Fi 会消失约半分钟。',
    's4.after': '之后 http://192.168.3.1 显示新的设置页（重启、Wi‑Fi 密码、信道、更新），车机浏览器显示新的 CarPlay 页面。以后更新：车内 设置 → 关于 → 检查更新，或手机页的软件。',
    'alt.title': '另一种方式：命令行', 'alt.text': '在连接到适配器 Wi‑Fi 的电脑上用 curl 完成同样的上传：',
    'alt.hint': '仓库还提供 tools/flash.sh，上传前检查适配器的分区大小并等待其恢复。',
    'dl.start': '下载中…', 'dl.done': '已保存，继续第 2 步。', 'dl.fail': '下载失败 — 请使用直接链接。'
  };
  T['zh-TW'] = {
    'sub': 'Tesla UI 韌體 · 首次安裝',
    'latest': '最新韌體', 'version': '版本', 'file': '檔案', 'notes': 'GitHub 發行說明',
    's1.title': '下載韌體', 's1.text': '請在手機或電腦仍有網際網路（家用 Wi‑Fi 或行動數據）時進行。檔案約 8 MB，儲存在下載資料夾。',
    's1.button': '下載最新韌體', 's1.direct': '直接連結（按鈕無效時）',
    's2.title': '連線到轉接器的 Wi‑Fi', 's2.text': '為 T2C 供電（車內或任何 USB 充電器），將手機或電腦連到它的網路。名稱以 AutoKit_ 或 TesPush_ 開頭，密碼印在轉接器上（預設 88888888）或在 Carlinkit App 設定。',
    's2.hint': '切換網路時請保持本頁開啟。轉接器的 Wi‑Fi 沒有網際網路是正常的。',
    's3.title': '安裝', 's3.text': '選擇下載的檔案並按安裝。瀏覽器會警告目標（http://192.168.3.1）不安全 — 那是區域網路中的轉接器，請確認傳送。',
    's3.pick': '韌體檔案 (T2C-tesla-ui-….img)', 's3.button': '安裝到轉接器',
    's3.warn': '僅適用於 Carlinkit T2C / TesPush T2C 韌體 1508 分支（版本形如 2609….1508.x）。完成前請保持轉接器供電。',
    's3.reply': '新分頁會顯示轉接器的回覆。{"code": 0, "msg": "upload successful"} 表示已接受；其他回覆表示被拒絕，未做任何更改。',
    's4.title': '等待約五分鐘', 's4.text': '轉接器檢查檔案，重新啟動進入復原模式寫入韌體，然後再次重新啟動。中間 Wi‑Fi 會消失約半分鐘。',
    's4.after': '之後 http://192.168.3.1 顯示新的設定頁（重新啟動、Wi‑Fi 密碼、頻道、更新），車機瀏覽器顯示新的 CarPlay 頁面。日後更新：車內 設定 → 關於 → 檢查更新，或手機頁的軟體。',
    'alt.title': '另一種方式：命令列', 'alt.text': '在連到轉接器 Wi‑Fi 的電腦上用 curl 完成同樣的上傳：',
    'alt.hint': '儲存庫也提供 tools/flash.sh，上傳前會檢查轉接器的分割區大小並等待其恢復。',
    'dl.start': '下載中…', 'dl.done': '已儲存，請繼續第 2 步。', 'dl.fail': '下載失敗 — 請使用直接連結。'
  };

  var lang = 'en';
  function pickLang(pref) {
    if (pref && pref !== 'auto' && T[pref]) return pref;
    var n = (navigator.language || 'en').toLowerCase();
    if (n.indexOf('ko') === 0) return 'ko';
    if (n.indexOf('ja') === 0) return 'ja';
    if (n.indexOf('zh') === 0) return (/tw|hk|mo|hant/.test(n)) ? 'zh-TW' : 'zh-CN';
    return 'en';
  }
  function t(k) { return (T[lang] && T[lang][k]) || T.en[k] || k; }
  function applyLang() {
    document.documentElement.lang = lang;
    var els = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < els.length; i++) els[i].textContent = t(els[i].getAttribute('data-i18n'));
  }
  function $(id) { return document.getElementById(id); }

  var latest = null;
  function loadLatest() {
    fetch(BASE + '/' + BRANCH + '/version.json?rand=' + Math.random(), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        latest = j;
        $('ver').textContent = j.appver + ' / ' + j.tsl;
        $('file').textContent = j.url.split('/').pop();
        $('msg').textContent = j.msg || '';
        if (j.release) $('release-link').href = j.release;
        $('direct-link').href = j.url;
        $('direct-link').setAttribute('download', j.url.split('/').pop());
        $('curl').textContent = "curl -F 'file=@" + j.url.split('/').pop() + ";filename=update.img' 'http://192.168.3.1/cgi-bin/index.cgi?id=upload'";
      })
      .catch(function () { $('ver').textContent = '—'; $('file').textContent = '—'; });
  }
  function download() {
    if (!latest) return;
    var name = latest.url.split('/').pop();
    $('btn-download').disabled = true; $('dl-prog').classList.remove('hidden'); $('dl-msg').textContent = t('dl.start');
    fetch(latest.url).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      var total = +r.headers.get('Content-Length') || 0, got = 0, chunks = [], reader = r.body.getReader();
      return (function read() {
        return reader.read().then(function (res) {
          if (res.done) return new Blob(chunks, { type: 'application/octet-stream' });
          chunks.push(res.value); got += res.value.length;
          if (total) $('dl-bar').style.width = (got / total * 100) + '%';
          return read();
        });
      })();
    }).then(function (blob) {
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 10000);
      $('dl-bar').style.width = '100%'; $('dl-msg').textContent = t('dl.done'); $('btn-download').disabled = false;
    }).catch(function () { $('dl-msg').textContent = t('dl.fail'); $('btn-download').disabled = false; });
  }

  document.addEventListener('DOMContentLoaded', function () {
    lang = pickLang(localStorage.getItem('t2c.lang'));
    $('lang').value = localStorage.getItem('t2c.lang') || 'auto';
    $('lang').onchange = function () { localStorage.setItem('t2c.lang', this.value); lang = pickLang(this.value); applyLang(); };
    applyLang();
    $('btn-download').onclick = download;
    loadLatest();
  });
})();
