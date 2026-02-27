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
  myColor?: Player; // onlineモード用
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

interface BallAnim {
  active: boolean;
  startX: number;
  startY: number;
  targetX: number;
  targetY: number;
  progress: number; // 0→1
  duration: number;
  targetRow: number;
  targetCol: number;
  player: Player;
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
const BALL_AREA_RATIO = 0.42; // キャンバス幅に対するボールエリア高さの比
const BALL_REST_Y_RATIO = 0.6; // ボールエリア内の高さ位置
const BALL_RADIUS_RATIO = 0.07;
const MAX_CANVAS_W = 480;
const FLY_DURATION = 420; // ms
const IMPACT_DURATION = 350; // ms
const CPU_THINK_DELAY = 700; // ms

// ============================================================
// 描画ユーティリティ
// ============================================================
function drawRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function drawPiece(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  player: Player,
  alpha = 1,
  scale = 1
) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  ctx.scale(scale, scale);

  // 影
  ctx.shadowColor = "rgba(0,0,0,0.5)";
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 3;

  const grad = ctx.createRadialGradient(
    -radius * 0.3,
    -radius * 0.35,
    radius * 0.05,
    0,
    0,
    radius
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
  x: number,
  y: number,
  radius: number,
  rotation = 0
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rotation);

  // 影
  ctx.shadowColor = "rgba(0,0,0,0.4)";
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 6;

  // 白い球体
  const sphereGrad = ctx.createRadialGradient(
    -radius * 0.3,
    -radius * 0.35,
    radius * 0.05,
    0,
    0,
    radius
  );
  sphereGrad.addColorStop(0, "#ffffff");
  sphereGrad.addColorStop(0.7, "#e8e8e8");
  sphereGrad.addColorStop(1, "#bbb");

  ctx.fillStyle = sphereGrad;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.shadowColor = "transparent";

  // サッカーボールのパッチ（黒い五角形パターン）
  ctx.fillStyle = "#1a1a1a";
  ctx.strokeStyle = "#1a1a1a";
  ctx.lineWidth = 1;

  // 中央パッチ
  drawPentagon(ctx, 0, 0, radius * 0.28);

  // 周囲5つのパッチ
  for (let i = 0; i < 5; i++) {
    const angle = (i * 2 * Math.PI) / 5 - Math.PI / 2;
    const px = Math.cos(angle) * radius * 0.58;
    const py = Math.sin(angle) * radius * 0.58;
    drawPentagon(ctx, px, py, radius * 0.22);
  }

  // アウトライン
  ctx.strokeStyle = "#333";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.stroke();

  ctx.restore();
}

