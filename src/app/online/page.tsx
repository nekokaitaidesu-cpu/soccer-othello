"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import GameCanvas, { GameCanvasHandle } from "@/components/GameCanvas";
import type { Sensitivity } from "@/components/GameCanvas";
import { supabase, isSupabaseConfigured } from "@/lib/supabaseClient";
import type { RealtimeChannel } from "@supabase/supabase-js";
import type { Player, BoardSize } from "@/lib/gameLogic";

type OnlineState =
  | "menu"
  | "creating"
  | "waiting"
  | "joining"
  | "playing"
  | "opponent_left";

type GameMessage =
  | { type: "guest_joined" }
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
  const [statusMsg, setStatusMsg] = useState("");
  const [selectedSize, setSelectedSize] = useState<BoardSize>(6);
  const [gameBoardSize, setGameBoardSize] = useState<BoardSize>(6);
  const [sensitivity, setSensitivity] = useState<Sensitivity>(1);

  const channelRef = useRef<RealtimeChannel | null>(null);
  const isHostRef = useRef(false);
  const gameRef = useRef<GameCanvasHandle>(null);

  // ============================================================
  // チャンネル切断
  // ============================================================
  const leaveChannel = useCallback(() => {
    if (channelRef.current && supabase) {
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => leaveChannel();
  }, [leaveChannel]);

  // ============================================================
  // 部屋を作る（ホスト）
  // ============================================================
  const createRoom = () => {
    if (!supabase) {
      setErrorMsg("Supabaseが設定されていません。.env.localを確認してください。");
      return;
    }
    const code = generateRoomCode();
    setRoomCode(code);
    setOnlineState("creating");
    isHostRef.current = true;

    const channel = supabase.channel(`soccer-othello-room-${code}`, {
      config: { broadcast: { self: false } },
    });

    channel
      .on("broadcast", { event: "game" }, ({ payload }: { payload: GameMessage }) => {
        if (payload.type === "guest_joined" && isHostRef.current) {
          // ゲスト接続 → ゲスト=白でゲーム開始
          channel.send({
            type: "broadcast",
            event: "game",
            payload: { type: "game_start", guestColor: "white", boardSize: selectedSize } as GameMessage,
          });
          setGameBoardSize(selectedSize);
          setMyColor("black");
          setOnlineState("playing");
        } else if (payload.type === "move") {
          gameRef.current?.applyExternalMove(payload.row, payload.col);
        }
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          setOnlineState("waiting");
          setStatusMsg(`部屋コード: ${code} を相手に伝えよう`);
        }
      });

    channelRef.current = channel;
  };

  // ============================================================
  // 部屋に入る（ゲスト）
  // ============================================================
  const joinRoom = () => {
    if (!supabase) {
      setErrorMsg("Supabaseが設定されていません。");
      return;
    }
    if (inputCode.length !== 4) {
      setErrorMsg("4桁のコードを入力してください");
      return;
    }
    setErrorMsg("");
    setOnlineState("joining");
    isHostRef.current = false;

    const channel = supabase.channel(`soccer-othello-room-${inputCode}`, {
      config: { broadcast: { self: false } },
    });

    channel
      .on("broadcast", { event: "game" }, ({ payload }: { payload: GameMessage }) => {
        if (payload.type === "game_start") {
          setMyColor(payload.guestColor);
          setGameBoardSize(payload.boardSize);
          setRoomCode(inputCode);
          setOnlineState("playing");
        } else if (payload.type === "move") {
          gameRef.current?.applyExternalMove(payload.row, payload.col);
        }
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          // 参加通知を送る
          channel.send({
            type: "broadcast",
            event: "game",
            payload: { type: "guest_joined" } as GameMessage,
          });
          setStatusMsg("ホストの応答を待っています...");
        } else if (status === "CHANNEL_ERROR") {
          setErrorMsg("部屋が見つかりません。コードを確認してください。");
          setOnlineState("menu");
        }
      });

    channelRef.current = channel;
  };

  // ============================================================
  // 自分の手を送信
  // ============================================================
  const sendMove = useCallback((row: number, col: number) => {
    channelRef.current?.send({
      type: "broadcast",
      event: "game",
      payload: { type: "move", row, col } as GameMessage,
    });
  }, []);

  // ============================================================
  // 部屋を出る
  // ============================================================
  const exitRoom = () => {
    leaveChannel();
    setOnlineState("menu");
    setRoomCode("");
    setInputCode("");
    setErrorMsg("");
    setStatusMsg("");
    setSelectedSize(6);
    setGameBoardSize(6);
    setSensitivity(1);
  };

  // ============================================================
  // Supabase未設定
  // ============================================================
  if (!isSupabaseConfigured()) {
    return (
      <div className="min-h-screen flex flex-col bg-green-950">
        <div className="w-full flex items-center px-4 py-3 bg-green-900 shadow-md">
          <Link href="/" className="text-green-300 mr-3 text-lg">←</Link>
          <h1 className="text-white font-bold text-lg">🌐 ONLINEモード</h1>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center px-6 gap-6">
          <div className="bg-yellow-900 border border-yellow-500 rounded-xl p-6 max-w-md text-center">
            <p className="text-yellow-300 font-bold text-lg mb-3">⚠️ 設定が必要です</p>
            <p className="text-yellow-100 text-sm mb-4">
              ONLINEモードを使うには Supabase の設定が必要です。
            </p>
            <ol className="text-left text-yellow-200 text-sm space-y-2">
              <li>1. <a href="https://supabase.com" target="_blank" rel="noopener" className="underline">supabase.com</a> で無料プロジェクト作成</li>
              <li>2. Project Settings → API からURLとAnon Keyを取得</li>
              <li>3. <code className="bg-black/30 px-1 rounded">.env.local</code> ファイルに設定:</li>
            </ol>
            <pre className="bg-black/40 rounded p-3 text-xs text-green-300 mt-3 text-left">
{`NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...`}
            </pre>
            <p className="text-yellow-300 text-xs mt-3">設定後 npm run dev を再起動</p>
          </div>
        </div>
      </div>
    );
  }

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
        <div className="flex-1 flex flex-col items-center justify-center px-6 gap-6 w-full max-w-sm py-10">
          {onlineState === "opponent_left" && (
            <p className="text-red-400 text-sm">相手が退出しました</p>
          )}

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
            {errorMsg && <p className="text-red-400 text-sm mt-2">{errorMsg}</p>}
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
              <p className="text-green-300">ホストの応答を待っています...</p>
            )}
            {onlineState === "creating" && (
              <p className="text-green-300">接続中...</p>
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
