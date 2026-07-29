import Phaser from 'phaser';
import RAPIER, { type RigidBody, type World } from '@dimforge/rapier2d-compat';
import { Chess, type Color, type PieceSymbol, type Square } from 'chess.js';
import { MenuScene } from './menu';
import { matchSocket, type MatchState } from './network';
import { settleProfile, type GameMode } from './profile';
import './style.css';

type PieceKind = 'pawn' | 'rook' | 'knight' | 'bishop' | 'queen';
type PlayerColor = 'white' | 'black';

type PieceCrop = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type PieceSpec = {
  displayHeight: number;
  crop: Record<PlayerColor, PieceCrop>;
};

type StackPiece = {
  body: RigidBody;
  color: PlayerColor;
  height: number;
  kind: PieceKind;
  outline?: Phaser.GameObjects.Image;
  previousY: number;
  serverId?: string;
  serverTarget?: { angle: number; x: number; y: number };
  settledOrder: number;
  sprite: Phaser.GameObjects.Image;
  width: number;
};

type SurvivorPiece = Pick<StackPiece, 'color' | 'kind' | 'settledOrder'>;

type GameStartData = {
  mode?: GameMode;
  opponentRating?: number;
};

const GAME_WIDTH = 1160;
const GAME_HEIGHT = 840;
const PLATFORM_HALF_WIDTH = 300;
const PLATFORM_Y = GAME_HEIGHT - 82;
const PLATFORM_CENTER_X = GAME_WIDTH / 2;
const FALL_LINE_Y = PLATFORM_Y + 16;
const FALL_RESOLUTION_MS = 1_000;
const SPAWN_Y = 150;
const SIDE_COLLIDER_SCALE = 1.12;
const TURN_DURATION_MS = 10_000;
const CHESS_BASE_TIME_MS = 5 * 60_000;
const CHESS_WINNER_BONUS_MS = 30_000;
const CHESS_INCREMENT_MS = 2_000;
const COLOR_SELECTION_MS = 10_000;
const STACK_DECK: PieceKind[] = [
  'pawn', 'pawn', 'pawn', 'pawn', 'pawn', 'pawn', 'pawn', 'pawn',
  'rook', 'rook',
  'knight', 'knight',
  'bishop', 'bishop',
  'queen',
];
const PLAYER_LABEL: Record<PlayerColor, string> = {
  white: '플레이어 1 · 백',
  black: '플레이어 2 · 흑',
};
const CHESS_PIECE_TYPE: Record<PieceKind, PieceSymbol> = {
  pawn: 'p',
  rook: 'r',
  knight: 'n',
  bishop: 'b',
  queen: 'q',
};

const PIECE_SPECS: Record<PieceKind, PieceSpec> = {
  pawn: {
    displayHeight: 98,
    crop: {
      white: { left: 612, top: 228, width: 313, height: 513 },
      black: { left: 618, top: 264, width: 299, height: 481 },
    },
  },
  rook: {
    displayHeight: 112,
    crop: {
      white: { left: 604, top: 234, width: 327, height: 471 },
      black: { left: 604, top: 268, width: 327, height: 453 },
    },
  },
  knight: {
    displayHeight: 120,
    crop: {
      white: { left: 586, top: 172, width: 341, height: 563 },
      black: { left: 590, top: 206, width: 335, height: 543 },
    },
  },
  bishop: {
    displayHeight: 124,
    crop: {
      white: { left: 600, top: 184, width: 333, height: 609 },
      black: { left: 604, top: 186, width: 327, height: 605 },
    },
  },
  queen: {
    displayHeight: 132,
    crop: {
      white: { left: 588, top: 162, width: 357, height: 633 },
      black: { left: 594, top: 162, width: 349, height: 631 },
    },
  },
};

const PIECE_KINDS = Object.keys(PIECE_SPECS) as PieceKind[];

class StackingScene extends Phaser.Scene {
  private activeAngle = 0;
  private aiActionAt = 0;
  private activePiece: StackPiece | null = null;
  private decks: Record<PlayerColor, PieceKind[]> = { black: [], white: [] };
  private colorSelectionEndMs = 0;
  private colorSelectionWinner: PlayerColor | null = null;
  private gameEnded = false;
  private pendingFallLoser: PlayerColor | null = null;
  private pendingFallRemainingMs = 0;
  private lastDropped: StackPiece | null = null;
  private lastDroppedBy: PlayerColor | null = null;
  private lastTimerTickMs = Date.now();
  private mode: GameMode = 'single';
  private networkMatch: MatchState | null = null;
  private networkChessStarted = false;
  private networkColorSelectionShown = false;
  private networkSettlementShown = false;
  private removeMatchListener: (() => void) | null = null;
  private networkText!: Phaser.GameObjects.Text;
  private opponentRating = 1200;
  private platformGraphics: Phaser.GameObjects.Graphics | null = null;
  private player: PlayerColor = 'white';
  private playerText!: Phaser.GameObjects.Text;
  private pieces: StackPiece[] = [];
  private settleDuration = 0;
  private settledPieceCount = 0;
  private statusText!: Phaser.GameObjects.Text;
  private targetX = GAME_WIDTH / 2;
  private timerText!: Phaser.GameObjects.Text;
  private turnTimeRemaining = TURN_DURATION_MS;
  private turnCount = 0;
  private world!: World;

  constructor() {
    super('stacking');
  }

  init(data: GameStartData) {
    this.mode = data.mode ?? 'single';
    this.opponentRating = data.opponentRating ?? 1200;
    this.networkSettlementShown = false;
  }

  preload() {
    for (const kind of PIECE_KINDS) {
      for (const color of ['white', 'black'] as const) {
        this.load.image(this.sourceTextureKey(kind, color), `/assets/${kind}_${color}.png`);
      }
    }
  }

