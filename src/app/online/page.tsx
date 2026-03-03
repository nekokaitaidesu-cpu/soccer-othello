"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import GameCanvas, { GameCanvasHandle } from "@/components/GameCanvas";
import type { Sensitivity } from "@/components/GameCanvas";
import type { Player, BoardSize, Board } from "@/lib/gameLogic";
import { getCPUMove } from "@/lib/gameLogic";
import type { DataConnection } from "peerjs";

const PEER_PREFIX = "soc-";
const CPU_THINK_DELAY = 700;

// ターン順ヘルパー（gameLogicのgetNextPlayerと同じロジック）
function nextPlayer(current: Player, pc: 2 | 3): Player {
  if (pc === 2) return current === "black" ? "white" : "black";
  if (current === "black") return "white";
  if (current === "white") return "red";
  return "black";
}

type OnlineState =
  | "menu"
  | "creating"
  | "waiting_1"    // ホスト: ゲスト1待ち
  | "waiting_2"    // ホスト(3人): ゲスト2待ち
  | "joining"
  | "playing"
  | "opponent_left";

type GameMessage =
  | { type: "game_start"; myColor: Player; boardSize: BoardSize; playerCount: 2 | 3 }
  | { type: "move"; row: number; col: number; player: Player }
  | { type: "player_left"; leftColor: Player };

