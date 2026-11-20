// Mac の OpenFOAM.app（`brew install gerlero/openfoam/openfoam@2606` で /Applications に入る）の検出。
// 中の Contents/Resources/etc/openfoam は zsh のスクリプトで、`openfoam -c "コマンド"` で環境を読み込んで実行できる。
// fs は差し替えられる（テスト用）。macOS 以外では何もしない。
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { createWrapperLauncher, type CommandLauncher } from './launcher';

export interface OpenFoamApp {
  /** ラッパー（etc/openfoam）の絶対パス */
  wrapper: string;
  /** 例: 'v2606' */
  version: string;
}

/** ラッパーの、.app からの相対パス */
const WRAPPER_REL = join('Contents', 'Resources', 'etc', 'openfoam');
const APP_RE = /^OpenFOAM-(v\d{4})\.app$/;

/** OpenFOAM.app 経由で起動するコマンド（アダプターが実際に呼ぶもの。engine/adapters/openfoam を参照） */
export const OPENFOAM_APP_COMMANDS = ['blockMesh', 'topoSet', 'subsetMesh', 'simpleFoam', 'pimpleFoam', 'foamToVTK'];

export interface FindOpenFoamAppOptions {
  /** 探すフォルダ。既定は /Applications と ~/Applications */
  roots?: string[];
  listDir?: (dir: string) => string[];
  exists?: (path: string) => boolean;
  /** 既定は process.platform。darwin 以外は null を返す */
  platform?: NodeJS.Platform;
  /** STUDIO_M_OPENFOAM_APP の値（.app または wrapper のパス）。既定は process.env から読む */
  override?: string;
}

function versionOf(appName: string): string | null {
  const m = APP_RE.exec(appName);
  return m ? m[1] : null;
}

export function findOpenFoamApp(o: FindOpenFoamAppOptions = {}): OpenFoamApp | null {
  if ((o.platform ?? process.platform) !== 'darwin') return null;
  const exists = o.exists ?? existsSync;
  const listDir =
    o.listDir ??
    ((d: string): string[] => {
      try {
        return readdirSync(d);
      } catch {
        return [];
      }
    });

  const override = o.override ?? process.env.STUDIO_M_OPENFOAM_APP;
  if (override) {
    if (isAbsolute(override)) {
      const p = resolve(override);
      const wrapper = p.endsWith('.app') ? join(p, WRAPPER_REL) : p;
      // wrapper のパスなら …/Contents/Resources/etc/openfoam の 5 つ上が .app
      const appName = p.endsWith('.app') ? basename(p) : basename(dirname(dirname(dirname(dirname(p)))));
      if (exists(wrapper)) return { wrapper, version: versionOf(appName) ?? 'unknown' };
    }
    console.warn(`STUDIO_M_OPENFOAM_APP（${override}）に OpenFOAM のラッパーが見つからないので無視します。OpenFOAM-v2606.app のパスか、その中の Contents/Resources/etc/openfoam のパスを指定してください`);
  }

  const roots = o.roots ?? ['/Applications', join(homedir(), 'Applications')];
  const found: OpenFoamApp[] = [];
  for (const root of roots) {
    for (const name of listDir(root)) {
      const version = versionOf(name);
      if (!version) continue;
      const wrapper = join(root, name, WRAPPER_REL);
      if (exists(wrapper)) found.push({ wrapper, version });
    }
  }
  // 新しい版（4 桁の数字が大きい方）を優先。同じ版なら先に見つけた方
  found.sort((a, b) => Number(b.version.slice(1)) - Number(a.version.slice(1)));
  return found[0] ?? null;
}

/** OpenFOAM.app が見つかれば、そのラッパー経由で起動するランチャーを返す（見つからなければ undefined = 直接起動） */
export function findOpenFoamLauncher(o: FindOpenFoamAppOptions = {}): CommandLauncher | undefined {
  const app = findOpenFoamApp(o);
  return app ? createWrapperLauncher({ commands: OPENFOAM_APP_COMMANDS, file: app.wrapper, label: `OpenFOAM.app（${app.version}）` }) : undefined;
}
