# 시스템 아키텍처

```text
브라우저
├─ React UI
├─ Phaser 게임 화면
├─ Rapier 표시용 물리
└─ Colyseus Client
        │
        ▼
게임 서버
├─ MatchRoom
├─ 서버 Rapier 물리
├─ chess.js
├─ 타이머
└─ 결과 판정
        │
        ▼
PostgreSQL
```

## 권한 원칙

클라이언트는 조작 요청만 보낸다. 기물 순서, 물리 결과, 생존 판정, 체스 이동, 시간, 최종 승패는 서버가 결정한다.

클라이언트 물리는 입력 반응과 시각화를 위해 사용할 수 있지만, 온라인 경기의 권위 있는 결과는 서버 시뮬레이션을 기준으로 한다.

## 책임 분리

- React: 로비·메뉴·결과 UI
- Phaser: 쌓기·체스 씬 렌더링과 입력
- Rapier: 쌓기 단계 충돌과 안정화
- chess.js: 체스 상태 전이와 합법 수 검증
- MatchRoom: 턴, 타이머, 재접속, 상태 배포
- PostgreSQL: 경기 기록과 사용자 데이터
