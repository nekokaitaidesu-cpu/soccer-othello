"use client";
import { useState } from "react";
import Link from "next/link";
import GameCanvas from "@/components/GameCanvas";
import type { BoardSize } from "@/lib/gameLogic";

export default function SoloPage() {
  const [boardSize, setBoardSize] = useState<BoardSize | null>(null);

  if (!boardSize) {
    return (
      <div className="min-h-screen flex flex-col items-center bg-green-950">
        <div className="w-full flex items-center px-4 py-3 bg-green-900 shadow-md">
          <Link href="/" className="text-green-300 mr-3 text-lg">←</Link>
          <h1 className="text-white font-bold text-lg">🎯 １人モード</h1>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center gap-6 px-6 w-full max-w-sm">
          <p className="text-green-300 font-bold text-xl">盤面サイズを選んでください</p>
          <button
            onClick={() => setBoardSize(6)}
            className="w-full py-6 rounded-2xl bg-gradient-to-r from-green-600 to-green-800 text-white text-2xl font-black shadow-lg active:scale-95 transition-transform"
          >
            6 × 6
            <p className="text-sm font-normal opacity-80 mt-1">34手で終了</p>
          </button>
          <button
            onClick={() => setBoardSize(8)}
            className="w-full py-6 rounded-2xl bg-gradient-to-r from-blue-600 to-blue-800 text-white text-2xl font-black shadow-lg active:scale-95 transition-transform"
          >
            8 × 8
            <p className="text-sm font-normal opacity-80 mt-1">62手で終了</p>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center bg-green-950">
      <div className="w-full flex items-center px-4 py-3 bg-green-900 shadow-md">
        <button onClick={() => setBoardSize(null)} className="text-green-300 mr-3 text-lg">←</button>
        <h1 className="text-white font-bold text-lg">🎯 １人モード</h1>
        <p className="text-green-400 text-xs ml-3">{boardSize}×{boardSize} ／ 好きな場所に投げて練習しよう</p>
      </div>
      <div className="w-full flex justify-center px-2 pt-2">
        <GameCanvas mode="solo" myColor="black" boardSize={boardSize} />
      </div>
    </div>
  );
}
