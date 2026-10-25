// 解析ごとの重ね描き（電磁波の波源の印など）の置き場。登録表から遅延 import で読み込み、
// 解析タブを切り替えるたびに前のものを片づけて、新しい解析のものを付ける。
import { loadOverlayFactory } from '../workbench';
import type { OverlayHandle } from '../workbench/types';
import { toast } from './dom';
import type { CanvasView } from './render';
import type { Store } from './state';

export function initOverlayHost(store: Store, view: CanvasView): void {
  let current: OverlayHandle | null = null;
  let seq = 0;

  // キャンバスには 1 本だけ描き手を登録し、その中身を差し替える
  view.overlays.push((p) => {
    try {
      current?.draw?.(p);
    } catch (e) {
      // 重ね描きが壊れても、メイン画面は止めない
      console.error(e);
      current = null;
    }
  });

  function mount(): void {
    const mine = ++seq;
    current?.dispose();
    current = null;
    view.invalid = true;
    void loadOverlayFactory(store.analysis)
      .then((factory) => {
        if (mine !== seq || !factory) return; // 待っている間に別の解析へ移った / この解析に重ね描きはない
        current = factory({ store, view });
        view.invalid = true;
      })
      .catch((e: unknown) => {
        console.error(e);
        toast('キャンバスの補助表示を読み込めませんでした。ページを開き直してみてください', 'error');
      });
  }

  store.on('analysis', mount);
  mount();
}
