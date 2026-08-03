# 배포 및 친구 초대 테스트

> 이 문서는 기존 웹 배포 환경을 정리한 기록이다. 현재 배포 채널은 Tauri 데스크톱 앱과 Capacitor 모바일 앱이며, 자세한 절차는 [19_NATIVE_DISTRIBUTION.md](19_NATIVE_DISTRIBUTION.md)를 따른다.

## 현재 구조

```text
Tauri Windows 앱 / Capacitor 모바일 앱
                 |
                 | WSS: VITE_WS_URL
                 v
Render Node WebSocket 서버
```

방 코드·매칭·실시간 상태와 서버 권위 물리는 Render의 Node WebSocket 서버가 처리한다. 이번 전환에서는 Render 서버를 유지하고, 기존 Cloudflare Pages 정적 클라이언트만 회수한다.

## Docker는 무엇인가

Docker는 별도의 서버나 API가 아니라, 서버 프로그램과 실행 환경을 하나의 **컨테이너 이미지**로 포장하는 도구다. 이 저장소에서는 `server/index.ts`가 실제 WebSocket 게임 서버이고, `Dockerfile`은 이 서버를 어떤 호스팅 환경에서도 같은 Node 버전·의존성으로 실행하도록 설명한다.

즉 역할은 다음과 같다.

```text
Dockerfile → WebSocket 서버 실행 이미지를 만듦
Render → 그 이미지를 인터넷에서 계속 실행함
Tauri / Capacitor → 동일한 Vite 클라이언트를 설치형 앱으로 배포함
```

Docker 이미지는 API 서버뿐 아니라 데이터 처리 작업, 프록시, 게임 서버 등 어떤 프로그램도 실행할 수 있다. Stackmate에서는 REST API가 아니라 장시간 연결을 유지하는 WebSocket 게임 서버를 컨테이너로 실행한다.

## Worker와 Durable Object는 무엇인가

- **Cloudflare Worker**: HTTP/WebSocket 요청이 들어올 때 Cloudflare 엣지에서 실행되는 짧은 서버 코드다. 경로 확인, 인증, 요청을 올바른 방으로 전달하는 관문 역할을 맡는다.
- **Durable Object (DO)**: 이름으로 하나만 존재하는 상태 보관형 Worker 인스턴스다. 예를 들어 `room-AB12CD`라는 DO 하나에 해당 방의 두 WebSocket 연결과 게임 상태를 모을 수 있다. 따라서 두 브라우저가 같은 방 상태를 보게 만드는 조정자에 적합하다.

```text
브라우저 1 ─┐
           ├─ Worker ─ Durable Object "room-AB12CD" ─ 방 상태·WebSocket 연결
브라우저 2 ─┘
```

간단한 채팅·턴제 게임이라면 Pages + Worker + Durable Object만으로도 좋은 선택이다. 반면 Stackmate처럼 Rapier 물리를 1초에 여러 번 계속 계산하는 게임 서버는, 시범 단계에서는 Docker 기반 Node 프로세스가 더 직접적이다. 나중에 DO로 옮기려면 물리 틱·CPU 제한·휴면 비용을 별도로 설계해야 한다.

## 로컬 확인

```powershell
npm install
npm run dev
```

브라우저 두 개를 열어 `1:1 방 만들기`를 누르고, 생성된 `초대 링크 복사` 버튼의 URL을 다른 창에 열어 참가한다.

Docker 컨테이너로 서버를 실행하는 경우에는 `npm run dev`가 아닌 아래 명령으로 클라이언트만 실행한다. `npm run dev`는 로컬 Node 서버도 함께 시작하므로 Docker가 사용하는 8787 포트와 충돌한다.

```powershell
docker compose up --build -d
npm run client
```

## 서버 컨테이너

서버 이미지를 빌드·실행한다. 로컬 개발에서는 Compose 명령 하나로 실행하는 것을 권장한다.

```powershell
docker compose up --build -d
docker compose ps
```

중지할 때는 다음을 실행한다. 컨테이너만 제거하며 소스 코드나 Docker 이미지는 삭제하지 않는다.

```powershell
docker compose down
```

Compose를 쓰지 않을 경우에는 아래 명령으로 직접 이미지를 빌드·실행할 수도 있다.

```powershell
docker build -t stackmate-ws .
docker run --rm -p 8787:8787 -e WS_PORT=8787 stackmate-ws
```

배포 플랫폼의 포트 환경 변수에 맞춰 `WS_PORT`를 지정한다. `GET /health`는 200과 `{"status":"ok"}`를 반환한다.

## 기존 Cloudflare Pages 회수

새 Tauri·Capacitor 빌드에서 방 생성·초대 링크·재접속·멀티 쌓기·체스 완료를 확인한 뒤, Cloudflare Dashboard에서 기존 Pages 프로젝트와 연결된 커스텀 도메인만 삭제한다. Render WebSocket 서버는 이 과정의 대상이 아니다.
