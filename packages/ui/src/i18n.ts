/**
 * English and Chinese strings for the viewer.
 *
 * Bilingual because the ecosystems PLUR plugs into are: roughly 40% of the
 * DeepSeek Harness plugin ecosystem ships Chinese-language content, and dsh
 * itself carries a `.zh.md` beside every doc. A memory viewer that only speaks
 * English is a viewer half those users cannot read.
 *
 * Plain functions and a frozen table rather than a framework — the package
 * stays dependency-free, and every string is visible in one file.
 *
 * @module
 */

/** Supported languages. */
export type Lang = 'en' | 'zh'

/** Every string the viewer renders. */
export interface Strings {
  /** Browser tab title. */
  docTitle: string
  /** Eyebrow above the headline. */
  brand: string
  /**
   * Headline. `{n}` is the engram count, `{r}` the total recall count.
   *
   * One template per language rather than two joined clauses: clause order and
   * punctuation (`—` vs `，`, `.` vs `。`) differ, and a shared joiner gets one
   * of them wrong.
   */
  heroTitle: string
  /** Headline when the store is empty. */
  heroEmpty: string
  /** Standfirst. `{since}` is the store's earliest date, already formatted. */
  heroSub: string
  /** Standfirst when the store is empty. */
  heroSubEmpty: string
  /** Accessible name for the language switch. */
  langSwitch: string
  openFolder: string
  openFolderHint: string
  statRecalled: string
  statNever: string
  statScopes: string
  statDomains: string
  written: string
  writtenSub: string
  mostRecalled: string
  mostRecalledSub: string
  nothingRecalled: string
  modeTop: string
  modeAll: string
  search: string
  searchPlaceholder: string
  colId: string
  colStatement: string
  colScope: string
  colRecalls: string
  colCreated: string
  metaId: string
  metaScope: string
  metaCreated: string
  metaDomain: string
  metaCommitment: string
  metaLastActive: string
  metaRecalls: string
  pinned: string
  neverRecalled: string
  recalledTimes: string
  emptyNoRecalls: string
  emptyNoMatch: string
  prev: string
  next: string
  /** `{total}` matches, showing `{shown}` from `{offset}`. */
  pagerCount: string
  requestFeature: string
  contribute: string
  github: string
  website: string
  peace: string
  love: string
  unity: string
  respect: string
}

const EN: Strings = {
  docTitle: 'PLUR Memory',
  brand: 'Local memory',
  heroTitle: 'Your agents remember {n} things — and have reached for them {r} times.',
  heroEmpty: 'Nothing learned yet',
  heroSub: 'Every correction, preference and hard-won detail since {since} — held on this machine and nowhere else. Select any row to read the whole engram.',
  heroSubEmpty: 'Correct an agent, state a preference, and it lands here. Everything stays on this machine.',
  langSwitch: 'Language',
  openFolder: 'Open folder',
  openFolderHint: 'Reveal the store in your file manager',
  statRecalled: 'Recalled',
  statNever: 'Never recalled',
  statScopes: 'Scopes',
  statDomains: 'Domains',
  written: 'Written',
  writtenSub: '{n} learned in the last 30 days · peak {peak}',
  mostRecalled: 'Most recalled',
  mostRecalledSub: 'what your agents actually pull into context',
  nothingRecalled: 'Nothing recalled yet.',
  modeTop: 'Most recalled',
  modeAll: 'All',
  search: 'Search',
  searchPlaceholder: 'Search statement or ID',
  colId: 'ID',
  colStatement: 'Statement',
  colScope: 'Scope',
  colRecalls: 'Recalls',
  colCreated: 'Created',
  metaId: 'ID',
  metaScope: 'Scope',
  metaCreated: 'Created',
  metaDomain: 'Domain',
  metaCommitment: 'Commitment',
  metaLastActive: 'Last active',
  metaRecalls: 'Recalls',
  pinned: 'pinned',
  neverRecalled: 'Never recalled',
  recalledTimes: 'Recalled {n} times',
  emptyNoRecalls: 'No engrams have been recalled yet.',
  emptyNoMatch: 'No engrams match.',
  prev: 'Previous',
  next: 'Next',
  pagerCount: '{total} matches · showing {shown} from {offset}',
  requestFeature: 'Request a feature',
  contribute: 'Contribute',
  github: 'GitHub',
  website: 'plur.ai',
  peace: 'Peace',
  love: 'Love',
  unity: 'Unity',
  respect: 'Respect',
}

