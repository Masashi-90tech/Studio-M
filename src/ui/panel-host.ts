// パネルの置き場: 解析ごとのパネル（WorkbenchModule.ui）を、登録表から遅延 import で読み込んで差し込む。
// 画面（settings / easy-panel）は解析の種類を見分けず、この置き場に「いまの解析」を渡すだけにする。
import { analysisLabel } from '../core/analyses';
import type { AnalysisKind } from '../core/types';
import { loadPanelFactory, peekPanelFactory } from '../workbench/registry';
import type { PanelFactory, PanelHandle, PanelSlot } from '../workbench/types';
import { clear, toast } from './dom';
import { withLoading } from './lazy';
import type { Runner } from './runner';
import type { Store } from './state';

const SLOT_NAME: Record<PanelSlot, string> = { settings: '設定パネル', easy: 'かんたんパネル', pro: '詳細設定パネル' };

export interface PanelSlotHost {
  /** 解析 kind のパネルに差し替える（null なら空にする）。読み込み済みなら同期で描く */
  mount(kind: AnalysisKind | null): void;
  /** プロジェクトや計算が変わったとき */
  refresh(): void;
  /** 毎フレーム */
  update(): void;
  /** いまのパネルの「作りの条件」（PanelHandle.structureKey）。パネルがなければ空文字 */
  structureKey(): string;
}

export function createPanelSlot(opts: {
  store: Store;
  runner: Runner;
  container: HTMLElement;
  slot: PanelSlot;
  /** パネルを作り終えたとき（読み込みを待った場合も含む）に呼ぶ */
  onMount?: () => void;
}): PanelSlotHost {
  const { store, runner, container, slot } = opts;
  let handle: PanelHandle | null = null;
  /** パネルが壊れたら、そのパネルだけ止める（メイン画面を巻き込まない） */
  let broken = false;
  let seq = 0;

  const label = (kind: AnalysisKind): string => `${analysisLabel(kind)}の${SLOT_NAME[slot]}`;

  function guard(kind: AnalysisKind, fn: () => void): void {
    if (broken) return;
    try {
      fn();
    } catch (e) {
      broken = true;
      console.error(e);
      toast(`${label(kind)}を表示できませんでした。他の解析は使えます（${e instanceof Error ? e.message : String(e)}）`, 'error');
    }
  }

  function make(kind: AnalysisKind, factory: PanelFactory): void {
    guard(kind, () => {
      handle = factory({ store, runner, container });
    });
    opts.onMount?.();
  }

  let current: AnalysisKind | null = null;

  return {
    mount(kind) {
      const mine = ++seq;
      try {
        handle?.dispose();
      } catch (e) {
        console.error(e);
      }
      handle = null;
      broken = false;
      current = kind;
      clear(container);
      if (!kind) return;
      const ready = peekPanelFactory(kind, slot);
      if (ready) {
        make(kind, ready);
        return;
      }
      void withLoading({ label: label(kind), task: loadPanelFactory(kind, slot) }).then((factory) => {
        if (mine !== seq || !factory) return; // 待っている間に別の解析へ移った / この解析にはそのパネルがない
        make(kind, factory);
      });
    },
    refresh() {
      if (current) guard(current, () => handle?.refresh?.());
    },
    update() {
      if (current) guard(current, () => handle?.update?.());
    },
    structureKey() {
      let key = '';
      if (current) guard(current, () => (key = handle?.structureKey?.() ?? ''));
      return key;
    },
  };
}
