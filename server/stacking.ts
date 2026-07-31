import RAPIER, { type RigidBody, type World } from '@dimforge/rapier2d-compat';

export type PieceKind = 'pawn' | 'rook' | 'knight' | 'bishop' | 'queen';
export type PlayerColor = 'white' | 'black';
export type SurvivorPiece = { color: PlayerColor; kind: PieceKind; settledOrder: number };

type PieceSpec = { height: number; width: number };
type PhysicsPiece = {
  body: RigidBody;
  color: PlayerColor;
  id: string;
  kind: PieceKind;
  previousY: number;
  settledOrder: number;
};

export type StackingSnapshot = {
  isDropping: boolean;
  nextPiece: { color: PlayerColor; kind: PieceKind } | null;
  pieces: Array<{ angle: number; color: PlayerColor; id: string; kind: PieceKind; settledOrder: number; x: number; y: number }>;
  turnEndsAt: number;
};

const GAME_WIDTH = 1160;
const PLATFORM_CENTER_X = GAME_WIDTH / 2;
const PLATFORM_HALF_WIDTH = 300;
const PLATFORM_Y = 758;
const FALL_LINE_Y = PLATFORM_Y + 16;
const SPAWN_Y = 150;
const SIDE_COLLIDER_SCALE = 1.12;
const TURN_DURATION_MS = 10_000;
const SETTLE_DURATION_MS = 550;
const STACK_DECK: PieceKind[] = [
  'pawn', 'pawn', 'pawn', 'pawn', 'pawn', 'pawn', 'pawn', 'pawn',
  'rook', 'rook', 'knight', 'knight', 'bishop', 'bishop', 'queen',
];

const PIECE_SPECS: Record<PieceKind, Record<PlayerColor, PieceSpec>> = {
  pawn: { white: { height: 98, width: 60 }, black: { height: 98, width: 61 } },
  rook: { white: { height: 112, width: 78 }, black: { height: 112, width: 81 } },
  knight: { white: { height: 120, width: 73 }, black: { height: 120, width: 74 } },
  bishop: { white: { height: 124, width: 68 }, black: { height: 124, width: 67 } },
  queen: { white: { height: 132, width: 75 }, black: { height: 132, width: 73 } },
};

function shuffledDeck() {
  const deck = [...STACK_DECK];
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const next = Math.floor(Math.random() * (index + 1));
    [deck[index], deck[next]] = [deck[next], deck[index]];
  }
  return deck;
}

export class StackingSimulation {
  private active: { color: PlayerColor; kind: PieceKind } | null;
  private decks: Record<PlayerColor, PieceKind[]>;
  private droppingPiece: PhysicsPiece | null = null;
  private impactEvents = new RAPIER.EventQueue(true);
  private lastSettledAt = 0;
  private nextPieceId = 1;
  private pieces = new Map<string, PhysicsPiece>();
  private settledCount = 0;
  private turnEndsAt = Date.now() + TURN_DURATION_MS;
  private turn: PlayerColor = 'white';
  private world: World;

