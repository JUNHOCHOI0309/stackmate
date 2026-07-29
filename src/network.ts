export type RoomState = {
  match: MatchState | null;
  mode: 'match' | 'private';
  players: Array<{ id: string; slot: 'white' | 'black' }>;
  opponentRating?: number;
  ready: boolean;
  roomId: string;
};

export type MatchState = {
  fen: string | null;
  phase: 'chess' | 'complete' | 'stacking';
  revision: number;
  stacking: {
    isDropping: boolean;
    nextPiece: { color: 'black' | 'white'; kind: 'bishop' | 'knight' | 'pawn' | 'queen' | 'rook' } | null;
    pieces: Array<{ angle: number; color: 'black' | 'white'; id: string; kind: 'bishop' | 'knight' | 'pawn' | 'queen' | 'rook'; settledOrder: number; x: number; y: number }>;
    turnEndsAt: number;
  } | null;
  stackingTurnPlayerId: string | null;
  winnerPlayerId: string | null;
  whitePlayerId: string | null;
};

type ServerMessage =
  | { type: 'connected'; clientId: string }
  | ({ type: 'room_state' } & RoomState)
  | { type: 'matchmaking_wait'; rating: number }
  | { type: 'error'; message: string }
  | { type: 'game_action'; from: string; action: unknown };

export class MatchSocket {
  private clientId: string | null = null;
  private matchListeners = new Set<(match: MatchState) => void>();
  private pendingMessages: unknown[] = [];
  private room: RoomState | null = null;
  private roomListeners = new Set<(room: RoomState) => void>();
  private socket: WebSocket | null = null;
  private statusListeners = new Set<(status: string) => void>();

  connect() {
    if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) {
      return;
    }
    const configuredEndpoint = import.meta.env.VITE_WS_URL?.trim();
    const endpoint = configuredEndpoint || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:8787`;
    this.publishStatus('연결 중…');
    this.socket = new WebSocket(endpoint);
    this.socket.addEventListener('open', () => {
      this.publishStatus('연결됨');
      this.pendingMessages.splice(0).forEach((message) => this.send(message));
    });
    this.socket.addEventListener('message', (event) => this.handleMessage(JSON.parse(event.data) as ServerMessage));
    this.socket.addEventListener('close', () => this.publishStatus('연결 끊김'));
    this.socket.addEventListener('error', () => this.publishStatus('서버 연결 실패'));
  }

  onStatus(listener: (status: string) => void) {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onRoom(listener: (room: RoomState) => void) {
    this.roomListeners.add(listener);
    return () => this.roomListeners.delete(listener);
  }

  onMatch(listener: (match: MatchState) => void) {
    this.matchListeners.add(listener);
    return () => this.matchListeners.delete(listener);
  }

  getClientId() {
    return this.clientId;
  }

  getMatch() {
    return this.room?.match ?? null;
  }

  createPrivateRoom() {
    this.send({ type: 'create_room' });
  }

  joinPrivateRoom(roomId: string) {
    this.send({ type: 'join_room', roomId: roomId.trim().toUpperCase() });
  }

  joinMatchmaking(rating: number) {
    this.send({ type: 'join_matchmaking', rating });
    this.publishStatus(`레이팅 ${rating} 기준 상대 탐색 중…`);
  }

  sendGameAction(action: unknown) {
    if (this.room === null) {
      return;
    }
    this.send({ type: 'game_action', action });
  }

  submitStackingDrop(revision: number, x: number, angle: number) {
    this.send({ type: 'stacking_drop', angle, revision, x });
  }

  startAuthoritativeChess(fen: string, whitePlayerId: string) {
    this.send({ type: 'start_chess', fen, whitePlayerId });
  }

  submitChessMove(from: string, to: string, promotion: 'b' | 'n' | 'q' | 'r' | undefined, revision: number) {
    this.send({ type: 'chess_move', from, promotion, revision, to });
  }

  private handleMessage(message: ServerMessage) {
    if (message.type === 'connected') {
      this.clientId = message.clientId;
      return;
    }
    if (message.type === 'room_state') {
      this.room = message;
      const url = new URL(location.href);
      url.searchParams.set('room', message.roomId);
      history.replaceState(null, '', url);
      this.publishStatus(message.ready ? `방 ${message.roomId} · 2명 연결됨` : `방 ${message.roomId} · 상대 대기 중`);
      this.roomListeners.forEach((listener) => listener(message));
      const match = message.match;
      if (match !== null) this.matchListeners.forEach((listener) => listener(match));
      return;
    }
    if (message.type === 'matchmaking_wait') {
      this.publishStatus(`레이팅 ${message.rating} 기준 상대 탐색 중…`);
      return;
    }
    if (message.type === 'error') {
      this.publishStatus(message.message);
    }
  }

  private publishStatus(status: string) {
    this.statusListeners.forEach((listener) => listener(status));
  }

  private send(message: unknown) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
      return;
    }
    if (this.socket?.readyState === WebSocket.CONNECTING) {
      this.pendingMessages.push(message);
    }
  }
}

export const matchSocket = new MatchSocket();
