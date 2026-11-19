// 力の釣り合いの検算（強度の解析）。
// 実験 4（docs/EXPERIMENT-4.md）で、CalculiX が時々、連立方程式の並列実行のせいで間違った反力を出すことが分かった。
// 変位や応力は一見もっともらしいので、結果を使う前に「支持の反力の合計が、荷重の合計と釣り合っているか」を確かめる。

export interface BalanceCheck {
  ok: boolean;
  /** 反力 + 荷重 の残り [N]（0 に近いほど釣り合っている） */
  residual: number;
  /** 荷重の大きさ [N] */
  load: number;
  /** 残り ÷ 荷重（荷重がほぼ 0 のときは使わない） */
  relative: number;
}

/** 釣り合っているとみなす相対差の上限（2%） */
export const BALANCE_TOLERANCE = 0.02;
/** 荷重がこれより小さいときは、相対ではなく絶対値 [N] で見る */
export const BALANCE_TINY_LOAD = 1e-3;

/**
 * reaction: 支持の節点の反力の合計（ccx の RF。支持が物体に及ぼす力）
 * applied: 支持でない節点にかけた荷重の合計（荷重の倍率をかけたあと）。
 *   支持の節点に直接かけた荷重は、拘束に吸われて RF には現れないので含めない。
 * 釣り合っていれば reaction + applied ≈ 0 になる。
 */
export function checkBalance(o: { reaction: { x: number; y: number }; applied: { x: number; y: number } }): BalanceCheck {
  const residual = Math.hypot(o.reaction.x + o.applied.x, o.reaction.y + o.applied.y);
  const load = Math.hypot(o.applied.x, o.applied.y);
  const relative = load > 0 ? residual / load : Infinity;
  const finite = Number.isFinite(residual);
  const ok = finite && (load < BALANCE_TINY_LOAD ? residual <= BALANCE_TINY_LOAD : relative <= BALANCE_TOLERANCE);
  return { ok, residual, load, relative };
}