function generateRoomCode(): string {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function shuffleColors(count: 2 | 3): Player[] {
  const all: Player[] = count === 3 ? ["black", "white", "red"] : ["black", "white"];
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all;
}

export default function OnlinePage() {
  const [onlineState, setOnlineState] = useState<OnlineState>("menu");
  const [roomCode, setRoomCode] = useState("");
  const [inputCode, setInputCode] = useState("");
  const [myColor, setMyColor] = useState<Player>("black");
  const [errorMsg, setErrorMsg] = useState("");
  const [selectedSize, setSelectedSize] = useState<BoardSize>(6);
  const [selectedPlayerCount, setSelectedPlayerCount] = useState<2 | 3>(2);
  const [gameBoardSize, setGameBoardSize] = useState<BoardSize>(6);
  const [gamePlayerCount, setGamePlayerCount] = useState<2 | 3>(2);
  const [sensitivity, setSensitivity] = useState<Sensitivity>(1);
  const [disconnectedMsg, setDisconnectedMsg] = useState("");
  const [disconnectedColors, setDisconnectedColors] = useState<Player[]>([]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const peerRef = useRef<any>(null);
  const conn1Ref = useRef<DataConnection | null>(null); // ゲスト1 or ホストへの接続
  const conn2Ref = useRef<DataConnection | null>(null); // ゲスト2（ホスト3人時）
  const gameRef = useRef<GameCanvasHandle>(null);
  const onlineStateRef = useRef<OnlineState>("menu");
  const isHostRef = useRef(false);
  const gamePcRef = useRef<2 | 3>(2);
  const myColorRef = useRef<Player>("black");
  const disconnectedColorsRef = useRef<Player[]>([]);

  useEffect(() => { onlineStateRef.current = onlineState; }, [onlineState]);
  useEffect(() => { myColorRef.current = myColor; }, [myColor]);

  const destroyPeer = useCallback(() => {
    conn1Ref.current?.close();
    conn2Ref.current?.close();
    peerRef.current?.destroy();
    conn1Ref.current = null;
    conn2Ref.current = null;
    peerRef.current = null;
    isHostRef.current = false;
    disconnectedColorsRef.current = [];
  }, []);

  useEffect(() => { return () => destroyPeer(); }, [destroyPeer]);

  // ============================================================
  // CPU代替投球（切断したプレイヤーの代わりにホストが投げる）
  // ============================================================
  const triggerCPUForDisconnected = useCallback((cpuColor: Player) => {
    const board: Board | undefined = gameRef.current?.getBoard();
    if (!board) return;
    const move = getCPUMove(board, cpuColor);
    if (!move) return;
    // applyExternalMoveを呼ぶだけ。onMove経由でrelayPlayersに含まれていればsendMoveが自動で呼ばれる
    gameRef.current?.applyExternalMove(move.row, move.col, cpuColor);
  }, []);

  // ターン変更コールバック（切断プレイヤーのターンならCPU代替）
  const handleTurnChange = useCallback((newPlayer: Player) => {
    if (!isHostRef.current) return;
    if (!disconnectedColorsRef.current.includes(newPlayer)) return;
    setTimeout(() => triggerCPUForDisconnected(newPlayer), CPU_THINK_DELAY);
  }, [triggerCPUForDisconnected]);

  // ============================================================
  // 自分の手を送信
  // ============================================================
  const sendMove = useCallback((row: number, col: number, player: Player) => {
    const msg: GameMessage = { type: "move", row, col, player };
    conn1Ref.current?.send(msg);
    conn2Ref.current?.send(msg);
  }, []);

  // ============================================================
  // 切断処理（ホスト用）
  // ============================================================
  const handleGuestDisconnect = useCallback((leftColor: Player) => {
    disconnectedColorsRef.current = [...disconnectedColorsRef.current, leftColor];
    setDisconnectedColors([...disconnectedColorsRef.current]);
    const remainingConns = [conn1Ref.current, conn2Ref.current].filter(Boolean).length;
    if (remainingConns === 0) {
      setOnlineState("opponent_left");
      destroyPeer();
      return;
    }
    const colorLabel = leftColor === "black" ? "⚫黒" : leftColor === "white" ? "⚪白" : "🔴赤";
    setDisconnectedMsg(`${colorLabel}が切断しました。CPUが代わります`);
    // 残ったゲストに通知
    const notifyMsg: GameMessage = { type: "player_left", leftColor };
    conn1Ref.current?.send(notifyMsg);
    conn2Ref.current?.send(notifyMsg);
    // 切断時点でそのプレイヤーのターンだった場合、即CPU起動（onTurnChangeは再発火しないため）
    const cp = gameRef.current?.getCurrentPlayer();
    if (cp === leftColor) {
      setTimeout(() => triggerCPUForDisconnected(leftColor), CPU_THINK_DELAY);
    }
  }, [destroyPeer, triggerCPUForDisconnected]);

  // ============================================================
  // 接続セットアップ（ゲスト側）
  // ============================================================
  const setupConnAsGuest = useCallback((conn: DataConnection) => {
    conn1Ref.current = conn;

    conn.on("data", (data) => {
      const msg = data as GameMessage;
      if (msg.type === "game_start") {
        setMyColor(msg.myColor);
        myColorRef.current = msg.myColor;
        setGameBoardSize(msg.boardSize);
        setGamePlayerCount(msg.playerCount);
        gamePcRef.current = msg.playerCount;
        setOnlineState("playing");
      } else if (msg.type === "move") {
        gameRef.current?.applyExternalMove(msg.row, msg.col, msg.player);
      } else if (msg.type === "player_left") {
        setDisconnectedMsg(
          `${msg.leftColor === "black" ? "⚫黒" : msg.leftColor === "white" ? "⚪白" : "🔴赤"}が切断しました。CPUが代わります`
        );
        disconnectedColorsRef.current = [...disconnectedColorsRef.current, msg.leftColor];
      }
    });

    conn.on("close", () => {
      setOnlineState("opponent_left");
      destroyPeer();
    });

    conn.on("error", () => {
      setErrorMsg("接続エラーが発生しました");
      setOnlineState("menu");
      destroyPeer();
    });
  }, [destroyPeer]);

  // ============================================================
  // 接続セットアップ（ホスト用 - ゲスト1）
  // ============================================================
  const setupConn1AsHost = useCallback((conn: DataConnection, assignedColor: Player, pc: 2 | 3, bs: BoardSize, guestColors: Player[]) => {
    conn1Ref.current = conn;

    conn.on("data", (data) => {
      const msg = data as GameMessage;
      if (msg.type === "move") {
        // 自分のキャンバスに適用
        gameRef.current?.applyExternalMove(msg.row, msg.col, msg.player);
        // 3人なら ゲスト2 にもリレー
        conn2Ref.current?.send(msg);
      }
    });

    conn.on("close", () => {
      // ゲーム中の切断のみCPU代打。ゲーム前（waiting_2など）の切断は無視
      if (onlineStateRef.current === "playing") {
        handleGuestDisconnect(assignedColor);
      }
    });

    conn.on("error", () => {
      setErrorMsg("接続エラー");
    });
  }, [handleGuestDisconnect]);

  // ============================================================
  // 接続セットアップ（ホスト用 - ゲスト2）
  // ============================================================
  const setupConn2AsHost = useCallback((conn: DataConnection, assignedColor: Player) => {
    conn2Ref.current = conn;

    conn.on("data", (data) => {
      const msg = data as GameMessage;
      if (msg.type === "move") {
        gameRef.current?.applyExternalMove(msg.row, msg.col, msg.player);
        // ゲスト1にリレー
        conn1Ref.current?.send(msg);
      }
    });

    conn.on("close", () => {
      if (onlineStateRef.current === "playing") {
        handleGuestDisconnect(assignedColor);
      }
    });

    conn.on("error", () => {
      setErrorMsg("接続エラー");
    });
  }, [handleGuestDisconnect]);

  // ============================================================
  // 部屋を作る（ホスト）
  // ============================================================
  const createRoom = async () => {
    setErrorMsg("");
    const code = generateRoomCode();
    setRoomCode(code);
    setOnlineState("creating");
    isHostRef.current = true;

    const { default: Peer } = await import("peerjs");
    const peer = new Peer(`${PEER_PREFIX}${code}`);
    peerRef.current = peer;

    peer.on("error", (err: { type?: string }) => {
      if (err.type === "unavailable-id") {
        setErrorMsg("このコードは使用中です。もう一度お試しください。");
      } else {
        setErrorMsg("接続エラーが発生しました。");
      }
      setOnlineState("menu");
      destroyPeer();
    });

    peer.on("open", () => {
      setOnlineState("waiting_1");
    });

    const pc = selectedPlayerCount;
    const bs = selectedSize;
    const colors = shuffleColors(pc);
    const hostColor = colors[0];

    let guestCount = 0;

    peer.on("connection", (conn: DataConnection) => {
      guestCount++;
      const guestColor = colors[guestCount]; // colors[1] for guest1, colors[2] for guest2

      if (pc === 2) {
        // 2人対戦: ゲスト接続即スタート
        setupConn1AsHost(conn, guestColor, pc, bs, colors);
        conn.on("open", () => {
          conn.send({ type: "game_start", myColor: guestColor, boardSize: bs, playerCount: pc } as GameMessage);
          setGameBoardSize(bs);
          setGamePlayerCount(pc);
          gamePcRef.current = pc;
          setMyColor(hostColor);
          myColorRef.current = hostColor;
          setOnlineState("playing");
        });
      } else {
        // 3人対戦
        if (guestCount === 1) {
          setupConn1AsHost(conn, guestColor, pc, bs, colors);
          setOnlineState("waiting_2");
        } else if (guestCount === 2) {
          setupConn2AsHost(conn, guestColor);
          // 両ゲストにゲームスタート送信
          conn.on("open", () => {
            conn1Ref.current?.send({ type: "game_start", myColor: colors[1], boardSize: bs, playerCount: pc } as GameMessage);
            conn.send({ type: "game_start", myColor: colors[2], boardSize: bs, playerCount: pc } as GameMessage);
            setGameBoardSize(bs);
            setGamePlayerCount(pc);
            gamePcRef.current = pc;
            setMyColor(hostColor);
            myColorRef.current = hostColor;
            setOnlineState("playing");
          });
        }
      }
    });
  };

  // ============================================================
  // 部屋に入る（ゲスト）
  // ============================================================
  const joinRoom = async () => {
    if (inputCode.length !== 4) {
      setErrorMsg("4桁のコードを入力してください");
      return;
    }
    setErrorMsg("");
    setOnlineState("joining");

    const { default: Peer } = await import("peerjs");
    const peer = new Peer();
    peerRef.current = peer;

    peer.on("open", () => {
      const conn = peer.connect(`${PEER_PREFIX}${inputCode}`, { reliable: true });
      setupConnAsGuest(conn);
      conn.on("open", () => {
        setRoomCode(inputCode);
      });

      setTimeout(() => {
        if (onlineStateRef.current === "joining") {
          setErrorMsg("ホストに接続できませんでした。コードを確認してください。");
          setOnlineState("menu");
          destroyPeer();
        }
      }, 10000);
    });

    peer.on("error", () => {
      setErrorMsg("部屋が見つかりません。コードを確認してください。");
      setOnlineState("menu");
      destroyPeer();
    });
  };

  // ============================================================
  // 部屋を出る
  // ============================================================
  const exitRoom = () => {
    destroyPeer();
    setOnlineState("menu");
    setRoomCode("");
    setInputCode("");
    setErrorMsg("");
    setSelectedSize(6);
    setSelectedPlayerCount(2);
    setGameBoardSize(6);
    setGamePlayerCount(2);
    setSensitivity(1);
    setDisconnectedMsg("");
    setDisconnectedColors([]);
  };

  // ============================================================
  // UI
  // ============================================================
  const colorLabel = (p: Player) => p === "black" ? "⚫黒" : p === "white" ? "⚪白" : "🔴赤";
  const waitingCount = onlineState === "waiting_2" ? "1/2" : "0/2";

  return (
    <div className="min-h-screen flex flex-col items-center bg-green-950">
      {/* ヘッダー */}
      <div className="w-full flex items-center px-4 py-3 bg-green-900 shadow-md">
        {onlineState === "playing" ? (
          <button onClick={exitRoom} className="text-green-300 mr-3 text-lg">←</button>
        ) : (
          <Link href="/" className="text-green-300 mr-3 text-lg">←</Link>
        )}
        <h1 className="text-white font-bold text-lg">🌐 ONLINEモード</h1>
        {onlineState === "playing" && (
          <span className="ml-3 text-green-300 text-xs">
            部屋: {roomCode} / あなたは{colorLabel(myColor)}
          </span>
        )}
      </div>

      {/* メニュー画面 */}
      {(onlineState === "menu" || onlineState === "opponent_left") && (
        <div className="flex-1 flex flex-col items-center justify-center px-6 gap-5 w-full max-w-sm py-8">
          {onlineState === "opponent_left" && (
            <p className="text-red-400 text-sm">相手が退出しました</p>
          )}
          {errorMsg && <p className="text-red-400 text-sm">{errorMsg}</p>}

          {/* 対戦人数 */}
          <div className="w-full bg-green-900 rounded-2xl p-4 shadow-lg">
            <p className="text-white font-bold text-sm mb-2">対戦人数（部屋を作る人が選択）</p>
            <div className="flex gap-3">
              <button
                onClick={() => setSelectedPlayerCount(2)}
                className={`flex-1 py-3 rounded-xl font-bold text-lg transition-all ${selectedPlayerCount === 2 ? "bg-green-500 text-white" : "bg-green-800 text-green-300"}`}
              >
                2人
                <p className="text-xs font-normal opacity-80">⚫ vs ⚪</p>
              </button>
              <button
                onClick={() => setSelectedPlayerCount(3)}
                className={`flex-1 py-3 rounded-xl font-bold text-lg transition-all ${selectedPlayerCount === 3 ? "bg-purple-500 text-white" : "bg-green-800 text-green-300"}`}
              >
                3人
                <p className="text-xs font-normal opacity-80">⚫⚪🔴</p>
              </button>
            </div>
          </div>

          {/* 盤面サイズ選択 */}
          <div className="w-full bg-green-900 rounded-2xl p-4 shadow-lg">
            <p className="text-white font-bold text-sm mb-2">盤面サイズ（部屋を作る人が選択）</p>
            <div className="flex gap-3">
              <button
                onClick={() => setSelectedSize(6)}
                className={`flex-1 py-3 rounded-xl font-bold text-lg transition-all ${selectedSize === 6 ? "bg-green-500 text-white" : "bg-green-800 text-green-300"}`}
              >
                6×6
              </button>
              <button
                onClick={() => setSelectedSize(8)}
                className={`flex-1 py-3 rounded-xl font-bold text-lg transition-all ${selectedSize === 8 ? "bg-blue-500 text-white" : "bg-green-800 text-green-300"}`}
              >
                8×8
              </button>
            </div>
          </div>

          {/* 感度設定 */}
          <div className="w-full bg-green-900 rounded-2xl p-4 shadow-lg">
            <p className="text-white font-bold text-sm mb-2">投げやすさ（感度）— 自分だけに適用</p>
            <div className="flex flex-col gap-2">
              {([1, 2, 3] as Sensitivity[]).map((s) => (
                <button
                  key={s}
                  onClick={() => setSensitivity(s)}
                  className={`w-full py-2 px-3 rounded-xl font-bold text-left text-sm flex items-center gap-2 transition-all ${
                    sensitivity === s ? "bg-yellow-500 text-black" : "bg-green-800 text-green-200"
                  }`}
                >
                  <span>感度 {s}</span>
                  <span className="font-normal opacity-90">
                    {s === 1 && "頑張って投げる ⭐"}
                    {s === 2 && "普通に投げる"}
                    {s === 3 && "簡単に遠くへ飛ぶ"}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* 部屋を作る */}
          <button
            onClick={createRoom}
            className="w-full py-5 rounded-2xl bg-gradient-to-r from-blue-600 to-blue-800 text-white text-xl font-bold shadow-lg active:scale-95 transition-transform"
          >
            🏠 部屋を作る
            <p className="text-xs font-normal opacity-80 mt-1">4桁コードが発行されます</p>
          </button>

          {/* 部屋に入る */}
          <div className="w-full bg-green-900 rounded-2xl p-5 shadow-lg">
            <p className="text-white font-bold text-lg mb-3">🚪 部屋に入る</p>
            <input
              type="tel"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={4}
              placeholder="4桁のコード"
              value={inputCode}
              onChange={(e) => setInputCode(e.target.value.replace(/\D/g, "").slice(0, 4))}
              className="w-full text-center text-3xl font-mono py-3 rounded-xl bg-green-800 text-white border-2 border-green-600 focus:border-green-400 outline-none tracking-widest"
            />
            <button
              onClick={joinRoom}
              disabled={inputCode.length !== 4}
              className="w-full mt-3 py-3 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-bold text-lg active:scale-95 transition-all"
            >
              参加する
            </button>
          </div>
        </div>
      )}

      {/* 待機画面 */}
      {(onlineState === "waiting_1" || onlineState === "waiting_2" || onlineState === "creating" || onlineState === "joining") && (
        <div className="flex-1 flex flex-col items-center justify-center px-6 gap-6">
          <div className="text-center">
            <div className="text-6xl mb-4 animate-bounce">⏳</div>
            {(onlineState === "waiting_1" || onlineState === "waiting_2") && (
              <>
                <p className="text-white text-xl font-bold mb-2">部屋コード</p>
                <p className="text-6xl font-mono font-black text-green-400 tracking-[0.2em] mb-4">
                  {roomCode}
                </p>
                <p className="text-green-300 text-sm">友だちにこのコードを伝えよう</p>
                {selectedPlayerCount === 3 && (
                  <p className="text-purple-300 text-sm mt-1">
                    参加者 {waitingCount} 人（あと{onlineState === "waiting_1" ? 2 : 1}人待ち）
                  </p>
                )}
                <p className="text-green-400 text-xs mt-1 animate-pulse">接続を待っています...</p>
              </>
            )}
            {onlineState === "joining" && (
              <p className="text-green-300">ホストに接続中...</p>
            )}
            {onlineState === "creating" && (
              <p className="text-green-300">部屋を作成中...</p>
            )}
            <button
              onClick={exitRoom}
              className="mt-6 px-6 py-2 rounded-xl bg-red-800 hover:bg-red-700 text-white text-sm"
            >
              キャンセル
            </button>
          </div>
        </div>
      )}

      {/* ゲーム画面 */}
      {onlineState === "playing" && (
        <div className="w-full flex flex-col items-center px-2 pt-2">
          {disconnectedMsg && (
            <p className="text-yellow-400 text-sm mb-2 bg-yellow-900/40 px-4 py-2 rounded-xl">
              ⚠️ {disconnectedMsg}（よわいCPUが代打）
            </p>
          )}
          <GameCanvas
            ref={gameRef}
            mode="online"
            myColor={myColor}
            boardSize={gameBoardSize}
            playerCount={gamePlayerCount}
            sensitivity={sensitivity}
            onMove={sendMove}
            onTurnChange={handleTurnChange}
            relayPlayers={disconnectedColors}
          />
        </div>
      )}
    </div>
  );
}
