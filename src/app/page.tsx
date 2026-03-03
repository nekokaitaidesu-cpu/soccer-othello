"use client";
import Link from "next/link";

export default function HomePage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6 bg-gradient-to-b from-green-950 to-green-900">
      {/* タイトル */}
      <div className="mb-10 text-center">
        <div className="text-6xl mb-3">⚽</div>
        <h1 className="text-4xl font-black tracking-wider text-white drop-shadow-lg">
          サッカーオセロ
        </h1>
        <p className="text-green-300 mt-2 text-sm">ボールを投げてコマを置こう！</p>
      </div>

      {/* モード選択 */}
      <div className="flex flex-col gap-4 w-full max-w-xs">
        <Link href="/solo">
          <button className="w-full py-5 rounded-2xl bg-gradient-to-r from-blue-500 to-blue-700 text-white text-xl font-bold shadow-lg active:scale-95 transition-transform">
            🎯 １人モード
            <p className="text-xs font-normal opacity-80 mt-1">投げる練習をしよう</p>
          </button>
        </Link>

        <Link href="/cpu">
          <button className="w-full py-5 rounded-2xl bg-gradient-to-r from-orange-500 to-orange-700 text-white text-xl font-bold shadow-lg active:scale-95 transition-transform">
            🤖 CPU対戦
            <p className="text-xs font-normal opacity-80 mt-1">コンピューターと対戦</p>
          </button>
        </Link>

        <Link href="/online">
          <button className="w-full py-5 rounded-2xl bg-gradient-to-r from-purple-500 to-purple-700 text-white text-xl font-bold shadow-lg active:scale-95 transition-transform">
            🌐 ONLINEモード
            <p className="text-xs font-normal opacity-80 mt-1">友だちとオンライン対戦</p>
          </button>
        </Link>
      </div>

      {/* ルール説明 */}
      <div className="mt-10 max-w-xs text-green-300 text-xs text-center leading-relaxed">
        <p>ボールを投げてコマを置く。相手のコマに当たると弾き飛ばして自分のコマに。所定の手数を投げ終わったら、コマが多い方の勝ち！</p>
      </div>
    </div>
  );
}
