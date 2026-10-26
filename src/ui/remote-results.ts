// 本計算（PC のエンジン）の結果の置き場。DOM にも Runner にも依存しない。
// 形や条件が変わるたびに runner の revision が増えるので、結果を受け取ったときの revision と
// 今の revision が違えば「古い結果」として、表示にも Excel にも使わない。
import type { AnalysisKind, ResultSet } from '../core/types';

export interface RemoteEntry {
  kind: AnalysisKind;
  /** 表示名つきの結果（label が入っている） */
  result: ResultSet;
  /** 結果を作る元になったプロジェクトの revision */
  rev: number;
  /** 画面に出す名前（例: 「CalculiX 本計算」） */
  label: string;
  at: number;
}

export class RemoteResults {
  private map = new Map<AnalysisKind, RemoteEntry>();

  set(opts: { kind: AnalysisKind; result: ResultSet; rev: number; label: string; at?: number }): RemoteEntry {
    const entry: RemoteEntry = { kind: opts.kind, rev: opts.rev, label: opts.label, at: opts.at ?? Date.now(), result: { ...opts.result, label: opts.label } };
    this.map.set(opts.kind, entry);
    return entry;
  }

  /** 今の revision と同じ（古くない）結果。なければ null */
  get(kind: AnalysisKind, rev: number): RemoteEntry | null {
    const e = this.map.get(kind);
    return e && e.rev === rev ? e : null;
  }

  /** 結果はあるが、形や条件が変わって古くなっているか */
  isStale(kind: AnalysisKind, rev: number): boolean {
    const e = this.map.get(kind);
    return !!e && e.rev !== rev;
  }

  /** 古くない結果すべて（Excel 出力用） */
  valid(rev: number): RemoteEntry[] {
    return [...this.map.values()].filter((e) => e.rev === rev);
  }

  clear(kind?: AnalysisKind): void {
    if (kind) this.map.delete(kind);
    else this.map.clear();
  }
}
