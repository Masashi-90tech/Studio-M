// 学びモードの入口。数学の窓（式の提供者・部品）、レッスン、進み具合の保存。
//
// 画面側の使い方:
//   const formulas = getMathProvider(kind).formulas({ project, result });
//   const win = renderMathWindow({ container, formulas });   // 結果やプロジェクトが変わったら win.update(...)
//   const panel = renderLessonPanel({ container, lesson, getContext: () => ({ project, result }), ... });
export { getMathProvider, MATH_PROVIDERS } from './providers';
export { LESSONS, LEARNING_PATH, LEARNING_ORDER, findLesson, lessonForPreset } from './lessons';
export { renderMathWindow, renderLessonPanel, renderLessonList } from './components';
export type { MathWindowHandle, MathWindowOptions, LessonPanelHandle, LessonPanelOptions, LessonListHandle, LessonListOptions } from './components';
export { loadProgress, saveProgress, updateLessonProgress, countDone, nextLessonId } from './progress';
export type { ProgressMap, StorageLike } from './progress';
export { progressFromState } from './lesson-logic';
export * from './types';
export { topic, TOPIC_LEVEL } from './topics';
