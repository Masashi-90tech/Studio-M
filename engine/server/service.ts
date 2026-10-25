// エンジン全体の組み立て: 検出結果の保持、ジョブ管理、HTTP サーバー。
import type { Server } from 'node:http';
import { ENGINE_PROTOCOL_VERSION, type EngineStatus } from '../../src/core/engine-protocol';
import type { EngineAdapter } from '../types';
import { detectEngines, type Detection, type ProbeFn } from './detect';
import { createEngineServer } from './http';
import { cleanStaleWorkDirs, JobManager, WORK_ROOT } from './jobs';
import { ENGINE_SERVER_ID, ENGINE_VERSION } from './version';

export interface EngineServiceOptions {
  adapters: EngineAdapter[];
  token: string;
  port: number;
  maxConcurrentJobs?: number;
  keep?: boolean;
  ttlHours?: number;
  commandTimeoutMs?: number;
  workRoot?: string;
  probe?: ProbeFn;
  maxBodyBytes?: number;
}

export interface EngineService {
  server: Server;
  jobs: JobManager;
  detect(): Promise<Detection>;
  status(refresh: boolean): Promise<EngineStatus>;
  /** 待ち受けを始める。使われたポートを返す（port が 0 なら空いているポート） */
  listen(): Promise<number>;
  close(): Promise<void>;
}

export function createEngineService(o: EngineServiceOptions): EngineService {
  let detection: Detection | null = null;
  let detecting: Promise<Detection> | null = null;
  const ttlMs = (o.ttlHours ?? 24) * 3600_000;

  const detect = (): Promise<Detection> => {
    detecting ??= detectEngines({ adapters: o.adapters, probe: o.probe })
      .then((d) => (detection = d))
      .finally(() => (detecting = null));
    return detecting;
  };

  const jobs = new JobManager({
    adapters: o.adapters,
    getInfo: (id) => detection?.infoById.get(id),
    dockerAvailable: () => detection?.dockerAvailable ?? false,
    maxConcurrentJobs: o.maxConcurrentJobs,
    keep: o.keep,
    ttlMs,
    commandTimeoutMs: o.commandTimeoutMs,
    workRoot: o.workRoot,
  });

  const status = async (refresh: boolean): Promise<EngineStatus> => {
    const d = refresh || !detection ? await detect() : detection;
    return {
      server: ENGINE_SERVER_ID,
      protocol: ENGINE_PROTOCOL_VERSION,
      version: ENGINE_VERSION,
      engines: d.engines,
      capabilities: d.capabilities,
      maxConcurrentJobs: jobs.maxConcurrentJobs,
    };
  };

  const server = createEngineServer({ token: o.token, jobs, getStatus: status, maxBodyBytes: o.maxBodyBytes });
  let sweeper: NodeJS.Timeout | undefined;

  return {
    server,
    jobs,
    detect,
    status,
    async listen() {
      await cleanStaleWorkDirs({ root: o.workRoot ?? WORK_ROOT, olderThanMs: ttlMs });
      await detect();
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(o.port, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      sweeper = setInterval(() => void jobs.sweep(), 10 * 60_000);
      sweeper.unref();
      return (server.address() as { port: number }).port;
    },
    async close() {
      clearInterval(sweeper);
      await jobs.shutdown();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