  create() {
    this.createTrimmedTextures();
    this.createUi();
    matchSocket.onStatus((status) => this.networkText?.setText(`WebSocket · ${status}`));
    matchSocket.connect();
    this.networkMatch = matchSocket.getMatch();
    this.removeMatchListener = matchSocket.onMatch((match) => {
      this.networkMatch = match;
      if (this.mode === 'multiplayer') {
        this.applyNetworkPhysics(match);
        if (match.phase === 'complete') this.showNetworkSettlement(match);
      }
    });
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.removeMatchListener?.());
    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (this.activePiece !== null && !this.gameEnded && this.canControlActivePiece()) {
        this.targetX = Phaser.Math.Clamp(pointer.x, PLATFORM_CENTER_X - 250, PLATFORM_CENTER_X + 250);
      }
    });
    this.input.on('pointerdown', () => {
      if (this.canControlActivePiece()) this.dropActivePiece();
    });
    this.input.keyboard?.on('keydown-SPACE', () => {
      if (this.canControlActivePiece()) this.dropActivePiece();
    });
    this.input.keyboard?.on('keydown-R', () => this.resetRound());
    this.resetRound();
    if (this.mode === 'multiplayer' && this.networkMatch?.phase === 'complete') {
      this.showNetworkSettlement(this.networkMatch);
    }
  }

  update(_time: number, delta: number) {
    if (this.colorSelectionWinner !== null) {
      this.updateColorSelectionTimer();
      return;
    }
    if (this.mode === 'multiplayer') {
      this.updateNetworkStacking(delta);
      return;
    }
    if (!this.gameEnded && this.activePiece !== null) {
      if (this.isAiStackTurn()) this.updateAiStackTurn();
      else this.updateActivePiece(delta);
      this.updateTurnTimer(delta);
    }

    if (!this.gameEnded || this.pendingFallLoser !== null) {
      this.world.step();
    }
    const fallenPieces = this.pieces.filter((piece) => (
      piece !== this.activePiece
      && piece.previousY <= FALL_LINE_Y
      && piece.body.translation().y > FALL_LINE_Y
    ));
    if (!this.gameEnded || this.pendingFallLoser !== null) {
      this.syncSprites();
    }

    if (this.pendingFallLoser !== null) {
      this.pendingFallRemainingMs = Math.max(0, this.pendingFallRemainingMs - delta);
      if (this.pendingFallRemainingMs === 0) {
        const loser = this.pendingFallLoser;
        this.pendingFallLoser = null;
        this.endRound(loser);
      }
      return;
    }

    if (this.gameEnded) {
      return;
    }

    if (fallenPieces.length > 0) {
      const loser = fallenPieces.length > 1
        ? (this.activePiece?.color ?? this.lastDroppedBy ?? this.player)
        : fallenPieces[0].color;
      this.beginFallResolution(loser);
      return;
    }

    this.checkSettlement(delta);
  }

  private beginFallResolution(loser: PlayerColor) {
    this.gameEnded = true;
    this.pendingFallLoser = loser;
    this.pendingFallRemainingMs = FALL_RESOLUTION_MS;
    this.timerText.setText('—').setColor('#b9c4dd');
    this.statusText.setText('낙하 감지 · 최종 생존 기물 판정 중…');
  }

  private checkSettlement(delta: number) {
    if (this.lastDropped === null) {
      return;
    }

    const velocity = this.lastDropped.body.linvel();
    const isStable = Math.hypot(velocity.x, velocity.y) < 8 && Math.abs(this.lastDropped.body.angvel()) < 0.12;
    this.settleDuration = isStable ? this.settleDuration + delta : 0;

    if (this.settleDuration >= 550) {
      this.lastDropped.settledOrder = ++this.settledPieceCount;
      this.lastDropped = null;
      this.settleDuration = 0;
      this.player = this.player === 'white' ? 'black' : 'white';
      if (this.decks[this.player].length === 0) {
        this.endPerfectRound();
      } else {
        this.spawnNextPiece();
      }
    }
  }

  private createPiece(kind: PieceKind, color: PlayerColor) {
    const spec = PIECE_SPECS[kind];
    const crop = spec.crop[color];
    const height = spec.displayHeight;
    const width = Math.round((crop.width / crop.height) * height);
    const sprite = this.add
      .image(this.targetX, SPAWN_Y, this.textureKey(kind, color))
      .setDisplaySize(width, height)
      .setDepth(10);
    const outline = color === 'black'
      ? this.add
        .image(this.targetX, SPAWN_Y, this.textureKey(kind, 'white'))
        .setDisplaySize(width + 10, height + 10)
        .setTint(0x7184b4)
        .setAlpha(0.72)
        .setDepth(9)
      : undefined;
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(this.targetX, SPAWN_Y),
    );

    this.addPieceColliders(body, kind, width, height);
    return { body, color, height, kind, outline, previousY: SPAWN_Y, settledOrder: 0, sprite, width };
  }

  private createPlatform() {
    this.platformGraphics?.destroy();
    const graphics = this.add.graphics().setDepth(1);
    graphics.fillStyle(0x7b5c3e, 1);
    graphics.fillRoundedRect(PLATFORM_CENTER_X - PLATFORM_HALF_WIDTH, PLATFORM_Y - 16, PLATFORM_HALF_WIDTH * 2, 32, 8);
    graphics.fillStyle(0xb99062, 1);
    graphics.fillRoundedRect(PLATFORM_CENTER_X - PLATFORM_HALF_WIDTH + 10, PLATFORM_Y - 13, PLATFORM_HALF_WIDTH * 2 - 20, 8, 4);
    graphics.lineStyle(2, 0xff6b6b, 0.65);
    graphics.lineBetween(90, FALL_LINE_Y, GAME_WIDTH - 90, FALL_LINE_Y);
    this.platformGraphics = graphics;

    const platform = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(PLATFORM_CENTER_X, PLATFORM_Y));
    const collider = RAPIER.ColliderDesc.cuboid(PLATFORM_HALF_WIDTH, 16).setFriction(0.62).setRestitution(0.32);
    this.world.createCollider(collider, platform);
  }

  private createTrimmedTextures() {
    for (const [kind, spec] of Object.entries(PIECE_SPECS) as [PieceKind, PieceSpec][]) {
      for (const color of ['white', 'black'] as const) {
        const crop = spec.crop[color];
        const source = this.textures.get(this.sourceTextureKey(kind, color)).getSourceImage() as CanvasImageSource;
        const texture = this.textures.createCanvas(this.textureKey(kind, color), crop.width, crop.height);
        if (texture === null) {
          throw new Error(`텍스처 생성에 실패했습니다: ${kind}_${color}`);
        }
        texture.getContext().drawImage(source, crop.left, crop.top, crop.width, crop.height, 0, 0, crop.width, crop.height);
        texture.refresh();
      }
    }
  }

  private createUi() {
    this.add.text(28, 22, 'STACKMATE · 물리 쌓기 프로토타입', {
      color: '#f5f2e8',
      fontFamily: 'system-ui, sans-serif',
      fontSize: '23px',
      fontStyle: '700',
    });
    this.playerText = this.add.text(28, 64, '', {
      color: '#d5ddff',
      fontFamily: 'system-ui, sans-serif',
      fontSize: '18px',
    });
    this.networkText = this.add.text(28, 92, 'WebSocket · 연결 중…', {
      color: '#8fa2cf',
      fontFamily: 'system-ui, sans-serif',
      fontSize: '13px',
    });
    this.statusText = this.add.text(GAME_WIDTH - 28, 26, '', {
      align: 'right',
      color: '#b9c4dd',
      fontFamily: 'system-ui, sans-serif',
      fontSize: '14px',
    }).setOrigin(1, 0);
    if (this.mode === 'multiplayer') {
      const forfeit = this.add.text(GAME_WIDTH - 28, 58, '기권하고 나가기', {
        color: '#ffaaa5',
        fontFamily: 'system-ui, sans-serif',
        fontSize: '14px',
        fontStyle: '700',
      }).setInteractive({ useHandCursor: true }).setOrigin(1, 0);
      forfeit.on('pointerdown', () => this.forfeitMatch());
    }
    this.timerText = this.add.text(GAME_WIDTH / 2, 48, '', {
      align: 'center',
      color: '#f5f2e8',
      fontFamily: 'system-ui, sans-serif',
      fontSize: '34px',
      fontStyle: '700',
      stroke: '#10131c',
      strokeThickness: 6,
    }).setDepth(30).setOrigin(0.5);
    this.add.text(GAME_WIDTH / 2, GAME_HEIGHT - 12, '마우스 또는 ← →: 이동 · Q / E: 회전 · 클릭 또는 Space: 낙하 · R: 다시 시작', {
      color: '#b9c4dd',
      fontFamily: 'system-ui, sans-serif',
      fontSize: '13px',
    }).setOrigin(0.5);
  }

  private dropActivePiece(isAutomatic = false) {
    if (this.activePiece === null || this.gameEnded || this.lastDropped !== null) {
      return;
    }

    if (this.mode === 'multiplayer') {
      const match = this.networkMatch;
      if (match === null || match.stacking === null || !this.canControlActivePiece()) return;
      const activePiece = this.activePiece;
      matchSocket.submitStackingDrop(match.revision, this.targetX, this.activeAngle);
      this.removePiece(activePiece);
      this.activePiece = null;
      this.statusText.setText('서버 물리 시뮬레이션 응답 대기 중…');
      this.timerText.setText('—').setColor('#b9c4dd');
      return;
    }

    this.activePiece.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    this.activePiece.body.setLinearDamping(0.08);
    this.activePiece.body.setAngularDamping(0.2);
    this.lastDropped = this.activePiece;
    this.lastDroppedBy = this.activePiece.color;
    this.activePiece = null;
    this.timerText.setText('—').setColor('#b9c4dd');
    this.statusText.setText(isAutomatic ? '시간 초과 · 현재 위치에서 자동 낙하' : '착지 안정화 확인 중…');
  }

  private endRound(loser: PlayerColor) {
    const winner = loser === 'white' ? 'black' : 'white';
    this.gameEnded = true;
    this.playerText.setText(`${PLAYER_LABEL[loser]} 기물 낙하 · ${PLAYER_LABEL[winner]} 쌓기 승리`);
    this.timerText.setText('—').setColor('#b9c4dd');
    this.statusText.setText(`총 ${this.turnCount}개 배치 · 체스 진영을 선택하세요`);
    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 90, `${PLAYER_LABEL[winner]} 승리!`, {
        color: '#ff8d8d',
        fontFamily: 'system-ui, sans-serif',
        fontSize: '44px',
        fontStyle: '700',
        stroke: '#311b25',
        strokeThickness: 8,
      })
      .setDepth(20)
      .setOrigin(0.5)
      .setName('round-result');
    if (this.mode === 'single' && winner === 'black') {
      this.statusText.setText('AI가 흑 진영을 선택했습니다');
      this.time.delayedCall(700, () => this.startChess(winner, 'black'));
    } else {
      this.showColorSelection(winner);
    }
  }

  private endPerfectRound() {
    this.gameEnded = true;
    this.playerText.setText('양쪽 전 기물 안정화 · 쌓기 단계 무승부');
    this.timerText.setText('—').setColor('#b9c4dd');
    this.statusText.setText('체스 진영은 무작위 · 시간 보너스 없음');
    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2, '완벽한 탑!', {
        color: '#b8e6a5',
        fontFamily: 'system-ui, sans-serif',
        fontSize: '44px',
        fontStyle: '700',
        stroke: '#193021',
        strokeThickness: 8,
      })
      .setDepth(20)
      .setOrigin(0.5)
      .setName('round-result');
    this.createActionButton(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 96, '무작위 진영으로 체스 시작', () => {
      this.startChess(null, Phaser.Math.Between(0, 1) === 0 ? 'white' : 'black');
    });
  }

  private createActionButton(x: number, y: number, label: string, onClick: () => void, fill = 0x34436d) {
    const button = this.add.container(x, y).setDepth(30).setName('chess-action');
    const background = this.add.rectangle(0, 0, 270, 54, fill, 1).setStrokeStyle(2, 0xcbd6ff).setInteractive({ useHandCursor: true });
    const text = this.add.text(0, 0, label, {
      color: '#f5f7ff',
      fontFamily: 'system-ui, sans-serif',
      fontSize: '17px',
      fontStyle: '700',
    }).setOrigin(0.5);
    background.on('pointerdown', onClick);
    background.on('pointerover', () => background.setFillStyle(0x52659c));
    background.on('pointerout', () => background.setFillStyle(fill));
    button.add([background, text]);
  }

  private showColorSelection(winner: PlayerColor) {
    this.colorSelectionWinner = winner;
    this.colorSelectionEndMs = Date.now() + COLOR_SELECTION_MS;
    this.add.text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 26, '체스에서 플레이할 진영을 선택하세요 · 10초 뒤 백으로 자동 시작', {
      color: '#d5ddff',
      fontFamily: 'system-ui, sans-serif',
      fontSize: '20px',
    }).setDepth(30).setOrigin(0.5).setName('chess-action');
    this.createActionButton(GAME_WIDTH / 2 - 148, GAME_HEIGHT / 2 + 44, '백으로 시작 · 5:30', () => this.startChess(winner, 'white'), 0x556487);
    this.createActionButton(GAME_WIDTH / 2 + 148, GAME_HEIGHT / 2 + 44, '흑으로 시작 · 5:30', () => this.startChess(winner, 'black'), 0x262b3a);
  }

  private isAiStackTurn() {
    return this.mode === 'single' && this.activePiece?.color === 'black';
  }

  private canControlActivePiece() {
    if (this.mode !== 'multiplayer') return !this.isAiStackTurn();
    const match = this.networkMatch;
    return match?.phase === 'stacking'
      && match.stacking !== null
      && !match.stacking.isDropping
      && match.stackingTurnPlayerId === matchSocket.getClientId();
  }

  private updateAiStackTurn() {
    if (Date.now() < this.aiActionAt) {
      return;
    }
    this.targetX = Phaser.Math.Between(PLATFORM_CENTER_X - 170, PLATFORM_CENTER_X + 170);
    this.activeAngle = Phaser.Math.FloatBetween(-0.16, 0.16);
    this.aiActionAt = Date.now() + Phaser.Math.Between(700, 1_300);
    this.time.delayedCall(420, () => {
      if (this.isAiStackTurn() && this.lastDropped === null) {
        this.dropActivePiece();
      }
    });
  }

  private updateColorSelectionTimer() {
    const winner = this.colorSelectionWinner;
    if (winner === null) return;
    const remaining = Math.max(0, this.colorSelectionEndMs - Date.now());
    this.timerText.setText(`진영 선택 ${(remaining / 1000).toFixed(1)}`).setColor('#ffdf8a');
    if (remaining === 0) {
      this.colorSelectionWinner = null;
      this.startChess(winner, 'white');
    }
  }

  private collectSurvivors(): SurvivorPiece[] {
    return this.pieces
      .filter((piece) => piece !== this.activePiece && piece.body.translation().y <= FALL_LINE_Y)
      .map(({ color, kind, settledOrder }) => ({ color, kind, settledOrder }));
  }

  private startChess(stackWinner: PlayerColor | null, winnerColor: PlayerColor) {
    this.colorSelectionWinner = null;
    this.scene.start('chess', {
      mode: this.mode,
      opponentRating: this.opponentRating,
      stackWinner,
      survivors: this.collectSurvivors(),
      winnerColor,
    });
  }

  private forfeitMatch() {
    if (this.gameEnded || this.mode !== 'multiplayer') return;
    this.gameEnded = true;
    this.activePiece = null;
    this.statusText.setText('기권을 서버에 전송했습니다…');
    this.timerText.setText('—').setColor('#ffcf7c');
    matchSocket.forfeitMatch();
  }

  private showNetworkSettlement(match: MatchState) {
    if (this.networkSettlementShown) return;
    this.networkSettlementShown = true;
    this.gameEnded = true;
    this.activePiece = null;

    const result = match.winnerPlayerId === matchSocket.getClientId() ? 'win' : 'loss';
    const settlement = settleProfile(result, this.opponentRating);
    const title = result === 'win' ? '승리' : '패배';
    const panel = this.add.container(GAME_WIDTH / 2, GAME_HEIGHT / 2).setDepth(80);
    panel.add(this.add.rectangle(0, 0, 520, 350, 0x161c2d, 0.98).setStrokeStyle(3, 0xd5ddff));
    panel.add(this.add.text(0, -106, `경기 결과 · ${title}`, {
      color: result === 'win' ? '#b8e6a5' : '#ff8d8d',
      fontFamily: 'system-ui, sans-serif', fontSize: '34px', fontStyle: '700',
    }).setOrigin(0.5));
    panel.add(this.add.text(0, -55, result === 'win' ? '상대가 기권했습니다' : '기권으로 경기가 종료되었습니다', {
      color: '#d5ddff', fontFamily: 'system-ui, sans-serif', fontSize: '17px', align: 'center',
    }).setOrigin(0.5));
    panel.add(this.add.text(0, -5, `레이팅  ${settlement.previousRating} → ${settlement.currentRating}  (${settlement.delta >= 0 ? '+' : ''}${settlement.delta})`, {
      color: settlement.delta > 0 ? '#b8e6a5' : '#ff8d8d',
      fontFamily: 'system-ui, sans-serif', fontSize: '22px', fontStyle: '700',
    }).setOrigin(0.5));
    const button = this.add.rectangle(0, 95, 250, 52, 0x40527f, 1).setStrokeStyle(2, 0xcbd6ff).setInteractive({ useHandCursor: true });
    const label = this.add.text(0, 95, '메인으로 돌아가기', {
      color: '#f5f7ff', fontFamily: 'system-ui, sans-serif', fontSize: '18px', fontStyle: '700',
    }).setOrigin(0.5);
    button.on('pointerdown', () => {
      matchSocket.leaveRoom();
      this.scene.start('menu');
    });
    panel.add([button, label]);
  }

  private resetRound() {
    this.children.getByName('round-result')?.destroy();
    this.children.getChildren()
      .filter((child) => child.name === 'chess-action')
      .forEach((child) => child.destroy());
    this.pieces.forEach((piece) => this.removePiece(piece));
    this.pieces = [];
    this.world?.free();
    this.world = new RAPIER.World({ x: 0, y: 400 });
    this.activePiece = null;
    this.activeAngle = 0;
    this.decks = {
      white: Phaser.Utils.Array.Shuffle([...STACK_DECK]),
      black: Phaser.Utils.Array.Shuffle([...STACK_DECK]),
    };
    this.gameEnded = false;
    this.pendingFallLoser = null;
    this.pendingFallRemainingMs = 0;
    this.colorSelectionWinner = null;
    this.colorSelectionEndMs = 0;
    this.aiActionAt = 0;
    this.lastDropped = null;
    this.lastDroppedBy = null;
    this.player = 'white';
    this.settleDuration = 0;
    this.settledPieceCount = 0;
    this.targetX = PLATFORM_CENTER_X;
    this.turnTimeRemaining = TURN_DURATION_MS;
    this.lastTimerTickMs = Date.now();
    this.turnCount = 0;
    this.createPlatform();
    if (this.mode === 'multiplayer') {
      this.statusText.setText('서버 쌓기 상태를 불러오는 중…');
      if (this.networkMatch !== null) this.applyNetworkPhysics(this.networkMatch);
      return;
    }
    this.spawnNextPiece();
  }

  private spawnNextPiece() {
    const kind = this.decks[this.player].shift();
    if (kind === undefined) {
      this.endPerfectRound();
      return;
    }

    this.activeAngle = 0;
    this.targetX = PLATFORM_CENTER_X;
    this.turnTimeRemaining = TURN_DURATION_MS;
    this.lastTimerTickMs = Date.now();
    this.activePiece = this.createPiece(kind, this.player);
    this.pieces.push(this.activePiece);
    this.turnCount += 1;
    this.playerText.setText(`${PLAYER_LABEL[this.player]}의 차례 · ${kind.toUpperCase()} · 남은 기물 ${this.decks[this.player].length}`);
    this.statusText.setText('위치를 정한 뒤 낙하하세요');
    this.timerText.setText('10.0').setColor('#f5f2e8');
  }

  private addPieceColliders(body: RigidBody, kind: PieceKind, width: number, height: number) {
    const addCuboid = (halfWidth: number, halfHeight: number, x: number, y: number) => {
      const collider = RAPIER.ColliderDesc.cuboid(halfWidth * SIDE_COLLIDER_SCALE, halfHeight)
        .setTranslation(x * SIDE_COLLIDER_SCALE, y)
        .setFriction(0.6)
        .setRestitution(0.234)
        .setDensity(0.72);
      this.world.createCollider(collider, body);
    };
    const addBall = (radius: number, x: number, y: number) => {
      const collider = RAPIER.ColliderDesc.ball(radius * 1.06)
        .setTranslation(x * SIDE_COLLIDER_SCALE, y)
        .setFriction(0.6)
        .setRestitution(0.252)
        .setDensity(0.72);
      this.world.createCollider(collider, body);
    };
    const addCapsule = (halfHeight: number, radius: number, x: number, y: number) => {
      const collider = RAPIER.ColliderDesc.capsule(halfHeight, radius * SIDE_COLLIDER_SCALE)
        .setTranslation(x * SIDE_COLLIDER_SCALE, y)
        .setFriction(0.6)
        .setRestitution(0.252)
        .setDensity(0.72);
      this.world.createCollider(collider, body);
    };
    const addConvex = (points: Array<[number, number]>) => {
      const expandedPoints = points.flatMap(([x, y]) => [x * SIDE_COLLIDER_SCALE, y]);
      const collider = RAPIER.ColliderDesc.convexHull(new Float32Array(expandedPoints));
      if (collider === null) {
        return;
      }

      collider.setFriction(0.6).setRestitution(0.252).setDensity(0.72);
      this.world.createCollider(collider, body);
    };

    // 받침대·기둥·상단을 분리한다. 하단은 두꺼운 중심부와 둥근 양 끝으로 구성한다.
    addCuboid(width * 0.42, height * 0.08, 0, height * 0.38);
    addBall(width * 0.12, -width * 0.3, height * 0.38);
    addBall(width * 0.12, width * 0.3, height * 0.38);

    switch (kind) {
      case 'pawn':
        addCapsule(height * 0.18, width * 0.14, 0, height * 0.08);
        addBall(width * 0.23, 0, -height * 0.31);
        break;
      case 'rook':
        addCuboid(width * 0.25, height * 0.26, 0, height * 0.06);
        addCuboid(width * 0.34, height * 0.1, 0, -height * 0.3);
        break;
      case 'knight':
        addCapsule(height * 0.22, width * 0.18, width * 0.04, height * 0.06);
        addConvex([
          [-width * 0.46, -height * 0.2],
          [-width * 0.27, -height * 0.39],
          [-width * 0.08, -height * 0.48],
          [width * 0.18, -height * 0.4],
          [width * 0.38, -height * 0.2],
          [width * 0.34, height * 0.04],
          [width * 0.06, height * 0.12],
          [-width * 0.22, height * 0.03],
        ]);
        break;
      case 'bishop':
        addCapsule(height * 0.2, width * 0.14, 0, height * 0.1);
        addBall(width * 0.18, 0, -height * 0.39);
        addConvex([
          [-width * 0.23, -height * 0.13],
          [-width * 0.15, -height * 0.35],
          [0, -height * 0.48],
          [width * 0.15, -height * 0.35],
          [width * 0.23, -height * 0.13],
          [width * 0.12, height * 0.06],
          [-width * 0.12, height * 0.06],
        ]);
        break;
      case 'queen':
        addCapsule(height * 0.21, width * 0.16, 0, height * 0.08);
        addBall(width * 0.16, 0, -height * 0.42);
        addConvex([
          [-width * 0.31, -height * 0.21],
          [-width * 0.2, -height * 0.38],
          [0, -height * 0.5],
          [width * 0.2, -height * 0.38],
          [width * 0.31, -height * 0.21],
          [width * 0.16, height * 0.05],
          [-width * 0.16, height * 0.05],
        ]);
        break;
    }
  }

  private applyNetworkPhysics(match: MatchState) {
    if (match.phase === 'chess') {
      this.startNetworkChess(match);
      return;
    }
    if (match.stacking === null) {
      this.gameEnded = match.phase === 'complete';
      return;
    }
    const snapshot = match.stacking;
    const serverIds = new Set(snapshot.pieces.map((piece) => piece.id));
    this.pieces.filter((piece) => piece.serverId !== undefined && !serverIds.has(piece.serverId)).forEach((piece) => this.removePiece(piece));

    for (const serverPiece of snapshot.pieces) {
      let piece = this.pieces.find((candidate) => candidate.serverId === serverPiece.id);
      if (piece === undefined) {
        piece = this.createPiece(serverPiece.kind, serverPiece.color);
        piece.serverId = serverPiece.id;
        this.pieces.push(piece);
        piece.body.setTranslation({ x: serverPiece.x, y: serverPiece.y }, true);
        piece.body.setRotation(serverPiece.angle, true);
      }
      piece.settledOrder = serverPiece.settledOrder;
      piece.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
      piece.serverTarget = { angle: serverPiece.angle, x: serverPiece.x, y: serverPiece.y };
    }

    if (snapshot.isDropping || snapshot.nextPiece === null) {
      if (this.activePiece !== null) {
        this.removePiece(this.activePiece);
        this.activePiece = null;
      }
    } else {
      const next = snapshot.nextPiece;
      if (this.activePiece === null || this.activePiece.kind !== next.kind || this.activePiece.color !== next.color) {
        if (this.activePiece !== null) this.removePiece(this.activePiece);
        this.activeAngle = 0;
        this.targetX = PLATFORM_CENTER_X;
        this.activePiece = this.createPiece(next.kind, next.color);
        this.pieces.push(this.activePiece);
      }
      this.player = next.color;
    }

    this.turnTimeRemaining = Math.max(0, snapshot.turnEndsAt - Date.now());
    this.playerText.setText(`${PLAYER_LABEL[this.player]}의 차례 · 서버 권위 물리`);
    if (match.phase === 'color_selection') {
      this.gameEnded = true;
      this.showNetworkColorSelection(match);
    } else {
      this.statusText.setText(this.canControlActivePiece() ? '위치를 정한 뒤 낙하하세요' : '상대 또는 서버 물리 시뮬레이션 진행 중…');
    }
    this.syncSprites();
  }

  private showNetworkColorSelection(match: MatchState) {
    if (this.networkColorSelectionShown || match.colorChoiceEndsAt === null) return;
    this.networkColorSelectionShown = true;
    const isWinner = match.colorSelectionWinnerId === matchSocket.getClientId();
    this.statusText.setText(isWinner ? '쌓기 승리 · 체스 진영을 선택하세요' : '상대가 체스 진영을 선택하는 중입니다');
    this.add.text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 26, isWinner
      ? '10초 안에 체스에서 플레이할 진영을 선택하세요'
      : '상대가 체스 진영을 선택 중입니다 · 미선택 시 백으로 시작', {
      color: '#d5ddff', fontFamily: 'system-ui, sans-serif', fontSize: '20px',
    }).setDepth(30).setOrigin(0.5).setName('chess-action');
    if (!isWinner) return;
    this.createActionButton(GAME_WIDTH / 2 - 148, GAME_HEIGHT / 2 + 44, '백으로 시작 · 5:30', () => matchSocket.selectChessColor('white'), 0x556487);
    this.createActionButton(GAME_WIDTH / 2 + 148, GAME_HEIGHT / 2 + 44, '흑으로 시작 · 5:30', () => matchSocket.selectChessColor('black'), 0x262b3a);
  }

  private startNetworkChess(match: MatchState) {
    if (this.networkChessStarted || match.fen === null) return;
    const room = matchSocket.getRoom();
    const stackWinner = room?.players.find((player) => player.id === match.winnerPlayerId)?.slot ?? 'white';
    const winnerColor: PlayerColor = match.whitePlayerId === match.winnerPlayerId ? 'white' : 'black';
    this.networkChessStarted = true;
    this.scene.start('chess', {
      fen: match.fen,
      localChessColor: match.whitePlayerId === matchSocket.getClientId() ? 'w' : 'b',
      mode: 'multiplayer',
      opponentRating: this.opponentRating,
      stackWinner,
      survivors: this.collectSurvivors(),
      winnerColor,
    });
  }

  private removePiece(piece: StackPiece) {
    piece.outline?.destroy();
    piece.sprite.destroy();
    this.world.removeRigidBody(piece.body);
    this.pieces = this.pieces.filter((candidate) => candidate !== piece);
  }

  private sourceTextureKey(kind: PieceKind, color: PlayerColor) {
    return `source-${kind}-${color}`;
  }

  private syncSprites() {
    for (const piece of this.pieces) {
      const position = piece.body.translation();
      piece.outline?.setPosition(position.x, position.y).setRotation(piece.body.rotation());
      piece.sprite.setPosition(position.x, position.y).setRotation(piece.body.rotation());
      piece.previousY = position.y;
    }
  }

  private textureKey(kind: PieceKind, color: PlayerColor) {
    return `piece-${kind}-${color}`;
  }

  private updateTurnTimer(_delta: number) {
    const now = Date.now();
    const elapsed = now - this.lastTimerTickMs;
    this.lastTimerTickMs = now;
    this.turnTimeRemaining = Math.max(0, this.turnTimeRemaining - elapsed);
    const seconds = this.turnTimeRemaining / 1000;
    this.timerText.setText(seconds.toFixed(1)).setColor(seconds <= 3 ? '#ff8d8d' : '#f5f2e8');

    if (this.turnTimeRemaining === 0) {
      this.dropActivePiece(true);
    }
  }

  private updateActivePiece(delta: number) {
    const activePiece = this.activePiece;
    if (activePiece === null) {
      return;
    }

    const keyboard = this.input.keyboard;
    const moveStep = (260 * delta) / 1000;
    const rotateStep = (2.4 * delta) / 1000;

    if (keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.LEFT).isDown) {
      this.targetX -= moveStep;
    }
    if (keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.RIGHT).isDown) {
      this.targetX += moveStep;
    }
    if (keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.Q).isDown) {
      this.activeAngle -= rotateStep;
    }
    if (keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.E).isDown) {
      this.activeAngle += rotateStep;
    }

    this.targetX = Phaser.Math.Clamp(this.targetX, PLATFORM_CENTER_X - 250, PLATFORM_CENTER_X + 250);
    if (this.mode === 'multiplayer') {
      activePiece.body.setTranslation({ x: this.targetX, y: SPAWN_Y }, true);
      activePiece.body.setRotation(this.activeAngle, true);
      this.syncSprites();
      return;
    }
    activePiece.body.setNextKinematicTranslation({ x: this.targetX, y: SPAWN_Y });
    activePiece.body.setNextKinematicRotation(this.activeAngle);
  }

  private updateNetworkStacking(delta: number) {
    const match = this.networkMatch;
    if (match === null || match === undefined || match.stacking === null) return;
    const blend = 1 - Math.exp((-delta * 14) / 1000);
    this.pieces.forEach((piece) => {
      if (piece.serverTarget === undefined) return;
      const current = piece.body.translation();
      const rotation = piece.body.rotation();
      piece.body.setTranslation({
        x: Phaser.Math.Linear(current.x, piece.serverTarget.x, blend),
        y: Phaser.Math.Linear(current.y, piece.serverTarget.y, blend),
      }, true);
      piece.body.setRotation(rotation + Phaser.Math.Angle.Wrap(piece.serverTarget.angle - rotation) * blend, true);
    });
    this.syncSprites();

    if (match.phase === 'color_selection' && match.colorChoiceEndsAt !== null) {
      const remaining = Math.max(0, match.colorChoiceEndsAt - Date.now());
      this.timerText.setText(`진영 선택 ${(remaining / 1000).toFixed(1)}`).setColor('#ffdf8a');
      return;
    }
    if (match.phase !== 'stacking') return;
    if (this.activePiece !== null && this.canControlActivePiece()) this.updateActivePiece(delta);
    const remaining = Math.max(0, match.stacking.turnEndsAt - Date.now());
    this.timerText.setText((remaining / 1000).toFixed(1)).setColor(remaining <= 3_000 ? '#ff8d8d' : '#f5f2e8');
  }
}

