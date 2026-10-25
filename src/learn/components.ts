// 学びモードの画面部品の入口。見た目は learn.css（style.css のトークンを使う）。
import './learn.css';

export { renderMathWindow, resultText, substitutedLine, varText } from './math-window';
export type { MathWindowHandle, MathWindowOptions } from './math-window';
export { renderBody, renderLessonPanel } from './lesson-panel';
export type { LessonPanelHandle, LessonPanelOptions } from './lesson-panel';
export { buildStages, renderLessonList } from './lesson-list';
export type { LessonListHandle, LessonListOptions } from './lesson-list';
