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

/** 放物線アニメーション（投げ→頂点→落下→着弾） */
interface BallAnim {
  active: boolean;
  startX: number;
  startY: number;
  targetX: number;
  targetY: number;
  progress: number; // 0→1
  duration: number; // ms
  arcH: number;     // 放物線の高さオフセット
  targetRow: number;
  targetCol: number;
  player: Player;
}

/** コインフリップアニメーション中のセル */
interface FlippingCell {
  id: number;
  row: number;
  col: number;
  progress: number;
  fromPlayer: Player;
  toPlayer: Player;
  startTime: number;
}

type GamePhase =
  | "idle"
  | "aiming"       // ボールをドラッグ中
  | "flying"       // 放物線アーク飛翔中
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
const FLIP_DURATION = 420;
const FLIP_STAGGER = 70;

// --- ユーザー投球キャリブレーション ---
// GRAVITY: 物理シミュ用（どのマスに飛ぶかの計算のみ）
// VELOCITY_SCALE: (px/ms) → (px/frame 相当) の変換係数
// 「かなり速いスワイプでようやく最上段に届く」チューニング
const GRAVITY = 0.3;
const VELOCITY_SCALE = 7;

// --- 放物線アーク描画パラメータ ---
// vertDist = startY - targetY（目標が遠いほど大きい）
// arcH = vertDist * ARC_FACTOR + ARC_BASE
// 近いマス（row7）は控えめなアーク、遠いマス（row0）は大きなアーク
const ARC_FACTOR = 0.6;
const ARC_BASE   = 60;

