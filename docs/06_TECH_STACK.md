# 기술 스택

## Frontend

| 기술 | 사용 이유 |
| --- | --- |
| React | 로비, 설정, 전적 등 게임 외 UI를 컴포넌트로 구성하기 좋음 |
| TypeScript | 상태·메시지·기물 데이터를 안전하게 다룸 |
| Vite | 빠른 개발 서버와 번들링 |
| Phaser 3 | 2D 씬, 입력, 스프라이트, 전환 연출 담당 |
| Rapier 2D | 결정론적 물리 설정을 지향하는 낙하·충돌·회전 처리 |
| chess.js | 체스 합법 수와 종료 조건 검증 |

## Backend

| 기술 | 사용 이유 |
| --- | --- |
| Node.js | TypeScript 기반의 실시간 게임 서버 구현 |
| Colyseus | 방 단위 1대1 상태 동기화와 재접속 처리 |
| Express | 인증·전적 등 HTTP API 확장 시 사용 |

## Database

PostgreSQL을 계정, 경기 결과, 레이팅, 기보의 영속 저장소로 사용한다.

## 배포 후보

- 정적 웹 클라이언트: Cloudflare Pages
- 게임 서버: NCP Ubuntu 또는 동등한 Linux VM
- 리버스 프록시: Nginx
- 프로세스 관리: PM2

초기 로컬 프로토타입에는 React 로비·서버·DB 없이 Phaser, Rapier, chess.js만 사용한다.
