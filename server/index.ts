import { Chess } from 'chess.js';
import RAPIER from '@dimforge/rapier2d-compat';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { StackingSimulation, type PieceKind, type PlayerColor, type SurvivorPiece } from './stacking';

type Client = {
  disconnectedAt: number | null;
  id: string;
  identified: boolean;
  joinAttemptKey: string;
  rating: number | null;
  roomId: string | null;
  socket: WebSocket;
};

type ServerMatchState = {
  chess: Chess | null;
  completionReason: 'checkmate' | 'draw' | 'resign' | 'timeout' | null;
  fen: string | null;
  colorChoiceEndsAt: number | null;
  colorSelectionWinnerId: string | null;
  phase: 'chess' | 'color_selection' | 'complete' | 'stacking';
  revision: number;
  stacking: StackingSimulation | null;
  stackingTurnPlayerId: string | null;
  winnerPlayerId: string | null;
  whitePlayerId: string | null;
};

type Room = {
  id: string;
  hostId: string | null;
  inviteExpiresAt: number | null;
  inviteToken: string | null;
  match: ServerMatchState | null;
  mode: 'match' | 'private';
  players: Client[];
};

type ClientMessage =
  | { type: 'identify_session'; sessionId: string }
  | { type: 'create_room' }
  | { type: 'join_invite'; token: string }
  | { type: 'join_room'; roomId: string }
  | { type: 'join_matchmaking'; rating: number }
  | { type: 'leave_room' }
  | { type: 'stacking_drop'; angle: number; revision: number; x: number }
  | { type: 'select_chess_color'; color: PlayerColor }
  | { type: 'start_chess'; fen: string; whitePlayerId: string }
  | { type: 'chess_move'; from: string; promotion?: 'b' | 'n' | 'q' | 'r'; revision: number; to: string }
  | { type: 'chess_forfeit'; reason: 'resign' | 'timeout' }
  | { type: 'game_action'; action: unknown };

const port = Number(process.env.PORT ?? process.env.WS_PORT ?? 8787);
const httpServer = createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  response.writeHead(404, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: 'not_found' }));
});
const wss = new WebSocketServer({ server: httpServer });
const clients = new Map<WebSocket, Client>();
const matchmakingQueue = new Set<Client>();
const rooms = new Map<string, Room>();
const RECONNECT_GRACE_MS = 5 * 60_000;
const INVITE_TTL_MS = 30 * 60_000;
const JOIN_ATTEMPT_LIMIT = 10;
const JOIN_ATTEMPT_WINDOW_MS = 60_000;
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const joinAttempts = new Map<string, number[]>();
let lastJoinAttemptCleanupAt = 0;

await RAPIER.init();

function createOpaqueToken(bytes = 16) {
  return randomBytes(bytes).toString('base64url');
}

function createRoomCode(length = 6) {
  return [...randomBytes(length)].map((byte) => ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length]).join('');
}

function createAvailableRoomCode() {
  let roomId = createRoomCode();
  while (rooms.has(roomId)) roomId = createRoomCode();
  return roomId;
}

function createPrivateRoom(host: Client): Room {
  return {
    hostId: host.id,
    id: createAvailableRoomCode(),
    inviteExpiresAt: Date.now() + INVITE_TTL_MS,
    inviteToken: createOpaqueToken(32),
    match: null,
    mode: 'private',
    players: [],
  };
}

function invalidateInvite(room: Room) {
  room.inviteExpiresAt = null;
  room.inviteToken = null;
}

function rotateInvite(room: Room) {
  room.inviteExpiresAt = Date.now() + INVITE_TTL_MS;
  room.inviteToken = createOpaqueToken(32);
}

