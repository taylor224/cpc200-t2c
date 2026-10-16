/* Phone-facing page of the T2C. Data sources:
 *   /cgi-bin/index.cgi?id=host|set|upload   stock CGI (version, resolution, channel, upload)
 *   /hw.json                                 written by the adapter at boot (hardware id)
 *   /cgi-bin/t2c.cgi?a=info|reboot|log|cat|wifi|channel|name|unname   helper script shipped with this firmware
 */
(function () {
  'use strict';
  var CONFIG = {
    // <base>/<branch>/version.json, e.g. .../updates/1508/version.json (fixed: the page cannot
    // be pointed at another server)
    UPDATE_BASE_URL: 'https://raw.githubusercontent.com/taylor224/cpc200-t2c/main/updates'
  };
  var CHANNELS = [6, 36, 40, 44, 48, 149, 153, 157, 161, 165];
  var CH40 = [36, 40, 44, 48, 149, 153, 157, 161];   // 5 GHz channels the hostapd wrapper runs at 40 MHz (valid HT40 pair)
  var DIAG = ['top', 'dns', 'hostapd', 'hostapd_default', 'lycfg', 'system', 'mtd', 'cmdline', 'mounts', 'meminfo', 'udisk', 'etc_wifi', 'ps', 'env', 'ifconfig', 'private',
    'hostapd_t2c', 't2c_hostapd', 'hostapd_log', 'flags', 'maps', 'usb', 'vht_fail', 'hostapd_caps', 'wlan_params', 'wlan_ls', 'wlan_all_sta_info', 'wlan_ap_info', 'wlan_trx_info', 'wlan_rx_signal'];

  var T = {};
  T.en = {
    'cp.name': 'Device name', 'cp.name_now': 'Now: Bluetooth {bt} · CarPlay {car}',
    'cp.name_hint': 'Shown in the iPhone’s Bluetooth list and as the car in CarPlay. Up to 12 letters, digits, spaces and _ . -. The adapter reboots; the Wi‑Fi network name stays the same.',
    'q.name': 'Rename the adapter to “{name}”? It reboots.', 'msg.name_chars': 'Use 1–12 letters, digits, spaces or _ . - (no space at the start or end)',
    'stg.download': 'Download', 'stg.upload': 'Send', 'stg.verify': 'Check', 'stg.write': 'Write · reboot', 'stg.done': 'Done',
    'sw.verifying': 'The adapter is checking and preparing the image', 'sw.writing': 'Writing the firmware — the adapter’s Wi‑Fi is off for about a minute; this page waits for it',
    'sw.elapsed': 'Elapsed {t}', 'sw.left': 'about {t} left', 'sw.same': 'The adapter came back with the old version',
    'sec.status': 'Status', 'st.wifi': 'Wi‑Fi network', 'st.channel': 'Channel', 'st.fw': 'Firmware', 'st.hw': 'Hardware',
    'st.uptime': 'Uptime', 'st.mem': 'Memory used', 'st.cpu': 'CPU', 'st.clients': 'Connected devices',
    'cp.res': 'Resolution', 'cp.auto': 'Auto', 'cp.res_hint': 'HD 1376×1072, SD 800×800, Auto follows the Tesla page. The Tesla page can override this per session.',
    'cp.icon': 'Car icon', 'cp.btnet': 'BT modem', 'on': 'On', 'off': 'Off',
    'wifi.channel': 'Channel', 'wifi.rec': 'recommended', 'wifi.channel_hint': 'Changing the channel reboots the adapter; your phone reconnects by itself. 36–48 and 149–161 are 5 GHz at 40 MHz (recommended), 165 is 5 GHz at 20 MHz, 6 is 2.4 GHz.',
    'wifi.psk': 'Password', 'wifi.psk_hint': '8–11 characters (letters, digits, ! @ # $ ^ * ( ) _ - . , : ; ? ~). The adapter reboots; the iPhone and the Tesla must rejoin with the new password.',
    'wifi.noedit': 'No saved settings file yet — set a password once from the Tesla screen (Wi‑Fi page), then it can be changed here.',
    'save': 'Save', 'show': 'Show', 'hide': 'Hide', 'ok': 'OK', 'cancel': 'Cancel',
    'sec.system': 'System', 'sys.reboot': 'Reboot', 'sys.log': 'Download log', 'sys.reset': 'Factory reset', 'sys.diag': 'Diagnostics',
    'sec.software': 'Software', 'sw.current': 'Installed',
    'sw.check': 'Check for updates', 'sw.upload': 'Install from file', 'sw.install': 'Download and install',
    'sw.latest': 'Your software is up to date', 'sw.new': 'New version available', 'sw.checking': 'Checking…', 'sw.check_fail': 'Could not reach the update server',
    'sw.downloading': 'Downloading…', 'sw.uploading': 'Uploading to the adapter…', 'sw.installing': 'Installing — the adapter reboots twice, keep it powered',
    'sw.done': 'Update complete', 'sw.fail': 'Update failed', 'sw.rejected': 'The adapter rejected the file',
    'q.reboot': 'Reboot the adapter now?', 'q.reset': 'Reset all settings?\nBluetooth pairings and the Wi‑Fi password are erased and the adapter reboots.',
    'q.channel': 'Switch the hotspot to channel {ch}?', 'q.install': 'Install version {v}?',
    'q.wifi': 'Change the Wi‑Fi password to “{psk}”? The adapter reboots and the car and phone must join with the new password.',
    'msg.rebooting': 'Rebooting… this page reconnects by itself', 'msg.back': 'Adapter is back online', 'msg.offline': 'Adapter not reachable — join its Wi‑Fi',
    'msg.saved': 'Saved', 'msg.fail': 'Failed', 'msg.reset': 'Resetting… the hotspot name and password return to their defaults',
    'msg.psk_short': 'Password must be 8–11 characters', 'msg.psk_chars': 'Unsupported character in password'
  };
  T.ko = {
    'cp.name': '기기 이름', 'cp.name_now': '현재: 블루투스 {bt} · CarPlay {car}',
    'cp.name_hint': 'iPhone 블루투스 목록과 CarPlay 차량 이름으로 표시됩니다. 영문·숫자·공백·_ . - 최대 12자. 저장하면 어댑터가 재부팅되며, Wi‑Fi 네트워크 이름은 그대로입니다.',
    'q.name': '어댑터 이름을 “{name}”(으)로 바꿀까요? 어댑터가 재부팅됩니다.', 'msg.name_chars': '영문·숫자·공백·_ . - 로 1–12자 (앞뒤 공백 불가)',
    'stg.download': '다운로드', 'stg.upload': '전송', 'stg.verify': '검사', 'stg.write': '쓰기 · 재부팅', 'stg.done': '완료',
    'sw.verifying': '어댑터가 이미지를 검사하고 준비하는 중', 'sw.writing': '펌웨어 쓰는 중 — 어댑터 Wi‑Fi가 1분쯤 꺼집니다. 이 페이지가 다시 연결될 때까지 기다립니다',
    'sw.elapsed': '경과 {t}', 'sw.left': '약 {t} 남음', 'sw.same': '어댑터가 이전 버전으로 다시 켜졌습니다',
    'sec.status': '상태', 'st.wifi': 'Wi‑Fi 네트워크', 'st.channel': '채널', 'st.fw': '펌웨어', 'st.hw': '하드웨어',
    'st.uptime': '가동 시간', 'st.mem': '메모리 사용', 'st.cpu': 'CPU', 'st.clients': '연결된 기기',
    'cp.res': '해상도', 'cp.auto': '자동', 'cp.res_hint': 'HD 1376×1072, SD 800×800, 자동은 테슬라 페이지를 따릅니다. 테슬라 페이지에서 세션마다 덮어쓸 수 있습니다.',
    'cp.icon': '차량 아이콘', 'cp.btnet': 'BT 모뎀', 'on': '켬', 'off': '끔',
    'wifi.channel': '채널', 'wifi.rec': '권장', 'wifi.channel_hint': '채널을 바꾸면 어댑터가 재부팅되고 폰이 자동으로 다시 접속합니다. 36–48, 149–161은 5 GHz 40 MHz(권장), 165는 5 GHz 20 MHz, 6은 2.4 GHz입니다.',
    'wifi.psk': '비밀번호', 'wifi.psk_hint': '8–11자(영문, 숫자, ! @ # $ ^ * ( ) _ - . , : ; ? ~). 어댑터가 재부팅되며 iPhone과 테슬라가 새 비밀번호로 다시 접속해야 합니다.',
    'wifi.noedit': '저장된 설정 파일이 아직 없습니다 — 테슬라 화면(Wi‑Fi 페이지)에서 비밀번호를 한 번 설정하면 여기서도 바꿀 수 있습니다.',
    'save': '저장', 'show': '보기', 'hide': '숨기기', 'ok': '확인', 'cancel': '취소',
    'sec.system': '시스템', 'sys.reboot': '재부팅', 'sys.log': '로그 다운로드', 'sys.reset': '공장 초기화', 'sys.diag': '진단 정보',
    'sec.software': '소프트웨어', 'sw.current': '설치된 버전',
    'sw.check': '업데이트 확인', 'sw.upload': '파일로 설치', 'sw.install': '다운로드 후 설치',
    'sw.latest': '최신 버전입니다', 'sw.new': '새 버전이 있습니다', 'sw.checking': '확인 중…', 'sw.check_fail': '업데이트 서버에 연결할 수 없습니다',
    'sw.downloading': '다운로드 중…', 'sw.uploading': '어댑터로 전송 중…', 'sw.installing': '설치 중 — 어댑터가 두 번 재부팅합니다. 전원을 유지하세요',
    'sw.done': '업데이트 완료', 'sw.fail': '업데이트 실패', 'sw.rejected': '어댑터가 파일을 거부했습니다',
    'q.reboot': '어댑터를 지금 재부팅할까요?', 'q.reset': '모든 설정을 초기화할까요?\n블루투스 페어링과 Wi‑Fi 비밀번호가 지워지고 어댑터가 재부팅됩니다.',
    'q.channel': '핫스팟을 {ch} 채널로 바꿀까요?', 'q.install': '버전 {v}을(를) 설치할까요?',
    'q.wifi': 'Wi‑Fi 비밀번호를 “{psk}”(으)로 바꿀까요? 어댑터가 재부팅되고 차량과 폰을 새 비밀번호로 다시 연결해야 합니다.',
    'msg.rebooting': '재부팅 중… 이 페이지가 자동으로 다시 연결됩니다', 'msg.back': '어댑터가 다시 켜졌습니다', 'msg.offline': '어댑터에 연결할 수 없습니다 — 어댑터 Wi‑Fi에 접속하세요',
    'msg.saved': '저장됨', 'msg.fail': '실패', 'msg.reset': '초기화 중… 핫스팟 이름과 비밀번호가 기본값으로 돌아갑니다',
    'msg.psk_short': '비밀번호는 8–11자여야 합니다', 'msg.psk_chars': '비밀번호에 쓸 수 없는 문자가 있습니다'
  };
  T.ja = {
    'cp.name': 'デバイス名', 'cp.name_now': '現在: Bluetooth {bt} · CarPlay {car}',
    'cp.name_hint': 'iPhone の Bluetooth 一覧と CarPlay の車名として表示されます。英数字・スペース・_ . - で 12 文字まで。保存するとアダプターが再起動します。Wi‑Fi ネットワーク名は変わりません。',
    'q.name': 'アダプター名を「{name}」に変更しますか？ 再起動します。', 'msg.name_chars': '英数字・スペース・_ . - で 1〜12 文字（先頭と末尾のスペース不可）',
    'stg.download': 'ダウンロード', 'stg.upload': '転送', 'stg.verify': '検査', 'stg.write': '書き込み · 再起動', 'stg.done': '完了',
    'sw.verifying': 'アダプターがイメージを検査・準備しています', 'sw.writing': 'ファームウェアを書き込み中 — アダプターの Wi‑Fi が 1 分ほど切れます。このページは再接続を待ちます',
    'sw.elapsed': '経過 {t}', 'sw.left': '残り約 {t}', 'sw.same': 'アダプターが以前のバージョンで起動しました',
    'sec.status': '状態', 'st.wifi': 'Wi‑Fi ネットワーク', 'st.channel': 'チャンネル', 'st.fw': 'ファームウェア', 'st.hw': 'ハードウェア',
    'st.uptime': '稼働時間', 'st.mem': 'メモリ使用量', 'st.cpu': 'CPU', 'st.clients': '接続中のデバイス',
    'cp.res': '解像度', 'cp.auto': '自動', 'cp.res_hint': 'HD 1376×1072、SD 800×800、自動は Tesla ページに従います。Tesla ページ側でセッションごとに上書きできます。',
    'cp.icon': '車のアイコン', 'cp.btnet': 'BT モデム', 'on': 'オン', 'off': 'オフ',
    'wifi.channel': 'チャンネル', 'wifi.rec': '推奨', 'wifi.channel_hint': 'チャンネルを変更するとアダプターが再起動し、スマートフォンは自動で再接続します。36〜48 と 149〜161 は 5 GHz・40 MHz（推奨）、165 は 5 GHz・20 MHz、6 は 2.4 GHz です。',
    'wifi.psk': 'パスワード', 'wifi.psk_hint': '8〜11 文字（英数字と ! @ # $ ^ * ( ) _ - . , : ; ? ~）。アダプターが再起動し、iPhone と Tesla は新しいパスワードで接続し直す必要があります。',
    'wifi.noedit': '保存された設定ファイルがまだありません。Tesla 画面（Wi‑Fi ページ）で一度パスワードを設定すると、ここでも変更できます。',
    'save': '保存', 'show': '表示', 'hide': '隠す', 'ok': 'OK', 'cancel': 'キャンセル',
    'sec.system': 'システム', 'sys.reboot': '再起動', 'sys.log': 'ログをダウンロード', 'sys.reset': '初期化', 'sys.diag': '診断情報',
    'sec.software': 'ソフトウェア', 'sw.current': 'インストール済み',
    'sw.check': '更新を確認', 'sw.upload': 'ファイルからインストール', 'sw.install': 'ダウンロードしてインストール',
    'sw.latest': '最新の状態です', 'sw.new': '新しいバージョンがあります', 'sw.checking': '確認中…', 'sw.check_fail': '更新サーバーに接続できません',
    'sw.downloading': 'ダウンロード中…', 'sw.uploading': 'アダプターへ転送中…', 'sw.installing': 'インストール中 — アダプターは 2 回再起動します。電源を切らないでください',
    'sw.done': '更新完了', 'sw.fail': '更新に失敗しました', 'sw.rejected': 'アダプターがファイルを拒否しました',
    'q.reboot': 'アダプターを今すぐ再起動しますか？', 'q.reset': 'すべての設定を初期化しますか？\nBluetooth のペアリングと Wi‑Fi パスワードが消去され、アダプターが再起動します。',
    'q.channel': 'ホットスポットをチャンネル {ch} に切り替えますか？', 'q.install': 'バージョン {v} をインストールしますか？',
    'q.wifi': 'Wi‑Fi パスワードを「{psk}」に変更しますか？ アダプターが再起動し、車とスマートフォンは新しいパスワードで接続し直す必要があります。',
    'msg.rebooting': '再起動中… このページは自動で再接続します', 'msg.back': 'アダプターがオンラインに戻りました', 'msg.offline': 'アダプターに接続できません — アダプターの Wi‑Fi に接続してください',
    'msg.saved': '保存しました', 'msg.fail': '失敗', 'msg.reset': '初期化中… ホットスポット名とパスワードは既定値に戻ります',
    'msg.psk_short': 'パスワードは 8〜11 文字です', 'msg.psk_chars': 'パスワードに使用できない文字があります'
  };
  T['zh-CN'] = {
    'cp.name': '设备名称', 'cp.name_now': '当前：蓝牙 {bt} · CarPlay {car}',
    'cp.name_hint': '显示在 iPhone 的蓝牙列表和 CarPlay 车辆名称中。最多 12 个字母、数字、空格及 _ . -。保存后适配器会重启，Wi‑Fi 网络名称不变。',
    'q.name': '将适配器名称改为“{name}”？适配器会重启。', 'msg.name_chars': '1–12 个字母、数字、空格或 _ . -（首尾不能是空格）',
    'stg.download': '下载', 'stg.upload': '传输', 'stg.verify': '校验', 'stg.write': '写入 · 重启', 'stg.done': '完成',
    'sw.verifying': '适配器正在校验并准备镜像', 'sw.writing': '正在写入固件 — 适配器的 Wi‑Fi 会关闭约一分钟，本页面会等待其恢复',
    'sw.elapsed': '已用 {t}', 'sw.left': '约剩 {t}', 'sw.same': '适配器以旧版本重新启动',
    'sec.status': '状态', 'st.wifi': 'Wi‑Fi 网络', 'st.channel': '信道', 'st.fw': '固件', 'st.hw': '硬件',
    'st.uptime': '运行时间', 'st.mem': '内存占用', 'st.cpu': 'CPU', 'st.clients': '已连接设备',
    'cp.res': '分辨率', 'cp.auto': '自动', 'cp.res_hint': 'HD 1376×1072，SD 800×800，自动跟随 Tesla 页面。Tesla 页面可按会话覆盖此设置。',
    'cp.icon': '车辆图标', 'cp.btnet': 'BT 调制解调器', 'on': '开', 'off': '关',
    'wifi.channel': '信道', 'wifi.rec': '推荐', 'wifi.channel_hint': '更改信道会重启适配器，手机会自动重新连接。36–48 和 149–161 为 5 GHz、40 MHz（推荐），165 为 5 GHz、20 MHz，6 为 2.4 GHz。',
    'wifi.psk': '密码', 'wifi.psk_hint': '8–11 个字符（字母、数字、! @ # $ ^ * ( ) _ - . , : ; ? ~）。适配器会重启，iPhone 和 Tesla 需用新密码重新连接。',
    'wifi.noedit': '尚无已保存的设置文件 — 先在 Tesla 屏幕（Wi‑Fi 页面）设置一次密码，之后即可在此修改。',
    'save': '保存', 'show': '显示', 'hide': '隐藏', 'ok': '确定', 'cancel': '取消',
    'sec.system': '系统', 'sys.reboot': '重启', 'sys.log': '下载日志', 'sys.reset': '恢复出厂设置', 'sys.diag': '诊断信息',
    'sec.software': '软件', 'sw.current': '已安装',
    'sw.check': '检查更新', 'sw.upload': '从文件安装', 'sw.install': '下载并安装',
    'sw.latest': '已是最新版本', 'sw.new': '有新版本', 'sw.checking': '检查中…', 'sw.check_fail': '无法连接更新服务器',
    'sw.downloading': '下载中…', 'sw.uploading': '正在传输到适配器…', 'sw.installing': '安装中 — 适配器会重启两次，请保持供电',
    'sw.done': '更新完成', 'sw.fail': '更新失败', 'sw.rejected': '适配器拒绝了该文件',
    'q.reboot': '现在重启适配器？', 'q.reset': '重置所有设置？\n蓝牙配对和 Wi‑Fi 密码将被清除，适配器将重启。',
    'q.channel': '将热点切换到信道 {ch}？', 'q.install': '安装版本 {v}？',
    'q.wifi': '将 Wi‑Fi 密码改为“{psk}”？适配器会重启，车辆和手机需用新密码重新连接。',
    'msg.rebooting': '重启中… 本页面会自动重新连接', 'msg.back': '适配器已恢复在线', 'msg.offline': '无法连接适配器 — 请加入其 Wi‑Fi',
    'msg.saved': '已保存', 'msg.fail': '失败', 'msg.reset': '重置中… 热点名称和密码恢复为默认值',
    'msg.psk_short': '密码须为 8–11 个字符', 'msg.psk_chars': '密码包含不支持的字符'
  };
  T['zh-TW'] = {
    'cp.name': '裝置名稱', 'cp.name_now': '目前：藍牙 {bt} · CarPlay {car}',
    'cp.name_hint': '顯示在 iPhone 的藍牙清單與 CarPlay 車輛名稱中。最多 12 個字母、數字、空格及 _ . -。儲存後轉接器會重新啟動，Wi‑Fi 網路名稱不變。',
    'q.name': '將轉接器名稱改為「{name}」？轉接器會重新啟動。', 'msg.name_chars': '1–12 個字母、數字、空格或 _ . -（開頭與結尾不能是空格）',
    'stg.download': '下載', 'stg.upload': '傳輸', 'stg.verify': '檢查', 'stg.write': '寫入 · 重新啟動', 'stg.done': '完成',
    'sw.verifying': '轉接器正在檢查並準備映像檔', 'sw.writing': '正在寫入韌體 — 轉接器的 Wi‑Fi 會關閉約一分鐘，本頁面會等待其恢復',
    'sw.elapsed': '已過 {t}', 'sw.left': '約剩 {t}', 'sw.same': '轉接器以舊版本重新啟動',
    'sec.status': '狀態', 'st.wifi': 'Wi‑Fi 網路', 'st.channel': '頻道', 'st.fw': '韌體', 'st.hw': '硬體',
    'st.uptime': '運作時間', 'st.mem': '記憶體使用', 'st.cpu': 'CPU', 'st.clients': '已連線裝置',
    'cp.res': '解析度', 'cp.auto': '自動', 'cp.res_hint': 'HD 1376×1072，SD 800×800，自動跟隨 Tesla 頁面。Tesla 頁面可依工作階段覆寫此設定。',
    'cp.icon': '車輛圖示', 'cp.btnet': 'BT 數據機', 'on': '開', 'off': '關',
    'wifi.channel': '頻道', 'wifi.rec': '建議', 'wifi.channel_hint': '更改頻道會重新啟動轉接器，手機會自動重新連線。36–48 與 149–161 為 5 GHz、40 MHz（建議），165 為 5 GHz、20 MHz，6 為 2.4 GHz。',
    'wifi.psk': '密碼', 'wifi.psk_hint': '8–11 個字元（字母、數字、! @ # $ ^ * ( ) _ - . , : ; ? ~）。轉接器會重新啟動，iPhone 與 Tesla 需以新密碼重新連線。',
    'wifi.noedit': '尚無已儲存的設定檔 — 先在 Tesla 螢幕（Wi‑Fi 頁面）設定一次密碼，之後即可在此修改。',
    'save': '儲存', 'show': '顯示', 'hide': '隱藏', 'ok': '確定', 'cancel': '取消',
    'sec.system': '系統', 'sys.reboot': '重新啟動', 'sys.log': '下載記錄', 'sys.reset': '恢復原廠設定', 'sys.diag': '診斷資訊',
    'sec.software': '軟體', 'sw.current': '已安裝',
    'sw.check': '檢查更新', 'sw.upload': '從檔案安裝', 'sw.install': '下載並安裝',
    'sw.latest': '已是最新版本', 'sw.new': '有新版本', 'sw.checking': '檢查中…', 'sw.check_fail': '無法連線更新伺服器',
    'sw.downloading': '下載中…', 'sw.uploading': '正在傳輸到轉接器…', 'sw.installing': '安裝中 — 轉接器會重新啟動兩次，請保持供電',
    'sw.done': '更新完成', 'sw.fail': '更新失敗', 'sw.rejected': '轉接器拒絕了該檔案',
    'q.reboot': '現在重新啟動轉接器？', 'q.reset': '重設所有設定？\n藍牙配對與 Wi‑Fi 密碼將被清除，轉接器將重新啟動。',
    'q.channel': '將熱點切換到頻道 {ch}？', 'q.install': '安裝版本 {v}？',
    'q.wifi': '將 Wi‑Fi 密碼改為「{psk}」？轉接器會重新啟動，車輛和手機需以新密碼重新連線。',
    'msg.rebooting': '重新啟動中… 本頁面會自動重新連線', 'msg.back': '轉接器已恢復連線', 'msg.offline': '無法連線轉接器 — 請加入其 Wi‑Fi',
    'msg.saved': '已儲存', 'msg.fail': '失敗', 'msg.reset': '重設中… 熱點名稱與密碼恢復為預設值',
    'msg.psk_short': '密碼須為 8–11 個字元', 'msg.psk_chars': '密碼包含不支援的字元'
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
  function t(k, vars) {
    var s = (T[lang] && T[lang][k]) || T.en[k] || k;
    if (vars) Object.keys(vars).forEach(function (v) { s = s.replace('{' + v + '}', vars[v]); });
    return s;
  }
  function applyLang() {
    document.documentElement.lang = lang;
    var els = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < els.length; i++) els[i].textContent = t(els[i].getAttribute('data-i18n'));
  }

  function $(id) { return document.getElementById(id); }
  function get(url) { return fetch(url, { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); }); }
  function toast(msg, ms) {
    var el = $('toast'); el.textContent = msg; el.classList.remove('hidden');
    clearTimeout(toast.timer); toast.timer = setTimeout(function () { el.classList.add('hidden'); }, ms || 2500);
  }
  function confirmBox(msg) {
    return new Promise(function (resolve) {
      var m = $('modal'); $('modal-text').textContent = msg; m.classList.remove('hidden');
      function done(v) { m.classList.add('hidden'); $('modal-ok').onclick = $('modal-cancel').onclick = null; resolve(v); }
      $('modal-ok').onclick = function () { done(true); };
      $('modal-cancel').onclick = function () { done(false); };
    });
  }
  function banner(msg) { var b = $('banner'); if (msg) { b.textContent = msg; b.classList.remove('hidden'); } else b.classList.add('hidden'); }
  function segSet(id, v) {
    var bs = $(id).querySelectorAll('button');
    for (var i = 0; i < bs.length; i++) bs[i].classList.toggle('on', bs[i].getAttribute('data-v') === String(v));
  }
  function segBind(id, fn) {
    var bs = $(id).querySelectorAll('button');
    for (var i = 0; i < bs.length; i++) bs[i].onclick = function () { var v = this.getAttribute('data-v'); Promise.resolve(fn(v)).then(function (ok) { if (ok !== false) segSet(id, v); }); };
  }
  function fmtUptime(s) {
    s = +s || 0; var d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    return (d ? d + 'd ' : '') + h + 'h ' + m + 'm';
  }
  function fmtKb(kb) { return kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB' : kb + ' KB'; }

  var host = null, info = null, appver = '', branch = '', uuid = '', sn = '';

  function setCgi(query) {
    return get('/cgi-bin/index.cgi?id=set&' + query).then(function (j) {
      if (j.code !== 0) throw new Error('code ' + j.code);
      toast(t('msg.saved')); return true;
    }).catch(function (e) { toast(t('msg.fail') + ' (' + e.message + ')'); return false; });
  }

  function loadHost() {
    return get('/cgi-bin/index.cgi?id=host').then(function (j) {
      host = j;
      appver = (j.sys && j.sys.appver) || '';
      branch = appver.split('.')[1] || '';
      sn = j.sn || ''; uuid = (j.wifi || '').replace(/:/g, '');
      $('st-fw').textContent = appver || '—'; $('sw-cur').textContent = appver || '—';
      $('st-uuid').textContent = uuid || '—';
      $('st-ssid').textContent = j.name || '—';
      $('st-ch').textContent = j.sig != null ? j.sig : '—';
      $('row-pix').hidden = j.pix == null;
      if (j.pix != null) segSet('seg-pix', j.pix);
      var sel = $('sel-ch'); if (j.sig != null && CHANNELS.indexOf(+j.sig) < 0) addChannel(+j.sig); sel.value = String(j.sig);
      $('row-icon').hidden = branch !== '1347';
      $('hint-pix').hidden = j.pix == null;
      segSet('seg-icon', j.name === 'Tesla' ? 'tsl0Tesla' : '');
      if (j.btnet === 1 || j.btnet === 2) segSet('seg-btnet', j.btnet === 2 ? 1 : 0);
      $('foot').textContent = (j.name ? j.name + ' · ' : '') + appver;
      banner(null);
    });
  }
  function loadHw() {
    return get('/hw.json').then(function (j) {
      $('st-hw').textContent = j.hw || '—';
      var bt = j.hw === 'BT_Network' || branch === '1552';
      $('row-btnet').hidden = bt;
    }).catch(function () { $('st-hw').textContent = '—'; }).then(showCarplayCard);
  }
  function loadInfo() {
    return get('/cgi-bin/t2c.cgi?a=info').then(function (j) {
      info = j;
      $('st-uptime').textContent = fmtUptime(j.uptime);
      var used = (j.mem_total_kb || 0) - (j.mem_avail_kb || 0);
      $('st-mem').textContent = j.mem_total_kb ? fmtKb(used) + ' / ' + fmtKb(j.mem_total_kb) + ' (' + Math.round(used * 100 / j.mem_total_kb) + '%)' : '—';
      $('st-cpu').textContent = (j.cpu_pct != null ? j.cpu_pct + '%' : '—') + (j.load ? ' · load ' + String(j.load).split(' ')[0] : '');
      $('st-clients').textContent = j.clients != null ? j.clients : '—';
      if (j.ssid) $('st-ssid').textContent = j.ssid;
      if (j.channel) { $('st-ch').textContent = j.channel; $('sel-ch').value = String(j.channel); }
      $('wifi-edit').hidden = !j.wifi_edit;
      $('wifi-view').hidden = !!j.wifi_edit;
      $('in-psk').value = j.psk || '';
      $('wifi-psk-text').textContent = '••••••••';
      // cgi 3 and later can rename the adapter (Bluetooth name + CarPlay car name)
      $('name-edit').hidden = !(j.cgi >= 3);
      if (j.cgi >= 3) {
        if (document.activeElement !== $('in-name')) $('in-name').value = j.devname || j.btname || '';
        $('name-now').textContent = t('cp.name_now', { bt: j.btname || '—', car: j.carname || '—' });
      }
      showCarplayCard();
    }).catch(function () { info = null; $('wifi-view').hidden = false; });
  }
  function showCarplayCard() {
    var card = $('card-carplay');
    card.hidden = !card.querySelector('.row:not([hidden]), #name-edit:not([hidden])');
  }
  function channelText(ch) {
    if (ch < 15) return ch + ' \u00b7 2.4 GHz';
    if (CH40.indexOf(ch) >= 0) return ch + ' \u00b7 5 GHz \u00b7 40 MHz \u00b7 ' + t('wifi.rec');
    return ch + ' \u00b7 5 GHz \u00b7 20 MHz';
  }
  function addChannel(ch) { var o = document.createElement('option'); o.value = ch; o.textContent = channelText(ch); $('sel-ch').appendChild(o); }
  function relabelChannels() { Array.prototype.forEach.call($('sel-ch').options, function (o) { o.textContent = channelText(+o.value); }); }

  /* ------------------------------------------------------------ reboot watch */
  function waitForReboot(msgWhileDown, onBack) {
    var seenDown = false, t0 = Date.now();
    banner(msgWhileDown);
    (function poll() {
      fetch('/cgi-bin/index.cgi?id=host', { cache: 'no-store' }).then(function (r) { return r.ok; }).catch(function () { return false; }).then(function (ok) {
        if (ok && seenDown) { banner(t('msg.back')); toast(t('msg.back')); if (onBack) onBack(); else setTimeout(function () { location.reload(); }, 1500); return; }
        if (!ok) seenDown = true;
        if (Date.now() - t0 > 10 * 60000) { banner(t('msg.offline')); return; }
        setTimeout(poll, 3000);
      });
    })();
  }

  /* ------------------------------------------------------------ software */
  function updateBase() { return CONFIG.UPDATE_BASE_URL; }
  var candidate = null;
  function pickVersion(j) {
    var mine = (sn + uuid).toLowerCase();
    if (j.test && mine) {
      for (var i = 0; i < j.test.length; i++) {
        var tst = j.test[i]; if (!tst.sn) continue;
        var parts = tst.sn.split(',');
        for (var k = 0; k < parts.length; k++) {
          var s = parts[k].toLowerCase();
          if (s && mine.slice(-s.length) === s) return tst.appver > appver ? tst : null;
        }
      }
    }
    return j.appver > appver ? j : null;
  }
  function checkUpdate() {
    $('sw-result').classList.add('hidden'); $('btn-check').disabled = true; toast(t('sw.checking'), 8000);
    fetch(updateBase() + '/' + branch + '/version.json?rand=' + Math.random(), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(function (j) {
        candidate = pickVersion(j);
        $('btn-check').disabled = false;
        if (!candidate) { toast(t('sw.latest')); return; }
        $('sw-new').textContent = t('sw.new') + ': ' + candidate.appver;
        $('sw-note').textContent = candidate.msg || '';
        $('sw-result').classList.remove('hidden'); toast(t('sw.new'));
      })
      .catch(function () { $('btn-check').disabled = false; toast(t('sw.check_fail'), 4000); });
  }

  /* Install progress. Download and upload are measured; what the adapter does afterwards is
   * known only coarsely: index.cgi?id=host reports update 1-2 while it checks and prepares
   * the image (about 4.5 minutes on the bench), then it reboots into recovery to write the
   * flash (no answer for ~30-60 s) and comes back with the new version (update 3 = done,
   * above 3 = failure code, as the stock page reads it). */
  var STAGES = ['download', 'upload', 'verify', 'write', 'done'];
  var SPAN = { download: [0, 40], upload: [40, 55], verify: [55, 88], write: [88, 99], done: [100, 100] };
  var EXPECT = { verify: 270, write: 45 };   // seconds
  var job = null;
  function fmtTime(sec) { sec = Math.max(0, Math.round(sec)); return Math.floor(sec / 60) + ':' + ('0' + sec % 60).slice(-2); }
  function stageElapsed() { return (Date.now() - job.tStage) / 1000; }
  function setStage(name, frac, msg) {
    if (!job) return;
    if (job.stage !== name) { job.stage = name; job.tStage = Date.now(); }
    var idx = STAGES.indexOf(name), lis = $('sw-stages').querySelectorAll('li');
    for (var i = 0; i < lis.length; i++) {
      var st = lis[i].getAttribute('data-s'), k = STAGES.indexOf(st);
      lis[i].className = job.skip[st] ? 'skip' : (k < idx || name === 'done') ? 'done' : k === idx ? 'now' : '';
    }
    var r = SPAN[name], pct = r[0] + (r[1] - r[0]) * Math.max(0, Math.min(1, frac || 0));
    $('sw-prog').classList.remove('hidden');
    $('sw-bar').style.width = pct + '%';
    $('sw-pct').textContent = Math.floor(pct) + '%';
    if (msg != null) $('sw-msg').textContent = msg;
    showEta();
  }
  function showEta() {
    if (!job) return;
    var txt = t('sw.elapsed', { t: fmtTime((Date.now() - job.t0) / 1000) });
    if (!job.end && (job.stage === 'verify' || job.stage === 'write')) {
      var left = job.stage === 'verify' ? Math.max(30, EXPECT.verify - stageElapsed()) + EXPECT.write : Math.max(10, EXPECT.write - stageElapsed());
      txt += ' · ' + t('sw.left', { t: fmtTime(left) });
    }
    $('sw-eta').textContent = txt;
  }
  function endJob(ok, msg) {
    job.end = true; clearInterval(job.timer);
    if (!ok) {
      var cur = $('sw-stages').querySelector('li.now'); if (cur) cur.className = 'fail';
      $('sw-msg').textContent = msg; $('btn-install').disabled = false; $('btn-check').disabled = false;
    }
    showEta();
  }
  function download(url) {
    setStage('download', 0, t('sw.downloading'));
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      var total = +r.headers.get('Content-Length') || 0, got = 0, chunks = [], reader = r.body.getReader();
      return (function read() {
        return reader.read().then(function (res) {
          if (res.done) { var out = new Uint8Array(got), p = 0; chunks.forEach(function (c) { out.set(c, p); p += c.length; }); return out; }
          chunks.push(res.value); got += res.value.length;
          if (total) setStage('download', got / total);
          return read();
        });
      })();
    });
  }
  function upload(bytes) {
    return new Promise(function (resolve, reject) {
      setStage('upload', 0, t('sw.uploading'));
      var xhr = new XMLHttpRequest(), fd = new FormData();
      fd.append('file', new Blob([bytes]), 'update.img');
      xhr.upload.onprogress = function (e) { if (e.lengthComputable) setStage('upload', e.loaded / e.total); };
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        var j = null; try { j = JSON.parse(xhr.responseText); } catch (e) { /* ignore */ }
        if (xhr.status === 200 && j && j.code === 0) resolve(); else reject(new Error(t('sw.rejected') + (j ? ' (' + j.code + ')' : ' ' + xhr.status)));
      };
      xhr.open('POST', '/cgi-bin/index.cgi?id=upload'); xhr.send(fd);
    });
  }
  function monitorInstall() {
    var before = appver, down = false;
    setStage('verify', 0, t('sw.verifying'));
    (function poll() {
      fetch('/cgi-bin/index.cgi?id=host', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
        var v = (j.sys && j.sys.appver) || '';
        if (j.update > 3) { endJob(false, t('sw.fail') + ' (' + j.update + ')'); return; }
        if (v && v !== before && (down || j.update === 3)) {
          setStage('done', 1, t('sw.done') + ' · ' + v); endJob(true);
          setTimeout(function () { location.reload(); }, 4000); return;
        }
        if (down && v === before && stageElapsed() > 90) { endJob(false, t('sw.same')); return; }
        if (!down) setStage('verify', Math.min(0.95, stageElapsed() / EXPECT.verify), t('sw.verifying'));
        setTimeout(poll, 3000);
      }).catch(function () {
        if (!down) { down = true; setStage('write', 0, t('sw.writing')); }
        else setStage('write', Math.min(0.95, stageElapsed() / EXPECT.write));
        if (Date.now() - job.t0 > 15 * 60000) { endJob(false, t('msg.offline')); return; }
        setTimeout(poll, 3000);
      });
    })();
  }
  function install(getBytes, fromFile) {
    $('btn-install').disabled = true; $('btn-check').disabled = true; $('sw-result').classList.add('hidden');
    job = { t0: Date.now(), tStage: Date.now(), stage: '', skip: { download: !!fromFile }, end: false };
    job.timer = setInterval(showEta, 1000);
    getBytes().then(upload).then(monitorInstall).catch(function (e) { endJob(false, t('sw.fail') + ': ' + e.message); });
  }

  /* ------------------------------------------------------------ wiring */
  function init() {
    lang = pickLang(localStorage.getItem('t2c.lang'));
    $('lang').value = localStorage.getItem('t2c.lang') || 'auto';
    $('lang').onchange = function () { localStorage.setItem('t2c.lang', this.value); lang = pickLang(this.value); applyLang(); relabelChannels(); };
    applyLang();
    CHANNELS.forEach(addChannel);
    try { localStorage.removeItem('t2c.updateUrl'); } catch (e) { /* older builds let users override the server */ }
    DIAG.forEach(function (name) {
      var b = document.createElement('button'); b.textContent = name;
      b.onclick = function () {
        $('diag-out').textContent = '…';
        fetch(name === 'top' ? '/cgi-bin/t2c.cgi?a=top&v=3' : '/cgi-bin/t2c.cgi?a=cat&f=' + name, { cache: 'no-store' }).then(function (r) { return r.text(); })
          .then(function (s) { $('diag-out').textContent = '# ' + name + '\n' + s; }).catch(function (e) { $('diag-out').textContent = e.message; });
      };
      $('diag-btns').appendChild(b);
    });

    segBind('seg-pix', function (v) { return setCgi('pix=' + v); });
    segBind('seg-icon', function (v) { return setCgi('icon=' + v); });
    segBind('seg-btnet', function (v) { return setCgi('btnet=' + v); });
    $('sel-ch').onchange = function () {
      var ch = this.value, prev = $('st-ch').textContent, sel = this;
      confirmBox(t('q.channel', { ch: ch })).then(function (ok) {
        if (!ok) { sel.value = prev; return; }
        if (info && info.wifi_edit) {
          // Same field the Tesla page writes (byte 5 of the settings file); the adapter reboots.
          fetch('/cgi-bin/t2c.cgi?a=channel', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'ch=' + ch })
            .then(function (r) { return r.json(); })
            .then(function (j) { if (j.code !== 0) throw new Error(j.msg || ('code ' + j.code)); waitForReboot(t('msg.rebooting')); })
            .catch(function (e) { toast(t('msg.fail') + ' (' + e.message + ')', 4000); sel.value = prev; });
        } else {
          setCgi('wifi=' + ch).then(function (done) { if (done) $('st-ch').textContent = ch; else sel.value = prev; });
        }
      });
    };
    $('btn-reboot').onclick = function () {
      confirmBox(t('q.reboot')).then(function (ok) {
        if (!ok) return;
        get('/cgi-bin/t2c.cgi?a=reboot').then(function () { waitForReboot(t('msg.rebooting')); })
          .catch(function (e) { toast(t('msg.fail') + ' (' + e.message + ')'); });
      });
    };
    $('btn-reset').onclick = function () {
      confirmBox(t('q.reset')).then(function (ok) {
        if (!ok) return;
        // the device name lives outside the stock settings; forget it first (older CGI: ignored)
        fetch('/cgi-bin/t2c.cgi?a=unname', { cache: 'no-store' }).catch(function () {}).then(function () {
          return get('/cgi-bin/index.cgi?id=set&rst=1');
        }).then(function (j) {
          if (j.code !== 0) throw new Error('code ' + j.code);
          waitForReboot(t('msg.reset'));
        }).catch(function (e) { toast(t('msg.fail') + ' (' + e.message + ')'); });
      });
    };
    function toggle(input, btn) { var show = input.type === 'password'; input.type = show ? 'text' : 'password'; btn.textContent = t(show ? 'hide' : 'show'); }
    $('btn-show').onclick = function () { toggle($('in-psk'), this); };
    $('btn-show-view').onclick = function () {
      var el = $('wifi-psk-text'), shown = el.textContent !== '••••••••';
      el.textContent = shown ? '••••••••' : ((info && info.psk) || '—'); this.textContent = t(shown ? 'show' : 'hide');
    };
    $('btn-wifi-save').onclick = function () {
      var psk = $('in-psk').value;
      // The adapter stores the password in a 12-byte field (11 characters max); the body is
      // sent verbatim, so the character set excludes anything that would need escaping.
      if (psk.length < 8 || psk.length > 11) { toast(t('msg.psk_short')); return; }
      if (!/^[A-Za-z0-9!@#$^*()_.,:;?~-]+$/.test(psk)) { toast(t('msg.psk_chars'), 4000); return; }
      confirmBox(t('q.wifi', { psk: psk })).then(function (ok) {
        if (!ok) return;
        fetch('/cgi-bin/t2c.cgi?a=wifi', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'psk=' + psk })
          .then(function (r) { return r.json(); })
          .then(function (j) { if (j.code !== 0) throw new Error(j.msg || ('code ' + j.code)); waitForReboot(t('msg.rebooting')); })
          .catch(function (e) { toast(t('msg.fail') + ' (' + e.message + ')', 4000); });
      });
    };
    $('btn-name-save').onclick = function () {
      var name = $('in-name').value;
      if (!/^[A-Za-z0-9_.-]([A-Za-z0-9 _.-]{0,10}[A-Za-z0-9_.-])?$/.test(name)) { toast(t('msg.name_chars'), 4000); return; }
      confirmBox(t('q.name', { name: name })).then(function (ok) {
        if (!ok) return;
        fetch('/cgi-bin/t2c.cgi?a=name', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'name=' + name })
          .then(function (r) { return r.json(); })
          .then(function (j) { if (j.code !== 0) throw new Error(j.msg || ('code ' + j.code)); waitForReboot(t('msg.rebooting')); })
          .catch(function (e) { toast(t('msg.fail') + ' (' + e.message + ')', 4000); });
      });
    };
    $('btn-check').onclick = checkUpdate;
    $('btn-install').onclick = function () {
      if (!candidate) return;
      var url = candidate.url + '?t=' + Math.random();
      confirmBox(t('q.install', { v: candidate.appver })).then(function (ok) { if (ok) install(function () { return download(url); }, false); });
    };
    $('in-file').onchange = function () {
      var f = this.files && this.files[0]; this.value = ''; if (!f) return;
      confirmBox(t('q.install', { v: f.name })).then(function (ok) {
        if (!ok) return;
        install(function () { return f.arrayBuffer().then(function (b) { return new Uint8Array(b); }); }, true);
      });
    };

    function refresh() {
      loadHost().then(loadHw).then(loadInfo).catch(function () { banner(t('msg.offline')); });
    }
    refresh();
    setInterval(function () { if (!$('sw-prog').classList.contains('hidden')) return; loadInfo().catch(function () {}); }, 15000);
  }
  document.addEventListener('DOMContentLoaded', init);
})();
