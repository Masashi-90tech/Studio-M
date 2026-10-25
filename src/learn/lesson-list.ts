// レッスン一覧: 学ぶ順（中学 → 高校 → 大学）に段階ごとに並べ、終えたものに ✓ を付ける。
import { clear, h } from './dom';
import type { LearningStage, Lesson, LessonProgress, MathLevel } from './types';
import { LEVEL_ORDER } from './topics';

export interface LessonListOptions {
  container: HTMLElement;
  lessons: Lesson[];
  progress: Record<string, Pick<LessonProgress, 'done'> & Partial<LessonProgress>>;
  onOpen(lessonId: string): void;
  /** 学ぶ順。省略時は lessons の level ごとに、渡された順で並べる */
  path?: LearningStage[];
}

export interface LessonListHandle {
  update(progress: LessonListOptions['progress']): void;
  dispose(): void;
}

/** 一覧に出す段階の組み立て（path がなければ level で分ける）。DOM に触れない */
export function buildStages(lessons: Lesson[], path?: LearningStage[]): { stage: Pick<LearningStage, 'level' | 'title' | 'description'>; lessons: Lesson[] }[] {
  const byId = new Map(lessons.map((l) => [l.id, l]));
  const used = new Set<string>();
  const out: { stage: Pick<LearningStage, 'level' | 'title' | 'description'>; lessons: Lesson[] }[] = [];
  for (const st of path ?? []) {
    const list = st.lessonIds.map((id) => byId.get(id)).filter((l): l is Lesson => !!l);
    list.forEach((l) => used.add(l.id));
    if (list.length > 0) out.push({ stage: { level: st.level, title: st.title, description: st.description }, lessons: list });
  }
  // path にないレッスンは level ごとの段にまとめる
  const rest = lessons.filter((l) => !used.has(l.id));
  for (const level of LEVEL_ORDER as MathLevel[]) {
    const list = rest.filter((l) => l.level === level);
    if (list.length > 0) out.push({ stage: { level, title: `${level}レベル`, description: '' }, lessons: list });
  }
  return out;
}

export function renderLessonList(opts: LessonListOptions): LessonListHandle {
  const { container, lessons, onOpen } = opts;
  let progress = opts.progress;
  const root = h('div', { class: 'll-list', role: 'region', 'aria-label': 'レッスン一覧' });
  container.append(root);
  const stages = buildStages(lessons, opts.path);

  const render = (): void => {
    clear(root);
    const doneCount = lessons.filter((l) => progress[l.id]?.done).length;
    root.append(h('p', { class: 'll-summary' }, `${doneCount} / ${lessons.length} レッスン完了`));
    stages.forEach((s, si) => {
      const hid = `ll-stage-${si}`;
      const ul = h('ul', { class: 'll-cards' });
      for (const l of s.lessons) {
        const done = progress[l.id]?.done === true;
        const started = !done && (progress[l.id]?.step ?? 0) > 0;
        ul.append(
          h(
            'li',
            null,
            h(
              'button',
              { type: 'button', class: `ll-card${done ? ' done' : ''}`, 'data-lesson-id': l.id, onclick: () => onOpen(l.id), 'aria-label': `${l.title}${done ? '（完了）' : started ? '（途中）' : ''}` },
              h('span', { class: 'll-card-check', 'aria-hidden': 'true' }, done ? '✓' : ''),
              h(
                'span',
                { class: 'll-card-body' },
                h('span', { class: 'll-card-title' }, l.title),
                h('span', { class: 'll-card-summary' }, l.summary),
                h('span', { class: 'll-card-meta' }, `約 ${l.minutes} 分${started ? ' ・ 途中' : ''}`, ...l.topics.map((t) => h('span', { class: 'lw-chip', 'data-level': t.level }, t.name))),
              ),
            ),
          ),
        );
      }
      root.append(
        h(
          'section',
          { class: 'll-stage', 'aria-labelledby': hid },
          h('h3', { class: 'll-stage-title', id: hid }, h('span', { class: 'll-level', 'data-level': s.stage.level }, s.stage.level), ` ${s.stage.title}`),
          s.stage.description ? h('p', { class: 'll-stage-desc' }, s.stage.description) : null,
          ul,
        ),
      );
    });
  };
  render();

  return {
    update(next) {
      progress = next;
      render();
    },
    dispose() {
      root.remove();
    },
  };
}
