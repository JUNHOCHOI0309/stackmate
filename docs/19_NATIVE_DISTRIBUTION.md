# 네이티브 배포 전환

## 배포 채널

- 데스크톱: Tauri로 현재 Vite·Phaser 클라이언트를 Windows 설치 프로그램으로 패키징한다.
- 모바일: Capacitor Android·iOS 프로젝트에 같은 `dist` 웹 번들을 동기화한다.
- 실시간 서버: Render의 Node WebSocket 서버를 계속 사용한다.
- 기존 Cloudflare Pages: 새 설치형 빌드를 검증한 뒤 중지·삭제한다.

## 필수 환경 변수

네이티브 앱은 Render WebSocket 주소를 번들에 포함해야 한다. 빌드 전 아래 값을 설정한다.

```powershell
$env:VITE_WS_URL = 'wss://<render-websocket-server>'
```

## 명령어

```powershell
# Android·iOS 프로젝트 동기화
npm run build:mobile

# Android Studio 열기
npx cap open android

# macOS에서 iOS 프로젝트 열기
npx cap open ios

# Windows 설치 파일 생성
npm run build:tauri
```

Tauri Windows 빌드에는 Rust, Microsoft C++ Build Tools, WebView2가 필요하다. Android APK/AAB 빌드에는 Android Studio와 Android SDK가 필요하며, iOS IPA 빌드에는 macOS와 Xcode가 필요하다.

## Cloudflare Pages 회수 순서

1. Render `wss://` 주소를 주입한 Tauri·Android 빌드를 실제 기기에서 검증한다.
2. 방 생성·초대 링크·재접속·멀티 쌓기·체스 완료까지 확인한다.
3. 기존 Pages 프로젝트의 커스텀 도메인이 있으면 먼저 해제한다.
4. Cloudflare Dashboard에서 Pages 프로젝트를 삭제하거나 배포를 중지한다.

Render WebSocket 서버는 Pages와 별개이므로 이 전환에서 삭제하지 않는다.
