"use client";

import {
  useRef,
  useEffect,
  useState,
  useCallback,
  useImperativeHandle,
  forwardRef,
} from "react";
import {
  Board,
  BoardSize,
  Player,
  createInitialBoard,
  applyMove,
  countPieces,
  getWinner,
  getTurnLimit,
  determineWinner,
  getCPUMove,
} from "@/lib/gameLogic";

// ============================================================
// 型定義
// ============================================================
export interface GameCanvasHandle {
  applyExternalMove: (row: number, col: number) => void;
}

export type Sensitivity = 1 | 2 | 3;
export type Difficulty = "easy" | "normal" | "hard" | "oni";

export interface GameCanvasProps {
  mode: "solo" | "cpu" | "online";
  myColor?: Player;
  boardSize?: BoardSize;
  sensitivity?: Sensitivity;
  difficulty?: Difficulty;
  playerCount?: 2 | 3;
  onMove?: (row: number, col: number) => void;
}

const SENSITIVITY_SCALE: Record<Sensitivity, number> = {
  1: 4,   // 頑張って投げる（おすすめ）
  2: 5.5, // 普通に投げる
  3: 7,   // 簡単に遠くへ飛ぶ
};

// ターン順（3人対応）
function getNextPlayer(current: Player, playerCount: number): Player {
  if (playerCount === 2) return current === "black" ? "white" : "black";
  if (current === "black") return "white";
  if (current === "white") return "red";
  return "black";
}

interface FlyingPiece {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  opacity: number;
  radius: number;
  color: Player;
}

/** 放物線アニメーション */
interface BallAnim {
  active: boolean;
  startX: number;
  startY: number;
  targetX: number;
  targetY: number;
  progress: number;
  duration: number;
  arcH: number;
  targetRow: number;
  targetCol: number;
  player: Player;
  isOffBoard?: boolean;
}

/** 煙パーティクル */
interface SmokeParticle {
  id: number;
  x: number; y: number;
  offsetX: number; offsetY: number;
  maxRadius: number;
  startTime: number;
  duration: number;
}

/** テキストポップ */
interface TextPop {
  id: number;
  x: number; y: number;
  text: string;
  startTime: number;
  duration: number;
}

type GamePhase =
  | "idle"
  | "aiming"
  | "flying"
  | "impact"
  | "cpu_thinking"
  | "gameover";

// ============================================================
// 定数
// ============================================================
const HEADER_H = 52;
const BALL_AREA_RATIO = 0.42;
const BALL_REST_Y_RATIO = 0.6;
const BALL_RADIUS_RATIO = 0.07;
const MAX_CANVAS_W = 480;
const IMPACT_DURATION = 350;
const CPU_THINK_DELAY = 700;
const GRAVITY = 0.3;
const VELOCITY_SCALE = 4;
const ARC_FACTOR = 0.6;
const ARC_BASE = 60;

// ============================================================
// 着弾セル計算（スワイプ速度 → row/col）
// ============================================================
function computeTargetFromVelocity(
  dragX: number,
  vx: number,
  vy: number,
  boardSize: number,
  L: {
    ballRestY: number;
    boardX: number; boardY: number; boardH: number;
    cellSize: number;
  }
): { row: number; col: number } {
  const boardBottom = L.boardY + L.boardH;
  const heightDiff = L.ballRestY - boardBottom;

  const v0BoardSq = vy * vy - 2 * GRAVITY * heightDiff;
  let row: number;
  let tToCross: number;

  if (v0BoardSq <= 0) {
    row = boardSize - 1;
    tToCross = -vy / GRAVITY;
  } else {
    const v0Board = Math.sqrt(v0BoardSq);
    const maxReach = (v0Board * v0Board) / (2 * GRAVITY);
    row = Math.max(0, Math.min(boardSize - 1, Math.floor((L.boardH - maxReach) / L.cellSize)));
    tToCross = (-vy - v0Board) / GRAVITY;
  }

  const xAtCross = dragX + vx * tToCross;
  const col = Math.max(0, Math.min(boardSize - 1, Math.floor((xAtCross - L.boardX) / L.cellSize)));
  return { row, col };
}

// ============================================================
// 描画ユーティリティ
// ============================================================
function drawRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number
) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function pieceColors(player: Player): { light: string; dark: string; stroke: string } {
  if (player === "black") return { light: "#666", dark: "#111", stroke: "#333" };
  if (player === "white") return { light: "#ffffff", dark: "#cccccc", stroke: "#999" };
  // red
  return { light: "#ff8888", dark: "#cc0000", stroke: "#880000" };
}

function drawPiece(
  ctx: CanvasRenderingContext2D,
  x: number, y: number,
  radius: number,
  player: Player,
  alpha = 1,
  scale = 1
) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  ctx.scale(scale, scale);

  ctx.shadowColor = "rgba(0,0,0,0.5)";
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 3;

  const grad = ctx.createRadialGradient(
    -radius * 0.3, -radius * 0.35, radius * 0.05,
    0, 0, radius
  );
  const pc = pieceColors(player);
  grad.addColorStop(0, pc.light);
  grad.addColorStop(1, pc.dark);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.shadowColor = "transparent";
  ctx.strokeStyle = pc.stroke;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.restore();
}

