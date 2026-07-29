import { Chess } from 'chess.js';
import { createServer } from 'node:http';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';

type Client = {
  id: string;
  rating: number | null;
  roomId: string | null;
  socket: WebSocket;
};

type ServerMatchState = {
  chess: Chess | null;
  fen: string | null;
  phase: 'chess' | 'complete' | 'stacking';
  revision: number;
  stackingTurnPlayerId: string | null;
  winnerPlayerId: string | null;
  whitePlayerId: string | null;
};

type Room = {
  id: string;
  match: ServerMatchState | null;
  mode: 'match' | 'private';
  players: Client[];
};

type ClientMessage =
  | { type: 'create_room' }
  | { type: 'join_room'; roomId: string }
  | { type: 'join_matchmaking'; rating: number }
  | { type: 'leave_room' }
  | { type: 'stacking_drop'; revision: number }
  | { type: 'start_chess'; fen: string; whitePlayerId: string }
  | { type: 'chess_move'; from: string; promotion?: 'b' | 'n' | 'q' | 'r'; revision: number; to: string }
  | { type: 'game_action'; action: unknown };

const port = Number(process.env.WS_PORT ?? 8787);
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

function createId(length = 6) {
  return Math.random().toString(36).slice(2, 2 + length).toUpperCase();
}

function send(socket: WebSocket, message: unknown) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function serializeMatchState(match: ServerMatchState | null) {
  if (match === null) return null;
  return {
    fen: match.fen,
    phase: match.phase,
    revision: match.revision,
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
    players: room.players.map((player, index) => ({ id: player.id, slot: index === 0 ? 'white' : 'black' })),
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
    fen: null,
    phase: 'stacking',
    revision: 0,
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
  room.players = room.players.filter((player) => player.id !== client.id);
  if (room.players.length === 0) {
    rooms.delete(room.id);
    return;
  }
  room.match = null;
  broadcastRoom(room);
}

function joinRoom(client: Client, room: Room) {
  if (room.players.length >= 2) {
    rejectAction(client, '방이 가득 찼습니다.');
    return;
  }
  leaveRoom(client);
  client.roomId = room.id;
  room.players.push(client);
  if (room.players.length === 2) room.match = createMatchState(room);
  broadcastRoom(room);
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
  const room: Room = { id: createId(), match: null, mode: 'match', players: [] };
  rooms.set(room.id, room);
  joinRoom(opponent, room);
  joinRoom(client, room);
}

function handleStackingDrop(client: Client, revision: number) {
  const room = getRoomForClient(client);
  const match = room?.match;
  if (room === undefined || match == null || match.phase !== 'stacking') {
    rejectAction(client, '쌓기 단계가 아닙니다.');
    return;
  }
  if (revision !== match.revision || match.stackingTurnPlayerId !== client.id) {
    return rejectAction(client, '현재 쌓기 턴이 아니거나 상태가 오래되었습니다.');
  }
  match.revision += 1;
  match.stackingTurnPlayerId = room.players.find((player) => player.id !== client.id)?.id ?? null;
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
  match.revision += 1;
  match.stackingTurnPlayerId = null;
  match.whitePlayerId = whitePlayerId;
  broadcastRoom(room);
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
      match.winnerPlayerId = match.chess.turn() === 'b'
        ? match.whitePlayerId
        : room.players.find((player) => player.id !== match.whitePlayerId)?.id ?? null;
    }
  }
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

wss.on('connection', (socket) => {
  const client: Client = { id: createId(10), rating: null, roomId: null, socket };
  clients.set(socket, client);
  send(socket, { type: 'connected', clientId: client.id });

  socket.on('message', (data) => {
    const message = parseMessage(data);
    if (message === null) return rejectAction(client, '잘못된 메시지 형식입니다.');
    if (message.type === 'create_room') {
      const room: Room = { id: createId(), match: null, mode: 'private', players: [] };
      rooms.set(room.id, room);
      return joinRoom(client, room);
    }
    if (message.type === 'join_matchmaking') return joinMatchmaking(client, message.rating);
    if (message.type === 'join_room') {
      const room = rooms.get(message.roomId.toUpperCase());
      return room === undefined ? rejectAction(client, '방을 찾을 수 없습니다.') : joinRoom(client, room);
    }
    if (message.type === 'leave_room') return leaveRoom(client);
    if (message.type === 'stacking_drop') return handleStackingDrop(client, message.revision);
    if (message.type === 'start_chess') return handleStartChess(client, message.fen, message.whitePlayerId);
    if (message.type === 'chess_move') return handleChessMove(client, message);
    if (message.type === 'game_action') {
      const room = getRoomForClient(client);
      if (room === undefined) return rejectAction(client, '게임 액션을 보낼 방에 참가하지 않았습니다.');
      room.players.filter((player) => player.id !== client.id).forEach((player) => send(player.socket, { type: 'game_action', from: client.id, action: message.action }));
    }
  });

  socket.on('close', () => {
    leaveRoom(client);
    clients.delete(socket);
  });
});

httpServer.listen(port, () => {
  console.log(`STACKMATE WebSocket server listening on ws://localhost:${port}`);
});