function isSessionId(value: string) {
  return /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

function requestAttemptKey(request: import('node:http').IncomingMessage) {
  const forwarded = request.headers['x-forwarded-for'];
  const forwardedAddress = typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : undefined;
  return forwardedAddress || request.socket.remoteAddress || createOpaqueToken();
}

function allowRoomJoinAttempt(client: Client) {
  const now = Date.now();
  const recentAttempts = (joinAttempts.get(client.joinAttemptKey) ?? []).filter((timestamp) => now - timestamp < JOIN_ATTEMPT_WINDOW_MS);
  if (recentAttempts.length >= JOIN_ATTEMPT_LIMIT) return false;
  recentAttempts.push(now);
  joinAttempts.set(client.joinAttemptKey, recentAttempts);
  return true;
}

function send(socket: WebSocket, message: unknown) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function serializeMatchState(match: ServerMatchState | null) {
  if (match === null) return null;
  return {
    completionReason: match.completionReason,
    fen: match.fen,
    colorChoiceEndsAt: match.colorChoiceEndsAt,
    colorSelectionWinnerId: match.colorSelectionWinnerId,
    phase: match.phase,
    revision: match.revision,
    stacking: match.stacking?.snapshot() ?? null,
    stackingTurnPlayerId: match.stackingTurnPlayerId,
    winnerPlayerId: match.winnerPlayerId,
    whitePlayerId: match.whitePlayerId,
  };
}

function roomSnapshot(room: Room, recipient: Client) {
  const opponent = room.players.find((player) => player.id !== recipient.id);
  return {
    match: serializeMatchState(room.match),
    mode: room.mode,
    opponentRating: opponent?.rating,
    inviteToken: room.mode === 'private' && recipient.id === room.hostId ? room.inviteToken : undefined,
    players: room.players.map((player, index) => ({ connected: player.disconnectedAt === null, id: player.id, slot: index === 0 ? 'white' : 'black' })),
    ready: room.players.length === 2,
    roomId: room.id,
  };
}

function broadcastRoom(room: Room) {
  room.players.forEach((player) => send(player.socket, { type: 'room_state', ...roomSnapshot(room, player) }));
}

function createMatchState(room: Room): ServerMatchState {
  return {
    chess: null,
    completionReason: null,
    colorChoiceEndsAt: null,
    colorSelectionWinnerId: null,
    fen: null,
    phase: 'stacking',
    revision: 0,
    stacking: new StackingSimulation(),
    stackingTurnPlayerId: room.players[0]?.id ?? null,
    winnerPlayerId: null,
    whitePlayerId: null,
  };
}

function getRoomForClient(client: Client) {
  return client.roomId === null ? undefined : rooms.get(client.roomId);
}

function rejectAction(client: Client, message: string) {
  send(client.socket, { type: 'error', message });
}

function leaveRoom(client: Client) {
  matchmakingQueue.delete(client);
  if (client.roomId === null) return;
  const room = rooms.get(client.roomId);
  client.roomId = null;
  if (room === undefined) return;
  if (room.mode === 'private' && room.hostId === client.id) {
    room.match?.stacking?.destroy();
    rooms.delete(room.id);
    room.players.filter((player) => player.id !== client.id).forEach((player) => {
      player.roomId = null;
      send(player.socket, { type: 'room_closed', message: '방장이 방을 나가 방이 종료되었습니다.' });
    });
    return;
  }
  room.players = room.players.filter((player) => player.id !== client.id);
  if (room.players.length === 0) {
    room.match?.stacking?.destroy();
    rooms.delete(room.id);
    return;
  }
  room.match?.stacking?.destroy();
  room.match = null;
  if (room.mode === 'private') rotateInvite(room);
  broadcastRoom(room);
}

function joinRoom(client: Client, room: Room) {
  const existingSeat = room.players.findIndex((player) => player.id === client.id);
  if (existingSeat >= 0) {
    const previousClient = room.players[existingSeat];
    client.rating ??= previousClient.rating;
    client.roomId = room.id;
    room.players[existingSeat] = client;
    broadcastRoom(room);
    return;
  }
  if (room.players.length >= 2) {
    rejectAction(client, '방이 가득 찼습니다.');
    return;
  }
  leaveRoom(client);
  client.roomId = room.id;
  room.players.push(client);
  if (room.players.length === 2 && room.match === null) {
    invalidateInvite(room);
    room.match = createMatchState(room);
  }
  broadcastRoom(room);
}

function disconnectClient(client: Client) {
  matchmakingQueue.delete(client);
  client.disconnectedAt = Date.now();
  const room = getRoomForClient(client);
  if (room !== undefined) broadcastRoom(room);
}

function restoreRoomForSession(client: Client) {
  const room = [...rooms.values()].find((candidate) => candidate.players.some((player) => player.id === client.id));
  if (room !== undefined) joinRoom(client, room);
}

function identifySession(client: Client, sessionId: string) {
  if (!isSessionId(sessionId)) return rejectAction(client, '유효하지 않은 세션입니다.');
  if (client.identified) return;
  client.id = sessionId;
  client.identified = true;
  send(client.socket, { type: 'connected', clientId: client.id });
  restoreRoomForSession(client);
}

function joinPrivateInvite(client: Client, token: string) {
  if (!allowRoomJoinAttempt(client)) return rejectAction(client, '방 참가 요청이 너무 많습니다. 잠시 후 다시 시도하세요.');
  const room = [...rooms.values()].find((candidate) => candidate.mode === 'private' && candidate.inviteToken === token);
  if (room === undefined || room.inviteExpiresAt === null || room.inviteExpiresAt <= Date.now()) {
    if (room !== undefined) {
      invalidateInvite(room);
      broadcastRoom(room);
    }
    return rejectAction(client, '유효하지 않거나 만료된 초대 링크입니다.');
  }
  joinRoom(client, room);
}

function joinMatchmaking(client: Client, rating: number) {
  leaveRoom(client);
  client.rating = Math.max(100, Math.round(rating));
  const opponent = [...matchmakingQueue]
    .filter((candidate) => candidate.socket.readyState === candidate.socket.OPEN && candidate.rating !== null)
    .sort((a, b) => Math.abs((a.rating ?? 0) - client.rating!) - Math.abs((b.rating ?? 0) - client.rating!))[0];
  if (opponent === undefined) {
    matchmakingQueue.add(client);
    send(client.socket, { type: 'matchmaking_wait', rating: client.rating });
    return;
  }
  matchmakingQueue.delete(opponent);
  const room: Room = { hostId: null, id: createAvailableRoomCode(), inviteExpiresAt: null, inviteToken: null, match: null, mode: 'match', players: [] };
  rooms.set(room.id, room);
  joinRoom(opponent, room);
  joinRoom(client, room);
}

function playerForStackColor(room: Room, color: PlayerColor) {
  return room.players[color === 'white' ? 0 : 1];
}

function handleStackingDrop(client: Client, revision: number, x: number, angle: number) {
  const room = getRoomForClient(client);
  const match = room?.match;
  if (room === undefined || match == null || match.phase !== 'stacking' || match.stacking === null) {
    rejectAction(client, '쌓기 단계가 아닙니다.');
    return;
  }
  if (revision !== match.revision || match.stackingTurnPlayerId !== client.id) {
    return rejectAction(client, '현재 쌓기 턴이 아니거나 상태가 오래되었습니다.');
  }
  if (!Number.isFinite(x) || !Number.isFinite(angle) || !match.stacking.drop(x, angle)) {
    return rejectAction(client, '현재 기물을 떨어뜨릴 수 없습니다.');
  }
  match.revision += 1;
  broadcastRoom(room);
}

function handleStartChess(client: Client, fen: string, whitePlayerId: string) {
  const room = getRoomForClient(client);
  const match = room?.match;
  if (room === undefined || match == null || match.phase !== 'stacking') {
    rejectAction(client, '체스 시작 요청을 처리할 수 없습니다.');
    return;
  }
  if (!room.players.some((player) => player.id === whitePlayerId)) {
    rejectAction(client, '백 플레이어 정보가 올바르지 않습니다.');
    return;
  }
  try {
    match.chess = new Chess(fen);
  } catch {
    return rejectAction(client, '유효하지 않은 체스 시작 상태입니다.');
  }
  match.fen = match.chess.fen();
  match.phase = 'chess';
  match.completionReason = null;
  match.revision += 1;
  match.stacking?.destroy();
  match.stacking = null;
  match.stackingTurnPlayerId = null;
  match.whitePlayerId = whitePlayerId;
  broadcastRoom(room);
}

function chessPieceType(kind: PieceKind) {
  return ({ bishop: 'b', knight: 'n', pawn: 'p', queen: 'q', rook: 'r' } as const)[kind];
}

function buildChessFen(survivors: SurvivorPiece[], whiteStackColor: PlayerColor) {
  const board = new Map<string, { color: 'b' | 'w'; type: string }>();
  board.set('e1', { color: 'w', type: 'k' });
  board.set('e8', { color: 'b', type: 'k' });
  const pawnFiles = ['d', 'e', 'c', 'f', 'b', 'g', 'a', 'h'];
  (['w', 'b'] as const).forEach((color) => {
    const stackColor: PlayerColor = color === 'w' ? whiteStackColor : (whiteStackColor === 'white' ? 'black' : 'white');
    const playerSurvivors = survivors.filter((piece) => piece.color === stackColor);
    const pawnRank = color === 'w' ? '2' : '7';
    const backRank = color === 'w' ? '1' : '8';
    const specialFiles: Record<PieceKind, string[]> = color === 'w'
      ? { rook: ['a', 'h'], knight: ['b', 'g'], bishop: ['c', 'f'], queen: ['d'], pawn: [] }
      : { rook: ['h', 'a'], knight: ['g', 'b'], bishop: ['f', 'c'], queen: ['d'], pawn: [] };
    playerSurvivors.filter((piece) => piece.kind === 'pawn').slice(0, pawnFiles.length).forEach((_, index) => {
      board.set(`${pawnFiles[index]}${pawnRank}`, { color, type: 'p' });
    });
    (['rook', 'knight', 'bishop', 'queen'] as const).forEach((kind) => {
      playerSurvivors.filter((piece) => piece.kind === kind).sort((a, b) => a.settledOrder - b.settledOrder).slice(0, specialFiles[kind].length).forEach((piece, index) => {
        board.set(`${specialFiles[kind][index]}${backRank}`, { color, type: chessPieceType(piece.kind) });
      });
    });
  });
  const rankFen = (rank: number) => {
    let empty = 0;
    let value = '';
    for (const file of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      const piece = board.get(`${file}${rank}`);
      if (piece === undefined) { empty += 1; continue; }
      if (empty > 0) { value += empty; empty = 0; }
      value += piece.color === 'w' ? piece.type.toUpperCase() : piece.type;
    }
    return `${value}${empty || ''}`;
  };
  const hasRook = (square: string, color: 'b' | 'w') => board.get(square)?.color === color && board.get(square)?.type === 'r';
  const castling = `${hasRook('h1', 'w') ? 'K' : ''}${hasRook('a1', 'w') ? 'Q' : ''}${hasRook('h8', 'b') ? 'k' : ''}${hasRook('a8', 'b') ? 'q' : ''}` || '-';
  return `${[8, 7, 6, 5, 4, 3, 2, 1].map(rankFen).join('/')} w ${castling} - 0 1`;
}

function startChessFromStack(room: Room, match: ServerMatchState, winnerColor: PlayerColor) {
  const winnerId = match.colorSelectionWinnerId;
  if (winnerId === null || match.stacking === null) return;
  const whitePlayerId = winnerColor === 'white'
    ? winnerId
    : room.players.find((player) => player.id !== winnerId)?.id ?? null;
  if (whitePlayerId === null) return;
  const whiteStackColor: PlayerColor = room.players[0]?.id === whitePlayerId ? 'white' : 'black';
  const chess = new Chess(buildChessFen(match.stacking.getSurvivors(), whiteStackColor));
  match.chess = chess;
  match.fen = chess.fen();
  match.phase = 'chess';
  match.whitePlayerId = whitePlayerId;
  match.colorChoiceEndsAt = null;
  match.colorSelectionWinnerId = null;
  match.stackingTurnPlayerId = null;
  match.stacking.destroy();
  match.stacking = null;
  match.revision += 1;
  broadcastRoom(room);
}

function handleChessColorSelection(client: Client, color: PlayerColor) {
  const room = getRoomForClient(client);
  const match = room?.match;
  if (room === undefined || match === undefined || match === null || match.phase !== 'color_selection' || match.colorSelectionWinnerId !== client.id) {
    return rejectAction(client, '체스 진영을 선택할 수 있는 상태가 아닙니다.');
  }
  startChessFromStack(room, match, color);
}

function handleChessMove(client: Client, message: Extract<ClientMessage, { type: 'chess_move' }>) {
  const room = getRoomForClient(client);
  const match = room?.match;
  if (room === undefined || match == null || match.chess === null || match.phase !== 'chess' || match.whitePlayerId === null) {
    return rejectAction(client, '체스 단계가 아닙니다.');
  }
  if (message.revision !== match.revision) {
    rejectAction(client, '오래된 체스 상태입니다.');
    return;
  }
  const expectedPlayerId = match.chess.turn() === 'w'
    ? match.whitePlayerId
    : room.players.find((player) => player.id !== match.whitePlayerId)?.id;
  if (expectedPlayerId !== client.id) {
    rejectAction(client, '현재 체스 턴이 아닙니다.');
    return;
  }
  try {
    match.chess.move({ from: message.from, promotion: message.promotion, to: message.to });
  } catch {
    return rejectAction(client, '허용되지 않는 체스 수입니다.');
  }
  match.fen = match.chess.fen();
  match.revision += 1;
  if (match.chess.isGameOver()) {
    match.phase = 'complete';
    if (match.chess.isCheckmate()) {
      match.completionReason = 'checkmate';
      match.winnerPlayerId = match.chess.turn() === 'b'
        ? match.whitePlayerId
        : room.players.find((player) => player.id !== match.whitePlayerId)?.id ?? null;
    } else {
      match.completionReason = 'draw';
      match.winnerPlayerId = null;
    }
  }
  broadcastRoom(room);
}

function handleChessForfeit(client: Client, reason: 'resign' | 'timeout') {
  const room = getRoomForClient(client);
  const match = room?.match;
  if (room === undefined || match == null || match.phase !== 'chess') {
    return rejectAction(client, '체스 단계가 아닙니다.');
  }
  match.phase = 'complete';
  match.completionReason = reason;
  match.winnerPlayerId = room.players.find((player) => player.id !== client.id)?.id ?? null;
  match.revision += 1;
  broadcastRoom(room);
}

function parseMessage(data: RawData) {
  try {
    const text = Array.isArray(data)
      ? Buffer.concat(data).toString()
      : data instanceof ArrayBuffer
        ? Buffer.from(data).toString()
        : data.toString();
    return JSON.parse(text) as ClientMessage;
  } catch {
    return null;
  }
}

wss.on('connection', (socket, request) => {
  const client: Client = {
    disconnectedAt: null,
    id: createOpaqueToken(),
    identified: false,
    joinAttemptKey: requestAttemptKey(request),
    rating: null,
    roomId: null,
    socket,
  };
  clients.set(socket, client);

  socket.on('message', (data) => {
    const message = parseMessage(data);
    if (message === null) return rejectAction(client, '잘못된 메시지 형식입니다.');
    if (message.type === 'identify_session') return identifySession(client, message.sessionId);
    if (!client.identified) return rejectAction(client, '세션 초기화 중입니다. 잠시 후 다시 시도하세요.');
    if (message.type === 'create_room') {
      const room = createPrivateRoom(client);
      rooms.set(room.id, room);
      return joinRoom(client, room);
    }
    if (message.type === 'join_matchmaking') return joinMatchmaking(client, message.rating);
    if (message.type === 'join_invite') return joinPrivateInvite(client, message.token);
    if (message.type === 'join_room') {
      if (!allowRoomJoinAttempt(client)) return rejectAction(client, '방 참가 요청이 너무 많습니다. 잠시 후 다시 시도하세요.');
      const room = rooms.get(message.roomId.toUpperCase());
      return room === undefined || room.mode !== 'private'
        ? rejectAction(client, '유효하지 않은 방 코드입니다.')
        : joinRoom(client, room);
    }
    if (message.type === 'leave_room') return leaveRoom(client);
    if (message.type === 'stacking_drop') return handleStackingDrop(client, message.revision, message.x, message.angle);
    if (message.type === 'select_chess_color') return handleChessColorSelection(client, message.color);
    if (message.type === 'start_chess') return handleStartChess(client, message.fen, message.whitePlayerId);
    if (message.type === 'chess_move') return handleChessMove(client, message);
    if (message.type === 'chess_forfeit') return handleChessForfeit(client, message.reason);
    if (message.type === 'game_action') {
      const room = getRoomForClient(client);
      if (room === undefined) return rejectAction(client, '게임 액션을 보낼 방에 참가하지 않았습니다.');
      room.players.filter((player) => player.id !== client.id).forEach((player) => send(player.socket, { type: 'game_action', from: client.id, action: message.action }));
    }
  });

  socket.on('close', () => {
    disconnectClient(client);
    clients.delete(socket);
  });
});

httpServer.listen(port, () => {
  console.log(`STACKMATE WebSocket server listening on ws://localhost:${port}`);
});

setInterval(() => {
  const now = Date.now();
  if (now - lastJoinAttemptCleanupAt >= JOIN_ATTEMPT_WINDOW_MS) {
    joinAttempts.forEach((attempts, key) => {
      const recentAttempts = attempts.filter((timestamp) => now - timestamp < JOIN_ATTEMPT_WINDOW_MS);
      if (recentAttempts.length === 0) joinAttempts.delete(key);
      else joinAttempts.set(key, recentAttempts);
    });
    lastJoinAttemptCleanupAt = now;
  }
  rooms.forEach((room) => {
    if (room.mode === 'private' && room.inviteExpiresAt !== null && now >= room.inviteExpiresAt) {
      invalidateInvite(room);
      broadcastRoom(room);
    }
    const expiredPlayerIds = room.players
      .filter((player) => player.disconnectedAt !== null && now - player.disconnectedAt >= RECONNECT_GRACE_MS)
      .map((player) => player.id);
    if (expiredPlayerIds.length > 0) {
      room.players = room.players.filter((player) => !expiredPlayerIds.includes(player.id));
      room.match?.stacking?.destroy();
      room.match = null;
      if (room.players.length === 0) {
        rooms.delete(room.id);
        return;
      }
      broadcastRoom(room);
      return;
    }
    const match = room.match;
    if (match?.phase === 'color_selection' && match.colorChoiceEndsAt !== null && now >= match.colorChoiceEndsAt) {
      startChessFromStack(room, match, 'white');
      return;
    }
    if (match?.phase !== 'stacking' || match.stacking === null) return;
    const result = match.stacking.tick(now);
    if (result.outcome !== null) {
      const winnerId = playerForStackColor(room, result.outcome === 'white' ? 'black' : 'white')?.id ?? null;
      match.phase = 'color_selection';
      match.winnerPlayerId = winnerId;
      match.colorSelectionWinnerId = winnerId;
      match.colorChoiceEndsAt = now + 10_000;
      match.stackingTurnPlayerId = null;
      match.revision += 1;
      broadcastRoom(room);
      return;
    }
    const nextPlayer = playerForStackColor(room, match.stacking.getTurn())?.id ?? null;
    if (result.changed || match.stackingTurnPlayerId !== nextPlayer) {
      match.stackingTurnPlayerId = nextPlayer;
      if (result.changed) match.revision += 1;
      broadcastRoom(room);
      return;
    }
    // 물리 월드와 동일한 60Hz로 상태를 전송해 클라이언트 렌더링이 30Hz로 보이지 않게 한다.
    broadcastRoom(room);
  });
}, 1000 / 60);