function drawSoccerBall(
  ctx: CanvasRenderingContext2D,
  x: number, y: number,
  radius: number,
  rotation = 0
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rotation);

  ctx.shadowColor = "rgba(0,0,0,0.4)";
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 6;

  const sphereGrad = ctx.createRadialGradient(
    -radius * 0.3, -radius * 0.35, radius * 0.05,
    0, 0, radius
  );
  sphereGrad.addColorStop(0, "#ffffff");
  sphereGrad.addColorStop(0.7, "#e8e8e8");
  sphereGrad.addColorStop(1, "#bbb");

  ctx.fillStyle = sphereGrad;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.shadowColor = "transparent";
  ctx.fillStyle = "#1a1a1a";
  ctx.strokeStyle = "#1a1a1a";
  ctx.lineWidth = 1;

  drawPentagon(ctx, 0, 0, radius * 0.28);
  for (let i = 0; i < 5; i++) {
    const angle = (i * 2 * Math.PI) / 5 - Math.PI / 2;
    drawPentagon(ctx, Math.cos(angle) * radius * 0.58, Math.sin(angle) * radius * 0.58, radius * 0.22);
  }

  ctx.strokeStyle = "#333";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.stroke();

  ctx.restore();
}

function drawPentagon(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  ctx.beginPath();
  for (let i = 0; i < 5; i++) {
    const angle = (i * 2 * Math.PI) / 5 - Math.PI / 2;
    if (i === 0) ctx.moveTo(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
    else ctx.lineTo(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
  }
  ctx.closePath();
  ctx.fill();
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

// ============================================================
// GameCanvas コンポーネント
// ============================================================
const GameCanvas = forwardRef<GameCanvasHandle, GameCanvasProps>(
  function GameCanvas({ mode, myColor = "black", boardSize = 6, sensitivity = 1, difficulty = "normal", playerCount = 2, onMove }, ref) {
    const velocityScale = SENSITIVITY_SCALE[sensitivity];
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    const boardSizeRef = useRef<BoardSize>(boardSize);
    const playerCountRef = useRef<2 | 3>(playerCount);
    const boardRef = useRef<Board>(createInitialBoard(boardSize, playerCount));
    const currentPlayerRef = useRef<Player>("black");

    const gamePhaseRef = useRef<GamePhase>("idle");
    const flyingPiecesRef = useRef<FlyingPiece[]>([]);
    const ballAnimRef = useRef<BallAnim>({
      active: false,
      startX: 0, startY: 0,
      targetX: 0, targetY: 0,
      progress: 0, duration: 500, arcH: 100,
      targetRow: 0, targetCol: 0, player: "black",
    });
    const ballRotationRef = useRef(0);
    const impactTimerRef = useRef(0);
    const impactCellRef = useRef<{ row: number; col: number } | null>(null);
    const flyPieceIdRef = useRef(0);
    const moveCountRef = useRef(0);
    const winnerRef = useRef<Player | "draw" | null>(null);
    const flippedCellsRef = useRef<{ row: number; col: number; startTime: number }[]>([]);
    const smokeParticlesRef = useRef<SmokeParticle[]>([]);
    const textPopsRef = useRef<TextPop[]>([]);
    const popIdRef = useRef(0);

    const isDraggingRef = useRef(false);
    const ballDragPosRef = useRef({ x: 0, y: 0 });
    const dragHistoryRef = useRef<{ x: number; y: number; t: number }[]>([]);

    const layoutRef = useRef({
      canvasW: 360, canvasH: 600,
      cellSize: 45,
      boardX: 0, boardY: HEADER_H,
      boardW: 360, boardH: 360,
      ballAreaY: HEADER_H + 360, ballAreaH: 160,
      ballRestX: 180, ballRestY: HEADER_H + 360 + 96,
      ballRadius: 25,
    });

    const initCounts = countPieces(createInitialBoard(boardSize, playerCount));
    const [displayState, setDisplayState] = useState({
      board: createInitialBoard(boardSize, playerCount) as Board,
      currentPlayer: "black" as Player,
      phase: "idle" as GamePhase,
      blackCount: initCounts.black,
      whiteCount: initCounts.white,
      redCount: initCounts.red,
      winner: null as Player | "draw" | null,
      message: "",
      moveCount: 0,
      turnLimit: getTurnLimit(boardSize, playerCount),
    });

    const lastRenderTime = useRef(0);
    const animFrameRef = useRef(0);
    const onMoveRef = useRef(onMove);
    useEffect(() => { onMoveRef.current = onMove; }, [onMove]);

    // ============================================================
    // レイアウト計算
    // ============================================================
    const calcLayout = useCallback(() => {
      const container = containerRef.current;
      if (!container) return;
      const bs = boardSizeRef.current;
      const w = Math.min(container.clientWidth, MAX_CANVAS_W);
      const cellSize = Math.floor(w / bs);
      const boardW = cellSize * bs;
      const ballAreaH = Math.floor(boardW * BALL_AREA_RATIO);
      const ballRadius = Math.floor(boardW * BALL_RADIUS_RATIO);
      const canvasW = boardW;
      const canvasH = HEADER_H + boardW + ballAreaH;
      const boardX = 0;
      const boardY = HEADER_H;
      const ballAreaY = boardY + boardW;
      const ballRestX = canvasW / 2;
      const ballRestY = ballAreaY + ballAreaH * BALL_REST_Y_RATIO;

      layoutRef.current = {
        canvasW, canvasH, cellSize,
        boardX, boardY, boardW, boardH: boardW,
        ballAreaY, ballAreaH, ballRestX, ballRestY, ballRadius,
      };

      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = canvasW;
        canvas.height = canvasH;
      }
    }, []);

    // ============================================================
    // displayState 同期
    // ============================================================
    function syncDisplayState(msg?: string) {
      const { black, white, red } = countPieces(boardRef.current);
      const winner = winnerRef.current ?? getWinner(boardRef.current);
      const phase = gamePhaseRef.current;
      const cp = currentPlayerRef.current;
      const mc = moveCountRef.current;
      const pc = playerCountRef.current;
      const tl = getTurnLimit(boardSizeRef.current, pc);

      let message = msg ?? "";
      if (!msg) {
        if (phase === "gameover") {
          message = winner === "draw" ? "引き分け！"
            : winner === "black" ? "黒の勝ち！"
            : winner === "white" ? "白の勝ち！"
            : "赤の勝ち！";
        } else if (phase === "cpu_thinking") {
          message = "CPUが考え中...";
        } else if (mode === "online") {
          message = cp === myColor ? "あなたのターン" : "相手のターン待ち";
        } else {
          message = cp === "black" ? "⚫ 黒のターン"
            : cp === "white" ? "⚪ 白のターン"
            : "🔴 赤のターン";
        }
      }

      setDisplayState({
        board: boardRef.current.map((r) => [...r]) as Board,
        currentPlayer: cp, phase,
        blackCount: black, whiteCount: white, redCount: red, winner, message,
        moveCount: mc, turnLimit: tl,
      });
    }

    // ============================================================
    // 放物線アーク開始（CPU / オンライン用）
    // ============================================================
    const throwBall = useCallback((row: number, col: number, player: Player) => {
      const L = layoutRef.current;
      const targetX = L.boardX + col * L.cellSize + L.cellSize / 2;
      const targetY = L.boardY + row * L.cellSize + L.cellSize / 2;
      const vertDist = L.ballRestY - targetY;
      const arcH = Math.max(ARC_BASE, vertDist * ARC_FACTOR + ARC_BASE);
      const duration = 380 + vertDist * 0.85;

      ballAnimRef.current = {
        active: true,
        startX: L.ballRestX, startY: L.ballRestY,
        targetX, targetY,
        progress: 0, duration, arcH,
        targetRow: row, targetCol: col, player,
      };
      ballRotationRef.current = 0;
      gamePhaseRef.current = "flying";
    }, []);

    // ============================================================
    // CPU投球（難易度に応じたノイズ付き）
    // ============================================================
    const fireCPUThrow = useCallback((next: Player) => {
      const bs = boardSizeRef.current;
      const cpuMove = getCPUMove(boardRef.current, next);
      if (!cpuMove) return;
      let nRow = cpuMove.row;
      let nCol = cpuMove.col;

      if (difficulty === "easy") {
        nRow = Math.floor(Math.random() * bs);
        nCol = Math.floor(Math.random() * bs);
      } else if (difficulty === "normal") {
        const r = Math.random();
        if (r > 0.4) {
          const amt = r > 0.8 ? 2 : 1;
          nRow = Math.max(0, Math.min(bs - 1, cpuMove.row + Math.round((Math.random() - 0.5) * 2 * amt)));
          nCol = Math.max(0, Math.min(bs - 1, cpuMove.col + Math.round((Math.random() - 0.5) * 2 * amt)));
        }
      } else if (difficulty === "hard") {
        const r = Math.random();
        if (r > 0.8) {
          const amt = r > 0.95 ? 2 : 1;
          nRow = Math.max(0, Math.min(bs - 1, cpuMove.row + Math.round((Math.random() - 0.5) * 2 * amt)));
          nCol = Math.max(0, Math.min(bs - 1, cpuMove.col + Math.round((Math.random() - 0.5) * 2 * amt)));
        }
      }
      // "oni": ノイズなし

      throwBall(nRow, nCol, next);
    }, [difficulty, throwBall]);

    // ============================================================
    // 着弾処理
    // ============================================================
    const handleImpact = useCallback(
      (row: number, col: number, player: Player) => {
        const result = applyMove(boardRef.current, row, col, player);

        if (!result.valid) {
          // 自分のコマに着弾 → 上下左右ランダムに1マス移動
          const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const;
          const [dr, dc] = DIRS[Math.floor(Math.random() * 4)];
          const nextRow = row + dr;
          const nextCol = col + dc;
          const bs = boardSizeRef.current;
          const L = layoutRef.current;
          const startX = L.boardX + col * L.cellSize + L.cellSize / 2;
          const startY = L.boardY + row * L.cellSize + L.cellSize / 2;

          if (nextRow < 0 || nextRow >= bs || nextCol < 0 || nextCol >= bs) {
            let edgeX: number;
            let edgeY: number;
            let edgeArcH: number;
            if (dc !== 0) {
              edgeX = dc < 0
                ? L.boardX + L.ballRadius
                : L.boardX + L.boardW - L.ballRadius;
              edgeY = startY;
              edgeArcH = 0;
            } else {
              edgeX = startX;
              edgeY = dr < 0
                ? L.boardY + L.ballRadius
                : L.boardY + L.boardH - L.ballRadius;
              edgeArcH = L.cellSize * 0.3;
            }
            ballAnimRef.current = {
              active: true,
              startX, startY, targetX: edgeX, targetY: edgeY,
              progress: 0, duration: 200, arcH: edgeArcH,
              targetRow: nextRow, targetCol: nextCol, player,
              isOffBoard: true,
            };
            gamePhaseRef.current = "flying";
          } else {
            const targetX = L.boardX + nextCol * L.cellSize + L.cellSize / 2;
            const targetY = L.boardY + nextRow * L.cellSize + L.cellSize / 2;
            const dist = Math.hypot(targetX - startX, targetY - startY);
            ballAnimRef.current = {
              active: true,
              startX, startY, targetX, targetY,
              progress: 0,
              duration: 160 + dist * 0.3,
              arcH: Math.max(12, dist * 0.18),
              targetRow: nextRow, targetCol: nextCol, player,
            };
            gamePhaseRef.current = "flying";
          }
          return;
        }

        // 相手コマを叩いた → 吹き飛ばしエフェクト
        if (result.replaced) {
          const L = layoutRef.current;
          const px = L.boardX + col * L.cellSize + L.cellSize / 2;
          const py = L.boardY + row * L.cellSize + L.cellSize / 2;
          // 元の盤面から叩かれたコマの色を取得（boardRef はまだ更新前）
          const replacedColor = boardRef.current[row][col] as Player;
          const angle = Math.random() * Math.PI * 2;
          const speed = 8 + Math.random() * 6;
          flyingPiecesRef.current.push({
            id: flyPieceIdRef.current++,
            x: px, y: py,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed - 4,
            opacity: 1,
            radius: layoutRef.current.cellSize * 0.38,
            color: replacedColor,
          });
        }

        // online: 最終着弾マスが確定したここで送信
        if (mode === "online" && player === myColor) {
          onMoveRef.current?.(row, col);
        }

        boardRef.current = result.newBoard;
        moveCountRef.current += 1;
        impactCellRef.current = { row, col };

        if (result.flipped.length > 0) {
          const now = Date.now();
          flippedCellsRef.current = result.flipped.map((cell) => ({
            ...cell, startTime: now,
          }));
        }
        gamePhaseRef.current = "impact";
        impactTimerRef.current = Date.now();
        ballAnimRef.current.active = false;

        const pc = playerCountRef.current;
        const turnLimit = getTurnLimit(boardSizeRef.current, pc);
        const boardFull = getWinner(boardRef.current);
        const turnLimitReached = moveCountRef.current >= turnLimit;

        if (boardFull || turnLimitReached) {
          winnerRef.current = determineWinner(boardRef.current);
          setTimeout(() => {
            gamePhaseRef.current = "gameover";
            syncDisplayState();
          }, IMPACT_DURATION);
          return;
        }

        setTimeout(() => {
          const next = getNextPlayer(player, playerCountRef.current);
          currentPlayerRef.current = next;
          gamePhaseRef.current = "idle";
          impactCellRef.current = null;

          if (mode === "cpu" && next !== myColor) {
            gamePhaseRef.current = "cpu_thinking";
            syncDisplayState();
            setTimeout(() => fireCPUThrow(next), CPU_THINK_DELAY);
          } else {
            syncDisplayState();
          }
        }, IMPACT_DURATION);
      },
      [mode, myColor, throwBall, fireCPUThrow]
    );

    // ============================================================
    // 外部からの着弾（ONLINEモード）
    // ============================================================
    useImperativeHandle(ref, () => ({
      applyExternalMove(row: number, col: number) {
        if (gamePhaseRef.current !== "idle") return;
        if (row === -1 && col === -1) {
          currentPlayerRef.current = myColor;
          gamePhaseRef.current = "idle";
          syncDisplayState();
          return;
        }
        const opponent: Player = myColor === "black" ? "white" : "black";
        throwBall(row, col, opponent);
      },
    }));

    // ============================================================
    // ポインター座標変換
    // ============================================================
    const getCanvasPos = useCallback(
      (e: PointerEvent): { x: number; y: number } => {
        const canvas = canvasRef.current;
        if (!canvas) return { x: 0, y: 0 };
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        return {
          x: (e.clientX - rect.left) * scaleX,
          y: (e.clientY - rect.top) * scaleY,
        };
      },
      []
    );

    const isNearBall = useCallback((cx: number, cy: number): boolean => {
      const L = layoutRef.current;
      const dx = cx - L.ballRestX;
      const dy = cy - L.ballRestY;
      return Math.sqrt(dx * dx + dy * dy) <= L.ballRadius * 3;
    }, []);

    const canInteract = useCallback((): boolean => {
      const phase = gamePhaseRef.current;
      if (phase !== "idle" && phase !== "aiming") return false;
      if (mode === "online" && currentPlayerRef.current !== myColor) return false;
      if (mode === "cpu" && currentPlayerRef.current !== myColor) return false;
      return true;
    }, [mode, myColor]);

    // ============================================================
    // アニメーションループ
    // ============================================================
    const animate = useCallback(
      (timestamp: number) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const dt = Math.min(timestamp - lastRenderTime.current, 50);
        lastRenderTime.current = timestamp;

        const L = layoutRef.current;
        const phase = gamePhaseRef.current;
        const bs = boardSizeRef.current;

        // 放物線アーク更新
        if (phase === "flying" && ballAnimRef.current.active) {
          const anim = ballAnimRef.current;
          anim.progress = Math.min(1, anim.progress + dt / anim.duration);
          ballRotationRef.current += 0.13;
          if (anim.progress >= 1) {
            if (anim.isOffBoard) {
              const ex = anim.targetX;
              const ey = anim.targetY;
              const pid = popIdRef.current++;
              const offAnim = ballAnimRef.current;
              const spreadDx = offAnim.targetX - offAnim.startX;
              const spreadDy = offAnim.targetY - offAnim.startY;
              const isHoriz = Math.abs(spreadDx) > Math.abs(spreadDy);
              for (let i = 0; i < 10; i++) {
                const perpX = isHoriz ? (Math.random() - 0.5) * 40 : (Math.random() - 0.5) * 16;
                const perpY = isHoriz ? (Math.random() - 0.5) * 16 : (Math.random() - 0.5) * 40;
                smokeParticlesRef.current.push({
                  id: pid * 100 + i,
                  x: ex, y: ey,
                  offsetX: perpX,
                  offsetY: perpY,
                  maxRadius: 10 + Math.random() * 16,
                  startTime: Date.now(),
                  duration: 700 + Math.random() * 300,
                });
              }
              textPopsRef.current.push({
                id: pid,
                x: ex, y: ey - 16,
                text: "ボスン",
                startTime: Date.now(),
                duration: 900,
              });
              ballAnimRef.current.active = false;
              const next = getNextPlayer(anim.player, playerCountRef.current);
              currentPlayerRef.current = next;
              gamePhaseRef.current = "idle";
              if (mode === "online" && anim.player === myColor) {
                onMoveRef.current?.(-1, -1);
              }
              if (mode === "cpu" && next !== myColor) {
                gamePhaseRef.current = "cpu_thinking";
                syncDisplayState();
                setTimeout(() => fireCPUThrow(next), CPU_THINK_DELAY);
              } else {
                syncDisplayState();
              }
            } else {
              handleImpact(anim.targetRow, anim.targetCol, anim.player);
            }
          }
        }

        if (phase === "aiming") {
          ballRotationRef.current += 0.04;
        }

        // 飛び散るコマ更新
        flyingPiecesRef.current = flyingPiecesRef.current
          .map((fp) => ({
            ...fp,
            x: fp.x + fp.vx,
            y: fp.y + fp.vy,
            vy: fp.vy + 0.5,
            opacity: fp.opacity - 0.025,
          }))
          .filter((fp) => fp.opacity > 0);

        // ============================================================
        // 描画
        // ============================================================
        ctx.clearRect(0, 0, L.canvasW, L.canvasH);

        drawHeader(ctx, L, bs);
        drawBoard(ctx, L, bs);

        // コマ描画
        const FLIP_DURATION = 400;
        const now = Date.now();
        flippedCellsRef.current = flippedCellsRef.current.filter(
          (f) => now - f.startTime < FLIP_DURATION
        );
        const board = boardRef.current;
        for (let r = 0; r < bs; r++) {
          for (let c = 0; c < bs; c++) {
            const cell = board[r][c];
            if (!cell) continue;
            const cx = L.boardX + c * L.cellSize + L.cellSize / 2;
            const cy = L.boardY + r * L.cellSize + L.cellSize / 2;

            let impactScale = 1;
            const ic = impactCellRef.current;
            if (ic && ic.row === r && ic.col === c && phase === "impact") {
              const elapsed = now - impactTimerRef.current;
              impactScale = 1 + 0.35 * Math.sin((elapsed / IMPACT_DURATION) * Math.PI);
            }

            const flipInfo = flippedCellsRef.current.find((f) => f.row === r && f.col === c);
            if (flipInfo) {
              const t = (now - flipInfo.startTime) / FLIP_DURATION;
              const scaleX = Math.abs(Math.cos(t * Math.PI));
              ctx.save();
              ctx.translate(cx, cy);
              ctx.scale(scaleX * impactScale, impactScale);
              const pc = pieceColors(cell);
              const grad = ctx.createRadialGradient(
                -L.cellSize * 0.38 * 0.3, -L.cellSize * 0.38 * 0.35, L.cellSize * 0.38 * 0.05,
                0, 0, L.cellSize * 0.38
              );
              grad.addColorStop(0, pc.light);
              grad.addColorStop(1, pc.dark);
              ctx.shadowColor = "rgba(0,0,0,0.5)"; ctx.shadowBlur = 6; ctx.shadowOffsetY = 3;
              ctx.fillStyle = grad;
              ctx.beginPath();
              ctx.arc(0, 0, L.cellSize * 0.38, 0, Math.PI * 2);
              ctx.fill();
              ctx.shadowColor = "transparent";
              ctx.strokeStyle = pc.stroke;
              ctx.lineWidth = 1.5;
              ctx.stroke();
              ctx.restore();
            } else {
              drawPiece(ctx, cx, cy, L.cellSize * 0.38, cell, 1, impactScale);
            }
          }
        }

        // 飛び散るコマ
        for (const fp of flyingPiecesRef.current) {
          drawPiece(ctx, fp.x, fp.y, fp.radius, fp.color, fp.opacity);
        }

        // 煙パーティクル
        const nowSmoke = Date.now();
        smokeParticlesRef.current = smokeParticlesRef.current.filter(
          (p) => nowSmoke - p.startTime < p.duration
        );
        for (const p of smokeParticlesRef.current) {
          const t = (nowSmoke - p.startTime) / p.duration;
          const rr = p.maxRadius * Math.sqrt(t);
          ctx.save();
          ctx.globalAlpha = 0.7 * (1 - t);
          ctx.fillStyle = "#aaaaaa";
          ctx.beginPath();
          ctx.arc(p.x + p.offsetX * t, p.y + p.offsetY * t, rr, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }

        // テキストポップ（ボスン）
        textPopsRef.current = textPopsRef.current.filter(
          (p) => nowSmoke - p.startTime < p.duration
        );
        for (const tp of textPopsRef.current) {
          const t = (nowSmoke - tp.startTime) / tp.duration;
          const rise = 28 * t;
          const alpha = t < 0.3 ? t / 0.3 : 1 - (t - 0.3) / 0.7;
          ctx.save();
          ctx.globalAlpha = alpha;
          ctx.font = `bold ${L.cellSize * 0.5}px sans-serif`;
          ctx.fillStyle = "#ffffff";
          ctx.strokeStyle = "rgba(0,0,0,0.7)";
          ctx.lineWidth = 3;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.strokeText(tp.text, tp.x, tp.y - rise);
          ctx.fillText(tp.text, tp.x, tp.y - rise);
          ctx.restore();
        }

        // ボールエリア背景
        drawBallArea(ctx, L);

        // ボール描画
        if (phase === "flying" && ballAnimRef.current.active) {
          const anim = ballAnimRef.current;
          const t = anim.progress;
          const bx = lerp(anim.startX, anim.targetX, t);
          const by = lerp(anim.startY, anim.targetY, t) - anim.arcH * Math.sin(t * Math.PI);
          drawSoccerBall(ctx, bx, by, L.ballRadius, ballRotationRef.current);
        } else if (phase === "aiming") {
          const dp = ballDragPosRef.current;
          drawSoccerBall(ctx, dp.x, dp.y, L.ballRadius, ballRotationRef.current);
        } else {
          drawSoccerBall(ctx, L.ballRestX, L.ballRestY, L.ballRadius, ballRotationRef.current);
        }

        drawBallAreaUI(ctx, L, phase, bs);

        animFrameRef.current = requestAnimationFrame(animate);
      },
      [handleImpact]
    );

    // ============================================================
    // ヘッダー描画
    // ============================================================
    function drawHeader(ctx: CanvasRenderingContext2D, L: typeof layoutRef.current, bs: BoardSize) {
      ctx.fillStyle = "#0d3d0d";
      ctx.fillRect(0, 0, L.canvasW, HEADER_H);

      const { black, white, red } = countPieces(boardRef.current);
      const cp = currentPlayerRef.current;
      const mc = moveCountRef.current;
      const pc = playerCountRef.current;
      const tl = getTurnLimit(bs, pc);
      ctx.save();

      if (pc === 3) {
        // 3人: 3等分表示
        const slotW = L.canvasW / 3;
        const players: { p: Player; label: string; count: number }[] = [
          { p: "black", label: "黒", count: black },
          { p: "white", label: "白", count: white },
          { p: "red",   label: "赤", count: red },
        ];
        players.forEach(({ p, label, count }, i) => {
          const active = cp === p;
          const x = i * slotW + 4;
          const w = slotW - 8;
          if (p === "black") ctx.fillStyle = active ? "rgba(0,0,0,0.8)" : "rgba(0,0,0,0.4)";
          else if (p === "white") ctx.fillStyle = active ? "rgba(60,60,60,0.8)" : "rgba(40,40,40,0.4)";
          else ctx.fillStyle = active ? "rgba(180,0,0,0.7)" : "rgba(100,0,0,0.3)";
          drawRoundRect(ctx, x, 6, w, HEADER_H - 12, 7);
          ctx.fill();
          if (active) {
            ctx.strokeStyle = "#4ade80"; ctx.lineWidth = 2;
            drawRoundRect(ctx, x, 6, w, HEADER_H - 12, 7);
            ctx.stroke();
          }
          drawPiece(ctx, x + 16, HEADER_H / 2, 9, p);
          ctx.fillStyle = active ? "#ffffff" : "#aaaaaa";
          ctx.font = `bold ${Math.floor(HEADER_H * 0.4)}px sans-serif`;
          ctx.textAlign = "left"; ctx.textBaseline = "middle";
          ctx.fillText(`${label} ${count}`, x + 30, HEADER_H / 2);
        });
      } else {
        // 2人: 左右半分
        const blackActive = cp === "black";
        ctx.fillStyle = blackActive ? "rgba(0,0,0,0.8)" : "rgba(0,0,0,0.4)";
        drawRoundRect(ctx, 8, 8, L.canvasW / 2 - 16, HEADER_H - 16, 8);
        ctx.fill();
        if (blackActive) {
          ctx.strokeStyle = "#4ade80"; ctx.lineWidth = 2;
          drawRoundRect(ctx, 8, 8, L.canvasW / 2 - 16, HEADER_H - 16, 8);
          ctx.stroke();
        }
        drawPiece(ctx, 28, HEADER_H / 2, 10, "black");
        ctx.fillStyle = blackActive ? "#ffffff" : "#aaaaaa";
        ctx.font = `bold ${Math.floor(HEADER_H * 0.45)}px sans-serif`;
        ctx.textAlign = "left"; ctx.textBaseline = "middle";
        ctx.fillText(`黒 ${black}`, 44, HEADER_H / 2);

        const whiteActive = cp === "white";
        ctx.fillStyle = whiteActive ? "rgba(60,60,60,0.8)" : "rgba(40,40,40,0.4)";
        drawRoundRect(ctx, L.canvasW / 2 + 8, 8, L.canvasW / 2 - 16, HEADER_H - 16, 8);
        ctx.fill();
        if (whiteActive) {
          ctx.strokeStyle = "#4ade80"; ctx.lineWidth = 2;
          drawRoundRect(ctx, L.canvasW / 2 + 8, 8, L.canvasW / 2 - 16, HEADER_H - 16, 8);
          ctx.stroke();
        }
        drawPiece(ctx, L.canvasW / 2 + 28, HEADER_H / 2, 10, "white");
        ctx.fillStyle = whiteActive ? "#ffffff" : "#aaaaaa";
        ctx.font = `bold ${Math.floor(HEADER_H * 0.45)}px sans-serif`;
        ctx.textAlign = "left";
        ctx.fillText(`白 ${white}`, L.canvasW / 2 + 44, HEADER_H / 2);
      }

      // 手数・感度表示
      ctx.font = `${Math.floor(HEADER_H * 0.28)}px sans-serif`;
      ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.textAlign = "center";
      ctx.fillText(`${mc}/${tl}手  感度${sensitivity}`, L.canvasW / 2, HEADER_H - 6);

      ctx.restore();
    }

    // ============================================================
    // 盤面描画
    // ============================================================
    function drawBoard(ctx: CanvasRenderingContext2D, L: typeof layoutRef.current, bs: BoardSize) {
      const bgGrad = ctx.createLinearGradient(0, L.boardY, 0, L.boardY + L.boardH);
      bgGrad.addColorStop(0, "#1d6b1d");
      bgGrad.addColorStop(1, "#155215");
      ctx.fillStyle = bgGrad;
      ctx.fillRect(L.boardX, L.boardY, L.boardW, L.boardH);

      ctx.save();
      ctx.strokeStyle = "rgba(255,255,255,0.2)";
      ctx.lineWidth = 0.5;
      for (let i = 0; i <= bs; i++) {
        ctx.beginPath();
        ctx.moveTo(L.boardX + i * L.cellSize, L.boardY);
        ctx.lineTo(L.boardX + i * L.cellSize, L.boardY + L.boardH);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(L.boardX, L.boardY + i * L.cellSize);
        ctx.lineTo(L.boardX + L.boardW, L.boardY + i * L.cellSize);
        ctx.stroke();
      }
      const dots = bs === 8
        ? [[2, 2], [2, 6], [6, 2], [6, 6], [4, 4]]
        : [[1, 1], [1, 4], [4, 1], [4, 4]];
      ctx.fillStyle = "rgba(255,255,255,0.3)";
      for (const [r, c] of dots) {
        ctx.beginPath();
        ctx.arc(L.boardX + c * L.cellSize, L.boardY + r * L.cellSize, 3, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // ============================================================
    // ボールエリア背景
    // ============================================================
    function drawBallArea(ctx: CanvasRenderingContext2D, L: typeof layoutRef.current) {
      const grad = ctx.createLinearGradient(0, L.ballAreaY, 0, L.ballAreaY + L.ballAreaH);
      grad.addColorStop(0, "#155215");
      grad.addColorStop(1, "#0d3d0d");
      ctx.fillStyle = grad;
      ctx.fillRect(0, L.ballAreaY, L.canvasW, L.ballAreaH);

      ctx.save();
      ctx.strokeStyle = "rgba(255,255,255,0.2)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, L.ballAreaY);
      ctx.lineTo(L.canvasW, L.ballAreaY);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(L.canvasW / 2, L.ballAreaY, L.ballAreaH * 0.55, Math.PI, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // ============================================================
    // ボールエリアUI
    // ============================================================
    function drawBallAreaUI(
      ctx: CanvasRenderingContext2D,
      L: typeof layoutRef.current,
      phase: GamePhase,
      bs: BoardSize
    ) {
      const cp = currentPlayerRef.current;
      const pc = playerCountRef.current;
      const isInteractable =
        phase === "idle" &&
        (mode === "solo" ||
          (mode === "cpu" && cp === myColor) ||
          (mode === "online" && cp === myColor));

      ctx.save();
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";

      if (phase === "gameover") {
        const { black, white, red } = countPieces(boardRef.current);
        const winner = winnerRef.current ?? determineWinner(boardRef.current);
        const msg = winner === "draw" ? "引き分け！"
          : winner === "black" ? "⚫ 黒の勝ち！"
          : winner === "white" ? "⚪ 白の勝ち！"
          : "🔴 赤の勝ち！";
        ctx.font = `bold ${L.cellSize * 0.55}px sans-serif`;
        ctx.fillStyle = "#FFD700";
        ctx.shadowColor = "rgba(0,0,0,0.8)"; ctx.shadowBlur = 8;
        ctx.fillText(msg, L.canvasW / 2, L.ballAreaY + L.ballAreaH - 8);
        ctx.font = `${L.cellSize * 0.38}px sans-serif`;
        ctx.fillStyle = "white";
        ctx.shadowBlur = 0;
        const scoreText = pc === 3
          ? `黒 ${black} ― 白 ${white} ― 赤 ${red}`
          : `黒 ${black} ― 白 ${white}`;
        ctx.fillText(scoreText, L.canvasW / 2, L.ballAreaY + L.ballAreaH - 8 - L.cellSize * 0.6);
        const mc = moveCountRef.current;
        const tl = getTurnLimit(bs, pc);
        ctx.font = `${L.cellSize * 0.32}px sans-serif`;
        ctx.fillStyle = "rgba(255,255,255,0.6)";
        ctx.fillText(`${mc}手終了（上限 ${tl}手）`, L.canvasW / 2, L.ballAreaY + L.ballAreaH - 8 - L.cellSize * 1.15);
      } else if (phase === "aiming") {
        ctx.font = `${L.cellSize * 0.4}px sans-serif`;
        ctx.fillStyle = "#7eff7e";
        ctx.fillText("勢いよく上に向かって離す！", L.canvasW / 2, L.ballAreaY + L.ballAreaH - 8);
      } else if (phase === "cpu_thinking") {
        ctx.font = `${L.cellSize * 0.4}px sans-serif`;
        ctx.fillStyle = "#ffaa44";
        ctx.fillText("CPU が考え中...", L.canvasW / 2, L.ballAreaY + L.ballAreaH - 8);
      } else if (isInteractable) {
        ctx.font = `${L.cellSize * 0.38}px sans-serif`;
        ctx.fillStyle = "rgba(255,255,255,0.7)";
        ctx.fillText("ボールをつかんで投げる！", L.canvasW / 2, L.ballAreaY + L.ballAreaH - 8);
      } else if (mode !== "solo") {
        ctx.font = `${L.cellSize * 0.38}px sans-serif`;
        ctx.fillStyle = "rgba(255,255,255,0.5)";
        ctx.fillText("相手のターン...", L.canvasW / 2, L.ballAreaY + L.ballAreaH - 8);
      }

      ctx.restore();
    }

    // ============================================================
    // ポインターイベント
    // ============================================================
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const onPointerDown = (e: PointerEvent) => {
        if (!canInteract()) return;
        const { x, y } = getCanvasPos(e);
        if (!isNearBall(x, y)) return;
        e.preventDefault();
        isDraggingRef.current = true;
        ballDragPosRef.current = { x, y };
        dragHistoryRef.current = [{ x, y, t: performance.now() }];
        gamePhaseRef.current = "aiming";
        canvas.setPointerCapture(e.pointerId);
      };

      const onPointerMove = (e: PointerEvent) => {
        if (!isDraggingRef.current) return;
        e.preventDefault();
        const { x, y } = getCanvasPos(e);
        ballDragPosRef.current = { x, y };

        const history = dragHistoryRef.current;
        history.push({ x, y, t: performance.now() });
        if (history.length > 8) history.shift();
      };

      const onPointerUp = (e: PointerEvent) => {
        if (!isDraggingRef.current) return;
        isDraggingRef.current = false;

        const history = dragHistoryRef.current;
        const dragPos = ballDragPosRef.current;
        dragHistoryRef.current = [];

        if (history.length < 2) {
          gamePhaseRef.current = "idle";
          return;
        }

        const recent = history.slice(-5);
        const first = recent[0];
        const last = recent[recent.length - 1];
        const dt = Math.max(8, last.t - first.t);
        const vx = (last.x - first.x) / dt * velocityScale;
        const vy = (last.y - first.y) / dt * velocityScale;

        if (vy > -0.5) {
          gamePhaseRef.current = "idle";
          syncDisplayState("上に向かってスワイプして投げよう！");
          return;
        }

        const L = layoutRef.current;
        const bsLocal = boardSizeRef.current;
        const target = computeTargetFromVelocity(dragPos.x, vx, vy, bsLocal, L);
        const cp = currentPlayerRef.current;

        const targetX = L.boardX + target.col * L.cellSize + L.cellSize / 2;
        const targetY = L.boardY + target.row * L.cellSize + L.cellSize / 2;
        const vertDist = dragPos.y - targetY;
        const arcH = Math.max(ARC_BASE, vertDist * ARC_FACTOR + ARC_BASE);
        const duration = 380 + Math.max(0, vertDist) * 0.85;

        ballAnimRef.current = {
          active: true,
          startX: dragPos.x, startY: dragPos.y,
          targetX, targetY,
          progress: 0, duration, arcH,
          targetRow: target.row, targetCol: target.col, player: cp,
        };
        gamePhaseRef.current = "flying";
      };

      canvas.addEventListener("pointerdown", onPointerDown, { passive: false });
      canvas.addEventListener("pointermove", onPointerMove, { passive: false });
      canvas.addEventListener("pointerup", onPointerUp);
      canvas.addEventListener("pointercancel", onPointerUp);

      return () => {
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointermove", onPointerMove);
        canvas.removeEventListener("pointerup", onPointerUp);
        canvas.removeEventListener("pointercancel", onPointerUp);
      };
    }, [canInteract, getCanvasPos, isNearBall, mode, myColor]);

    // ============================================================
    // 初期化・リサイズ
    // ============================================================
    useEffect(() => {
      calcLayout();
      lastRenderTime.current = performance.now();
      animFrameRef.current = requestAnimationFrame(animate);

      // 初手がCPUのターンなら自動起動
      if (mode === "cpu" && currentPlayerRef.current !== myColor) {
        gamePhaseRef.current = "cpu_thinking";
        syncDisplayState();
        setTimeout(() => fireCPUThrow(currentPlayerRef.current), CPU_THINK_DELAY);
      } else {
        syncDisplayState();
      }

      const ro = new ResizeObserver(() => calcLayout());
      if (containerRef.current) ro.observe(containerRef.current);

      return () => {
        cancelAnimationFrame(animFrameRef.current);
        ro.disconnect();
      };
    }, [animate, calcLayout]); // eslint-disable-line react-hooks/exhaustive-deps

    // ============================================================
    // リスタート
    // ============================================================
    const restart = () => {
      const bs = boardSizeRef.current;
      const pc = playerCountRef.current;
      boardRef.current = createInitialBoard(bs, pc);
      currentPlayerRef.current = "black";
      gamePhaseRef.current = "idle";
      flyingPiecesRef.current = [];
      ballAnimRef.current.active = false;
      isDraggingRef.current = false;
      dragHistoryRef.current = [];
      impactCellRef.current = null;
      moveCountRef.current = 0;
      winnerRef.current = null;
      flippedCellsRef.current = [];
      smokeParticlesRef.current = [];
      textPopsRef.current = [];

      // リスタート後も初手がCPUなら自動起動
      if (mode === "cpu" && currentPlayerRef.current !== myColor) {
        gamePhaseRef.current = "cpu_thinking";
        syncDisplayState();
        setTimeout(() => fireCPUThrow(currentPlayerRef.current), CPU_THINK_DELAY);
      } else {
        syncDisplayState();
      }
    };

    // ============================================================
    // レンダー
    // ============================================================
    return (
      <div
        ref={containerRef}
        className="w-full flex flex-col items-center"
        style={{ maxWidth: MAX_CANVAS_W }}
      >
        <canvas
          ref={canvasRef}
          style={{
            width: "100%",
            maxWidth: MAX_CANVAS_W,
            cursor: displayState.phase === "idle" ? "grab" : "default",
          }}
        />

        {displayState.phase === "gameover" && (
          <button
            onClick={restart}
            className="mt-4 px-8 py-3 bg-green-600 hover:bg-green-500 text-white font-bold rounded-xl text-lg active:scale-95 transition-all"
          >
            もう一度プレイ
          </button>
        )}
      </div>
    );
  }
);

export default GameCanvas;
