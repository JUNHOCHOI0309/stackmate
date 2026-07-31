import Phaser from 'phaser';
import { type GameMode, loadProfile, type PlayerProfile } from './profile';

const GAME_WIDTH = 1160;
const GAME_HEIGHT = 840;
const PAWN_CROP = { height: 513, left: 612, top: 228, width: 313 };
const AI_PROFILE: PlayerProfile = { draws: 2, losses: 8, rating: 1200, wins: 12 };

export type MatchupStartData = {
  mode: GameMode;
  opponentProfile?: PlayerProfile;
  opponentRating?: number;
};

function gradientBadgeSvg(id: string, colors: [string, string, string]) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220" viewBox="0 0 220 220">
    <defs>
      <linearGradient id="gradient-${id}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${colors[0]}"/><stop offset="0.5" stop-color="${colors[1]}"/><stop offset="1" stop-color="${colors[2]}"/>
      </linearGradient>
      <filter id="noise-${id}" x="-20%" y="-20%" width="140%" height="140%">
        <feTurbulence type="fractalNoise" baseFrequency="0.025" numOctaves="3" seed="8" result="noise"/>
        <feColorMatrix in="noise" type="saturate" values="1.8" result="colored-noise"/>
        <feBlend in="SourceGraphic" in2="colored-noise" mode="screen"/>
      </filter>
      <clipPath id="clip-${id}"><circle cx="110" cy="110" r="98"/></clipPath>
    </defs>
    <g clip-path="url(#clip-${id})">
      <rect width="220" height="220" fill="url(#gradient-${id})"/>
      <rect x="-25" y="-25" width="270" height="270" fill="url(#gradient-${id})" filter="url(#noise-${id})" opacity="0.72"/>
      <path d="M-10 174C54 108 112 226 234 54" fill="none" stroke="#fff" stroke-width="20" opacity="0.24"/>
      <circle cx="45" cy="48" r="38" fill="#fff" opacity="0.2"/>
    </g>
    <circle cx="110" cy="110" r="99" fill="none" stroke="#f5f7ff" stroke-width="5" opacity="0.86"/>
  </svg>`;
}

export class MatchupScene extends Phaser.Scene {
  private matchData!: MatchupStartData;
  private countdownText!: Phaser.GameObjects.Text;
  private remainingSeconds = 3;
  private started = false;

  constructor() {
    super('matchup');
  }

  init(data: MatchupStartData) {
    this.matchData = data;
    this.remainingSeconds = 3;
    this.started = false;
  }

  preload() {
    if (!this.textures.exists('matchup-pawn-white-source')) this.load.image('matchup-pawn-white-source', '/assets/pawn_white.png');
    if (!this.textures.exists('matchup-badge-pink')) this.load.svg('matchup-badge-pink', `data:image/svg+xml;utf8,${encodeURIComponent(gradientBadgeSvg('pink', ['#ff6bb5', '#8e58ff', '#55e7ff']))}`);
    if (!this.textures.exists('matchup-badge-lime')) this.load.svg('matchup-badge-lime', `data:image/svg+xml;utf8,${encodeURIComponent(gradientBadgeSvg('lime', ['#52e7bb', '#d4ff5a', '#ffbb64']))}`);
  }

  create() {
    this.createPawnTextures();
    this.add.rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0x10131c);
    this.add.text(GAME_WIDTH / 2, 58, 'STACKMATE · MATCHUP', {
      color: '#f5f2e8', fontFamily: 'system-ui, sans-serif', fontSize: '27px', fontStyle: '700', letterSpacing: 2,
    }).setOrigin(0.5);
    this.add.text(GAME_WIDTH / 2, 94, this.matchData.mode === 'multiplayer' ? '상대와 전적을 확인하고 탑 쌓기를 시작합니다' : 'AI와의 대결을 시작합니다', {
      color: '#b9c4dd', fontFamily: 'system-ui, sans-serif', fontSize: '16px',
    }).setOrigin(0.5);

    const localProfile = loadProfile();
    const opponentProfile = this.matchData.mode === 'single'
      ? AI_PROFILE
      : this.matchData.opponentProfile ?? null;
    const opponentCard = this.createProfileCard({
      accent: 0xee5aa7,
      badge: 'matchup-badge-pink',
      color: 'black',
      label: this.matchData.mode === 'single' ? 'STACKMATE AI' : '상대 플레이어',
      profile: opponentProfile,
      x: -520,
      y: 255,
    });
    const localCard = this.createProfileCard({
      accent: 0x58cfa9,
      badge: 'matchup-badge-lime',
      color: 'white',
      label: '나',
      profile: localProfile,
      x: GAME_WIDTH + 520,
      y: 585,
    });

    const versus = this.add.text(GAME_WIDTH / 2, 420, 'VS', {
      color: '#f5f2e8', fontFamily: 'system-ui, sans-serif', fontSize: '70px', fontStyle: '700', stroke: '#667bb4', strokeThickness: 9,
    }).setOrigin(0.5).setDepth(5).setAlpha(0).setScale(0.55);
    this.countdownText = this.add.text(GAME_WIDTH / 2, 468, '', {
      color: '#ffdf8a', fontFamily: 'system-ui, sans-serif', fontSize: '18px', fontStyle: '700',
    }).setOrigin(0.5);
    this.tweens.add({
      delay: 120,
      duration: 720,
      ease: 'Cubic.Out',
      targets: opponentCard,
      x: GAME_WIDTH / 2,
    });
    this.tweens.add({
      delay: 260,
      duration: 720,
      ease: 'Cubic.Out',
      targets: localCard,
      x: GAME_WIDTH / 2,
    });
    this.tweens.add({
      delay: 660,
      duration: 360,
      ease: 'Back.Out',
      scale: 1,
      targets: versus,
      alpha: 1,
    });
    this.updateCountdown();
    this.time.addEvent({ callback: () => {
      this.remainingSeconds -= 1;
      if (this.remainingSeconds <= 0) this.startStacking();
      else this.updateCountdown();
    }, delay: 1_000, repeat: 2 });
  }

  private createPawnTextures() {
    (['white', 'black'] as const).forEach((color) => {
      const targetKey = `matchup-pawn-${color}`;
      if (this.textures.exists(targetKey)) return;
      const source = this.textures.get('matchup-pawn-white-source').getSourceImage() as CanvasImageSource;
      const texture = this.textures.createCanvas(targetKey, PAWN_CROP.width, PAWN_CROP.height);
      if (texture === null) return;
      const context = texture.getContext();
      context.drawImage(source, PAWN_CROP.left, PAWN_CROP.top, PAWN_CROP.width, PAWN_CROP.height, 0, 0, PAWN_CROP.width, PAWN_CROP.height);
      const pixels = context.getImageData(0, 0, PAWN_CROP.width, PAWN_CROP.height);
      for (let index = 0; index < pixels.data.length; index += 4) {
        const brightness = (pixels.data[index] + pixels.data[index + 1] + pixels.data[index + 2]) / 3;
        pixels.data[index] = 255;
        pixels.data[index + 1] = 255;
        pixels.data[index + 2] = 255;
        pixels.data[index + 3] = Phaser.Math.Clamp((brightness - 190) * 3.9, 0, 255);
      }
      context.putImageData(pixels, 0, 0);
      texture.refresh();
    });
  }

  private createProfileCard(data: {
    accent: number;
    badge: string;
    color: 'black' | 'white';
    label: string;
    profile: PlayerProfile | null;
    x: number;
    y: number;
  }) {
    const card = this.add.container(data.x, data.y);
    card.add(this.add.rectangle(0, 0, 900, 210, data.accent, 0.94).setStrokeStyle(5, 0xf5f7ff, 0.25));
    card.add(this.add.rectangle(0, 0, 900, 210, 0x10131c, 0.12));
    card.add(this.add.image(-335, 0, data.badge).setDisplaySize(172, 172));
    card.add(this.add.image(-335, 4, `matchup-pawn-${data.color}`)
      .setDisplaySize(105, 160)
      .setTint(data.color === 'white' ? 0xffffff : 0x161925));
    card.add(this.add.text(-205, -52, data.label, {
      color: '#ffffff', fontFamily: 'system-ui, sans-serif', fontSize: '30px', fontStyle: '700',
    }).setOrigin(0, 0.5));
    const record = data.profile === null
      ? '전적 동기화 중'
      : `${data.profile.wins}승 ${data.profile.losses}패 ${data.profile.draws}무`;
    const rating = data.profile === null ? 'RATING —' : `♛  ${data.profile.rating}`;
    card.add(this.add.text(-205, 22, record, {
      color: '#f5f7ff', fontFamily: 'system-ui, sans-serif', fontSize: '24px', fontStyle: '700',
    }).setOrigin(0, 0.5));
    card.add(this.add.text(344, 0, rating, {
      color: '#fff4a9', fontFamily: 'system-ui, sans-serif', fontSize: '36px', fontStyle: '700',
    }).setOrigin(0.5));
    return card;
  }

  private updateCountdown() {
    this.countdownText.setText(`${this.remainingSeconds}초 뒤 탑 쌓기를 시작합니다`);
  }

  private startStacking() {
    if (this.started) return;
    this.started = true;
    this.scene.start('stacking', {
      mode: this.matchData.mode,
      opponentRating: this.matchData.opponentProfile?.rating ?? this.matchData.opponentRating,
    });
  }
}
