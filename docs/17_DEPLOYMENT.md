# 배포 및 친구 초대 테스트

## 권장 시범 구조

```text
Cloudflare Pages (Vite 정적 파일)
        |
        | WSS: VITE_WS_URL
        v
Node WebSocket 서버 (Docker: Fly.io / Render / Railway 등)
```

Pages는 정적 클라이언트를 배포하고, 방 코드·매칭·실시간 상태는 별도 WebSocket 서버가 처리한다. 이 프로젝트는 서버 권위 물리 시뮬레이션을 추가할 예정이므로, 시범 단계에서는 Node 서버를 별도 컨테이너로 유지한다.

Cloudflare만으로 구성할 수도 있지만, 그 경우 Pages 외에 **Worker + Durable Object**를 별도 배포해야 한다. Pages 프로젝트 내부에서 Durable Object를 직접 생성할 수는 없다. Durable Object는 방별 WebSocket 연결을 조정하는 용도로 적합하지만, 지속적인 물리 틱을 운영하기 전에 Worker CPU/비용 모델을 별도로 검토한다.

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
