// PC のエンジンまわりの入口（軽い）。画面（main.ts・設定ポップオーバー）はここだけを呼び、
// 通信・パネル・結果カードは必要になったときに遅延 import する。
//   - 合言葉が保存されていれば、起動後に自動で接続を確かめ、結果ボックスの下に本計算カードを出す
//   - 設定（⚙）を開いたとき、「PCのエンジン」の欄を作る
import { hasSavedEngineToken } from './engine-config';
import type { EngineView } from './engine-view';
import { withLoading } from './lazy';
import type { Runner } from './runner';
import type { Store } from './state';

export interface EngineUi {
  /** 設定ポップオーバーの中に「PCのエンジン」の欄を作る（初めて開くときだけ読み込む） */
  mountSettings(container: HTMLElement): Promise<void>;
  /** 毎フレーム。読み込み前は何もしない */
  update(): void;
}

export function initEngineUi(opts: { store: Store; runner: Runner; resultsHost: HTMLElement }): EngineUi {
  let booting: Promise<import('./engine-session').EngineSession | null> | null = null;
  let view: EngineView | null = null;

  /** 通信とカードを読み込み、セッションを 1 つだけ作る */
  function boot(): Promise<import('./engine-session').EngineSession | null> {
    booting ??= (async () => {
      const [sessionMod, viewMod] = await Promise.all([import('./engine-session'), import('./engine-view')]);
      const session = new sessionMod.EngineSession({ runner: opts.runner });
      view = viewMod.mountEngineView({ store: opts.store, runner: opts.runner, session, host: opts.resultsHost });
      return session;
    })().catch((e) => {
      booting = null;
      throw e;
    });
    return booting;
  }

  // 合言葉が保存されている人には、少し待ってから自動で接続を確かめる（画面の起動を邪魔しない）
  if (hasSavedEngineToken()) {
    window.setTimeout(() => {
      void boot()
        .then((session) => session?.connect())
        .catch((e) => console.error(e));
    }, 600);
  }

  return {
    async mountSettings(container) {
      const [session, panel] = await Promise.all([withLoading({ label: 'PCのエンジンの設定', task: boot() }), withLoading({ label: 'PCのエンジンの設定', task: import('./engine-panel') })]);
      if (!session || !panel) return;
      panel.mountEnginePanel({ session, container });
    },
    update() {
      view?.update();
    },
  };
}
