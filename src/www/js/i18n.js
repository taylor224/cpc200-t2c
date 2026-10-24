/* Client-side i18n for the T2C Tesla web UI.
 * Languages: en, zh-CN, zh-TW, ko, ja.
 * The device firmware can only persist zh-CN / zh-TW / en / auto, so the
 * chosen language is stored in localStorage and the server index is used only
 * as a hint when nothing is stored.
 */
(function (global) {
  'use strict';

  var LANGS = ['en', 'zh-CN', 'zh-TW', 'ko', 'ja'];
  var NAMES = { en: 'English', 'zh-CN': '简体中文', 'zh-TW': '繁體中文', ko: '한국어', ja: '日本語' };

  var T = {};

  T.en = {
    'nav.home': 'Home', 'nav.devices': 'Devices', 'nav.cellular': 'Cellular', 'nav.wifi': 'Wi‑Fi',
    'nav.bluetooth': 'Bluetooth', 'nav.display': 'Display', 'nav.language': 'Language',
    'nav.system': 'System', 'nav.about': 'About', 'nav.reload': 'Reload page',

    'home.title': 'CarPlay', 'home.subtitle': 'Wireless CarPlay for Tesla',
    'home.pair_title': 'Pair your iPhone',
    'home.step1': 'Turn on Bluetooth and Wi‑Fi on the iPhone.',
    'home.step2': 'In Settings › Bluetooth, choose',
    'home.step3': 'Accept the pairing request. CarPlay starts automatically.',
    'home.bt_name': 'Bluetooth name', 'home.show_qr': 'Show QR code', 'home.hide_qr': 'Hide QR code', 'home.reboot': 'Restart adapter', 'home.reboot_hint': 'Power-cycles the adapter; CarPlay reconnects in about a minute.', 'home.reboot_btn': 'Restart', 'home.reboot_confirm': 'Restart the adapter? CarPlay reconnects in about a minute.', 'home.usb': 'USB console', 'home.usb_hint': 'Root shell on the USB-C port for a laptop. Keep it off in the car.',
    'home.qr_hint': 'Scan with the iPhone camera', 'home.connecting': 'Connecting…',
    'home.waiting': 'Waiting for iPhone', 'home.connected': 'iPhone connected',
    'home.starting': 'Starting CarPlay…', 'home.open_carplay': 'Open CarPlay', 'home.car_ui': 'iPhone connected · settings',
    'home.elsewhere': 'CarPlay is open on another screen', 'home.use_here': 'Use this screen',
    'home.reload_loop': 'The page kept reloading without effect and stopped. Check the adapter, then reload by hand.',
    'home.elsewhere_hint': 'The adapter works with one screen at a time and another browser has just connected. Switch CarPlay back to this screen?',
    'home.open_settings': 'Settings', 'home.last_device': 'Last connected',

    'dev.auto': 'Auto connect', 'dev.auto_hint': 'Reconnect to the last iPhone automatically',
    'dev.paired': 'Paired iPhones', 'dev.none': 'No paired iPhones yet',
    'dev.or_pair': 'Or pair a new iPhone over Bluetooth:',
    'dev.connect': 'Connect', 'dev.disconnect': 'Disconnect', 'dev.forget': 'Forget',
    'dev.connected': 'Connected',

    'cell.dial': 'Data connection', 'cell.connected': 'Connected', 'cell.not_connected': 'Not connected',
    'cell.signal': 'Signal', 'cell.carrier': 'Carrier', 'cell.refresh': 'Refresh',
    'cell.none': 'No cellular module', 'cell.na': 'N/A',

    'wifi.ssid': 'Network name', 'wifi.password': 'Password', 'wifi.show': 'Show', 'wifi.hide': 'Hide',
    'wifi.change_pw': 'Change password', 'wifi.channel': 'Channel', 'wifi.band24': '2.4 GHz', 'wifi.band5': '5 GHz',
    'wifi.auto': 'Auto', 'wifi.rec40': '40 MHz channels, recommended', 'wifi.pw_title': 'Set network password', 'wifi.pw_new': 'New password',
    'wifi.pw_rule': 'Use 8 to 11 letters or digits. Special characters are not supported.',
    'wifi.pw_changed': 'Password changed. Reconnect with the new password:',
    'wifi.pw_warn': 'Changing the password disconnects everyone currently connected.',
    'wifi.channel_hint': 'Changing the channel restarts the hotspot briefly.',

    'bt.name': 'Bluetooth name', 'bt.modem': 'Bluetooth modem',
    'bt.modem_hint': 'Use the phone\'s cellular data over Bluetooth instead of the built‑in 4G. On the phone, turn on Personal Hotspot and allow sharing over Bluetooth first. The phone must stay online.',

    'disp.theme': 'Appearance', 'disp.theme_light': 'Light', 'disp.theme_dark': 'Dark', 'disp.theme_auto': 'Follow night mode',
    'disp.night': 'Night mode', 'disp.night_hint': 'Asks the iPhone to draw CarPlay in dark appearance',
    'disp.night_sched': 'Automatic night mode', 'disp.night_off': 'Off', 'disp.night_18': '18:00 – 06:00', 'disp.night_19': '19:00 – 07:00',
    'disp.res': 'Picture quality', 'disp.q_ultra': 'Ultra', 'disp.q_high': 'High', 'disp.q_balanced': 'Balanced', 'disp.q_low': 'Low', 'disp.q_ultralow': 'Ultra low',
    'disp.res_hint': 'Higher: sharper, smaller CarPlay icons, more Wi‑Fi and decoding work. Lower: bigger icons, lighter on the browser. A change restarts CarPlay for a moment; it never changes by itself.',
    'disp.fps': 'Frame rate', 'disp.fps_standard': 'Standard', 'disp.fps_smooth': 'Smooth',
    'disp.mode': 'Video transport', 'disp.mode_auto': 'Automatic', 'disp.mode_picture': 'Picture', 'disp.mode_video': 'Video',
    'disp.mode_hint': 'Video streams the iPhone\'s H.264 directly and decodes it in the browser: 3–5× less Wi‑Fi bandwidth and no transcoding in the adapter. Automatic uses Picture only if this browser cannot decode video.',
    'video.slow': 'The browser cannot keep up with the video at this quality. If the picture stutters, choose a lower quality or the Standard frame rate under Display.',
    'video.unsupported': 'Video is not supported in this browser. Using Picture.',
    'video.keyframe': 'Waiting for key frame…',
    'disp.fit': 'Picture fit', 'disp.fit_contain': 'Fit', 'disp.fit_cover': 'Fill', 'disp.fit_stretch': 'Stretch',
    'disp.stats': 'Performance overlay', 'disp.stats_hint': 'Shows frame rate, bandwidth and decode time over the picture',
    'disp.session': 'Current CarPlay size',

    'lang.title': 'Language', 'lang.auto': 'Automatic', 'lang.hint': 'Automatic follows the Tesla browser language.',

    'sys.online': 'Online check', 'sys.online_hint': 'Periodically verify Internet reachability through the adapter',
    'sys.driver': 'Driving position', 'sys.lhd': 'Left‑hand drive', 'sys.rhd': 'Right‑hand drive',
    'sys.car_name': 'Car name on iPhone', 'sys.car_name_hint': 'Shown on the iPhone as the connected car (iOS only)',
    'sys.icon': 'Car icon on iPhone', 'sys.icon_default': 'Default', 'sys.icon_custom': 'Custom',
    'sys.tesla_tm': 'Tesla and the Tesla logo are trademarks of Tesla, Inc., registered in the U.S. and other countries.',
    'sys.mic_test': 'Microphone test', 'sys.open_mic_test': 'Open test page',

    'about.update': 'Software update', 'about.check': 'Check for updates', 'about.model': 'Model',
    'about.fw': 'Firmware', 'about.hw': 'Hardware', 'about.uuid': 'UUID', 'about.reset': 'Factory reset',
    'about.reset_btn': 'Reset', 'about.reset_confirm': 'Restore factory settings? All pairings and settings will be erased.',
    'about.latest': 'You are up to date.', 'about.new_version': 'A new version is available. Update now?',
    'about.update_ok': 'Update succeeded. The adapter is restarting.',
    'about.update_fail': 'Update failed. Check the Internet connection and try again.',
    'about.downloading': 'Downloading', 'about.installing': 'Installing', 'about.keep_power': 'Keep the adapter powered until it restarts.',
    'about.net_error': 'Network problem. Check the connection and reload?',
    'about.ws_lost': 'Not connected to the adapter. Reload the page?',
    'home.update_avail': 'New update available ({v})', 'home.update_view': 'View',
    'about.new_version_v': 'Version {v} is available (installed: {cur}).', 'about.notes_none': 'No release notes.',
    'about.update_hint': 'The update is downloaded and installed on the adapter, which then restarts (about 5–6 minutes). Keep the adapter powered until then.',
    'about.later': 'Later', 'about.update_now': 'Update', 'about.new_short': 'update {v} available',
    'about.check_fail': 'Could not get the update information. Check the internet connection.',

    'dlg.ok': 'OK', 'dlg.cancel': 'Cancel', 'dlg.save': 'Save', 'dlg.reload': 'Reload', 'dlg.close': 'Close',
    'dlg.yes': 'Yes', 'video.nosignal': 'No picture from iPhone',
    'video.backlist': 'Unauthorized device', 'video.touch_hint': 'Tap to interact',

    'stat.fps': 'fps', 'stat.kbps': 'kbit/s', 'stat.decode': 'decode', 'stat.dropped': 'dropped', 'stat.mode': 'mode',
    // 26101701: takeover retry, decoder step-down, event log
    'home.retry_in': 'reconnecting in {s} s', 'about.events': 'Recent events', 'about.events_hint': 'Connections, takeovers, session restarts, decoder warnings', 'about.events_show': 'Show', 'about.events_none': 'No events recorded yet.', 'about.events_clear': 'Clear',
    'video.loading': 'Loading the video decoder… (waiting for the connection)', 'video.transient': 'The video decoder could not be set up (connection or GPU). Using Picture for now; Video is tried again in 10 minutes.'
  };

  T.ko = {
    'nav.home': '홈', 'nav.devices': '기기', 'nav.cellular': '셀룰러', 'nav.wifi': 'Wi‑Fi',
    'nav.bluetooth': '블루투스', 'nav.display': '화면', 'nav.language': '언어',
    'nav.system': '시스템', 'nav.about': '정보', 'nav.reload': '페이지 새로고침',

    'home.title': 'CarPlay', 'home.subtitle': '테슬라를 위한 무선 CarPlay',
    'home.pair_title': 'iPhone 연결하기',
    'home.step1': 'iPhone에서 Bluetooth와 Wi‑Fi를 켭니다.',
    'home.step2': '설정 › Bluetooth에서 다음 기기를 선택합니다:',
    'home.step3': '페어링 요청을 수락하면 CarPlay가 자동으로 시작됩니다.',
    'home.bt_name': '블루투스 이름', 'home.show_qr': 'QR 코드 보기', 'home.hide_qr': 'QR 코드 숨기기', 'home.reboot': '어댑터 재부팅', 'home.reboot_hint': '어댑터를 껐다 켭니다. CarPlay는 1분쯤 뒤에 다시 연결됩니다.', 'home.reboot_btn': '재부팅', 'home.reboot_confirm': '어댑터를 재부팅할까요? CarPlay는 1분쯤 뒤에 다시 연결됩니다.', 'home.usb': 'USB 콘솔', 'home.usb_hint': 'USB-C 포트로 노트북에 루트 셸을 제공합니다. 차에서는 꺼두세요.',
    'home.qr_hint': 'iPhone 카메라로 스캔하세요', 'home.connecting': '연결 중…',
    'home.waiting': 'iPhone을 기다리는 중', 'home.connected': 'iPhone 연결됨',
    'home.starting': 'CarPlay 시작 중…', 'home.open_carplay': 'CarPlay 열기', 'home.car_ui': 'iPhone 연결됨 · 설정',
    'home.elsewhere': '다른 화면에서 CarPlay 사용 중', 'home.use_here': '이 화면에서 사용',
    'home.reload_loop': '페이지를 반복해서 새로 고쳐도 적용되지 않아 중단했습니다. 어댑터를 확인한 뒤 직접 새로 고침하세요.',
    'home.elsewhere_hint': '어댑터는 한 번에 한 화면만 연결할 수 있는데, 다른 브라우저가 방금 연결했습니다. 이 화면으로 다시 가져올까요?',
    'home.open_settings': '설정', 'home.last_device': '최근 연결',

    'dev.auto': '자동 연결', 'dev.auto_hint': '마지막으로 연결한 iPhone에 자동으로 다시 연결합니다',
    'dev.paired': '페어링된 iPhone', 'dev.none': '페어링된 iPhone이 없습니다',
    'dev.or_pair': '또는 Bluetooth로 새 iPhone을 페어링하세요:',
    'dev.connect': '연결', 'dev.disconnect': '연결 해제', 'dev.forget': '삭제',
    'dev.connected': '연결됨',

    'cell.dial': '데이터 연결', 'cell.connected': '연결됨', 'cell.not_connected': '연결 안 됨',
    'cell.signal': '신호 세기', 'cell.carrier': '통신사', 'cell.refresh': '새로고침',
    'cell.none': '셀룰러 모듈 없음', 'cell.na': '없음',

    'wifi.ssid': '네트워크 이름', 'wifi.password': '비밀번호', 'wifi.show': '표시', 'wifi.hide': '숨기기',
    'wifi.change_pw': '비밀번호 변경', 'wifi.channel': '채널', 'wifi.band24': '2.4 GHz', 'wifi.band5': '5 GHz',
    'wifi.auto': '자동', 'wifi.rec40': '40 MHz 채널, 권장', 'wifi.pw_title': '네트워크 비밀번호 설정', 'wifi.pw_new': '새 비밀번호',
    'wifi.pw_rule': '영문 또는 숫자 8~11자. 특수문자는 사용할 수 없습니다.',
    'wifi.pw_changed': '비밀번호가 변경되었습니다. 새 비밀번호로 다시 연결하세요:',
    'wifi.pw_warn': '비밀번호를 변경하면 현재 연결된 모든 기기의 연결이 끊어집니다.',
    'wifi.channel_hint': '채널을 변경하면 핫스팟이 잠시 재시작됩니다.',

    'bt.name': '블루투스 이름', 'bt.modem': '블루투스 모뎀',
    'bt.modem_hint': '내장 4G 대신 휴대폰의 셀룰러 데이터를 Bluetooth로 사용합니다. 먼저 휴대폰에서 개인용 핫스팟과 Bluetooth 공유를 켜세요. 휴대폰은 계속 온라인 상태여야 합니다.',

    'disp.theme': '테마', 'disp.theme_light': '라이트', 'disp.theme_dark': '다크', 'disp.theme_auto': '야간 모드 따라가기',
    'disp.night': '야간 모드', 'disp.night_hint': 'iPhone이 CarPlay를 어두운 모양으로 그리도록 요청합니다',
    'disp.night_sched': '자동 야간 모드', 'disp.night_off': '끔', 'disp.night_18': '18:00 – 06:00', 'disp.night_19': '19:00 – 07:00',
    'disp.res': '화질', 'disp.q_ultra': '초고해상도', 'disp.q_high': '고해상도', 'disp.q_balanced': '균형', 'disp.q_low': '저해상도', 'disp.q_ultralow': '초저해상도',
    'disp.res_hint': '높을수록 선명하고 아이콘이 작아지며 Wi‑Fi·디코딩 부담이 커집니다. 낮을수록 아이콘이 커지고 가벼워집니다. 바꾸면 CarPlay가 잠시 다시 연결되며, 자동으로 바뀌지 않습니다.',
    'disp.fps': '프레임 속도', 'disp.fps_standard': '표준', 'disp.fps_smooth': '부드럽게',
    'disp.mode': '영상 전송 방식', 'disp.mode_auto': '자동', 'disp.mode_picture': '이미지', 'disp.mode_video': '비디오',
    'disp.mode_hint': '비디오는 iPhone의 H.264를 그대로 전송해 브라우저에서 디코딩합니다. Wi‑Fi 대역폭 3~5배 절감, 어댑터 재인코딩 없음. 자동은 브라우저가 비디오를 디코딩하지 못할 때만 이미지(MJPEG)를 씁니다.',
    'video.slow': '이 화질에서는 브라우저가 영상을 따라가지 못하고 있습니다. 화면이 끊기면 화면 메뉴에서 화질을 낮추거나 프레임 속도를 표준으로 바꿔 보세요.',
    'video.unsupported': '이 브라우저는 비디오를 지원하지 않습니다. 이미지 방식을 사용합니다.',
    'video.keyframe': '키 프레임을 기다리는 중…',
    'disp.fit': '화면 맞춤', 'disp.fit_contain': '맞춤', 'disp.fit_cover': '채우기', 'disp.fit_stretch': '늘이기',
    'disp.stats': '성능 오버레이', 'disp.stats_hint': '화면 위에 프레임 속도, 대역폭, 디코딩 시간을 표시합니다',
    'disp.session': '현재 CarPlay 해상도',

    'lang.title': '언어', 'lang.auto': '자동', 'lang.hint': '자동은 테슬라 브라우저 언어를 따릅니다.',

    'sys.online': '온라인 확인', 'sys.online_hint': '어댑터를 통한 인터넷 연결을 주기적으로 확인합니다',
    'sys.driver': '운전석 위치', 'sys.lhd': '왼쪽 운전석', 'sys.rhd': '오른쪽 운전석',
    'sys.car_name': 'iPhone에 표시될 차량 이름', 'sys.car_name_hint': 'iPhone에서 연결된 차량 이름으로 표시됩니다 (iOS 전용)',
    'sys.icon': 'iPhone에 표시될 차량 아이콘', 'sys.icon_default': '기본', 'sys.icon_custom': '사용자 지정',
    'sys.tesla_tm': 'Tesla 및 Tesla 로고는 미국 및 기타 국가에 등록된 Tesla, Inc.의 상표입니다.',
    'sys.mic_test': '마이크 테스트', 'sys.open_mic_test': '테스트 페이지 열기',

    'about.update': '소프트웨어 업데이트', 'about.check': '업데이트 확인', 'about.model': '모델',
    'about.fw': '펌웨어', 'about.hw': '하드웨어', 'about.uuid': 'UUID', 'about.reset': '공장 초기화',
    'about.reset_btn': '초기화', 'about.reset_confirm': '공장 설정으로 복원할까요? 모든 페어링과 설정이 삭제됩니다.',
    'about.latest': '최신 버전입니다.', 'about.new_version': '새 버전이 있습니다. 지금 업데이트할까요?',
    'about.update_ok': '업데이트가 완료되었습니다. 어댑터가 다시 시작됩니다.',
    'about.update_fail': '업데이트에 실패했습니다. 인터넷 연결을 확인한 후 다시 시도하세요.',
    'about.downloading': '다운로드 중', 'about.installing': '설치 중', 'about.keep_power': '재시작될 때까지 어댑터 전원을 유지하세요.',
    'about.net_error': '네트워크 문제가 발생했습니다. 연결을 확인한 후 새로고침할까요?',
    'about.ws_lost': '어댑터와 연결되어 있지 않습니다. 페이지를 새로고침할까요?',
    'home.update_avail': '새 업데이트가 있습니다 ({v})', 'home.update_view': '보기',
    'about.new_version_v': '새 버전 {v}을 설치할 수 있습니다. 현재 버전은 {cur}입니다.', 'about.notes_none': '변경 내용 정보가 없습니다.',
    'about.update_hint': '업데이트를 내려받아 어댑터에 설치한 뒤 어댑터가 다시 시작됩니다(약 5~6분). 끝날 때까지 어댑터 전원을 유지하세요.',
    'about.later': '나중에', 'about.update_now': '업데이트', 'about.new_short': '새 버전 {v}',
    'about.check_fail': '업데이트 정보를 가져오지 못했습니다. 인터넷 연결을 확인하세요.',

    'dlg.ok': '확인', 'dlg.cancel': '취소', 'dlg.save': '저장', 'dlg.reload': '새로고침', 'dlg.close': '닫기',
    'dlg.yes': '예', 'video.nosignal': 'iPhone에서 화면이 오지 않습니다',
    'video.backlist': '인증되지 않은 기기', 'video.touch_hint': '탭하여 조작',

    'stat.fps': 'fps', 'stat.kbps': 'kbit/s', 'stat.decode': '디코딩', 'stat.dropped': '드롭', 'stat.mode': '모드',
    // 26101701: takeover retry, decoder step-down, event log
    'home.retry_in': '{s}초 후 다시 연결', 'about.events': '최근 이벤트', 'about.events_hint': '연결, 화면 전환, 세션 재시작, 디코딩 경고 기록', 'about.events_show': '보기', 'about.events_none': '기록된 이벤트가 없습니다.', 'about.events_clear': '지우기',
    'video.loading': '영상 디코더 불러오는 중… (연결 대기)', 'video.transient': '영상 디코더를 준비하지 못했습니다(연결 또는 GPU 문제). 당분간 이미지 방식을 사용하고 10분 후 비디오를 다시 시도합니다.'
  };

  T.ja = {
    'nav.home': 'ホーム', 'nav.devices': 'デバイス', 'nav.cellular': 'モバイル通信', 'nav.wifi': 'Wi‑Fi',
    'nav.bluetooth': 'Bluetooth', 'nav.display': '画面', 'nav.language': '言語',
    'nav.system': 'システム', 'nav.about': '情報', 'nav.reload': 'ページを再読み込み',

    'home.title': 'CarPlay', 'home.subtitle': 'Tesla のためのワイヤレス CarPlay',
    'home.pair_title': 'iPhone をペアリング',
    'home.step1': 'iPhone の Bluetooth と Wi‑Fi をオンにします。',
    'home.step2': '設定 › Bluetooth で次のデバイスを選択します:',
    'home.step3': 'ペアリング要求を承認すると CarPlay が自動的に開始します。',
    'home.bt_name': 'Bluetooth 名', 'home.show_qr': 'QR コードを表示', 'home.hide_qr': 'QR コードを隠す', 'home.reboot': 'アダプターを再起動', 'home.reboot_hint': 'アダプターを再起動します。CarPlay は約 1 分後に再接続します。', 'home.reboot_btn': '再起動', 'home.reboot_confirm': 'アダプターを再起動しますか？CarPlay は約 1 分後に再接続します。', 'home.usb': 'USB コンソール', 'home.usb_hint': 'USB-C ポートでノート PC にルートシェルを提供します。車内ではオフに。',
    'home.qr_hint': 'iPhone のカメラでスキャン', 'home.connecting': '接続中…',
    'home.waiting': 'iPhone を待っています', 'home.connected': 'iPhone 接続済み',
    'home.starting': 'CarPlay を開始中…', 'home.open_carplay': 'CarPlay を開く', 'home.car_ui': 'iPhone 接続済み · 設定',
    'home.elsewhere': '別の画面で CarPlay を使用中', 'home.use_here': 'この画面で使う',
    'home.reload_loop': 'ページを再読み込みしても反映されないため停止しました。アダプターを確認してから手動で再読み込みしてください。',
    'home.elsewhere_hint': 'アダプターは同時に 1 つの画面にしか接続できず、別のブラウザーが接続しました。この画面に戻しますか？',
    'home.open_settings': '設定', 'home.last_device': '最後に接続',

    'dev.auto': '自動接続', 'dev.auto_hint': '最後に接続した iPhone に自動で再接続します',
    'dev.paired': 'ペアリング済みの iPhone', 'dev.none': 'ペアリング済みの iPhone はありません',
    'dev.or_pair': 'または Bluetooth で新しい iPhone をペアリング:',
    'dev.connect': '接続', 'dev.disconnect': '切断', 'dev.forget': '削除',
    'dev.connected': '接続済み',

    'cell.dial': 'データ接続', 'cell.connected': '接続済み', 'cell.not_connected': '未接続',
    'cell.signal': '電波強度', 'cell.carrier': '通信事業者', 'cell.refresh': '更新',
    'cell.none': 'モバイル通信モジュールなし', 'cell.na': 'なし',

    'wifi.ssid': 'ネットワーク名', 'wifi.password': 'パスワード', 'wifi.show': '表示', 'wifi.hide': '隠す',
    'wifi.change_pw': 'パスワードを変更', 'wifi.channel': 'チャンネル', 'wifi.band24': '2.4 GHz', 'wifi.band5': '5 GHz',
    'wifi.auto': '自動', 'wifi.rec40': '40 MHz チャンネル、推奨', 'wifi.pw_title': 'ネットワークパスワードの設定', 'wifi.pw_new': '新しいパスワード',
    'wifi.pw_rule': '英数字 8〜11 文字。記号は使用できません。',
    'wifi.pw_changed': 'パスワードを変更しました。新しいパスワードで再接続してください:',
    'wifi.pw_warn': 'パスワードを変更すると、現在接続中のすべての機器が切断されます。',
    'wifi.channel_hint': 'チャンネルを変更するとホットスポットが一時的に再起動します。',

    'bt.name': 'Bluetooth 名', 'bt.modem': 'Bluetooth モデム',
    'bt.modem_hint': '内蔵 4G の代わりに、スマートフォンのモバイルデータを Bluetooth 経由で使用します。先にスマートフォンでインターネット共有と Bluetooth 共有をオンにしてください。スマートフォンはオンラインのままにする必要があります。',

    'disp.theme': '外観', 'disp.theme_light': 'ライト', 'disp.theme_dark': 'ダーク', 'disp.theme_auto': 'ナイトモードに従う',
    'disp.night': 'ナイトモード', 'disp.night_hint': 'iPhone に CarPlay をダーク表示で描画するよう要求します',
    'disp.night_sched': '自動ナイトモード', 'disp.night_off': 'オフ', 'disp.night_18': '18:00 – 06:00', 'disp.night_19': '19:00 – 07:00',
    'disp.res': '画質', 'disp.q_ultra': '超高解像度', 'disp.q_high': '高解像度', 'disp.q_balanced': 'バランス', 'disp.q_low': '低解像度', 'disp.q_ultralow': '超低解像度',
    'disp.res_hint': '高いほど鮮明でアイコンが小さく、Wi‑Fi とデコードの負荷が増えます。低いほどアイコンが大きく軽くなります。変更すると CarPlay が一瞬再接続します。自動では変わりません。',
    'disp.fps': 'フレームレート', 'disp.fps_standard': '標準', 'disp.fps_smooth': 'スムーズ',
    'disp.mode': '映像の転送方式', 'disp.mode_auto': '自動', 'disp.mode_picture': '画像', 'disp.mode_video': 'ビデオ',
    'disp.mode_hint': 'ビデオは iPhone の H.264 をそのまま送り、ブラウザでデコードします。Wi‑Fi 帯域を 3〜5 倍節約し、アダプターでの再エンコードもありません。自動はブラウザがビデオをデコードできない場合だけ画像（MJPEG）を使います。',
    'video.slow': 'この画質ではブラウザが映像の処理に追いついていません。映像が途切れる場合は、画面メニューで画質を下げるか、フレームレートを標準にしてください。',
    'video.unsupported': 'このブラウザはビデオに対応していません。画像方式を使用します。',
    'video.keyframe': 'キーフレームを待っています…',
    'disp.fit': '画面の合わせ方', 'disp.fit_contain': 'フィット', 'disp.fit_cover': '全体に広げる', 'disp.fit_stretch': '引き伸ばす',
    'disp.stats': 'パフォーマンス表示', 'disp.stats_hint': '画面上にフレームレート・帯域・デコード時間を表示します',
    'disp.session': '現在の CarPlay 解像度',

    'lang.title': '言語', 'lang.auto': '自動', 'lang.hint': '自動は Tesla ブラウザの言語に従います。',

    'sys.online': 'オンライン確認', 'sys.online_hint': 'アダプター経由のインターネット接続を定期的に確認します',
    'sys.driver': '運転席の位置', 'sys.lhd': '左ハンドル', 'sys.rhd': '右ハンドル',
    'sys.car_name': 'iPhone に表示する車名', 'sys.car_name_hint': 'iPhone に接続中の車として表示されます（iOS のみ）',
    'sys.icon': 'iPhone に表示する車のアイコン', 'sys.icon_default': 'デフォルト', 'sys.icon_custom': 'カスタム',
    'sys.tesla_tm': 'Tesla および Tesla ロゴは、米国およびその他の国で登録された Tesla, Inc. の商標です。',
    'sys.mic_test': 'マイクテスト', 'sys.open_mic_test': 'テストページを開く',

    'about.update': 'ソフトウェアアップデート', 'about.check': 'アップデートを確認', 'about.model': 'モデル',
    'about.fw': 'ファームウェア', 'about.hw': 'ハードウェア', 'about.uuid': 'UUID', 'about.reset': '工場出荷時にリセット',
    'about.reset_btn': 'リセット', 'about.reset_confirm': '工場出荷時の設定に戻しますか？すべてのペアリングと設定が消去されます。',
    'about.latest': '最新の状態です。', 'about.new_version': '新しいバージョンがあります。今すぐ更新しますか？',
    'about.update_ok': '更新が完了しました。アダプターが再起動します。',
    'about.update_fail': '更新に失敗しました。インターネット接続を確認して再試行してください。',
    'about.downloading': 'ダウンロード中', 'about.installing': 'インストール中', 'about.keep_power': '再起動するまでアダプターの電源を切らないでください。',
    'about.net_error': 'ネットワークに問題があります。接続を確認して再読み込みしますか？',
    'about.ws_lost': 'アダプターに接続されていません。ページを再読み込みしますか？',
    'home.update_avail': '新しいアップデートがあります（{v}）', 'home.update_view': '表示',
    'about.new_version_v': '新しいバージョン {v} をインストールできます（現在 {cur}）。', 'about.notes_none': 'リリースノートはありません。',
    'about.update_hint': 'アップデートをダウンロードしてアダプターにインストールし、アダプターが再起動します（約 5〜6 分）。終わるまでアダプターの電源を切らないでください。',
    'about.later': '後で', 'about.update_now': 'アップデート', 'about.new_short': '新バージョン {v}',
    'about.check_fail': 'アップデート情報を取得できませんでした。インターネット接続を確認してください。',

    'dlg.ok': 'OK', 'dlg.cancel': 'キャンセル', 'dlg.save': '保存', 'dlg.reload': '再読み込み', 'dlg.close': '閉じる',
    'dlg.yes': 'はい', 'video.nosignal': 'iPhone から映像がありません',
    'video.backlist': '未承認のデバイス', 'video.touch_hint': 'タップして操作',

    'stat.fps': 'fps', 'stat.kbps': 'kbit/s', 'stat.decode': 'デコード', 'stat.dropped': 'ドロップ', 'stat.mode': 'モード',
    // 26101701: takeover retry, decoder step-down, event log
    'home.retry_in': '{s} 秒後に再接続', 'about.events': '最近のイベント', 'about.events_hint': '接続・画面の切り替え・セッション再開・デコード警告の記録', 'about.events_show': '表示', 'about.events_none': 'イベントはまだありません。', 'about.events_clear': '消去',
    'video.loading': '動画デコーダーを読み込み中…（接続待ち）', 'video.transient': '動画デコーダーを準備できませんでした（接続または GPU）。しばらく画像方式を使い、10 分後に動画を再試行します。'
  };

  T['zh-CN'] = {
    'nav.home': '首页', 'nav.devices': '设备', 'nav.cellular': '蜂窝网络', 'nav.wifi': 'Wi‑Fi',
    'nav.bluetooth': '蓝牙', 'nav.display': '显示', 'nav.language': '语言',
    'nav.system': '系统', 'nav.about': '关于', 'nav.reload': '刷新页面',

    'home.title': 'CarPlay', 'home.subtitle': '为 Tesla 打造的无线 CarPlay',
    'home.pair_title': '配对您的 iPhone',
    'home.step1': '在 iPhone 上打开蓝牙和 Wi‑Fi。',
    'home.step2': '在“设置 › 蓝牙”中选择：',
    'home.step3': '接受配对请求后，CarPlay 会自动启动。',
    'home.bt_name': '蓝牙名称', 'home.show_qr': '显示二维码', 'home.hide_qr': '隐藏二维码', 'home.reboot': '重启适配器', 'home.reboot_hint': '重启适配器，CarPlay 大约 1 分钟后重新连接。', 'home.reboot_btn': '重启', 'home.reboot_confirm': '要重启适配器吗？CarPlay 大约 1 分钟后重新连接。', 'home.usb': 'USB 控制台', 'home.usb_hint': '通过 USB-C 口向笔记本提供 root shell。车内请关闭。',
    'home.qr_hint': '用 iPhone 相机扫描', 'home.connecting': '连接中…',
    'home.waiting': '等待 iPhone', 'home.connected': 'iPhone 已连接',
    'home.starting': '正在启动 CarPlay…', 'home.open_carplay': '打开 CarPlay', 'home.car_ui': 'iPhone 已连接 · 设置',
    'home.elsewhere': 'CarPlay 正在其他屏幕上使用', 'home.use_here': '在此屏幕使用',
    'home.reload_loop': '页面反复重新加载仍未生效，已停止。请检查适配器后手动刷新。',
    'home.elsewhere_hint': '适配器一次只能连接一个屏幕，另一个浏览器刚刚已连接。要切换回此屏幕吗？',
    'home.open_settings': '设置', 'home.last_device': '上次连接',

    'dev.auto': '自动连接', 'dev.auto_hint': '自动重新连接上次使用的 iPhone',
    'dev.paired': '已配对的 iPhone', 'dev.none': '暂无已配对的 iPhone',
    'dev.or_pair': '或通过蓝牙配对新的 iPhone：',
    'dev.connect': '连接', 'dev.disconnect': '断开', 'dev.forget': '删除',
    'dev.connected': '已连接',

    'cell.dial': '数据连接', 'cell.connected': '已连接', 'cell.not_connected': '未连接',
    'cell.signal': '信号强度', 'cell.carrier': '运营商', 'cell.refresh': '刷新',
    'cell.none': '无蜂窝模块', 'cell.na': '无',

    'wifi.ssid': '网络名称', 'wifi.password': '密码', 'wifi.show': '显示', 'wifi.hide': '隐藏',
    'wifi.change_pw': '修改密码', 'wifi.channel': '信道', 'wifi.band24': '2.4 GHz', 'wifi.band5': '5 GHz',
    'wifi.auto': '自动', 'wifi.rec40': '40 MHz 信道，推荐', 'wifi.pw_title': '设置网络密码', 'wifi.pw_new': '新密码',
    'wifi.pw_rule': '请使用 8～11 位英文或数字，不支持特殊字符。',
    'wifi.pw_changed': '密码已修改，请使用新密码重新连接：',
    'wifi.pw_warn': '修改密码将断开当前已连接的所有设备。',
    'wifi.channel_hint': '更改信道会短暂重启热点。',

    'bt.name': '蓝牙名称', 'bt.modem': '蓝牙调制解调器',
    'bt.modem_hint': '通过蓝牙使用手机的蜂窝数据，替代内置 4G。请先在手机上打开个人热点并允许通过蓝牙共享网络。手机需保持联网。',

    'disp.theme': '外观', 'disp.theme_light': '浅色', 'disp.theme_dark': '深色', 'disp.theme_auto': '跟随夜间模式',
    'disp.night': '夜间模式', 'disp.night_hint': '请求 iPhone 以深色外观绘制 CarPlay',
    'disp.night_sched': '自动夜间模式', 'disp.night_off': '关闭', 'disp.night_18': '18:00 – 06:00', 'disp.night_19': '19:00 – 07:00',
    'disp.res': '画质', 'disp.q_ultra': '超高分辨率', 'disp.q_high': '高分辨率', 'disp.q_balanced': '均衡', 'disp.q_low': '低分辨率', 'disp.q_ultralow': '超低分辨率',
    'disp.res_hint': '画质越高越清晰、图标越小，Wi‑Fi 和解码负担越大；越低图标越大、越流畅。更改后 CarPlay 会短暂重连，不会自动更改。',
    'disp.fps': '帧率', 'disp.fps_standard': '标准', 'disp.fps_smooth': '流畅',
    'disp.mode': '视频传输方式', 'disp.mode_auto': '自动', 'disp.mode_picture': '图片', 'disp.mode_video': '视频',
    'disp.mode_hint': '“视频”直接传输 iPhone 的 H.264 并在浏览器中解码：Wi‑Fi 带宽减少 3～5 倍，适配器无需转码。“自动”仅在浏览器无法解码视频时使用“图片”(MJPEG)。',
    'video.slow': '当前画质下浏览器的视频解码跟不上。如画面卡顿，请在“显示”中降低画质或将帧率改为标准。',
    'video.unsupported': '此浏览器不支持视频方式，使用“图片”方式。',
    'video.keyframe': '等待关键帧…',
    'disp.fit': '画面适配', 'disp.fit_contain': '适应', 'disp.fit_cover': '填充', 'disp.fit_stretch': '拉伸',
    'disp.stats': '性能叠加层', 'disp.stats_hint': '在画面上显示帧率、带宽和解码耗时',
    'disp.session': '当前 CarPlay 分辨率',

    'lang.title': '语言', 'lang.auto': '自动', 'lang.hint': '“自动”跟随 Tesla 浏览器的语言。',

    'sys.online': '联网检测', 'sys.online_hint': '定期检测通过适配器的互联网连通性',
    'sys.driver': '驾驶位', 'sys.lhd': '左驾', 'sys.rhd': '右驾',
    'sys.car_name': 'iPhone 上显示的车辆名称', 'sys.car_name_hint': '在 iPhone 上显示为已连接的车辆（仅 iOS）',
    'sys.icon': 'iPhone 上显示的车辆图标', 'sys.icon_default': '默认', 'sys.icon_custom': '自定义',
    'sys.tesla_tm': 'Tesla 及 Tesla 标志是 Tesla, Inc. 在美国及其他国家/地区注册的商标。',
    'sys.mic_test': '麦克风测试', 'sys.open_mic_test': '打开测试页面',

    'about.update': '软件更新', 'about.check': '检查更新', 'about.model': '型号',
    'about.fw': '固件', 'about.hw': '硬件', 'about.uuid': 'UUID', 'about.reset': '恢复出厂设置',
    'about.reset_btn': '重置', 'about.reset_confirm': '确定恢复出厂设置？所有配对和设置都将被清除。',
    'about.latest': '已是最新版本。', 'about.new_version': '发现新版本，是否立即更新？',
    'about.update_ok': '更新成功，适配器正在重启。',
    'about.update_fail': '更新失败，请检查网络连接后重试。',
    'about.downloading': '正在下载', 'about.installing': '正在安装', 'about.keep_power': '请在重启完成前保持适配器供电。',
    'about.net_error': '网络异常，请确认网络连接。是否刷新？',
    'about.ws_lost': '未连接到适配器，是否刷新页面？',
    'home.update_avail': '有新的更新（{v}）', 'home.update_view': '查看',
    'about.new_version_v': '可以安装新版本 {v}（当前 {cur}）。', 'about.notes_none': '没有更新说明。',
    'about.update_hint': '下载更新并安装到适配器后，适配器会重新启动（约 5–6 分钟）。完成前请保持适配器供电。',
    'about.later': '稍后', 'about.update_now': '更新', 'about.new_short': '新版本 {v}',
    'about.check_fail': '无法获取更新信息，请检查网络连接。',

    'dlg.ok': '确定', 'dlg.cancel': '取消', 'dlg.save': '保存', 'dlg.reload': '刷新', 'dlg.close': '关闭',
    'dlg.yes': '是', 'video.nosignal': '没有来自 iPhone 的画面',
    'video.backlist': '未授权设备', 'video.touch_hint': '点按以操作',

    'stat.fps': 'fps', 'stat.kbps': 'kbit/s', 'stat.decode': '解码', 'stat.dropped': '丢帧', 'stat.mode': '模式',
    // 26101701: takeover retry, decoder step-down, event log
    'home.retry_in': '{s} 秒后重新连接', 'about.events': '最近事件', 'about.events_hint': '连接、屏幕切换、会话重启、解码警告记录', 'about.events_show': '查看', 'about.events_none': '暂无事件记录。', 'about.events_clear': '清除',
    'video.loading': '正在加载视频解码器…（等待连接）', 'video.transient': '无法准备视频解码器（连接或 GPU 问题）。暂时使用图片模式，10 分钟后重试视频。'
  };

  T['zh-TW'] = {
    'nav.home': '首頁', 'nav.devices': '裝置', 'nav.cellular': '行動網路', 'nav.wifi': 'Wi‑Fi',
    'nav.bluetooth': '藍牙', 'nav.display': '顯示', 'nav.language': '語言',
    'nav.system': '系統', 'nav.about': '關於', 'nav.reload': '重新整理頁面',

    'home.title': 'CarPlay', 'home.subtitle': '為 Tesla 打造的無線 CarPlay',
    'home.pair_title': '配對您的 iPhone',
    'home.step1': '在 iPhone 上開啟藍牙與 Wi‑Fi。',
    'home.step2': '在「設定 › 藍牙」中選擇：',
    'home.step3': '接受配對要求後，CarPlay 會自動啟動。',
    'home.bt_name': '藍牙名稱', 'home.show_qr': '顯示 QR Code', 'home.hide_qr': '隱藏 QR Code', 'home.reboot': '重新啟動轉接器', 'home.reboot_hint': '重新啟動轉接器，CarPlay 約 1 分鐘後會重新連線。', 'home.reboot_btn': '重新啟動', 'home.reboot_confirm': '要重新啟動轉接器嗎？CarPlay 約 1 分鐘後會重新連線。', 'home.usb': 'USB 主控台', 'home.usb_hint': '透過 USB-C 連接埠提供筆電 root shell。車內請關閉。',
    'home.qr_hint': '用 iPhone 相機掃描', 'home.connecting': '連線中…',
    'home.waiting': '等待 iPhone', 'home.connected': 'iPhone 已連線',
    'home.starting': '正在啟動 CarPlay…', 'home.open_carplay': '開啟 CarPlay', 'home.car_ui': 'iPhone 已連線 · 設定',
    'home.elsewhere': 'CarPlay 正在其他螢幕上使用', 'home.use_here': '在此螢幕使用',
    'home.reload_loop': '頁面反覆重新載入仍未生效，已停止。請檢查轉接器後手動重新整理。',
    'home.elsewhere_hint': '轉接器一次只能連線一個螢幕，另一個瀏覽器剛剛已連線。要切換回此螢幕嗎？',
    'home.open_settings': '設定', 'home.last_device': '上次連線',

    'dev.auto': '自動連線', 'dev.auto_hint': '自動重新連線上次使用的 iPhone',
    'dev.paired': '已配對的 iPhone', 'dev.none': '尚無已配對的 iPhone',
    'dev.or_pair': '或透過藍牙配對新的 iPhone：',
    'dev.connect': '連線', 'dev.disconnect': '中斷連線', 'dev.forget': '移除',
    'dev.connected': '已連線',

    'cell.dial': '數據連線', 'cell.connected': '已連線', 'cell.not_connected': '未連線',
    'cell.signal': '訊號強度', 'cell.carrier': '電信業者', 'cell.refresh': '重新整理',
    'cell.none': '無行動網路模組', 'cell.na': '無',

    'wifi.ssid': '網路名稱', 'wifi.password': '密碼', 'wifi.show': '顯示', 'wifi.hide': '隱藏',
    'wifi.change_pw': '變更密碼', 'wifi.channel': '頻道', 'wifi.band24': '2.4 GHz', 'wifi.band5': '5 GHz',
    'wifi.auto': '自動', 'wifi.rec40': '40 MHz 頻道，建議', 'wifi.pw_title': '設定網路密碼', 'wifi.pw_new': '新密碼',
    'wifi.pw_rule': '請使用 8～11 位英文或數字，不支援特殊字元。',
    'wifi.pw_changed': '密碼已變更，請使用新密碼重新連線：',
    'wifi.pw_warn': '變更密碼將中斷目前已連線的所有裝置。',
    'wifi.channel_hint': '變更頻道會短暫重新啟動熱點。',

    'bt.name': '藍牙名稱', 'bt.modem': '藍牙數據機',
    'bt.modem_hint': '透過藍牙使用手機的行動數據，取代內建 4G。請先在手機上開啟個人熱點並允許透過藍牙分享網路。手機需保持連線。',

    'disp.theme': '外觀', 'disp.theme_light': '淺色', 'disp.theme_dark': '深色', 'disp.theme_auto': '跟隨夜間模式',
    'disp.night': '夜間模式', 'disp.night_hint': '要求 iPhone 以深色外觀繪製 CarPlay',
    'disp.night_sched': '自動夜間模式', 'disp.night_off': '關閉', 'disp.night_18': '18:00 – 06:00', 'disp.night_19': '19:00 – 07:00',
    'disp.res': '畫質', 'disp.q_ultra': '超高解析度', 'disp.q_high': '高解析度', 'disp.q_balanced': '均衡', 'disp.q_low': '低解析度', 'disp.q_ultralow': '超低解析度',
    'disp.res_hint': '畫質越高越清晰、圖示越小，Wi‑Fi 與解碼負擔越大；越低圖示越大、越流暢。變更後 CarPlay 會短暫重新連線，不會自動變更。',
    'disp.fps': '畫面更新率', 'disp.fps_standard': '標準', 'disp.fps_smooth': '流暢',
    'disp.mode': '影像傳輸方式', 'disp.mode_auto': '自動', 'disp.mode_picture': '圖片', 'disp.mode_video': '影片',
    'disp.mode_hint': '「影片」直接傳輸 iPhone 的 H.264 並在瀏覽器中解碼：Wi‑Fi 頻寬減少 3～5 倍，轉接器無需轉碼。「自動」僅在瀏覽器無法解碼影片時使用「圖片」(MJPEG)。',
    'video.slow': '目前畫質下瀏覽器的影片解碼跟不上。若畫面卡頓，請在「顯示」中降低畫質或將畫面更新率改為標準。',
    'video.unsupported': '此瀏覽器不支援影片方式，使用「圖片」方式。',
    'video.keyframe': '等待關鍵影格…',
    'disp.fit': '畫面縮放', 'disp.fit_contain': '符合', 'disp.fit_cover': '填滿', 'disp.fit_stretch': '延展',
    'disp.stats': '效能資訊', 'disp.stats_hint': '在畫面上顯示畫面更新率、頻寬與解碼時間',
    'disp.session': '目前 CarPlay 解析度',

    'lang.title': '語言', 'lang.auto': '自動', 'lang.hint': '「自動」跟隨 Tesla 瀏覽器的語言。',

    'sys.online': '連線檢測', 'sys.online_hint': '定期檢測透過轉接器的網際網路連線',
    'sys.driver': '駕駛座位置', 'sys.lhd': '左駕', 'sys.rhd': '右駕',
    'sys.car_name': 'iPhone 上顯示的車輛名稱', 'sys.car_name_hint': '在 iPhone 上顯示為已連線的車輛（僅 iOS）',
    'sys.icon': 'iPhone 上顯示的車輛圖示', 'sys.icon_default': '預設', 'sys.icon_custom': '自訂',
    'sys.tesla_tm': 'Tesla 及 Tesla 標誌是 Tesla, Inc. 在美國及其他國家/地區註冊的商標。',
    'sys.mic_test': '麥克風測試', 'sys.open_mic_test': '開啟測試頁面',

    'about.update': '軟體更新', 'about.check': '檢查更新', 'about.model': '型號',
    'about.fw': '韌體', 'about.hw': '硬體', 'about.uuid': 'UUID', 'about.reset': '恢復原廠設定',
    'about.reset_btn': '重設', 'about.reset_confirm': '確定恢復原廠設定？所有配對與設定都將被清除。',
    'about.latest': '已是最新版本。', 'about.new_version': '發現新版本，是否立即更新？',
    'about.update_ok': '更新成功，轉接器正在重新啟動。',
    'about.update_fail': '更新失敗，請檢查網路連線後重試。',
    'about.downloading': '正在下載', 'about.installing': '正在安裝', 'about.keep_power': '請在重新啟動完成前保持轉接器供電。',
    'about.net_error': '網路異常，請確認網路連線。是否重新整理？',
    'about.ws_lost': '未連線到轉接器，是否重新整理頁面？',
    'home.update_avail': '有新的更新（{v}）', 'home.update_view': '查看',
    'about.new_version_v': '可以安裝新版本 {v}（目前 {cur}）。', 'about.notes_none': '沒有更新說明。',
    'about.update_hint': '下載更新並安裝到轉接器後，轉接器會重新啟動（約 5–6 分鐘）。完成前請保持轉接器供電。',
    'about.later': '稍後', 'about.update_now': '更新', 'about.new_short': '新版本 {v}',
    'about.check_fail': '無法取得更新資訊，請檢查網路連線。',

    'dlg.ok': '確定', 'dlg.cancel': '取消', 'dlg.save': '儲存', 'dlg.reload': '重新整理', 'dlg.close': '關閉',
    'dlg.yes': '是', 'video.nosignal': '沒有來自 iPhone 的畫面',
    'video.backlist': '未授權裝置', 'video.touch_hint': '點按以操作',

    'stat.fps': 'fps', 'stat.kbps': 'kbit/s', 'stat.decode': '解碼', 'stat.dropped': '丟幀', 'stat.mode': '模式',
    // 26101701: takeover retry, decoder step-down, event log
    'home.retry_in': '{s} 秒後重新連線', 'about.events': '最近事件', 'about.events_hint': '連線、螢幕切換、工作階段重啟、解碼警告記錄', 'about.events_show': '檢視', 'about.events_none': '尚無事件記錄。', 'about.events_clear': '清除',
    'video.loading': '正在載入影片解碼器…（等待連線）', 'video.transient': '無法準備影片解碼器（連線或 GPU 問題）。暫時使用圖片模式，10 分鐘後重試影片。'
  };

  var current = 'en';

  function normalize(tag) {
    if (!tag) return null;
    tag = String(tag);
    var low = tag.toLowerCase();
    if (low.indexOf('ko') === 0) return 'ko';
    if (low.indexOf('ja') === 0) return 'ja';
    if (low.indexOf('zh') === 0) {
      if (/hant|tw|hk|mo/.test(low)) return 'zh-TW';
      return 'zh-CN';
    }
    if (low.indexOf('en') === 0) return 'en';
    return null;
  }

  /** Server lan index (0 zh-CN, 1 zh-TW, 2 en, 3 auto) to tag. */
  function fromServerIndex(i) {
    return ({ 0: 'zh-CN', 1: 'zh-TW', 2: 'en' })[i] || null;
  }

  /** Tag to server lan index. ko/ja have no server equivalent: use auto (3). */
  function toServerIndex(tag) {
    return ({ 'zh-CN': 0, 'zh-TW': 1, en: 2 })[tag] !== undefined ? ({ 'zh-CN': 0, 'zh-TW': 1, en: 2 })[tag] : 3;
  }

  function detect(serverIndex) {
    var stored = null;
    try { stored = localStorage.getItem('t2c.lang'); } catch (e) { /* ignore */ }
    if (stored === 'auto') stored = null;
    if (stored && T[stored]) return stored;
    var nav = normalize(navigator.language || (navigator.languages && navigator.languages[0]));
    if (nav) return nav;
    var srv = fromServerIndex(serverIndex);
    return srv || 'en';
  }

  function t(key, vars) {
    var s = (T[current] && T[current][key]) || T.en[key] || key;
    if (vars) {
      Object.keys(vars).forEach(function (k) {
        s = s.replace(new RegExp('\\{' + k + '\\}', 'g'), vars[k]);
      });
    }
    return s;
  }

  function apply(root) {
    root = root || document;
    var nodes = root.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var key = el.getAttribute('data-i18n');
      var attr = el.getAttribute('data-i18n-attr');
      if (attr) el.setAttribute(attr, t(key));
      else el.textContent = t(key);
    }
    document.documentElement.setAttribute('lang', current);
  }

  function set(tag) {
    if (!T[tag]) tag = 'en';
    current = tag;
    try { localStorage.setItem('t2c.lang', tag); } catch (e) { /* ignore */ }
    apply();
  }

  function setAuto() {
    try { localStorage.setItem('t2c.lang', 'auto'); } catch (e) { /* ignore */ }
    current = detect();
    apply();
  }

  function isAuto() {
    try { var v = localStorage.getItem('t2c.lang'); return !v || v === 'auto'; } catch (e) { return true; }
  }

  global.I18N = {
    LANGS: LANGS, NAMES: NAMES, t: t, apply: apply, set: set, setAuto: setAuto, isAuto: isAuto,
    detect: detect, normalize: normalize, fromServerIndex: fromServerIndex, toServerIndex: toServerIndex,
    get current() { return current; },
    init: function (serverIndex) { current = detect(serverIndex); apply(); return current; }
  };
})(window);
