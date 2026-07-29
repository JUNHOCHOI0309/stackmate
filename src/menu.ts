import Phaser from 'phaser';
import { matchSocket, type RoomState } from './network';
import { loadProfile, type GameMode } from './profile';

const GAME_WIDTH = 1160;
const GAME_HEIGHT = 840;

type MatchStartData = {
  mode: GameMode;
  opponentRating?: number;
};

export class MenuScene extends Phaser.Scene {
  private inviteButton: Phaser.GameObjects.Container | null = null;
  private roomText!: Phaser.GameObjects.Text;
  private startingGame = false;
  private statusText!: Phaser.GameObjects.Text;

  constructor() {
    super('menu');
  }

  create() {
    const profile = loadProfile();
    this.add.rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0x10131c);
    this.add.text(GAME_WIDTH / 2, 126, 'STACKMATE', {
      color: '#f5f2e8', fontFamily: 'system-ui, sans-serif', fontSize: '68px', fontStyle: '700', letterSpacing: 5,
    }).setOrigin(0.5);
    this.add.text(GAME_WIDTH / 2, 202, '물리 쌓기 × 체스 전략', {
      color: '#b9c4dd', fontFamily: 'system-ui, sans-serif', fontSize: '22px',
    }).setOrigin(0.5);
    this.add.text(58, 54, `레이팅 ${profile.rating}  ·  ${profile.wins}승 ${profile.losses}패 ${profile.draws}무`, {
      color: '#d5ddff', fontFamily: 'system-ui, sans-serif', fontSize: '18px', fontStyle: '700',
    });

    this.createButton(GAME_WIDTH / 2, 320, '싱글플레이 · AI 대전', 0x53699d, () => this.startGame({ mode: 'single' }));
    this.createButton(GAME_WIDTH / 2, 398, `빠른 매칭 · 레이팅 ${profile.rating}`, 0x356052, () => matchSocket.joinMatchmaking(profile.rating));
    this.createButton(GAME_WIDTH / 2 - 146, 476, '1:1 방 만들기', 0x34436d, () => matchSocket.createPrivateRoom(), 260);
    this.createButton(GAME_WIDTH / 2 + 146, 476, '방 코드로 참가', 0x34436d, () => this.joinByCode(), 260);

    this.statusText = this.add.text(GAME_WIDTH / 2, 585, 'WebSocket 연결 중…', {
      color: '#b9c4dd', fontFamily: 'system-ui, sans-serif', fontSize: '18px', align: 'center',
    }).setOrigin(0.5);
    this.roomText = this.add.text(GAME_WIDTH / 2, 624, '', {
      color: '#ffdf8a', fontFamily: 'monospace', fontSize: '20px', align: 'center',
    }).setOrigin(0.5);
    this.add.text(GAME_WIDTH / 2, 748, '쌓기 승자는 10초 안에 체스 진영을 선택합니다 · 미선택 시 백', {
      color: '#8fa2cf', fontFamily: 'system-ui, sans-serif', fontSize: '15px',
    }).setOrigin(0.5);

    const removeStatusListener = matchSocket.onStatus((status) => this.statusText?.setText(status));
    const removeRoomListener = matchSocket.onRoom((room) => this.handleRoom(room));
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      removeStatusListener();
      removeRoomListener();
    });
    matchSocket.connect();
    const invitedRoom = new URLSearchParams(location.search).get('room');
    if (invitedRoom !== null) {
      matchSocket.joinPrivateRoom(invitedRoom);
    }
  }

  private createButton(x: number, y: number, label: string, fill: number, onClick: () => void, width = 560) {
    const background = this.add.rectangle(x, y, width, 58, fill, 1).setStrokeStyle(2, 0xcbd6ff).setInteractive({ useHandCursor: true });
    const text = this.add.text(x, y, label, {
      color: '#f5f7ff', fontFamily: 'system-ui, sans-serif', fontSize: '19px', fontStyle: '700',
    }).setOrigin(0.5);
    background.on('pointerdown', onClick);
    background.on('pointerover', () => background.setFillStyle(0x5e76ad));
    background.on('pointerout', () => background.setFillStyle(fill));
    return [background, text];
  }

  private handleRoom(room: RoomState) {
    const type = room.mode === 'match' ? '빠른 매칭' : '비공개 방';
    this.roomText.setText(`${type} 코드: ${room.roomId}${room.ready ? ' · 매치 시작' : ' · 상대를 기다리는 중'}`);
    if (room.mode === 'private' && this.inviteButton === null) {
      this.inviteButton = this.createInviteButton(room.roomId);
    }
    if (room.ready && !this.startingGame) {
      this.startingGame = true;
      this.time.delayedCall(650, () => this.startGame({ mode: 'multiplayer', opponentRating: room.opponentRating }));
    }
  }

  private joinByCode() {
    const roomId = window.prompt('참가할 방 코드를 입력하세요');
    if (roomId !== null && roomId.trim() !== '') {
      matchSocket.joinPrivateRoom(roomId);
    }
  }

  private createInviteButton(roomId: string) {
    const button = this.add.container(GAME_WIDTH / 2, 678);
    const background = this.add.rectangle(0, 0, 300, 46, 0x34436d, 1)
      .setStrokeStyle(2, 0xcbd6ff)
      .setInteractive({ useHandCursor: true });
    const text = this.add.text(0, 0, '초대 링크 복사', {
      color: '#f5f7ff', fontFamily: 'system-ui, sans-serif', fontSize: '16px', fontStyle: '700',
    }).setOrigin(0.5);
    background.on('pointerdown', async () => {
      const inviteUrl = new URL(location.href);
      inviteUrl.searchParams.set('room', roomId);
      try {
        await navigator.clipboard.writeText(inviteUrl.toString());
        this.statusText.setText('초대 링크를 복사했습니다. 친구에게 보내세요.');
      } catch {
        window.prompt('아래 초대 링크를 친구에게 보내세요.', inviteUrl.toString());
      }
    });
    background.on('pointerover', () => background.setFillStyle(0x5e76ad));
    background.on('pointerout', () => background.setFillStyle(0x34436d));
    button.add([background, text]);
    return button;
  }

  private startGame(data: MatchStartData) {
    this.scene.start('stacking', data);
  }
}
