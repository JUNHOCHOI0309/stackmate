# STACKMATE

체스말을 번갈아 쌓고, 기물이 떨어지는 순간 살아남은 체스말만으로 체스를 진행하는 웹 기반 1대1 물리 전략 게임입니다.

```text
체스말 쌓기 → 생존 기물 판정 → 체스판 자동 배치 → 체스 대전
```

물리 쌓기 실력은 체스 단계의 병력 확보에, 체스 실력은 최종 역전에 영향을 줍니다. 낙하는 경기의 끝이 아니라 다음 전략 게임의 시작입니다.

## 주요 기능

- 2D 측면 시점의 체스말 물리 쌓기
- 플레이어별 독립 무작위 기물 순서
- 낙하 후 생존 기물 판정
- 생존 기물 기반 체스판 자동 배치
- 체크, 체크메이트, 캐슬링을 포함한 체스 대전

## 계획 기술 스택

| 영역 | 기술 |
| --- | --- |
| 클라이언트 UI | React, TypeScript, Vite |
| 게임·물리 | Phaser 3, Rapier 2D |
| 체스 규칙 | chess.js |
| 실시간 서버 | Node.js, Colyseus |
| 데이터 | PostgreSQL |

초기 MVP는 `Phaser + Rapier 2D + chess.js`로 로컬 2인 프로토타입을 만드는 것을 목표로 합니다.

## 문서

기획과 구현 명세는 [docs](docs/)에서 관리합니다.

- [게임 개요](docs/01_GAME_OVERVIEW.md)
- [게임 규칙](docs/02_GAME_RULES.md)
- [레퍼런스 분석](docs/03_REFERENCE_ANALYSIS.md)
- [기술 스택](docs/06_TECH_STACK.md)
- [물리 명세](docs/08_PHYSICS_SPEC.md)
- [체스 시스템](docs/09_CHESS_SYSTEM.md)
- [MVP 범위](docs/12_MVP_SCOPE.md)
- [개발 로드맵](docs/14_ROADMAP.md)
- [스킨·코스메틱 시스템](docs/16_SKIN_SYSTEM.md)

## 개발 상태

Vite + TypeScript 기반의 로컬 프로토타입 시작 환경을 구성했습니다. Phaser 3, Rapier 2D, chess.js를 사용합니다.

## 실행

Node.js 20.19 이상이 필요합니다.

```bash
npm install
npm start
```

개발 서버가 시작되면 터미널에 표시된 주소(기본값: `http://localhost:5173`)를 브라우저에서 엽니다.

## 현재 프로토타입

로컬 2인용 물리 쌓기 화면을 먼저 구현했습니다. 백·흑이 각각 15개로 섞인 기물 덱을 번갈아 받침대에 떨어뜨리고, 기물이 낙하 기준선을 넘으면 라운드가 끝납니다.

- 마우스 또는 `←` / `→`: 기물 이동
- `Q` / `E`: 기물 회전
- 클릭 또는 `Space`: 기물 낙하
- `R`: 라운드 다시 시작

각 턴은 10초이며, 시간 초과 시 기물이 현재 위치에서 자동 낙하합니다.

프로덕션 빌드는 다음 명령으로 확인할 수 있습니다.

```bash
npm run build
```

## 라이선스

라이선스는 아직 정하지 않았습니다.
