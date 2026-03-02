export const BOARD_SIZE = 8;
export type BoardSize = 6 | 8;
export type Player = "black" | "white" | "red";
export type Cell = Player | null;
export type Board = Cell[][];

export interface MoveResult {
  newBoard: Board;
  replaced: boolean;
  valid: boolean;
  flipped: { row: number; col: number }[];
}

export function createInitialBoard(size: BoardSize = 8, playerCount: 2 | 3 = 2): Board {
  const board: Board = Array(size)
    .fill(null)
    .map(() => Array(size).fill(null));
  const h = size / 2 - 1;

  if (playerCount === 3) {
    // 3人: 各色2コマ、2×3の交互配置
    // (h, colStart)=B  (h, colStart+1)=W  (h, colStart+2)=R
    // (h+1, colStart)=R  (h+1, colStart+1)=B  (h+1, colStart+2)=W
    const colStart = size / 2 - 2;
    board[h][colStart]     = "black";
    board[h][colStart + 1] = "white";
    board[h][colStart + 2] = "red";
    board[h + 1][colStart]     = "red";
    board[h + 1][colStart + 1] = "black";
    board[h + 1][colStart + 2] = "white";
  } else {
    // 2人: 通常オセロ配置
    board[h][h]         = "white";
    board[h][h + 1]     = "black";
    board[h + 1][h]     = "black";
    board[h + 1][h + 1] = "white";
  }
  return board;
}

export function getTurnLimit(size: BoardSize, playerCount: 2 | 3 = 2): number {
  if (playerCount === 3) return size === 6 ? 30 : 58;
  return size === 6 ? 34 : 62;
}

export function determineWinner(board: Board): Player | "draw" {
  const { black, white, red } = countPieces(board);
  const max = Math.max(black, white, red);
  const tied = [black === max, white === max, red === max].filter(Boolean).length;
  if (tied > 1) return "draw";
  if (black === max) return "black";
  if (white === max) return "white";
  return "red";
}

/**
 * コマを置く。
 * - 空マス → 自分のコマを配置 ＋ 挟んだ相手コマをひっくり返す（自色同士で挟めばどの色でも反転）
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
  // 自色同士で挟まれたコマはすべて（何色でも）ひっくり返す
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
    // 自分以外のコマが続く間進む（どの色でも対象）
    while (r >= 0 && r < size && c >= 0 && c < size && newBoard[r][c] !== null && newBoard[r][c] !== player) {
      line.push({ row: r, col: c });
      r += dr;
      c += dc;
    }
    // 自分のコマで挟まれていれば反転
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
  red: number;
  empty: number;
} {
  let black = 0, white = 0, red = 0, empty = 0;
  for (const row of board) {
    for (const cell of row) {
      if (cell === "black") black++;
      else if (cell === "white") white++;
      else if (cell === "red") red++;
      else empty++;
    }
  }
  return { black, white, red, empty };
}

export function isBoardFull(board: Board): boolean {
  return board.every((row) => row.every((cell) => cell !== null));
}

export function getWinner(board: Board): Player | "draw" | null {
  if (!isBoardFull(board)) return null;
  return determineWinner(board);
}

export function getCPUMove(
  board: Board,
  cpuPlayer: Player
): { row: number; col: number } | null {
  const opponentCells: { row: number; col: number }[] = [];
  const emptyCells: { row: number; col: number }[] = [];

  const size = board.length;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (board[r][c] !== null && board[r][c] !== cpuPlayer) {
        opponentCells.push({ row: r, col: c });
      } else if (board[r][c] === null) {
        emptyCells.push({ row: r, col: c });
      }
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
