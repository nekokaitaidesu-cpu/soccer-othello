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
  Player,
  BOARD_SIZE,
  createInitialBoard,
  applyMove,
  countPieces,
  getWinner,
  getCPUMove,
} from "@/lib/gameLogic";

// ============================================================
// 型定義
// ============================================================
export interface GameCanvasHandle {
  applyExternalMove: (row: number, col: number) => void;
}

export interface GameCanvasProps {
  mode: "solo" | "cpu" | "online";
  myColor?: Player;
  onMove?: (row: number, col: number) => void;
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

/** 物理演算中のボール状態 */
interface BallPhysics {
  x: number;
  y: number;
  vx: number;
  vy: number;
  player: Player;
}

/** コインフリップアニメーション中のセル */
interface FlippingCell {
  id: number;
  row: number;
  col: number;
  progress: number; // 0→1
  fromPlayer: Player;
  toPlayer: Player;
  startTime: number; // ms (performance.now 相当 → Date.now で代用)
}

type GamePhase =
  | "idle"
  | "aiming"   // ボールをドラッグ中（ボールが指に追従）
  | "flying"   // 物理演算で飛翔中
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
const IMPACT_DURATION = 350;   // ms
const CPU_THINK_DELAY = 700;   // ms
const GRAVITY = 0.35;          // px/frame
const VELOCITY_SCALE = 10;     // (px/ms) → (px/frame)
const FLIP_DURATION = 420;     // ms コイン1枚のフリップ時間
const FLIP_STAGGER = 70;       // ms 複数コマのフリップ開始ずれ
const CPU_NOISE = 0.8;         // CPUの投げぶれ（px/frame）

// ============================================================
// CPU用 投球速度計算
// 物理: x(t) = x0 + vx*t, y(t) = y0 + vy*t + 0.5*g*t^2
// 盤面底辺(entryY)に到達するときの vy が targetRow に対応した速度になるよう計算
// ============================================================
function computeCpuThrow(
  startX: number,
  startY: number,
  targetRow: number,
  targetCol: number,
  boardX: number,
  boardY: number,
  boardH: number,
  cellSize: number
): { vx: number; vy: number } {
  const entryY = boardY + boardH; // 盤面の底辺Y
  const targetX = boardX + targetCol * cellSize + cellSize / 2;
  const D = entryY - startY; // 負（上に飛ぶ）

  // targetRow に対応した entryY 通過時の上昇速度 v0
  // row = floor((boardH - v0^2/(2g)) / cellSize)
  // → v0 = sqrt(2g * (boardH - (row+0.5)*cellSize))
  const needed = boardH - (targetRow + 0.5) * cellSize;
  const v0 = Math.sqrt(Math.max(0.1, 2 * GRAVITY * needed));
  const vyEntry = -v0; // 上向き（マイナス）

  // 連立方程式を解いて飛行時間 t を求める
  // vyEntry*t - 0.5*g*t^2 = D  →  0.5*g*t^2 - vyEntry*t + D = 0
  // 解: t = (vyEntry ± sqrt(vyEntry^2 - 2*g*D)) / g  ※D<0なので判別式>0保証
  const disc = Math.sqrt(vyEntry * vyEntry - 2 * GRAVITY * D);
  const t = (vyEntry + disc) / GRAVITY; // 正の解

  const vy0 = vyEntry - GRAVITY * t;
  const vx0 = (targetX - startX) / t;

  return { vx: vx0, vy: vy0 };
}

// ============================================================
// 描画ユーティリティ
// ============================================================
function drawRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number,
  w: number, h: number,
  r: number
) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/**
 * コマ描画。scaleX=1 が通常、0 がフリップ中央（消える）、-1 が裏面（使わない）
 * abs(cos(progress*π)) をかけてコインフリップを表現
 */
