export const BOARD_SIZE = 8;
export type Player = "black" | "white";
export type Cell = Player | null;
export type Board = Cell[][];

export interface MoveResult {
  newBoard: Board;
  replaced: boolean;
  valid: boolean;
  flipped: { row: number; col: number }[]; // 現在は常に空（ひっくり返しなし）
}

export function createInitialBoard(): Board {
  const board: Board = Array(BOARD_SIZE)
    .fill(null)
    .map(() => Array(BOARD_SIZE).fill(null));
  board[3][3] = "white";
  board[3][4] = "black";
  board[4][3] = "black";
  board[4][4] = "white";
  return board;
}

/**
 * コマを置く。
 * - 空マス → 自分のコマを配置
 * - 相手のコマ → 1-1交換（ひっくり返しなし）
 * - 自分のコマ → invalid（呼び出し元でリダイレクト処理）
 */
export function applyMove(
  board: Board,
  row: number,
  col: number,
  player: Player
): MoveResult {
  if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) {
    return { newBoard: board, replaced: false, valid: false, flipped: [] };
  }
  if (board[row][col] === player) {
    return { newBoard: board, replaced: false, valid: false, flipped: [] };
  }
  const newBoard = board.map((r) => [...r]);
  const replaced = newBoard[row][col] !== null; // 相手コマを直接叩いた
  newBoard[row][col] = player;
  return { newBoard, replaced, valid: true, flipped: [] };
}

/**
 * 自分のコマに着弾したとき、最も近い「空きマスまたは相手コマ」を返す。
 * ユークリッド距離が最小のセルを選ぶ。
 */
export function findNearestValidCell(
  board: Board,
  row: number,
  col: number,
  player: Player
): { row: number; col: number } | null {
  const candidates: { row: number; col: number; dist: number }[] = [];
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (r === row && c === col) continue;
      if (board[r][c] !== player) {
        const dr = r - row, dc = c - col;
        candidates.push({ row: r, col: c, dist: dr * dr + dc * dc });
      }
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.dist - b.dist);
  return { row: candidates[0].row, col: candidates[0].col };
}

export function countPieces(board: Board): {
  black: number;
  white: number;
  empty: number;
} {
  let black = 0, white = 0, empty = 0;
  for (const row of board) {
    for (const cell of row) {
      if (cell === "black") black++;
      else if (cell === "white") white++;
      else empty++;
    }
  }
  return { black, white, empty };
}

export function isBoardFull(board: Board): boolean {
  return board.every((row) => row.every((cell) => cell !== null));
}

export function getWinner(board: Board): Player | "draw" | null {
  if (!isBoardFull(board)) return null;
  const { black, white } = countPieces(board);
  if (black > white) return "black";
  if (white > black) return "white";
  return "draw";
}

export function getCPUMove(
  board: Board,
  cpuPlayer: Player
): { row: number; col: number } | null {
  const opponent: Player = cpuPlayer === "black" ? "white" : "black";

  const opponentCells: { row: number; col: number }[] = [];
  const emptyCells: { row: number; col: number }[] = [];

  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (board[r][c] === opponent) opponentCells.push({ row: r, col: c });
      else if (board[r][c] === null) emptyCells.push({ row: r, col: c });
    }
  }

  if (opponentCells.length === 0 && emptyCells.length === 0) return null;

  // 70%の確率で相手コマを狙う
  if (opponentCells.length > 0 && Math.random() < 0.7) {
    return opponentCells[Math.floor(Math.random() * opponentCells.length)];
  }
  if (emptyCells.length > 0) {
    return emptyCells[Math.floor(Math.random() * emptyCells.length)];
  }
  return opponentCells[Math.floor(Math.random() * opponentCells.length)];
}