  constructor() {
    this.world = new RAPIER.World({ x: 0, y: 400 });
    const platform = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(PLATFORM_CENTER_X, PLATFORM_Y));
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(PLATFORM_HALF_WIDTH, 16)
        .setFriction(0.62)
        .setRestitution(0.32)
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(22),
      platform,
    );
    this.decks = { black: shuffledDeck(), white: shuffledDeck() };
    this.active = this.takeNextPiece();
  }

  destroy() {
    this.impactEvents.free();
    this.world.free();
  }

  getTurn() {
    return this.turn;
  }

  getSurvivors(): SurvivorPiece[] {
    return [...this.pieces.values()]
      .filter((piece) => piece.body.translation().y <= FALL_LINE_Y)
      .map((piece) => ({ color: piece.color, kind: piece.kind, settledOrder: piece.settledOrder }));
  }

  snapshot(): StackingSnapshot {
    return {
      isDropping: this.droppingPiece !== null,
      nextPiece: this.active,
      pieces: [...this.pieces.values()].map((piece) => {
        const translation = piece.body.translation();
        return { angle: piece.body.rotation(), color: piece.color, id: piece.id, kind: piece.kind, settledOrder: piece.settledOrder, x: translation.x, y: translation.y };
      }),
      turnEndsAt: this.turnEndsAt,
    };
  }

  drop(x: number, angle: number) {
    if (this.active === null || this.droppingPiece !== null) return false;
    const piece = this.createPiece(this.active.kind, this.active.color, PhaserClamp(x, PLATFORM_CENTER_X - 250, PLATFORM_CENTER_X + 250), angle);
    piece.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    piece.body.setLinearDamping(0.08);
    piece.body.setAngularDamping(0.2);
    this.pieces.set(piece.id, piece);
    this.droppingPiece = piece;
    this.active = null;
    return true;
  }

  tick(now: number) {
    if (this.droppingPiece === null && this.active !== null && now >= this.turnEndsAt) {
      this.drop(PLATFORM_CENTER_X, 0);
      return { changed: true, impactForce: 0, outcome: null as PlayerColor | null };
    }
    if (this.droppingPiece === null) return { changed: false, impactForce: 0, outcome: null as PlayerColor | null };

    this.world.step(this.impactEvents);
    let impactForce = 0;
    this.impactEvents.drainContactForceEvents((event) => {
      impactForce = Math.max(impactForce, event.totalForceMagnitude());
    });
    const fallen = [...this.pieces.values()].find((piece) => piece.previousY <= FALL_LINE_Y && piece.body.translation().y > FALL_LINE_Y);
    this.pieces.forEach((piece) => { piece.previousY = piece.body.translation().y; });
    if (fallen !== undefined) return { changed: true, impactForce, outcome: fallen.color };

    const velocity = this.droppingPiece.body.linvel();
    const stable = Math.hypot(velocity.x, velocity.y) < 8 && Math.abs(this.droppingPiece.body.angvel()) < 0.12;
    this.lastSettledAt = stable ? (this.lastSettledAt || now) : 0;
    if (this.lastSettledAt !== 0 && now - this.lastSettledAt >= SETTLE_DURATION_MS) {
      this.droppingPiece.settledOrder = ++this.settledCount;
      this.droppingPiece = null;
      this.lastSettledAt = 0;
      this.turn = this.turn === 'white' ? 'black' : 'white';
      this.active = this.takeNextPiece();
      this.turnEndsAt = now + TURN_DURATION_MS;
      return { changed: true, impactForce, outcome: null as PlayerColor | null };
    }
    return { changed: false, impactForce, outcome: null as PlayerColor | null };
  }

  private takeNextPiece() {
    const kind = this.decks[this.turn].shift();
    return kind === undefined ? null : { color: this.turn, kind };
  }

  private createPiece(kind: PieceKind, color: PlayerColor, x: number, angle: number) {
    const spec = PIECE_SPECS[kind][color];
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, SPAWN_Y).setRotation(angle));
    this.addPieceColliders(body, kind, spec.width, spec.height);
    return { body, color, id: `piece-${this.nextPieceId++}`, kind, previousY: SPAWN_Y, settledOrder: 0 };
  }

  private addPieceColliders(body: RigidBody, kind: PieceKind, width: number, height: number) {
    const addCuboid = (halfWidth: number, halfHeight: number, x: number, y: number) => {
      this.world.createCollider(RAPIER.ColliderDesc.cuboid(halfWidth * SIDE_COLLIDER_SCALE, halfHeight).setTranslation(x * SIDE_COLLIDER_SCALE, y).setFriction(0.6).setRestitution(0.234).setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(22).setDensity(0.72), body);
    };
    const addBall = (radius: number, x: number, y: number) => {
      this.world.createCollider(RAPIER.ColliderDesc.ball(radius * 1.06).setTranslation(x * SIDE_COLLIDER_SCALE, y).setFriction(0.6).setRestitution(0.252).setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(22).setDensity(0.72), body);
    };
    const addCapsule = (halfHeight: number, radius: number, x: number, y: number) => {
      this.world.createCollider(RAPIER.ColliderDesc.capsule(halfHeight, radius * SIDE_COLLIDER_SCALE).setTranslation(x * SIDE_COLLIDER_SCALE, y).setFriction(0.6).setRestitution(0.252).setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(22).setDensity(0.72), body);
    };
    const addConvex = (points: Array<[number, number]>) => {
      const collider = RAPIER.ColliderDesc.convexHull(new Float32Array(points.flatMap(([x, y]) => [x * SIDE_COLLIDER_SCALE, y])));
      if (collider !== null) this.world.createCollider(collider.setFriction(0.6).setRestitution(0.252).setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(22).setDensity(0.72), body);
    };

    addCuboid(width * 0.42, height * 0.08, 0, height * 0.38);
    addBall(width * 0.12, -width * 0.3, height * 0.38);
    addBall(width * 0.12, width * 0.3, height * 0.38);
    if (kind === 'pawn') { addCapsule(height * 0.18, width * 0.14, 0, height * 0.08); addBall(width * 0.23, 0, -height * 0.31); }
    if (kind === 'rook') { addCuboid(width * 0.25, height * 0.26, 0, height * 0.06); addCuboid(width * 0.34, height * 0.1, 0, -height * 0.3); }
    if (kind === 'knight') {
      addCapsule(height * 0.22, width * 0.18, width * 0.04, height * 0.06);
      addConvex([[-width * 0.46, -height * 0.2], [-width * 0.27, -height * 0.39], [-width * 0.08, -height * 0.48], [width * 0.18, -height * 0.4], [width * 0.38, -height * 0.2], [width * 0.34, height * 0.04], [width * 0.06, height * 0.12], [-width * 0.22, height * 0.03]]);
    }
    if (kind === 'bishop') {
      addCapsule(height * 0.2, width * 0.14, 0, height * 0.1); addBall(width * 0.18, 0, -height * 0.39);
      addConvex([[-width * 0.23, -height * 0.13], [-width * 0.15, -height * 0.35], [0, -height * 0.48], [width * 0.15, -height * 0.35], [width * 0.23, -height * 0.13], [width * 0.12, height * 0.06], [-width * 0.12, height * 0.06]]);
    }
    if (kind === 'queen') {
      addCapsule(height * 0.21, width * 0.16, 0, height * 0.08); addBall(width * 0.16, 0, -height * 0.42);
      addConvex([[-width * 0.31, -height * 0.21], [-width * 0.2, -height * 0.38], [0, -height * 0.5], [width * 0.2, -height * 0.38], [width * 0.31, -height * 0.21], [width * 0.16, height * 0.05], [-width * 0.16, height * 0.05]]);
    }
  }
}

function PhaserClamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
