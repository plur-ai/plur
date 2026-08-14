/**
 * `@plur-ai/ui` — the local memory viewer.
 *
 * Pure HTML render functions over a PLUR store. No framework, no bundler, no
 * runtime dependencies: a host supplies engram rows, this returns a page.
 *
 * Consumed by `plur ui` (the CLI opens it in a browser) and by `@plur-ai/dsh`
 * (which serves it as a tab inside DeepSeek Harness).
 *
 * @module @plur-ai/ui
 */
export { renderBrowse, renderPage, htmlEscape, type BrowseOptions, type BrowseLinks, type BrowseMode } from './views.js'
export {
  formatDate,
  resolveLang,
  strings,
  fill,
  type Lang,
  type Strings,
} from './i18n.js'
export {
  filterEngrams,
  memoryStats,
  recallCount,
  topByRecall,
  storeSpan,
  writtenPerDay,
  type BrowseQuery,
  type BrowsePage,
  type DayCount,
  type EngramRow,
  type MemoryStats,
  type StoreSpan,
} from './query.js'
export { CSS } from './theme.js'
