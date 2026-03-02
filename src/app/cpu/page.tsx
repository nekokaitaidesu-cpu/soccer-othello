"use client";
import { useState } from "react";
import Link from "next/link";
import GameCanvas from "@/components/GameCanvas";
import type { BoardSize } from "@/lib/gameLogic";
import type { Sensitivity, Difficulty } from "@/components/GameCanvas";

export default function CpuPage() {
  const [boardSize, setBoardSize] = useState<BoardSize | null>(null);
  const [sensitivity, setSensitivity] = useState<Sensitivity>(1);
  const [difficulty, setDifficulty] = useState<Difficulty>("normal");

  if (!boardSize) {
    return (
      <div className="min-h-screen flex flex-col items-center bg-green-950">
        <div className="w-full flex items-center px-4 py-3 bg-green-900 shadow-md">
          <Link href="/" className="text-green-300 mr-3 text-lg">←</Link>
          <h1 className="text-white font-bold text-lg">🤖 CPU対戦</h1>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center gap-5 px-6 w-full max-w-sm py-8">

          {/* 盤面サイズ */}
          <p className="text-green-300 font-bold text-lg self-start">盤面サイズ</p>
          <div className="w-full flex gap-3">
            <button
              onClick={() => setBoardSize(6)}
              className="flex-1 py-5 rounded-2xl bg-gradient-to-r from-green-600 to-green-800 text-white text-2xl font-black shadow-lg active:scale-95 transition-transform"
            >
              6 × 6
              <p className="text-xs font-normal opacity-80 mt-1">34手で終了</p>
            </button>
            <button
              onClick={() => setBoardSize(8)}
              className="flex-1 py-5 rounded-2xl bg-gradient-to-r from-blue-600 to-blue-800 text-white text-2xl font-black shadow-lg active:scale-95 transition-transform"
            >
              8 × 8
              <p className="text-xs font-normal opacity-80 mt-1">62手で終了</p>
            </button>
          </div>

          {/* 難易度設定 */}
          <p className="text-green-300 font-bold text-lg self-start mt-2">難易度</p>
          <div className="w-full flex flex-col gap-2">
            {(
              [
                { value: "easy",   label: "かんたん",   desc: "" },
                { value: "normal", label: "ふつう",     desc: "" },
                { value: "hard",   label: "つよい",     desc: "" },
                { value: "oni",    label: "おにつよい", desc: "👹" },
              ] as { value: Difficulty; label: string; desc: string }[]
            ).map(({ value, label, desc }) => (
              <button
                key={value}
                onClick={() => setDifficulty(value)}
                className={`w-full py-3 px-4 rounded-xl font-bold text-left transition-all flex items-center gap-3 ${
                  difficulty === value
                    ? "bg-red-500 text-white"
                    : "bg-green-800 text-green-200"
                }`}
              >
                <span className="text-lg">{label}</span>
                {desc && <span className="text-sm font-normal opacity-90">{desc}</span>}
                {difficulty === value && (
                  <span className="ml-auto text-xs bg-black/20 px-2 py-0.5 rounded-full">選択中</span>
                )}
              </button>
            ))}
          </div>

          {/* 感度設定 */}
          <p className="text-green-300 font-bold text-lg self-start mt-2">投げやすさ（感度）</p>
          <div className="w-full flex flex-col gap-2">
            {([1, 2, 3] as Sensitivity[]).map((s) => (
              <button
                key={s}
                onClick={() => setSensitivity(s)}
                className={`w-full py-3 px-4 rounded-xl font-bold text-left transition-all flex items-center gap-3 ${
                  sensitivity === s
                    ? "bg-yellow-500 text-black"
                    : "bg-green-800 text-green-200"
                }`}
              >
                <span className="text-lg">感度 {s}</span>
                <span className="text-sm font-normal opacity-90">
                  {s === 1 && "頑張って投げる ⭐ おすすめ"}
                  {s === 2 && "普通に投げる"}
                  {s === 3 && "簡単に遠くへ飛ぶ"}
                </span>
                {sensitivity === s && (
                  <span className="ml-auto text-xs bg-black/20 px-2 py-0.5 rounded-full">選択中</span>
                )}
              </button>
            ))}
          </div>

        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center bg-green-950">
      <div className="w-full flex items-center px-4 py-3 bg-green-900 shadow-md">
        <button onClick={() => setBoardSize(null)} className="text-green-300 mr-3 text-lg">←</button>
        <h1 className="text-white font-bold text-lg">🤖 CPU対戦</h1>
        <p className="text-green-400 text-xs ml-3">{boardSize}×{boardSize} ／ あなた（黒） vs CPU（白）</p>
      </div>
      <div className="w-full flex justify-center px-2 pt-2">
        <GameCanvas mode="cpu" myColor="black" boardSize={boardSize} sensitivity={sensitivity} difficulty={difficulty} />
      </div>
    </div>
  );
}