function drawPentagon(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number
) {
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

function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

// ============================================================
// GameCanvas コンポーネント
// ============================================================
const GameCanvas = forwardRef<GameCanvasHandle, GameCanvasProps>(
  function GameCanvas({ mode, myColor = "black", onMove }, ref) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    // ゲーム状態（Refで保持してアニメーションループから直接アクセス）
    const boardRef = useRef<Board>(createInitialBoard());
    const currentPlayerRef = useRef<Player>("black");
    const gamePhaseRef = useRef<GamePhase>("idle");
    const flyingPiecesRef = useRef<FlyingPiece[]>([]);
    const ballAnimRef = useRef<BallAnim>({
      active: false,
      startX: 0,
      startY: 0,
      targetX: 0,
      targetY: 0,
      progress: 0,
      duration: FLY_DURATION,
      targetRow: 0,
      targetCol: 0,
      player: "black",
    });
    const impactTimerRef = useRef(0);
    const impactCellRef = useRef<{ row: number; col: number } | null>(null);
    const ballRotationRef = useRef(0);

    // ドラッグ状態
    const isDraggingRef = useRef(false);
    const dragCurrentRef = useRef({ x: 0, y: 0 });
    const aimTargetRef = useRef<{ row: number; col: number } | null>(null);

    // レイアウト
    const layoutRef = useRef({
      canvasW: 360,
      canvasH: 600,
      cellSize: 45,
      boardX: 0,
      boardY: HEADER_H,
      boardW: 360,
      boardH: 360,
      ballAreaY: HEADER_H + 360,
      ballAreaH: 160,
      ballRestX: 180,
      ballRestY: HEADER_H + 360 + 96,
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
    const flyPieceIdRef = useRef(0);

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
        canvasW,
        canvasH,
        cellSize,
        boardX,
        boardY,
        boardW,
        boardH: boardW,
        ballAreaY,
        ballAreaH,
        ballRestX,
        ballRestY,
        ballRadius,
      };

      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = canvasW;
        canvas.height = canvasH;
      }
    }, []);

    // ============================================================
    // ターゲットセル計算（ドラッグ位置 → 盤上のセル）
    // ============================================================
    const getTargetCell = useCallback(
      (cx: number, cy: number): { row: number; col: number } | null => {
        const L = layoutRef.current;
        if (cy < L.boardY || cy > L.boardY + L.boardH) return null;
        if (cx < L.boardX || cx > L.boardX + L.boardW) return null;
        const col = Math.floor((cx - L.boardX) / L.cellSize);
        const row = Math.floor((cy - L.boardY) / L.cellSize);
        return {
          row: Math.max(0, Math.min(BOARD_SIZE - 1, row)),
          col: Math.max(0, Math.min(BOARD_SIZE - 1, col)),
        };
      },
      []
    );

    // ============================================================
    // ボール投げ処理
    // ============================================================
    const throwBall = useCallback(
      (row: number, col: number, player: Player) => {
        const L = layoutRef.current;
        const targetX = L.boardX + col * L.cellSize + L.cellSize / 2;
        const targetY = L.boardY + row * L.cellSize + L.cellSize / 2;

        // アニメーション開始
        ballAnimRef.current = {
          active: true,
          startX: L.ballRestX,
          startY: L.ballRestY,
          targetX,
          targetY,
          progress: 0,
          duration: FLY_DURATION,
          targetRow: row,
          targetCol: col,
          player,
        };
        gamePhaseRef.current = "flying";
      },
      []
    );

    // ============================================================
    // 着弾処理
    // ============================================================
    const handleImpact = useCallback(
      (row: number, col: number, player: Player) => {
        const result = applyMove(boardRef.current, row, col, player);

        if (!result.valid) {
          // 自分のコマ → リトライ
          gamePhaseRef.current = "idle";
          ballAnimRef.current.active = false;
          syncDisplayState("自分のコマには当たれません！もう一度");
          return;
        }

        if (result.replaced) {
          // 相手コマを弾き飛ばすアニメーション
          const L = layoutRef.current;
          const px = L.boardX + col * L.cellSize + L.cellSize / 2;
          const py = L.boardY + row * L.cellSize + L.cellSize / 2;
          const opponent: Player = player === "black" ? "white" : "black";
          const angle = Math.random() * Math.PI * 2;
          const speed = 8 + Math.random() * 6;
          flyingPiecesRef.current.push({
            id: flyPieceIdRef.current++,
            x: px,
            y: py,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed - 4,
            opacity: 1,
            radius: L.cellSize * 0.38,
            color: opponent,
          });
        }

        boardRef.current = result.newBoard;
        impactCellRef.current = { row, col };
        gamePhaseRef.current = "impact";
        impactTimerRef.current = Date.now();
        ballAnimRef.current.active = false;

        const winner = getWinner(boardRef.current);
        if (winner) {
          setTimeout(() => {
            gamePhaseRef.current = "gameover";
            syncDisplayState();
          }, IMPACT_DURATION);
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
              if (cpuMove) {
                throwBall(cpuMove.row, cpuMove.col, next);
              }
            }, CPU_THINK_DELAY);
          } else {
            syncDisplayState();
          }
        }, IMPACT_DURATION);
      },
      [mode, myColor, throwBall]
    );

    // ============================================================
    // displayState同期（React再レンダリングのため）
    // ============================================================
    function syncDisplayState(msg?: string) {
      const { black, white } = countPieces(boardRef.current);
      const winner = getWinner(boardRef.current);
      const phase = gamePhaseRef.current;
      const cp = currentPlayerRef.current;

      let message = msg ?? "";
      if (!msg) {
        if (phase === "gameover") {
          message =
            winner === "draw"
              ? "引き分け！"
              : winner === "black"
              ? "黒の勝ち！"
              : "白の勝ち！";
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
        currentPlayer: cp,
        phase,
        blackCount: black,
        whiteCount: white,
        winner,
        message,
      });
    }

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
    // ポインターイベント処理
    // ============================================================
    const getCanvasPos = useCallback(
      (e: PointerEvent | MouseEvent | TouchEvent): { x: number; y: number } => {
        const canvas = canvasRef.current;
        if (!canvas) return { x: 0, y: 0 };
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        let cx: number, cy: number;
        if ("touches" in e && e.touches.length > 0) {
          cx = (e.touches[0].clientX - rect.left) * scaleX;
          cy = (e.touches[0].clientY - rect.top) * scaleY;
        } else {
          const me = e as MouseEvent;
          cx = (me.clientX - rect.left) * scaleX;
          cy = (me.clientY - rect.top) * scaleY;
        }
        return { x: cx, y: cy };
      },
      []
    );

    const isNearBall = useCallback((cx: number, cy: number): boolean => {
      const L = layoutRef.current;
      const dx = cx - L.ballRestX;
      const dy = cy - L.ballRestY;
      return Math.sqrt(dx * dx + dy * dy) <= L.ballRadius * 2.5;
    }, []);

    const canInteract = useCallback((): boolean => {
      const phase = gamePhaseRef.current;
      if (phase !== "idle" && phase !== "aiming") return false;
      if (mode === "online" && currentPlayerRef.current !== myColor)
        return false;
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

        // --- ボールアニメーション更新 ---
        if (phase === "flying" && ballAnimRef.current.active) {
          const anim = ballAnimRef.current;
          anim.progress = Math.min(
            1,
            anim.progress + dt / anim.duration
          );
          ballRotationRef.current += 0.15;
          if (anim.progress >= 1) {
            handleImpact(anim.targetRow, anim.targetCol, anim.player);
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

        // ============================================================
        // 描画
        // ============================================================
        ctx.clearRect(0, 0, L.canvasW, L.canvasH);

        // --- ヘッダー ---
        drawHeader(ctx, L);

        // --- 盤面 ---
        drawBoard(ctx, L);

        // --- コマ ---
        const board = boardRef.current;
        for (let r = 0; r < BOARD_SIZE; r++) {
          for (let c = 0; c < BOARD_SIZE; c++) {
            const cell = board[r][c];
            if (!cell) continue;
            const cx = L.boardX + c * L.cellSize + L.cellSize / 2;
            const cy = L.boardY + r * L.cellSize + L.cellSize / 2;

            // 着弾エフェクト
            let scale = 1;
            const ic = impactCellRef.current;
            if (ic && ic.row === r && ic.col === c && phase === "impact") {
              const elapsed = Date.now() - impactTimerRef.current;
              const t = elapsed / IMPACT_DURATION;
              scale = 1 + 0.3 * Math.sin(t * Math.PI);
            }
            drawPiece(ctx, cx, cy, L.cellSize * 0.38, cell, 1, scale);
          }
        }

        // --- 飛び散るコマ ---
        for (const fp of flyingPiecesRef.current) {
          drawPiece(ctx, fp.x, fp.y, fp.radius, fp.color, fp.opacity);
        }

        // --- エイム中のハイライト ---
        if (phase === "aiming" && aimTargetRef.current) {
          const { row, col } = aimTargetRef.current;
          const hx = L.boardX + col * L.cellSize;
          const hy = L.boardY + row * L.cellSize;
          const cellBoard = board[row][col];
          const cp = currentPlayerRef.current;
          const isOwn = cellBoard === cp;

          ctx.save();
          ctx.fillStyle = isOwn
            ? "rgba(255,50,50,0.35)"
            : cellBoard
            ? "rgba(255,200,0,0.45)"
            : "rgba(255,255,255,0.3)";
          ctx.strokeStyle = isOwn ? "#ff4444" : "#ffff00";
          ctx.lineWidth = 2;
          drawRoundRect(ctx, hx + 1, hy + 1, L.cellSize - 2, L.cellSize - 2, 4);
          ctx.fill();
          ctx.stroke();
          ctx.restore();

          // エイムライン
          const ballX = L.ballRestX;
          const ballY = L.ballRestY;
          const targetX = L.boardX + col * L.cellSize + L.cellSize / 2;
          const targetY = L.boardY + row * L.cellSize + L.cellSize / 2;
          drawAimLine(ctx, ballX, ballY, targetX, targetY);
        }

        // --- ボールエリア背景 ---
        drawBallArea(ctx, L);

        // --- ボール ---
        if (phase === "flying" && ballAnimRef.current.active) {
          const anim = ballAnimRef.current;
          const t = easeOutCubic(anim.progress);
          const bx = lerp(anim.startX, anim.targetX, t);
          // 放物線
          const arcH = (anim.startY - anim.targetY) * 0.3;
          const by =
            lerp(anim.startY, anim.targetY, t) -
            arcH * Math.sin(anim.progress * Math.PI);
          drawSoccerBall(ctx, bx, by, L.ballRadius, ballRotationRef.current);
        } else if (phase !== "flying") {
          drawSoccerBall(
            ctx,
            L.ballRestX,
            L.ballRestY,
            L.ballRadius,
            isDraggingRef.current ? 0.1 : 0
          );
        }

        // --- ターン表示（ボールエリア） ---
        drawBallAreaUI(ctx, L, phase);

        animFrameRef.current = requestAnimationFrame(animate);
      },
      [handleImpact]
    );

    // ヘッダー描画
    function drawHeader(ctx: CanvasRenderingContext2D, L: typeof layoutRef.current) {
      // 背景
      ctx.fillStyle = "#0d3d0d";
      ctx.fillRect(0, 0, L.canvasW, HEADER_H);

      // 黒コマ数
      const { black, white } = countPieces(boardRef.current);
      const cp = currentPlayerRef.current;

      ctx.save();

      // 黒スコア
      const blackActive = cp === "black";
      ctx.fillStyle = blackActive ? "rgba(0,0,0,0.8)" : "rgba(0,0,0,0.4)";
      drawRoundRect(ctx, 8, 8, L.canvasW / 2 - 16, HEADER_H - 16, 8);
      ctx.fill();
      if (blackActive) {
        ctx.strokeStyle = "#4ade80";
        ctx.lineWidth = 2;
        drawRoundRect(ctx, 8, 8, L.canvasW / 2 - 16, HEADER_H - 16, 8);
        ctx.stroke();
      }

      // 黒円
      drawPiece(ctx, 28, HEADER_H / 2, 10, "black");
      ctx.fillStyle = blackActive ? "#ffffff" : "#aaaaaa";
      ctx.font = `bold ${Math.floor(HEADER_H * 0.45)}px sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(`黒 ${black}`, 44, HEADER_H / 2);

      // 白スコア
      const whiteActive = cp === "white";
      ctx.fillStyle = whiteActive ? "rgba(60,60,60,0.8)" : "rgba(40,40,40,0.4)";
      drawRoundRect(ctx, L.canvasW / 2 + 8, 8, L.canvasW / 2 - 16, HEADER_H - 16, 8);
      ctx.fill();
      if (whiteActive) {
        ctx.strokeStyle = "#4ade80";
        ctx.lineWidth = 2;
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

    // 盤面描画
    function drawBoard(ctx: CanvasRenderingContext2D, L: typeof layoutRef.current) {
      // 背景
      const bgGrad = ctx.createLinearGradient(0, L.boardY, 0, L.boardY + L.boardH);
      bgGrad.addColorStop(0, "#1d6b1d");
      bgGrad.addColorStop(1, "#155215");
      ctx.fillStyle = bgGrad;
      ctx.fillRect(L.boardX, L.boardY, L.boardW, L.boardH);

      // グリッド線
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

      // センターマーク
      ctx.fillStyle = "rgba(255,255,255,0.3)";
      const dots = [
        [2, 2], [2, 6], [6, 2], [6, 6], [4, 4],
      ];
      for (const [r, c] of dots) {
        ctx.beginPath();
        ctx.arc(
          L.boardX + c * L.cellSize,
          L.boardY + r * L.cellSize,
          3,
          0,
          Math.PI * 2
        );
        ctx.fill();
      }
      ctx.restore();
    }

    // ボールエリア背景
    function drawBallArea(ctx: CanvasRenderingContext2D, L: typeof layoutRef.current) {
      const grad = ctx.createLinearGradient(
        0,
        L.ballAreaY,
        0,
        L.ballAreaY + L.ballAreaH
      );
      grad.addColorStop(0, "#155215");
      grad.addColorStop(1, "#0d3d0d");
      ctx.fillStyle = grad;
      ctx.fillRect(0, L.ballAreaY, L.canvasW, L.ballAreaH);

      // ラインマーキング
      ctx.save();
      ctx.strokeStyle = "rgba(255,255,255,0.2)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, L.ballAreaY);
      ctx.lineTo(L.canvasW, L.ballAreaY);
      ctx.stroke();

      // 半円
      ctx.beginPath();
      ctx.arc(L.canvasW / 2, L.ballAreaY, L.ballAreaH * 0.55, Math.PI, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // ボールエリアのUI（ターン表示など）
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
        const msg =
          winner === "draw"
            ? "引き分け！"
            : winner === "black"
            ? "⚫ 黒の勝ち！"
            : "⚪ 白の勝ち！";
        ctx.font = `bold ${L.cellSize * 0.55}px sans-serif`;
        ctx.fillStyle = "#FFD700";
        ctx.shadowColor = "rgba(0,0,0,0.8)";
        ctx.shadowBlur = 8;
        ctx.fillText(msg, L.canvasW / 2, L.ballAreaY + L.ballAreaH - 8);
        ctx.font = `${L.cellSize * 0.4}px sans-serif`;
        ctx.fillStyle = "white";
        ctx.fillText(
          `黒 ${black} ― 白 ${white}`,
          L.canvasW / 2,
          L.ballAreaY + L.ballAreaH - 8 - L.cellSize * 0.6
        );
      } else if (phase === "aiming") {
        ctx.font = `${L.cellSize * 0.4}px sans-serif`;
        ctx.fillStyle = "#7eff7e";
        ctx.fillText("ターゲットを選んで離す", L.canvasW / 2, L.ballAreaY + L.ballAreaH - 8);
      } else if (phase === "cpu_thinking") {
        ctx.font = `${L.cellSize * 0.4}px sans-serif`;
        ctx.fillStyle = "#ffaa44";
        ctx.fillText("CPU が考え中...", L.canvasW / 2, L.ballAreaY + L.ballAreaH - 8);
      } else if (isInteractable) {
        ctx.font = `${L.cellSize * 0.38}px sans-serif`;
        ctx.fillStyle = "rgba(255,255,255,0.7)";
        ctx.fillText("ボールをドラッグして投げる", L.canvasW / 2, L.ballAreaY + L.ballAreaH - 8);
      } else if (mode !== "solo") {
        ctx.font = `${L.cellSize * 0.38}px sans-serif`;
        ctx.fillStyle = "rgba(255,255,255,0.5)";
        ctx.fillText("相手のターン...", L.canvasW / 2, L.ballAreaY + L.ballAreaH - 8);
      }

      ctx.restore();
    }

    // エイムライン描画
    function drawAimLine(
      ctx: CanvasRenderingContext2D,
      bx: number,
      by: number,
      tx: number,
      ty: number
    ) {
      ctx.save();
      ctx.strokeStyle = "rgba(255,255,100,0.7)";
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 5]);
      ctx.shadowColor = "rgba(255,255,0,0.5)";
      ctx.shadowBlur = 4;

      // 放物線の制御点
      const mx = (bx + tx) / 2;
      const my = Math.min(by, ty) - Math.abs(by - ty) * 0.2;

      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.quadraticCurveTo(mx, my, tx, ty);
      ctx.stroke();

      // 矢印
      const angle = Math.atan2(ty - my, tx - mx);
      const arrowSize = 10;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(
        tx - arrowSize * Math.cos(angle - Math.PI / 6),
        ty - arrowSize * Math.sin(angle - Math.PI / 6)
      );
      ctx.moveTo(tx, ty);
      ctx.lineTo(
        tx - arrowSize * Math.cos(angle + Math.PI / 6),
        ty - arrowSize * Math.sin(angle + Math.PI / 6)
      );
      ctx.stroke();

      ctx.restore();
    }

    // ============================================================
    // イベントハンドラ
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
        dragCurrentRef.current = { x, y };
        gamePhaseRef.current = "aiming";
        canvas.setPointerCapture(e.pointerId);
      };

      const onPointerMove = (e: PointerEvent) => {
        if (!isDraggingRef.current) return;
        e.preventDefault();
        const { x, y } = getCanvasPos(e);
        dragCurrentRef.current = { x, y };
        const cell = getTargetCell(x, y);
        aimTargetRef.current = cell;
      };

      const onPointerUp = (e: PointerEvent) => {
        if (!isDraggingRef.current) return;
        isDraggingRef.current = false;
        const target = aimTargetRef.current;
        aimTargetRef.current = null;

        if (!target) {
          gamePhaseRef.current = "idle";
          return;
        }

        const cp = currentPlayerRef.current;
        throwBall(target.row, target.col, cp);
        if (mode === "online" && onMove) {
          onMove(target.row, target.col);
        }
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
    }, [canInteract, getCanvasPos, getTargetCell, isNearBall, throwBall, mode, onMove]);

    // ============================================================
    // 初期化・リサイズ
    // ============================================================
    useEffect(() => {
      calcLayout();
      lastRenderTime.current = performance.now();
      animFrameRef.current = requestAnimationFrame(animate);
      syncDisplayState();

      const ro = new ResizeObserver(() => {
        calcLayout();
      });
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
      ballAnimRef.current.active = false;
      impactCellRef.current = null;
      isDraggingRef.current = false;
      aimTargetRef.current = null;
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
            cursor:
              displayState.phase === "idle" ? "crosshair" : "default",
          }}
        />

        {/* ゲームオーバー時のボタン */}
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
