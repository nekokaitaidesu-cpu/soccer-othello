export const BOARD_SIZE = 8;
export type BoardSize = 6 | 8;
export type Player = "black" | "white";
export type Cell = Player | null;
export type Board = Cell[][];

export interface MoveResult {
  newBoard: Board;
  replaced: boolean;
  valid: boolean;
  flipped: { row: number; col: number }[]; // 現在は常に空（ひっくり返しなし）
}

export function createInitialBoard(size: BoardSize = 8): Board {
  const board: Board = Array(size)
    .fill(null)
    .map(() => Array(size).fill(null));
  const h = size / 2 - 1;
  board[h][h] = "white";
  board[h][h + 1] = "black";
  board[h + 1][h] = "black";
  board[h + 1][h + 1] = "white";
  return board;
}

export function getTurnLimit(size: BoardSize): number {
  return size === 6 ? 34 : 62;
}

export function determineWinner(board: Board): Player | "draw" {
  const { black, white } = countPieces(board);
  if (black > white) return "black";
  if (white > black) return "white";
  return "draw";
}

/**
 * コマを置く。
 * - 空マス → 自分のコマを配置 ＋ 挟んだ相手コマをひっくり返す（標準オセロルール）
 * - 相手のコマ → 1-1直接交換のみ（ひっくり返しなし）
 * - 自分のコマ → invalid（呼び出し元でリダイレクト処理）
 */
export function applyMove(
  board: Board,
  row: number,
  col: number,
  player: Player
): MoveResult {
  const size = board.length;
  if (row < 0 || row >= size || col < 0 || col >= size) {
    return { newBoard: board, replaced: false, valid: false, flipped: [] };
  }
  if (board[row][col] === player) {
    return { newBoard: board, replaced: false, valid: false, flipped: [] };
  }

  const newBoard = board.map((r) => [...r]);
  const replaced = newBoard[row][col] !== null; // 相手コマを直接叩いた
  newBoard[row][col] = player;

  // 相手コマへの直接着弾はひっくり返しなし（1-1交換のみ）
  if (replaced) {
    return { newBoard, replaced: true, valid: true, flipped: [] };
  }

  // 空マスへの着弾 → 8方向を確認してオセロのひっくり返し処理
  const opponent: Player = player === "black" ? "white" : "black";
  const directions = [
    [-1, -1], [-1, 0], [-1, 1],
    [0, -1],           [0, 1],
    [1, -1],  [1, 0],  [1, 1],
  ];
  const flipped: { row: number; col: number }[] = [];

  for (const [dr, dc] of directions) {
    const line: { row: number; col: number }[] = [];
    let r = row + dr;
    let c = col + dc;
    while (r >= 0 && r < size && c >= 0 && c < size && newBoard[r][c] === opponent) {
      line.push({ row: r, col: c });
      r += dr;
      c += dc;
    }
    // 相手コマが1枚以上あり、自分のコマで挟まれていれば反転
    if (line.length > 0 && r >= 0 && r < size && c >= 0 && c < size && newBoard[r][c] === player) {
      for (const cell of line) {
        newBoard[cell.row][cell.col] = player;
        flipped.push(cell);
      }
    }
  }

  return { newBoard, replaced: false, valid: true, flipped };
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
  const size = board.length;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
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

  const size = board.length;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
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