type ChessStartData = {
  fen?: string;
  localChessColor?: Color;
  mode: GameMode;
  opponentRating: number;
  stackWinner: PlayerColor | null;
  survivors: SurvivorPiece[];
  winnerColor: PlayerColor;
};

const CHESS_SYMBOLS: Record<Color, Record<PieceSymbol, string>> = {
  w: { p: '♙', n: '♘', b: '♗', r: '♖', q: '♕', k: '♔' },
  b: { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚' },
};

class ChessScene extends Phaser.Scene {
  private aiActionAt = 0;
  private board!: Phaser.GameObjects.Graphics;
  private capturedBy: Record<Color, PieceSymbol[]> = { w: [], b: [] };
  private capturedText!: Phaser.GameObjects.Text;
  private chess = new Chess();
  private clocks: Record<Color, number> = { w: CHESS_BASE_TIME_MS, b: CHESS_BASE_TIME_MS };
  private drawAcceptButton!: Phaser.GameObjects.Container;
  private drawOfferBy: Color | null = null;
  private gameOver = false;
  private historyText!: Phaser.GameObjects.Text;
  private lastClockTickMs = Date.now();
  private localChessColor: Color = 'w';
  private messageText!: Phaser.GameObjects.Text;
  private mode: GameMode = 'single';
  private moveText!: Phaser.GameObjects.Text;
  private opponentRating = 1200;
  private pendingPromotion: { from: Square; to: Square } | null = null;
  private pieceSprites: Phaser.GameObjects.Image[] = [];
  private promotionUi: Phaser.GameObjects.Container | null = null;
  private removeMatchListener: (() => void) | null = null;
  private selectedSquare: Square | null = null;
  private selectedTargets: Square[] = [];
  private stackWinner: PlayerColor | null = null;
  private survivorCounts: Record<PlayerColor, number> = { black: 0, white: 0 };
  private timerTexts!: Record<Color, Phaser.GameObjects.Text>;
  private whitePlayer: PlayerColor = 'white';
  private networkSettlementShown = false;

  constructor() {
    super('chess');
  }

  preload() {
    (['w', 'b'] as const).forEach((color) => {
      (['k', 'q', 'r', 'b', 'n', 'p'] as PieceSymbol[]).forEach((piece) => {
        const assetPiece = piece.toUpperCase();
        this.load.svg(this.svgTextureKey(color, piece), `/assets/chess-svg/${color}${assetPiece}.svg`, { width: 90, height: 90 });
      });
    });
  }

  init(data: ChessStartData) {
    this.mode = data.mode;
    this.opponentRating = data.opponentRating;
    this.stackWinner = data.stackWinner;
    this.whitePlayer = data.stackWinner === null
      ? data.winnerColor
      : (data.winnerColor === 'white' ? data.stackWinner : this.opponent(data.stackWinner));
    this.localChessColor = data.localChessColor ?? (this.whitePlayer === 'white' ? 'w' : 'b');
    const winnerSide: Color | null = data.stackWinner === null
      ? null
      : (data.winnerColor === 'white' ? 'w' : 'b');
    this.clocks = {
      w: CHESS_BASE_TIME_MS + (winnerSide === 'w' ? CHESS_WINNER_BONUS_MS : 0),
      b: CHESS_BASE_TIME_MS + (winnerSide === 'b' ? CHESS_WINNER_BONUS_MS : 0),
    };
    this.survivorCounts = {
      white: data.survivors.filter((piece) => piece.color === 'white').length,
      black: data.survivors.filter((piece) => piece.color === 'black').length,
    };
    this.chess = data.fen === undefined ? this.createChessFromSurvivors(data.survivors) : new Chess(data.fen);
    this.capturedBy = { w: [], b: [] };
    this.drawOfferBy = null;
    this.gameOver = false;
    this.lastClockTickMs = Date.now();
    this.aiActionAt = Date.now() + 650;
    this.selectedSquare = null;
    this.selectedTargets = [];
    this.pendingPromotion = null;
    this.networkSettlementShown = false;
  }

  create() {
    this.createUi();
    this.board = this.add.graphics().setDepth(1);
    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => this.handleBoardInput(pointer));
    this.input.keyboard?.on('keydown-R', () => this.scene.start('stacking'));
    if (this.mode === 'multiplayer') {
      this.removeMatchListener = matchSocket.onMatch((match) => this.applyNetworkChessState(match));
      const match = matchSocket.getMatch();
      if (match !== null) this.applyNetworkChessState(match);
      this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.removeMatchListener?.());
    }
    this.renderBoard();
  }

  update(_time: number, _delta: number) {
    if (this.gameOver) {
      return;
    }

    const now = Date.now();
    const elapsed = now - this.lastClockTickMs;
    this.lastClockTickMs = now;
    const turn = this.chess.turn();
    this.clocks[turn] = Math.max(0, this.clocks[turn] - elapsed);
    this.updateClocks();
    if (this.clocks[turn] === 0) {
      const winner = turn === 'w' ? 'b' : 'w';
      if (this.mode === 'multiplayer') {
        this.gameOver = true;
        this.messageText.setText('시간 초과를 서버에 확인 중…').setColor('#ffcf7c');
        matchSocket.forfeitChess('timeout');
        return;
      }
      this.finishGame(`${this.playerForColor(winner)} 승리 · 시간 초과`, winner);
      return;
    }
    if (this.isAiChessTurn() && now >= this.aiActionAt) {
      const moves = this.chess.moves({ verbose: true });
      const captures = moves.filter((move) => move.captured !== undefined);
      const move = Phaser.Utils.Array.GetRandom(captures.length > 0 ? captures : moves);
      this.aiActionAt = now + Phaser.Math.Between(650, 1_100);
      this.completeMove(move.from, move.to, move.promotion);
    }
  }

  private boardPosition(square: Square) {
    const file = square.charCodeAt(0) - 97;
    const rank = Number(square[1]);
    return { file, rank, x: 280 + file * 75 + 37.5, y: 126 + (8 - rank) * 75 + 37.5 };
  }

  private applyNetworkChessState(match: MatchState) {
    if (match.phase === 'chess' && match.fen !== null && this.chess.fen() !== match.fen) {
      this.chess = new Chess(match.fen);
      this.selectedSquare = null;
      this.selectedTargets = [];
      this.pendingPromotion = null;
      this.lastClockTickMs = Date.now();
      this.renderBoard();
      return;
    }
    if (match.phase !== 'complete' || this.networkSettlementShown) return;
    this.networkSettlementShown = true;
    const winner: Color | null = match.winnerPlayerId === null
      ? null
      : match.winnerPlayerId === match.whitePlayerId ? 'w' : 'b';
    const reason = {
      checkmate: '체크메이트',
      draw: '무승부',
      resign: '기권',
      timeout: '시간 초과',
    }[match.completionReason ?? 'draw'];
    const message = winner === null ? reason : `${this.playerForColor(winner)} 승리 · ${reason}`;
    this.finishGame(message, winner);
  }

  private createChessFromSurvivors(survivors: SurvivorPiece[]) {
    const board = new Map<Square, { color: Color; type: PieceSymbol }>();
    board.set('e1', { color: 'w', type: 'k' });
    board.set('e8', { color: 'b', type: 'k' });

    const pawnFiles = ['d', 'e', 'c', 'f', 'b', 'g', 'a', 'h'];
    (['w', 'b'] as const).forEach((color) => {
      const player = color === 'w' ? this.whitePlayer : this.opponent(this.whitePlayer);
      const playerSurvivors = survivors.filter((piece) => piece.color === player);
      const rank = color === 'w' ? '1' : '8';
      const pawnRank = color === 'w' ? '2' : '7';
      const specialFiles: Record<PieceKind, string[]> = color === 'w'
        ? { rook: ['a', 'h'], knight: ['b', 'g'], bishop: ['c', 'f'], queen: ['d'], pawn: [] }
        : { rook: ['h', 'a'], knight: ['g', 'b'], bishop: ['f', 'c'], queen: ['d'], pawn: [] };
      const pawns = playerSurvivors.filter((piece) => piece.kind === 'pawn');

      pawns.slice(0, pawnFiles.length).forEach((_, index) => {
        board.set(`${pawnFiles[index]}${pawnRank}` as Square, { color, type: 'p' });
      });
      (['rook', 'knight', 'bishop', 'queen'] as const).forEach((kind) => {
        playerSurvivors.filter((piece) => piece.kind === kind).sort((a, b) => a.settledOrder - b.settledOrder).slice(0, specialFiles[kind].length).forEach((piece, index) => {
          board.set(`${specialFiles[kind][index]}${rank}` as Square, { color, type: CHESS_PIECE_TYPE[piece.kind] });
        });
      });
    });

    const rankFen = (rank: number) => {
      let emptyCount = 0;
      let fen = '';
      for (const file of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
        const piece = board.get(`${file}${rank}` as Square);
        if (piece === undefined) {
          emptyCount += 1;
          continue;
        }
        if (emptyCount > 0) {
          fen += emptyCount.toString();
          emptyCount = 0;
        }
        fen += piece.color === 'w' ? piece.type.toUpperCase() : piece.type;
      }
      return `${fen}${emptyCount > 0 ? emptyCount.toString() : ''}`;
    };

    const hasRook = (square: Square, color: Color) => {
      const piece = board.get(square);
      return piece?.color === color && piece.type === 'r';
    };
    const castling = [
      hasRook('h1', 'w') ? 'K' : '',
      hasRook('a1', 'w') ? 'Q' : '',
      hasRook('h8', 'b') ? 'k' : '',
      hasRook('a8', 'b') ? 'q' : '',
    ].join('') || '-';
    const fen = `${[8, 7, 6, 5, 4, 3, 2, 1].map(rankFen).join('/')} w ${castling} - 0 1`;
    return new Chess(fen);
  }

  private createUi() {
    this.add.text(40, 28, 'STACKMATE · 체스 단계', {
      color: '#f5f2e8', fontFamily: 'system-ui, sans-serif', fontSize: '26px', fontStyle: '700',
    });
    const bonusText = this.stackWinner === null
      ? '쌓기 무승부 · 시간 보너스 없음'
      : `${PLAYER_LABEL[this.stackWinner]} 쌓기 승리 · 선택 진영에 +30초`;
    this.add.text(40, 68, bonusText, {
      color: '#b9c4dd', fontFamily: 'system-ui, sans-serif', fontSize: '15px',
    });
    this.add.text(40, 91, `생존 기물 · 플레이어 1: ${this.survivorCounts.white}개 / 플레이어 2: ${this.survivorCounts.black}개`, {
      color: '#8fa2cf', fontFamily: 'system-ui, sans-serif', fontSize: '14px',
    });
    this.messageText = this.add.text(GAME_WIDTH / 2, 62, '', {
      color: '#f5f2e8', fontFamily: 'system-ui, sans-serif', fontSize: '21px', fontStyle: '700', align: 'center',
    }).setOrigin(0.5);
    this.moveText = this.add.text(GAME_WIDTH / 2, 804, '기물을 선택한 뒤 이동할 칸을 선택하세요 · R: 쌓기 단계로', {
      color: '#b9c4dd', fontFamily: 'system-ui, sans-serif', fontSize: '15px', align: 'center',
    }).setOrigin(0.5);

    const createClock = (color: Color, x: number, label: string) => {
      this.add.text(x, 190, label, {
        color: color === 'w' ? '#f5f2e8' : '#b9c4dd', fontFamily: 'system-ui, sans-serif', fontSize: '18px', fontStyle: '700', align: 'center',
      }).setOrigin(0.5);
      return this.add.text(x, 224, '', {
        color: '#f5f2e8', fontFamily: 'monospace', fontSize: '34px', fontStyle: '700', align: 'center',
      }).setOrigin(0.5);
    };
    this.timerTexts = {
      w: createClock('w', 135, `${this.playerForColor('w')} · 백`),
      b: createClock('b', 1025, `${this.playerForColor('b')} · 흑`),
    };
    this.createControlButton(135, 320, '무승부 제안', () => this.offerDraw());
    this.createControlButton(135, 380, '기권하고 나가기', () => this.resign());
    this.drawAcceptButton = this.createControlButton(1025, 320, '무승부 수락', () => this.acceptDraw(), 0x4d785d);
    this.drawAcceptButton.setVisible(false);
    this.add.text(930, 380, '기보', {
      color: '#d5ddff', fontFamily: 'system-ui, sans-serif', fontSize: '17px', fontStyle: '700',
    }).setOrigin(0.5);
    this.historyText = this.add.text(930, 408, '아직 수가 없습니다', {
      color: '#b9c4dd', fontFamily: 'monospace', fontSize: '14px', align: 'center', wordWrap: { width: 200 },
    }).setOrigin(0.5, 0);
    this.add.text(930, 610, '잡은 기물', {
      color: '#d5ddff', fontFamily: 'system-ui, sans-serif', fontSize: '17px', fontStyle: '700',
    }).setOrigin(0.5);
    this.capturedText = this.add.text(930, 636, '', {
      color: '#f5f2e8', fontFamily: 'Georgia, serif', fontSize: '27px', align: 'center', wordWrap: { width: 200 },
    }).setOrigin(0.5, 0);
    this.updateClocks();
  }

  private createControlButton(x: number, y: number, label: string, onClick: () => void, fill = 0x34436d) {
    const button = this.add.container(x, y).setDepth(20);
    const background = this.add.rectangle(0, 0, 190, 46, fill, 1).setStrokeStyle(1, 0xcbd6ff).setInteractive({ useHandCursor: true });
    const text = this.add.text(0, 0, label, {
      color: '#f5f7ff', fontFamily: 'system-ui, sans-serif', fontSize: '16px', fontStyle: '700',
    }).setOrigin(0.5);
    background.on('pointerdown', onClick);
    background.on('pointerover', () => background.setFillStyle(0x52659c));
    background.on('pointerout', () => background.setFillStyle(fill));
    button.add([background, text]);
    return button;
  }

  private finishGame(message: string, winner: Color | null = null) {
    this.gameOver = true;
    this.selectedSquare = null;
    this.selectedTargets = [];
    this.pendingPromotion = null;
    this.promotionUi?.destroy();
    this.promotionUi = null;
    this.drawAcceptButton?.setVisible(false);
    this.messageText.setText(message).setColor('#ffcf7c');
    this.moveText.setText('게임 종료 · 정산을 확인하세요');
    this.renderBoard();
    this.showSettlement(winner, message);
  }

  private handleBoardInput(pointer: Phaser.Input.Pointer) {
    if (this.gameOver || this.pendingPromotion !== null || this.isAiChessTurn()) {
      return;
    }
    const file = Math.floor((pointer.x - 280) / 75);
    const rank = 8 - Math.floor((pointer.y - 126) / 75);
    if (file < 0 || file > 7 || rank < 1 || rank > 8) {
      return;
    }
    const square = `${String.fromCharCode(97 + file)}${rank}` as Square;
    const current = this.chess.get(square);
    const turn = this.chess.turn();

    if (this.mode === 'multiplayer' && turn !== this.localChessColor) {
      return;
    }

    if (this.selectedSquare === null) {
      if (current?.color === turn) {
        this.selectSquare(square);
      }
      return;
    }

    if (current?.color === turn) {
      this.selectSquare(square);
      return;
    }

    if (!this.selectedTargets.includes(square)) {
      this.selectedSquare = null;
      this.selectedTargets = [];
      this.renderBoard();
      return;
    }

    const selectedPiece = this.chess.get(this.selectedSquare);
    const isPromotion = selectedPiece?.type === 'p' && (square.endsWith('1') || square.endsWith('8'));
    if (isPromotion) {
      this.pendingPromotion = { from: this.selectedSquare, to: square };
      this.showPromotionChoices();
      return;
    }

    this.completeMove(this.selectedSquare, square);
  }

  private completeMove(from: Square, to: Square, promotion?: PieceSymbol) {
    if (this.mode === 'multiplayer') {
      const match = matchSocket.getMatch();
      if (match === null || match.phase !== 'chess') return;
      const networkPromotion = promotion === 'b' || promotion === 'n' || promotion === 'q' || promotion === 'r' ? promotion : undefined;
      matchSocket.submitChessMove(from, to, networkPromotion, match.revision);
      this.selectedSquare = null;
      this.selectedTargets = [];
      this.messageText.setText('서버가 수를 검증 중입니다…').setColor('#b9c4dd');
      this.renderBoard();
      return;
    }
    const turn = this.chess.turn();
    const move = this.chess.move({ from, to, promotion });
    if (move === null) {
      return;
    }
    if (move.captured !== undefined) {
      this.capturedBy[turn].push(move.captured);
    }
    this.clocks[turn] += CHESS_INCREMENT_MS;
    this.lastClockTickMs = Date.now();
    if (this.drawOfferBy !== null && this.drawOfferBy !== turn) {
      this.drawOfferBy = null;
    }
    this.selectedSquare = null;
    this.selectedTargets = [];
    this.renderBoard();
    if (this.chess.isCheckmate()) {
      this.finishGame(`${this.playerForColor(turn)} 승리 · 체크메이트`, turn);
    } else if (this.chess.isDraw()) {
      this.finishGame('무승부');
    }
  }

  private showPromotionChoices() {
    this.promotionUi?.destroy();
    const ui = this.add.container(GAME_WIDTH / 2, 757).setDepth(40);
    const panel = this.add.rectangle(0, 0, 470, 66, 0x161c2d, 0.97).setStrokeStyle(2, 0xd5ddff);
    const label = this.add.text(-210, 0, '승격:', {
      color: '#f5f2e8', fontFamily: 'system-ui, sans-serif', fontSize: '17px', fontStyle: '700',
    }).setOrigin(0, 0.5);
    ui.add([panel, label]);
    (['q', 'r', 'b', 'n'] as PieceSymbol[]).forEach((piece, index) => {
      const x = -105 + index * 72;
      const button = this.add.rectangle(x, 0, 56, 48, 0x40527f, 1).setStrokeStyle(1, 0xcbd6ff).setInteractive({ useHandCursor: true });
      const symbol = this.add.text(x, 2, CHESS_SYMBOLS[this.chess.turn()][piece], {
        color: this.chess.turn() === 'w' ? '#fffaf0' : '#141724', fontFamily: 'Georgia, serif', fontSize: '34px',
      }).setOrigin(0.5);
      button.on('pointerdown', () => {
        const pending = this.pendingPromotion;
        if (pending === null) {
          return;
        }
        this.pendingPromotion = null;
        ui.destroy();
        this.promotionUi = null;
        this.completeMove(pending.from, pending.to, piece);
      });
      ui.add([button, symbol]);
    });
    this.promotionUi = ui;
    this.messageText.setText('승격할 기물을 선택하세요').setColor('#ffdf8a');
  }

  private offerDraw() {
    if (this.gameOver || this.drawOfferBy !== null) {
      return;
    }
    this.drawOfferBy = this.chess.turn();
    this.messageText.setText('무승부를 제안했습니다 · 수를 진행하세요').setColor('#ffdf8a');
  }

  private acceptDraw() {
    if (this.gameOver || this.drawOfferBy === null || this.drawOfferBy === this.chess.turn()) {
      return;
    }
    this.finishGame('합의 무승부');
  }

  private resign() {
    if (this.gameOver) {
      return;
    }
    if (this.mode === 'multiplayer') {
      this.gameOver = true;
      this.messageText.setText('기권을 서버에 전송했습니다…').setColor('#ffcf7c');
      matchSocket.forfeitMatch();
      return;
    }
    const winner = this.chess.turn() === 'w' ? 'b' : 'w';
    this.finishGame(`${this.playerForColor(winner)} 승리 · 기권`, winner);
  }

  private humanChessColor(): Color {
    return this.localChessColor;
  }

  private isAiChessTurn() {
    return this.mode === 'single' && this.chess.turn() !== this.humanChessColor();
  }

  private showSettlement(winner: Color | null, reason: string) {
    const humanColor = this.humanChessColor();
    const result = winner === null ? 'draw' : winner === humanColor ? 'win' : 'loss';
    const settlement = this.mode === 'multiplayer'
      ? settleProfile(result, this.opponentRating)
      : { currentRating: 0, delta: 0, previousRating: 0 };
    const title = result === 'win' ? '승리' : result === 'loss' ? '패배' : '무승부';
    const panel = this.add.container(GAME_WIDTH / 2, GAME_HEIGHT / 2).setDepth(80).setName('settlement');
    panel.add(this.add.rectangle(0, 0, 520, 350, 0x161c2d, 0.98).setStrokeStyle(3, 0xd5ddff));
    panel.add(this.add.text(0, -118, `경기 결과 · ${title}`, {
      color: result === 'win' ? '#b8e6a5' : result === 'loss' ? '#ff8d8d' : '#ffdf8a',
      fontFamily: 'system-ui, sans-serif', fontSize: '34px', fontStyle: '700',
    }).setOrigin(0.5));
    panel.add(this.add.text(0, -65, reason, {
      color: '#d5ddff', fontFamily: 'system-ui, sans-serif', fontSize: '17px', align: 'center',
    }).setOrigin(0.5));
    const ratingText = this.mode === 'multiplayer'
      ? `레이팅  ${settlement.previousRating} → ${settlement.currentRating}  (${settlement.delta >= 0 ? '+' : ''}${settlement.delta})`
      : 'AI 대전 · 레이팅 미반영';
    panel.add(this.add.text(0, -10, ratingText, {
      color: settlement.delta > 0 ? '#b8e6a5' : settlement.delta < 0 ? '#ff8d8d' : '#ffdf8a',
      fontFamily: 'system-ui, sans-serif', fontSize: '22px', fontStyle: '700',
    }).setOrigin(0.5));
    const button = this.add.rectangle(0, 95, 250, 52, 0x40527f, 1).setStrokeStyle(2, 0xcbd6ff).setInteractive({ useHandCursor: true });
    const label = this.add.text(0, 95, '메인으로 돌아가기', {
      color: '#f5f7ff', fontFamily: 'system-ui, sans-serif', fontSize: '18px', fontStyle: '700',
    }).setOrigin(0.5);
    button.on('pointerdown', () => {
      if (this.mode === 'multiplayer') matchSocket.leaveRoom();
      this.scene.start('menu');
    });
    panel.add([button, label]);
  }

  private opponent(color: PlayerColor) {
    return color === 'white' ? 'black' : 'white';
  }

  private playerForColor(color: Color): string {
    const player = color === 'w' ? this.whitePlayer : this.opponent(this.whitePlayer);
    return player === 'white' ? '플레이어 1' : '플레이어 2';
  }

  private renderBoard() {
    const originX = 280;
    const originY = 126;
    const cell = 75;
    const checkedSquare = this.chess.isCheck() ? this.findKingSquare(this.chess.turn()) : null;
    this.board.clear();
    for (let rank = 0; rank < 8; rank += 1) {
      for (let file = 0; file < 8; file += 1) {
        const square = `${String.fromCharCode(97 + file)}${8 - rank}` as Square;
        const isLight = (file + rank) % 2 === 0;
        this.board.fillStyle(isLight ? 0xe0c49a : 0x7d563c, 1);
        this.board.fillRect(originX + file * cell, originY + rank * cell, cell, cell);
        if (square === checkedSquare) {
          this.board.fillStyle(0xe85a67, 0.64);
          this.board.fillRect(originX + file * cell, originY + rank * cell, cell, cell);
        }
        if (square === this.selectedSquare) {
          this.board.fillStyle(0xf8dc60, 0.6);
          this.board.fillRect(originX + file * cell, originY + rank * cell, cell, cell);
        } else if (this.selectedTargets.includes(square)) {
          this.board.fillStyle(0x79c48e, 0.55);
          this.board.fillCircle(originX + file * cell + cell / 2, originY + rank * cell + cell / 2, 13);
        }
      }
    }
    this.board.lineStyle(3, 0xd5ddff, 0.85).strokeRect(originX, originY, cell * 8, cell * 8);
    this.pieceSprites.forEach((piece) => piece.destroy());
    this.pieceSprites = [];
    for (const rank of [1, 2, 3, 4, 5, 6, 7, 8]) {
      for (const file of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
        const square = `${file}${rank}` as Square;
        const piece = this.chess.get(square);
        if (piece === undefined) {
          continue;
        }
        const position = this.boardPosition(square);
        const sprite = this.add
          .image(position.x, position.y, this.svgTextureKey(piece.color, piece.type))
          .setDisplaySize(66, 66)
          .setDepth(5);
        this.pieceSprites.push(sprite);
      }
    }
    const turnLabel = this.chess.turn() === 'w' ? '백' : '흑';
    if (!this.gameOver && this.pendingPromotion === null) {
      const drawText = this.drawOfferBy === null
        ? ''
        : (this.drawOfferBy === this.chess.turn() ? ' · 무승부 제안 후 수를 진행하세요' : ' · 상대 무승부 제안');
      this.messageText
        .setText(`${this.playerForColor(this.chess.turn())}의 차례 · ${turnLabel}${this.chess.isCheck() ? ' · 체크!' : ''}${drawText}`)
        .setColor(this.chess.isCheck() ? '#ff8d8d' : '#f5f2e8');
    }
    this.updateMovePanels();
    this.updateClocks();
  }

  private findKingSquare(color: Color): Square | null {
    for (const rank of [1, 2, 3, 4, 5, 6, 7, 8]) {
      for (const file of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
        const square = `${file}${rank}` as Square;
        const piece = this.chess.get(square);
        if (piece?.color === color && piece.type === 'k') {
          return square;
        }
      }
    }
    return null;
  }

  private updateMovePanels() {
    const history = this.chess.history();
    this.historyText?.setText(history.length === 0 ? '아직 수가 없습니다' : history.map((move, index) => (
      index % 2 === 0 ? `${Math.floor(index / 2) + 1}. ${move}` : move
    )).join(' '));
    const whiteCaptures = this.capturedBy.w.map((piece) => CHESS_SYMBOLS.b[piece]).join(' ');
    const blackCaptures = this.capturedBy.b.map((piece) => CHESS_SYMBOLS.w[piece]).join(' ');
    this.capturedText?.setText(`백: ${whiteCaptures || '—'}\n흑: ${blackCaptures || '—'}`);
    const canAcceptDraw = !this.gameOver && this.drawOfferBy !== null && this.drawOfferBy !== this.chess.turn();
    this.drawAcceptButton?.setVisible(canAcceptDraw);
  }

  private selectSquare(square: Square) {
    this.selectedSquare = square;
    this.selectedTargets = this.chess.moves({ square, verbose: true }).map((move) => move.to);
    this.renderBoard();
  }

  private svgTextureKey(color: Color, piece: PieceSymbol) {
    return `board-piece-${color}-${piece}`;
  }

  private updateClocks() {
    (['w', 'b'] as const).forEach((color) => {
      const totalSeconds = Math.ceil(this.clocks[color] / 1000);
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      const active = !this.gameOver && this.chess.turn() === color;
      this.timerTexts[color]?.setText(`${minutes}:${seconds.toString().padStart(2, '0')}`).setColor(active ? '#ffdf8a' : '#f5f2e8');
    });
  }
}

async function start() {
  await RAPIER.init();

  new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'app',
    backgroundColor: '#10131c',
    width: GAME_WIDTH,
    height: GAME_HEIGHT,
    scene: [MenuScene, StackingScene, ChessScene],
    scale: {
      // Display size is controlled by CSS. FIT mutates the canvas size during
      // window resizes, which can leave it stuck at a previously shrunken size.
      mode: Phaser.Scale.NONE,
    },
  });
}

void start();