function drawPiece(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  player: Player,
  alpha = 1,
  scale = 1,
  scaleX = 1
) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  ctx.scale(scale * scaleX, scale);

  ctx.shadowColor = "rgba(0,0,0,0.5)";
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 3;

  const grad = ctx.createRadialGradient(
    -radius * 0.3, -radius * 0.35, radius * 0.05,
    0, 0, radius
  );
  if (player === "black") {
    grad.addColorStop(0, "#666");
    grad.addColorStop(1, "#111");
  } else {
    grad.addColorStop(0, "#ffffff");
    grad.addColorStop(1, "#cccccc");
  }
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.shadowColor = "transparent";
  ctx.strokeStyle = player === "black" ? "#333" : "#999";
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
    const px = cx + Math.cos(angle) * r;
    const py = cy + Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
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
  function GameCanvas({ mode, myColor = "black", onMove }, ref) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    // ゲーム状態
    const boardRef = useRef<Board>(createInitialBoard());
    const currentPlayerRef = useRef<Player>("black");
    const gamePhaseRef = useRef<GamePhase>("idle");
    const flyingPiecesRef = useRef<FlyingPiece[]>([]);
    const flippingCellsRef = useRef<FlippingCell[]>([]);
    const ballPhysRef = useRef<BallPhysics>({ x: 0, y: 0, vx: 0, vy: 0, player: "black" });
    const ballRotationRef = useRef(0);
    const impactTimerRef = useRef(0);
    const impactCellRef = useRef<{ row: number; col: number } | null>(null);
    const flyPieceIdRef = useRef(0);

    // ドラッグ状態
    const isDraggingRef = useRef(false);
    const ballDragPosRef = useRef({ x: 0, y: 0 });
    const dragHistoryRef = useRef<{ x: number; y: number; t: number }[]>([]);

    // レイアウト
    const layoutRef = useRef({
      canvasW: 360, canvasH: 600,
      cellSize: 45,
      boardX: 0, boardY: HEADER_H,
      boardW: 360, boardH: 360,
      ballAreaY: HEADER_H + 360, ballAreaH: 160,
      ballRestX: 180, ballRestY: HEADER_H + 360 + 96,
      ballRadius: 25,
    });

    // React状態（UI更新用）
    const [displayState, setDisplayState] = useState({
      board: createInitialBoard() as Board,
      currentPlayer: "black" as Player,
      phase: "idle" as GamePhase,
      blackCount: 2,
      whiteCount: 2,
      winner: null as Player | "draw" | null,
      message: "",
    });

    const lastRenderTime = useRef(0);
    const animFrameRef = useRef(0);

    // ============================================================
    // レイアウト計算
    // ============================================================
    const calcLayout = useCallback(() => {
      const container = containerRef.current;
      if (!container) return;
      const w = Math.min(container.clientWidth, MAX_CANVAS_W);
      const cellSize = Math.floor(w / BOARD_SIZE);
      const boardW = cellSize * BOARD_SIZE;
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
      const { black, white } = countPieces(boardRef.current);
      const winner = getWinner(boardRef.current);
      const phase = gamePhaseRef.current;
      const cp = currentPlayerRef.current;

      let message = msg ?? "";
      if (!msg) {
        if (phase === "gameover") {
          message = winner === "draw" ? "引き分け！"
            : winner === "black" ? "黒の勝ち！" : "白の勝ち！";
        } else if (phase === "cpu_thinking") {
          message = "CPUが考え中...";
        } else if (mode === "online") {
          message = cp === myColor ? "あなたのターン" : "相手のターン待ち";
        } else {
          message = cp === "black" ? "⚫ 黒のターン" : "⚪ 白のターン";
        }
      }

      setDisplayState({
        board: boardRef.current.map((r) => [...r]) as Board,
        currentPlayer: cp, phase,
        blackCount: black, whiteCount: white, winner, message,
      });
    }

    // ============================================================
    // ボール投げ（CPU / オンライン用 → 物理計算で飛ばす）
    // ============================================================
    const throwBall = useCallback((row: number, col: number, player: Player) => {
      const L = layoutRef.current;
      const { vx, vy } = computeCpuThrow(
        L.ballRestX, L.ballRestY,
        row, col,
        L.boardX, L.boardY, L.boardH, L.cellSize
      );
      // 少しぶれを加える（CPUらしさ）
      ballPhysRef.current = {
        x: L.ballRestX,
        y: L.ballRestY,
        vx: vx + (Math.random() - 0.5) * CPU_NOISE,
        vy: vy + (Math.random() - 0.5) * CPU_NOISE,
        player,
      };
      ballRotationRef.current = 0;
      gamePhaseRef.current = "flying";
    }, []);

    // ============================================================
    // 着弾処理
    // ============================================================
    const handleImpact = useCallback(
      (row: number, col: number, player: Player) => {
        const result = applyMove(boardRef.current, row, col, player);

        if (!result.valid) {
          gamePhaseRef.current = "idle";
          syncDisplayState("自分のコマには当たれません！もう一度");
          return;
        }

        // 直接叩いたコマの吹き飛ばしエフェクト
        if (result.replaced) {
          const L = layoutRef.current;
          const px = L.boardX + col * L.cellSize + L.cellSize / 2;
          const py = L.boardY + row * L.cellSize + L.cellSize / 2;
          const opponent: Player = player === "black" ? "white" : "black";
          const angle = Math.random() * Math.PI * 2;
          const speed = 8 + Math.random() * 6;
          flyingPiecesRef.current.push({
            id: flyPieceIdRef.current++,
            x: px, y: py,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed - 4,
            opacity: 1,
            radius: L.cellSize * 0.38,
            color: opponent,
          });
        }

        // ひっくり返るコマのアニメーション登録
        const opponent: Player = player === "black" ? "white" : "black";
        const now = Date.now();
        for (let i = 0; i < result.flipped.length; i++) {
          const { row: fr, col: fc } = result.flipped[i];
          flippingCellsRef.current.push({
            id: flyPieceIdRef.current++,
            row: fr, col: fc,
            progress: 0,
            fromPlayer: opponent,
            toPlayer: player,
            startTime: now + i * FLIP_STAGGER,
          });
        }

        boardRef.current = result.newBoard;
        impactCellRef.current = { row, col };
        gamePhaseRef.current = "impact";
        impactTimerRef.current = Date.now();

        const winner = getWinner(boardRef.current);
        const flipTotalMs = result.flipped.length > 0
          ? (result.flipped.length - 1) * FLIP_STAGGER + FLIP_DURATION
          : 0;
        const totalDelay = Math.max(IMPACT_DURATION, flipTotalMs);

        if (winner) {
          setTimeout(() => {
            gamePhaseRef.current = "gameover";
            syncDisplayState();
          }, totalDelay);
          return;
        }

        setTimeout(() => {
          const next: Player = player === "black" ? "white" : "black";
          currentPlayerRef.current = next;
          gamePhaseRef.current = "idle";
          impactCellRef.current = null;

          if (mode === "cpu" && next !== myColor) {
            gamePhaseRef.current = "cpu_thinking";
            syncDisplayState();
            setTimeout(() => {
              const cpuMove = getCPUMove(boardRef.current, next);
              if (cpuMove) throwBall(cpuMove.row, cpuMove.col, next);
            }, CPU_THINK_DELAY);
          } else {
            syncDisplayState();
          }
        }, totalDelay);
      },
      [mode, myColor, throwBall]
    );

    // ============================================================
    // 外部からの着弾（ONLINEモード）
    // ============================================================
    useImperativeHandle(ref, () => ({
      applyExternalMove(row: number, col: number) {
        if (gamePhaseRef.current !== "idle") return;
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

        lastRenderTime.current = timestamp;
        const L = layoutRef.current;
        const phase = gamePhaseRef.current;

        // --- 物理演算ボール更新 ---
        if (phase === "flying") {
          const phys = ballPhysRef.current;
          const prevY = phys.y;
          const prevVy = phys.vy;

          phys.x += phys.vx;
          phys.y += prevVy;
          phys.vy = prevVy + GRAVITY;
          ballRotationRef.current += phys.vx * 0.05 + (prevVy < 0 ? -0.12 : 0.08);

          // 盤面底辺を下から上に通過したとき → 着弾
          const boardBottom = L.boardY + L.boardH;
          if (prevY > boardBottom && phys.y <= boardBottom) {
            const col = Math.floor((phys.x - L.boardX) / L.cellSize);
            if (col >= 0 && col < BOARD_SIZE) {
              // 着弾時の上昇速度で「どの行に当たるか」を決定
              const v0 = Math.max(0, -prevVy);
              const maxReach = (v0 * v0) / (2 * GRAVITY);
              const row = Math.max(
                0,
                Math.min(BOARD_SIZE - 1, Math.floor((L.boardH - maxReach) / L.cellSize))
              );
              // オンラインモード：自分の手を送信
              if (mode === "online" && currentPlayerRef.current === myColor) {
                onMoveRef.current?.(row, col);
              }
              handleImpact(row, col, phys.player);
            }
            // colが外れでも一旦 flying 継続 → off-screen で reset
          }

          // 画面外 → リセット
          if (
            phys.y > L.canvasH + 150 ||
            phys.x < -150 ||
            phys.x > L.canvasW + 150 ||
            phys.y < L.boardY - 100
          ) {
            gamePhaseRef.current = "idle";
            syncDisplayState("外れた！もう一度！");
          }
        }

        // --- 飛び散るコマ更新 ---
        flyingPiecesRef.current = flyingPiecesRef.current
          .map((fp) => ({
            ...fp,
            x: fp.x + fp.vx,
            y: fp.y + fp.vy,
            vy: fp.vy + 0.5,
            opacity: fp.opacity - 0.025,
          }))
          .filter((fp) => fp.opacity > 0);

        // --- フリップアニメーション更新 ---
        const now = Date.now();
        flippingCellsRef.current = flippingCellsRef.current
          .map((fc) => ({
            ...fc,
            progress: Math.min(1, Math.max(0, (now - fc.startTime) / FLIP_DURATION)),
          }))
          .filter((fc) => now < fc.startTime + FLIP_DURATION);

        // ============================================================
        // 描画
        // ============================================================
        ctx.clearRect(0, 0, L.canvasW, L.canvasH);

        drawHeader(ctx, L);
        drawBoard(ctx, L);

        // --- コマ描画（フリップアニメ含む）---
        const board = boardRef.current;
        for (let r = 0; r < BOARD_SIZE; r++) {
          for (let c = 0; c < BOARD_SIZE; c++) {
            const cell = board[r][c];
            if (!cell) continue;
            const cx = L.boardX + c * L.cellSize + L.cellSize / 2;
            const cy = L.boardY + r * L.cellSize + L.cellSize / 2;

            // 着弾エフェクト（スケール跳ね）
            let impactScale = 1;
            const ic = impactCellRef.current;
            if (ic && ic.row === r && ic.col === c && phase === "impact") {
              const elapsed = Date.now() - impactTimerRef.current;
              impactScale = 1 + 0.35 * Math.sin((elapsed / IMPACT_DURATION) * Math.PI);
            }

            // フリップアニメーション
            const flip = flippingCellsRef.current.find(
              (f) => f.row === r && f.col === c && now >= f.startTime
            );
            if (flip) {
              const p = flip.progress;
              // cos(p*π): 0→1→0→-1→... → abs で 1→0→1 の折り返し
              const scaleX = Math.abs(Math.cos(p * Math.PI));
              const displayPlayer = p < 0.5 ? flip.fromPlayer : flip.toPlayer;
              drawPiece(ctx, cx, cy, L.cellSize * 0.38, displayPlayer, 1, impactScale, scaleX);
            } else {
              drawPiece(ctx, cx, cy, L.cellSize * 0.38, cell, 1, impactScale);
            }
          }
        }

        // --- 飛び散るコマ ---
        for (const fp of flyingPiecesRef.current) {
          drawPiece(ctx, fp.x, fp.y, fp.radius, fp.color, fp.opacity);
        }

        // --- ボールエリア背景 ---
        drawBallArea(ctx, L);

        // --- ボール描画 ---
        if (phase === "flying") {
          const phys = ballPhysRef.current;
          drawSoccerBall(ctx, phys.x, phys.y, L.ballRadius, ballRotationRef.current);
        } else if (phase === "aiming") {
          // ドラッグ中：ボールが指に追従
          const dp = ballDragPosRef.current;
          drawSoccerBall(ctx, dp.x, dp.y, L.ballRadius, ballRotationRef.current);
          // 軌道プレビュー
          drawTrajectoryPreview(ctx, L, dp.x, dp.y);
        } else {
          // 待機中（idle / impact / cpu_thinking / gameover）：ボールは元の位置
          drawSoccerBall(ctx, L.ballRestX, L.ballRestY, L.ballRadius, ballRotationRef.current);
        }

        drawBallAreaUI(ctx, L, phase);

        animFrameRef.current = requestAnimationFrame(animate);
      },
      [handleImpact]
    );

    // ============================================================
    // 軌道プレビュー描画（aiming中）
    // ============================================================
    function drawTrajectoryPreview(
      ctx: CanvasRenderingContext2D,
      L: typeof layoutRef.current,
      startX: number,
      startY: number
    ) {
      const history = dragHistoryRef.current;
      if (history.length < 2) return;

      const recent = history.slice(-4);
      const first = recent[0];
      const last = recent[recent.length - 1];
      const dt = Math.max(8, last.t - first.t);
      const vx = (last.x - first.x) / dt * VELOCITY_SCALE;
      const vy = (last.y - first.y) / dt * VELOCITY_SCALE;

      if (vy >= -1) return; // 上向きの速度がなければ表示しない

      // 軌道点を計算
      const points: { x: number; y: number }[] = [];
      let px = startX, py = startY, pvx = vx, pvy = vy;
      let landingRow = -1, landingCol = -1;

      for (let i = 0; i < 120; i++) {
        const prevPy = py;
        px += pvx;
        py += pvy;
        pvy += GRAVITY;

        points.push({ x: px, y: py });

        const boardBottom = L.boardY + L.boardH;
        if (prevPy > boardBottom && py <= boardBottom) {
          // 予測着弾点
          const col = Math.floor((px - L.boardX) / L.cellSize);
          if (col >= 0 && col < BOARD_SIZE) {
            const v0 = Math.max(0, -pvy + GRAVITY); // このフレームの前のvy
            const maxReach = (v0 * v0) / (2 * GRAVITY);
            landingRow = Math.max(0, Math.min(BOARD_SIZE - 1, Math.floor((L.boardH - maxReach) / L.cellSize)));
            landingCol = col;
          }
          break;
        }
        if (py > L.canvasH + 20 || py < L.boardY - 80) break;
      }

      // 破線弧を描画
      ctx.save();
      ctx.strokeStyle = "rgba(255,230,80,0.55)";
      ctx.lineWidth = 2;
      ctx.setLineDash([7, 5]);
      ctx.beginPath();
      let started = false;
      for (const p of points) {
        if (!started) { ctx.moveTo(p.x, p.y); started = true; }
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      // 予測着弾セルをハイライト
      if (landingRow >= 0 && landingCol >= 0) {
        const hx = L.boardX + landingCol * L.cellSize;
        const hy = L.boardY + landingRow * L.cellSize;
        ctx.fillStyle = "rgba(255,240,60,0.28)";
        ctx.strokeStyle = "rgba(255,240,60,0.85)";
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 3]);
        drawRoundRect(ctx, hx + 1, hy + 1, L.cellSize - 2, L.cellSize - 2, 4);
        ctx.fill();
        ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.restore();
    }

    // ============================================================
    // ヘッダー描画
    // ============================================================
    function drawHeader(ctx: CanvasRenderingContext2D, L: typeof layoutRef.current) {
      ctx.fillStyle = "#0d3d0d";
      ctx.fillRect(0, 0, L.canvasW, HEADER_H);

      const { black, white } = countPieces(boardRef.current);
      const cp = currentPlayerRef.current;
      ctx.save();

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

      ctx.restore();
    }

    // ============================================================
    // 盤面描画
    // ============================================================
    function drawBoard(ctx: CanvasRenderingContext2D, L: typeof layoutRef.current) {
      const bgGrad = ctx.createLinearGradient(0, L.boardY, 0, L.boardY + L.boardH);
      bgGrad.addColorStop(0, "#1d6b1d");
      bgGrad.addColorStop(1, "#155215");
      ctx.fillStyle = bgGrad;
      ctx.fillRect(L.boardX, L.boardY, L.boardW, L.boardH);

      ctx.save();
      ctx.strokeStyle = "rgba(255,255,255,0.2)";
      ctx.lineWidth = 0.5;
      for (let i = 0; i <= BOARD_SIZE; i++) {
        ctx.beginPath();
        ctx.moveTo(L.boardX + i * L.cellSize, L.boardY);
        ctx.lineTo(L.boardX + i * L.cellSize, L.boardY + L.boardH);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(L.boardX, L.boardY + i * L.cellSize);
        ctx.lineTo(L.boardX + L.boardW, L.boardY + i * L.cellSize);
        ctx.stroke();
      }

      ctx.fillStyle = "rgba(255,255,255,0.3)";
      for (const [r, c] of [[2, 2], [2, 6], [6, 2], [6, 6], [4, 4]]) {
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
      phase: GamePhase
    ) {
      const cp = currentPlayerRef.current;
      const isInteractable =
        phase === "idle" &&
        (mode === "solo" ||
          (mode === "cpu" && cp === myColor) ||
          (mode === "online" && cp === myColor));

      ctx.save();
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";

      if (phase === "gameover") {
        const { black, white } = countPieces(boardRef.current);
        const winner = getWinner(boardRef.current);
        const msg = winner === "draw" ? "引き分け！"
          : winner === "black" ? "⚫ 黒の勝ち！" : "⚪ 白の勝ち！";
        ctx.font = `bold ${L.cellSize * 0.55}px sans-serif`;
        ctx.fillStyle = "#FFD700";
        ctx.shadowColor = "rgba(0,0,0,0.8)"; ctx.shadowBlur = 8;
        ctx.fillText(msg, L.canvasW / 2, L.ballAreaY + L.ballAreaH - 8);
        ctx.font = `${L.cellSize * 0.4}px sans-serif`;
        ctx.fillStyle = "white";
        ctx.fillText(`黒 ${black} ― 白 ${white}`, L.canvasW / 2, L.ballAreaY + L.ballAreaH - 8 - L.cellSize * 0.6);
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

        // ドラッグ中ボール回転
        ballRotationRef.current += 0.05;
      };

      const onPointerUp = (e: PointerEvent) => {
        if (!isDraggingRef.current) return;
        isDraggingRef.current = false;

        const history = dragHistoryRef.current;
        dragHistoryRef.current = [];

        if (history.length < 2) {
          gamePhaseRef.current = "idle";
          return;
        }

        // 速度計算（直近のドラッグ履歴から）
        const recent = history.slice(-5);
        const first = recent[0];
        const last = recent[recent.length - 1];
        const dt = Math.max(8, last.t - first.t);
        const vx = (last.x - first.x) / dt * VELOCITY_SCALE;
        const vy = (last.y - first.y) / dt * VELOCITY_SCALE;

        // 上向きの勢いがなければキャンセル
        if (vy > -2) {
          gamePhaseRef.current = "idle";
          syncDisplayState("上に向かってスワイプして投げよう！");
          return;
        }

        const cp = currentPlayerRef.current;
        ballPhysRef.current = {
          x: ballDragPosRef.current.x,
          y: ballDragPosRef.current.y,
          vx, vy,
          player: cp,
        };
        gamePhaseRef.current = "flying";

        // オンラインモード：投げた後に手を送信（着弾時のrowを送りたいが簡略化のため飛翔開始時に予測）
        // ※ handleImpactで実際の着弾後にonMoveを呼ぶ方が正確だが、非同期タイミングの都合でここで送信
        // → handleImpact内で完結させる設計に変更 (onMoveはhandleImpact経由で呼ばれない点はオンライン側で要対応)
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
    }, [canInteract, getCanvasPos, isNearBall]);

    // ============================================================
    // 初期化・リサイズ
    // ============================================================
    useEffect(() => {
      calcLayout();
      lastRenderTime.current = performance.now();
      animFrameRef.current = requestAnimationFrame(animate);
      syncDisplayState();

      const ro = new ResizeObserver(() => calcLayout());
      if (containerRef.current) ro.observe(containerRef.current);

      return () => {
        cancelAnimationFrame(animFrameRef.current);
        ro.disconnect();
      };
    }, [animate, calcLayout]);

    // ============================================================
    // リスタート
    // ============================================================
    const restart = () => {
      boardRef.current = createInitialBoard();
      currentPlayerRef.current = "black";
      gamePhaseRef.current = "idle";
      flyingPiecesRef.current = [];
      flippingCellsRef.current = [];
      ballPhysRef.current = { x: 0, y: 0, vx: 0, vy: 0, player: "black" };
      isDraggingRef.current = false;
      dragHistoryRef.current = [];
      impactCellRef.current = null;
      syncDisplayState();
    };

    // オンラインモード用: handleImpact内でonMoveを呼べるようにするラッパー
    // ※ ユーザーが盤に当てたとき実際の (row, col) を送信するため、
    //    animate()内の着弾検出から handleImpact を呼ぶ前にonMoveを呼ぶ
    // → animate内で直接onMoveを呼ぶよう調整（useEffectでonMoveをrefに保持）
    const onMoveRef = useRef(onMove);
    useEffect(() => { onMoveRef.current = onMove; }, [onMove]);

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