// ============================================================
// ユーザーのスワイプ速度から「どのセルに着弾するか」を計算
// 盤面底辺(boardY+boardH)を下から上へ通過したときの状態で判断:
//   列 → 通過時のX座標
//   行 → 通過時の上昇速度（速い＝上の行、遅い＝下の行）
// ============================================================
function computeTargetFromThrow(
  startX: number,
  startY: number,
  vx: number,
  vy: number,
  boardX: number,
  boardY: number,
  boardH: number,
  boardW: number,
  cellSize: number,
  canvasW: number,
  canvasH: number
): { row: number; col: number } | null {
  let px = startX, py = startY, pvx = vx, pvy = vy;
  const boardBottom = boardY + boardH;

  for (let i = 0; i < 400; i++) {
    const prevPy = py;
    px += pvx;
    py += pvy;
    pvy += GRAVITY;

    // 盤面底辺を下から上へ通過
    if (prevPy > boardBottom && py <= boardBottom) {
      const col = Math.floor((px - boardX) / cellSize);
      if (col < 0 || col >= BOARD_SIZE) return null; // 横外れ

      // 通過時の上昇速度で行を決定（速い→上の行、遅い→下の行）
      const v0 = Math.max(0, -(pvy - GRAVITY)); // このステップで使った速度（GRAVITY加算前）
      const maxReach = (v0 * v0) / (2 * GRAVITY);
      const row = Math.max(
        0,
        Math.min(BOARD_SIZE - 1, Math.floor((boardH - maxReach) / cellSize))
      );
      return { row, col };
    }

    // 画面外 → ミス
    if (py > canvasH + 200 || px < -200 || px > canvasW + 200 || py < boardY - 200) {
      return null;
    }
  }
  return null;
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

function drawPiece(
  ctx: CanvasRenderingContext2D,
  x: number, y: number,
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
  function GameCanvas({ mode, myColor = "black", onMove }, ref) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    // ゲーム状態
    const boardRef = useRef<Board>(createInitialBoard());
    const currentPlayerRef = useRef<Player>("black");
    const gamePhaseRef = useRef<GamePhase>("idle");
    const flyingPiecesRef = useRef<FlyingPiece[]>([]);
    const flippingCellsRef = useRef<FlippingCell[]>([]);
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

    const [displayState, setDisplayState] = useState({
      board: createInitialBoard() as Board,
      currentPlayer: "black" as Player,
      phase: "idle" as GamePhase,
      blackCount: 2, whiteCount: 2,
      winner: null as Player | "draw" | null,
      message: "",
    });

    const lastRenderTime = useRef(0);
    const animFrameRef = useRef(0);

    // onMove の最新参照（クロージャ問題回避）
    const onMoveRef = useRef(onMove);
    useEffect(() => { onMoveRef.current = onMove; }, [onMove]);

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
    // 着弾処理
    // ============================================================
    const handleImpact = useCallback(
      (row: number, col: number, player: Player) => {
        const result = applyMove(boardRef.current, row, col, player);

        if (!result.valid) {
          gamePhaseRef.current = "idle";
          ballAnimRef.current.active = false;
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

        // ひっくり返るコマのフリップアニメーション登録
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
        ballAnimRef.current.active = false;

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

        const dt = Math.min(timestamp - lastRenderTime.current, 50);
        lastRenderTime.current = timestamp;

        const L = layoutRef.current;
        const phase = gamePhaseRef.current;

        // --- 放物線アーク更新 ---
        if (phase === "flying" && ballAnimRef.current.active) {
          const anim = ballAnimRef.current;
          anim.progress = Math.min(1, anim.progress + dt / anim.duration);
          ballRotationRef.current += 0.13;

          if (anim.progress >= 1) {
            // 放物線の終点（落下しきった）→ 着弾
            handleImpact(anim.targetRow, anim.targetCol, anim.player);
          }
        }

        // --- ドラッグ中ボール回転 ---
        if (phase === "aiming") {
          ballRotationRef.current += 0.04;
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
        if (phase === "flying" && ballAnimRef.current.active) {
          // 放物線アーク: 投げ → 浮く → 頂点 → 落ちる
          const anim = ballAnimRef.current;
          const t = anim.progress;
          const bx = lerp(anim.startX, anim.targetX, t);
          // y = startY→targetY の直線 − arcH*sin(t*π)
          // t=0: by=startY（投げた位置）
          // t=0.5: by=midY - arcH（頂点、最も高い位置）
          // t=1: by=targetY（着弾、落ちきった位置）
          const by = lerp(anim.startY, anim.targetY, t) - anim.arcH * Math.sin(t * Math.PI);
          drawSoccerBall(ctx, bx, by, L.ballRadius, ballRotationRef.current);
        } else if (phase === "aiming") {
          // ドラッグ中：ボールが指に追従
          const dp = ballDragPosRef.current;
          drawSoccerBall(ctx, dp.x, dp.y, L.ballRadius, ballRotationRef.current);
        } else {
          // 待機・着弾後など：元の位置
          drawSoccerBall(ctx, L.ballRestX, L.ballRestY, L.ballRadius, ballRotationRef.current);
        }

        drawBallAreaUI(ctx, L, phase);

        animFrameRef.current = requestAnimationFrame(animate);
      },
      [handleImpact]
    );

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

        // スワイプ速度を計算（直近ドラッグ履歴から）
        const recent = history.slice(-5);
        const first = recent[0];
        const last = recent[recent.length - 1];
        const dt = Math.max(8, last.t - first.t);
        const vx = (last.x - first.x) / dt * VELOCITY_SCALE;
        const vy = (last.y - first.y) / dt * VELOCITY_SCALE;

        // 上向きの勢いがなければキャンセル
        if (vy > -1.5) {
          gamePhaseRef.current = "idle";
          syncDisplayState("上に向かってスワイプして投げよう！");
          return;
        }

        const L = layoutRef.current;

        // 物理シミュレーションでどのセルに飛ぶかを計算
        const target = computeTargetFromThrow(
          dragPos.x, dragPos.y, vx, vy,
          L.boardX, L.boardY, L.boardH, L.boardW,
          L.cellSize, L.canvasW, L.canvasH
        );

        if (!target) {
          // 盤外ミス
          gamePhaseRef.current = "idle";
          syncDisplayState("外れた！もう一度！");
          return;
        }

        const cp = currentPlayerRef.current;

        // オンラインモード：自分の手を送信
        if (mode === "online" && cp === myColor) {
          onMoveRef.current?.(target.row, target.col);
        }

        // 目標セルへの放物線アーク開始
        const targetX = L.boardX + target.col * L.cellSize + L.cellSize / 2;
        const targetY = L.boardY + target.row * L.cellSize + L.cellSize / 2;
        // 投げた位置（dragPos）から目標まで
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
      ballAnimRef.current.active = false;
      isDraggingRef.current = false;
      dragHistoryRef.current = [];
      impactCellRef.current = null;
      syncDisplayState();
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
