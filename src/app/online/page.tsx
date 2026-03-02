"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import GameCanvas, { GameCanvasHandle } from "@/components/GameCanvas";
import type { Sensitivity } from "@/components/GameCanvas";
import type { Player, BoardSize } from "@/lib/gameLogic";
import type { DataConnection } from "peerjs";
// peerjs は dynamic import でブラウザ側のみロード

const PEER_PREFIX = "soc-";

type OnlineState =
  | "menu"
  | "creating"
  | "waiting"
  | "joining"
  | "playing"
  | "opponent_left";

type GameMessage =
  | { type: "game_start"; guestColor: Player; boardSize: BoardSize }
  | { type: "move"; row: number; col: number };

function generateRoomCode(): string {
  return String(Math.floor(1000 + Math.random() * 9000));
}

export default function OnlinePage() {
  const [onlineState, setOnlineState] = useState<OnlineState>("menu");
  const [roomCode, setRoomCode] = useState("");
  const [inputCode, setInputCode] = useState("");
  const [myColor, setMyColor] = useState<Player>("black");
  const [errorMsg, setErrorMsg] = useState("");
  const [selectedSize, setSelectedSize] = useState<BoardSize>(6);
  const [gameBoardSize, setGameBoardSize] = useState<BoardSize>(6);
  const [sensitivity, setSensitivity] = useState<Sensitivity>(1);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const peerRef = useRef<any>(null);
  const connRef = useRef<DataConnection | null>(null);
  const gameRef = useRef<GameCanvasHandle>(null);
  const onlineStateRef = useRef<OnlineState>("menu");

  useEffect(() => {
    onlineStateRef.current = onlineState;
  }, [onlineState]);

  const destroyPeer = useCallback(() => {
    connRef.current?.close();
    peerRef.current?.destroy();
    connRef.current = null;
    peerRef.current = null;
  }, []);

  useEffect(() => {
    return () => destroyPeer();
  }, [destroyPeer]);

  // ============================================================
  // 接続セットアップ（共通）
  // ============================================================
  const setupConn = useCallback(
    (conn: DataConnection) => {
      connRef.current = conn;

      conn.on("data", (data) => {
        const msg = data as GameMessage;
        if (msg.type === "game_start") {
          setMyColor(msg.guestColor);
          setGameBoardSize(msg.boardSize);
          setOnlineState("playing");
        } else if (msg.type === "move") {
          gameRef.current?.applyExternalMove(msg.row, msg.col);
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
    },
    [destroyPeer]
  );

  // ============================================================
  // 部屋を作る（ホスト）
  // ============================================================
  const createRoom = async () => {
    setErrorMsg("");
    const code = generateRoomCode();
    setRoomCode(code);
    setOnlineState("creating");

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
      setOnlineState("waiting");
    });

    peer.on("connection", (conn: DataConnection) => {
      setupConn(conn);
      conn.on("open", () => {
        const bs = selectedSize;
        conn.send({ type: "game_start", guestColor: "white", boardSize: bs } as GameMessage);
        setGameBoardSize(bs);
        setMyColor("black");
        setOnlineState("playing");
      });
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
      setupConn(conn);

      conn.on("open", () => {
        setRoomCode(inputCode);
        // ホストから game_start が来るまで待つ
      });

      // 接続タイムアウト（10秒）
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
  // 自分の手を送信
  // ============================================================
  const sendMove = useCallback((row: number, col: number) => {
    connRef.current?.send({ type: "move", row, col } as GameMessage);
  }, []);

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
    setGameBoardSize(6);
    setSensitivity(1);
  };

  // ============================================================
  // UI
  // ============================================================
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
            部屋: {roomCode} / あなたは{myColor === "black" ? "⚫黒" : "⚪白"}
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

          {/* 盤面サイズ選択 */}
          <div className="w-full bg-green-900 rounded-2xl p-4 shadow-lg">
            <p className="text-white font-bold text-sm mb-2">盤面サイズ（部屋を作る人が選択）</p>
            <div className="flex gap-3">
              <button
                onClick={() => setSelectedSize(6)}
                className={`flex-1 py-3 rounded-xl font-bold text-lg transition-all ${selectedSize === 6 ? "bg-green-500 text-white" : "bg-green-800 text-green-300"}`}
              >
                6×6
                <p className="text-xs font-normal opacity-80">34手</p>
              </button>
              <button
                onClick={() => setSelectedSize(8)}
                className={`flex-1 py-3 rounded-xl font-bold text-lg transition-all ${selectedSize === 8 ? "bg-blue-500 text-white" : "bg-green-800 text-green-300"}`}
              >
                8×8
                <p className="text-xs font-normal opacity-80">62手</p>
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
      {(onlineState === "waiting" || onlineState === "creating" || onlineState === "joining") && (
        <div className="flex-1 flex flex-col items-center justify-center px-6 gap-6">
          <div className="text-center">
            <div className="text-6xl mb-4 animate-bounce">⏳</div>
            {onlineState === "waiting" && (
              <>
                <p className="text-white text-xl font-bold mb-2">部屋コード</p>
                <p className="text-6xl font-mono font-black text-green-400 tracking-[0.2em] mb-4">
                  {roomCode}
                </p>
                <p className="text-green-300 text-sm">友だちにこのコードを伝えよう</p>
                <p className="text-green-400 text-xs mt-1 animate-pulse">相手の接続を待っています...</p>
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
        <div className="w-full flex justify-center px-2 pt-2">
          <GameCanvas
            ref={gameRef}
            mode="online"
            myColor={myColor}
            boardSize={gameBoardSize}
            sensitivity={sensitivity}
            onMove={sendMove}
          />
        </div>
      )}
    </div>
  );
}
