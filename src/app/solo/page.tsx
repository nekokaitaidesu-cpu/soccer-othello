"use client";
import Link from "next/link";
import GameCanvas from "@/components/GameCanvas";

export default function SoloPage() {
  return (
    <div className="min-h-screen flex flex-col items-center bg-green-950">
      {/* ヘッダー */}
      <div className="w-full flex items-center px-4 py-3 bg-green-900 shadow-md">
        <Link href="/" className="text-green-300 mr-3 text-lg">←</Link>
        <h1 className="text-white font-bold text-lg">🎯 １人モード</h1>
        <p className="text-green-400 text-xs ml-3">好きな場所に投げて練習しよう</p>
      </div>

      {/* ゲーム */}
      <div className="w-full flex justify-center px-2 pt-2">
        <GameCanvas mode="solo" myColor="black" />
      </div>
    </div>
  );
}