const ZH: Strings = {
  docTitle: 'PLUR 记忆',
  brand: '本地记忆',
  heroTitle: '你的 agent 记住了 {n} 条内容，并已调用了 {r} 次。',
  heroEmpty: '尚未学到任何内容',
  heroSub: '自 {since}以来的每一次纠正、每一条偏好、每一个来之不易的细节——只保存在这台机器上。点击任意行可阅读完整 engram。',
  heroSubEmpty: '纠正一次 agent，或说明一条偏好，它就会出现在这里。所有内容都留在本机。',
  langSwitch: '语言',
  openFolder: '打开目录',
  openFolderHint: '在文件管理器中显示存储目录',
  statRecalled: '被召回过',
  statNever: '从未召回',
  statScopes: 'Scope',
  statDomains: '领域',
  written: '写入',
  writtenSub: '最近 30 天新增 {n} 条 · 峰值 {peak}',
  mostRecalled: '召回最多',
  mostRecalledSub: 'agent 真正放进上下文的内容',
  nothingRecalled: '尚无召回记录。',
  modeTop: '召回最多',
  modeAll: '全部',
  search: '搜索',
  searchPlaceholder: '搜索内容或 ID',
  colId: 'ID',
  colStatement: '内容',
  colScope: 'Scope',
  colRecalls: '召回',
  colCreated: '创建于',
  metaId: 'ID',
  metaScope: 'Scope',
  metaCreated: '创建于',
  metaDomain: '领域',
  metaCommitment: '确信度',
  metaLastActive: '最近活跃',
  metaRecalls: '召回次数',
  pinned: '已固定',
  neverRecalled: '从未召回',
  recalledTimes: '已召回 {n} 次',
  emptyNoRecalls: '还没有任何 engram 被召回过。',
  emptyNoMatch: '没有匹配的 engram。',
  prev: '上一页',
  next: '下一页',
  pagerCount: '共 {total} 条 · 显示 {shown} 条，从第 {offset} 条起',
  requestFeature: '提交需求',
  contribute: '参与贡献',
  github: 'GitHub',
  website: 'plur.ai',
  peace: '和平',
  love: '友爱',
  unity: '团结',
  respect: '尊重',
}

const TABLE: Readonly<Record<Lang, Strings>> = Object.freeze({ en: EN, zh: ZH })

/**
 * Resolve a language tag, falling back to English.
 *
 * Accepts anything an `Accept-Language` header or a query parameter might
 * carry, so `zh`, `zh-CN` and `zh-Hans` all land on Chinese.
 *
 * @param value - a language tag, or anything at all.
 * @returns a supported language.
 */
export function resolveLang(value: string | null | undefined): Lang {
  return typeof value === 'string' && value.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/**
 * The string table for a language.
 *
 * @param lang - the language.
 * @returns its strings.
 */
export function strings(lang: Lang): Strings {
  return TABLE[lang] ?? EN
}

/**
 * Interpolate `{name}` placeholders.
 *
 * @param template - the string, from {@link strings}.
 * @param values - replacements, already display-formatted.
 * @returns the filled string.
 */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in values ? String(values[key]) : whole)
}

const ZH_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

/**
 * Format an ISO date for display.
 *
 * Written by hand rather than through `Intl`: the viewer must render the same
 * text on any machine, and `Intl` output varies with the host's ICU build.
 *
 * @param iso - a `YYYY-MM-DD` date, or undefined.
 * @param lang - the display language.
 * @returns the formatted date, or an empty string when there is no date.
 */
export function formatDate(iso: string | undefined, lang: Lang): string {
  const match = ZH_DATE.exec(iso ?? '')
  if (!match) return ''
  const [, y, m, d] = match
  const month = Number(m), day = Number(d)
  return lang === 'zh'
    ? `${y}年${month}月${day}日`
    : `${day} ${MONTHS[month - 1]} ${y}`
}
