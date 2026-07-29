# 배포 및 친구 초대 테스트

## 권장 시범 구조

```text
Cloudflare Pages (Vite 정적 파일)
        |
        | WSS: VITE_WS_URL
        v
Node WebSocket 서버 (Docker: Fly.io / Render / Railway 등)
```

Pages는 정적 클라이언트를 배포하고, 방 코드·매칭·실시간 상태와 서버 권위 물리는 별도 WebSocket 서버가 처리한다. 시범 단계에서는 이 Node 서버를 별도 컨테이너로 유지한다.

Cloudflare만으로 구성할 수도 있지만, 그 경우 Pages 외에 **Worker + Durable Object**를 별도 배포해야 한다. Pages 프로젝트 내부에서 Durable Object를 직접 생성할 수는 없다. Durable Object는 방별 WebSocket 연결을 조정하는 용도로 적합하지만, 지속적인 물리 틱을 운영하기 전에 Worker CPU/비용 모델을 별도로 검토한다.

## Docker는 무엇인가

Docker는 별도의 서버나 API가 아니라, 서버 프로그램과 실행 환경을 하나의 **컨테이너 이미지**로 포장하는 도구다. 이 저장소에서는 `server/index.ts`가 실제 WebSocket 게임 서버이고, `Dockerfile`은 이 서버를 어떤 호스팅 환경에서도 같은 Node 버전·의존성으로 실행하도록 설명한다.

즉 역할은 다음과 같다.

```text
Dockerfile → WebSocket 서버 실행 이미지를 만듦
Fly.io / Render / Railway → 그 이미지를 인터넷에서 계속 실행함
Cloudflare Pages → 브라우저용 정적 파일을 배포함
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

## 서버 컨테이너

서버 이미지를 빌드·실행한다.

```powershell
docker build -t stackmate-ws .
docker run --rm -p 8787:8787 -e WS_PORT=8787 stackmate-ws
```

배포 플랫폼의 포트 환경 변수에 맞춰 `WS_PORT`를 지정한다. `GET /health`는 200과 `{"status":"ok"}`를 반환한다.

## Cloudflare Pages

1. Git 저장소를 Pages 프로젝트에 연결한다.
2. Build command는 `npm run build`, output directory는 `dist`로 설정한다.
3. Pages 환경 변수 `VITE_WS_URL`에 배포한 서버의 `wss://...` 주소를 입력한다.
4. 다시 빌드·배포한다. `VITE_` 변수는 브라우저 번들에 공개되므로 비밀값을 넣지 않는다.

배포 후 방을 만들고 초대 링크를 친구에게 보내면, 두 브라우저가 같은 WebSocket 방에 연결된다.
