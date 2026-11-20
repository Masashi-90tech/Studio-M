// --selftest の本体: Engine に片持ち梁を投げて、同梱の ccx で本計算できるかを確かめる（electron は import しない）。
// ジョブは利用者の画面と同じ経路（EngineBridge.request → POST /jobs → GET /jobs/:id）で投げる。
import { writeFile } from 'node:fs/promises';
import type { EngineStatus, JobState } from '../../src/core/engine-protocol';
import { decodeJobState } from '../../src/core/engine-wire';
import type { EngineBridge } from './engine-bridge';
import { buildReport, buildSelftestJob, evaluateSelftest, NO_CCX_MESSAGE, type SelftestCheck, type SelftestReport } from './selftest-logic';

export interface RunSelftestOptions {
  /** Engine を起動できなかったときは null と startError */
  bridge: EngineBridge | null;
  startError?: string;
  /** 同梱の ccx の場所（見つからなければ null） */
  ccxPath: string | null;
  os: string;
  appVersion: string;
  /** 本計算を待つ上限（ミリ秒）。既定 120 秒 */
  timeoutMs?: number;
}

const decode = (body: ArrayBuffer): unknown => JSON.parse(new TextDecoder().decode(body));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function getStatus(bridge: EngineBridge): Promise<EngineStatus> {
  const res = await bridge.request({ method: 'GET', path: '/status?refresh=1' });
  if (res.status !== 200) throw new Error(`/status が HTTP ${res.status} を返しました`);
  return decode(res.body) as EngineStatus;
}

async function runJob(bridge: EngineBridge, timeoutMs: number): Promise<JobState> {
  const posted = await bridge.request({ method: 'POST', path: '/jobs', body: buildSelftestJob() });
  const p = decode(posted.body) as { id?: string; error?: string };
  if (posted.status >= 300 || !p.id) throw new Error(`ジョブを投げられませんでした（HTTP ${posted.status}）: ${p.error ?? '不明'}`);
  const t0 = Date.now();
  for (;;) {
    const r = await bridge.request({ method: 'GET', path: `/jobs/${p.id}` });
    const job = decodeJobState(decode(r.body));
    if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') return job;
    if (Date.now() - t0 > timeoutMs) throw new Error(`${Math.round(timeoutMs / 1000)} 秒待っても本計算が終わりませんでした（${job.message}）。PC の負荷を下げて、もう一度試してください`);
    await sleep(300);
  }
}

/** 自己診断を実行して報告を返す（例外は投げず、失敗は報告の中に入れる） */
export async function runSelftest(o: RunSelftestOptions): Promise<SelftestReport> {
  const base = { ccxPath: o.ccxPath, os: o.os, appVersion: o.appVersion };
  const early = (check: SelftestCheck): SelftestReport => buildReport({ ...base, checks: [check], status: null });
  if (!o.ccxPath) return early({ id: 'bundled-ccx', label: '同梱の ccx がある', ok: false, detail: NO_CCX_MESSAGE });
  if (!o.bridge) return early({ id: 'engine-start', label: 'Studio M Engine が起動する', ok: false, detail: o.startError ?? 'Studio M Engine を起動できませんでした' });

  let status: EngineStatus | null = null;
  let job: JobState | null = null;
  let jobError: string | undefined;
  try {
    status = await getStatus(o.bridge);
    if (status.engines.find((e) => e.id === 'calculix')?.available) job = await runJob(o.bridge, o.timeoutMs ?? 120_000);
    else jobError = 'CalculiX が使えないため、本計算を試しませんでした';
  } catch (e) {
    jobError = e instanceof Error ? e.message : String(e);
  }
  return buildReport({ ...base, status, checks: [{ id: 'bundled-ccx', label: '同梱の ccx がある', ok: true, detail: o.ccxPath }, ...evaluateSelftest({ status, job, jobError })] });
}

/** 結果を標準出力と（あれば）ファイルに書く。ファイルに書けなかったときは理由を標準エラーに出す */
export async function writeReport(report: SelftestReport, out?: string): Promise<void> {
  const text = JSON.stringify(report, null, 2);
  process.stdout.write(`${text}\n`);
  if (out) {
    try {
      await writeFile(out, `${text}\n`, 'utf8');
    } catch (e) {
      process.stderr.write(`結果を ${out} に書けませんでした（${e instanceof Error ? e.message : String(e)}）。書き込める場所を指定してください\n`);
    }
  }
}
