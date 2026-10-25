// 遅延 import の共通処理: 少し待たされたら「読み込み中」を出し、失敗したら日本語のメッセージを出す。
import { busyToast, toast } from './dom';

/** この時間（ms）を超えて待たされたら「読み込み中」を出す。速いときは何も出さない */
const SLOW_MS = 300;

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 重い部品の読み込みを待つ。label は「電磁波の解析エンジン」のような名前（メッセージに入る）。
 * 失敗したら toast で知らせて null を返す（呼び出し側は null のとき何もしなくてよい）。
 */
export async function withLoading<T>(opts: { label: string; task: Promise<T> }): Promise<T | null> {
  const busy: { dismiss?: () => void } = {};
  const timer = window.setTimeout(() => {
    busy.dismiss = busyToast(`${opts.label}を読み込み中…`);
  }, SLOW_MS);
  try {
    return await opts.task;
  } catch (e) {
    console.error(e);
    toast(`${opts.label}を読み込めませんでした。ページを開き直してみてください（${reason(e)}）`, 'error');
    return null;
  } finally {
    window.clearTimeout(timer);
    busy.dismiss?.();
  }
}
