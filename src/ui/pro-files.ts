// Studio M Pro のファイルの開く・保存（OS のダイアログは main が出す）。DOM には触れない。
// 直前に開いた・保存したファイルの path を覚え、2 回目からの「保存」はダイアログなしで上書きする。
import type { Project } from '../core/types';
import type { ProApi } from './engine-ipc';
import { parseProjectText, safeFileName } from './project-utils';

export interface ProFileSession {
  /** 直前に開いた・保存したファイルの path（なければ null） */
  readonly path: string | null;
  /** 開くダイアログを出して読む。取り消しなら null。読めないファイルは日本語の Error */
  open(): Promise<Project | null>;
  /** 保存する。saveAs が true、または保存先がまだないときはダイアログを出す。取り消しなら null */
  save(o: { project: Project; saveAs?: boolean }): Promise<{ path: string } | null>;
}

export function createProFileSession(files: NonNullable<ProApi['file']>): ProFileSession {
  let path: string | null = null;
  return {
    get path() {
      return path;
    },
    async open() {
      const opened = await files.open();
      if (!opened) return null;
      const project = parseProjectText(opened.text);
      path = opened.path;
      return project;
    },
    async save({ project, saveAs }) {
      const text = JSON.stringify(project, null, 2);
      const suggestedName = `${safeFileName(project.name)}.studiom.json`;
      const saved = await files.save({ ...(path && !saveAs ? { path } : {}), text, suggestedName });
      if (saved) path = saved.path;
      return saved;
    },
  };
}
