/**
 * 检索的「精确匹配」一路：从查询抽字面量、给候选段打精确分。纯函数，不依赖宿主，便于单测。
 *
 * BM25 用二字组切中文，「大肥鱼小课堂」和「大肥鱼」「小课堂」分散出现的段几乎同分，
 * 专有名词、引号原文、编号、别名这类「字面就该命中」的信号被稀释了。这里从查询里抽出这些字面量，
 * 在候选段里做带边界的子串匹配，单独排一路名次，再在 rank-fusion.ts 里和 BM25（及语义）名次做 RRF。
 *
 * 防刷分：中文短语至少 3 字（单字、二字组交给 BM25）；超过一半候选都含有的字面量视为口头禅不计分；
 * 精确分不到门槛的段不进精确榜。
 */

export type ExactTermKind = 'quote' | 'alias' | 'id' | 'number' | 'word' | 'phrase';

export interface ExactTerm {
  kind: ExactTermKind;
  /** 规范化后的字面量（NFKC + 小写） */
  text: string;
  /** 基础权重：越像「专有」的字面量越高 */
  weight: number;
}

export interface ExactDoc {
  id: string;
  /** 参与匹配的全文（标题路径 + 正文） */
  text: string;
  /** 可选的切词表：有它就先用二字组做 O(1) 预筛，省掉大部分 includes */
  terms?: { has(term: string): boolean };
}

export interface ExactScore {
  score: number;
  /** 命中的字面量（原样），用于日志/工具输出 */
  matched: string[];
}

const WEIGHT: Record<Exclude<ExactTermKind, 'phrase'>, number> = {
  quote: 3,
  alias: 3,
  id: 3,
  number: 1.5,
  word: 1.5,
};

/** 进精确榜的最低精确分：一个 3 字常见短语（权重 1 × idf 折扣）不够格 */
export const EXACT_MIN_SCORE = 1;
/** 精确分达到这个值，说明命中了引号原文/别名/id 级别的强信号 */
export const EXACT_STRONG_SCORE = 2.5;
/** 中文短语长度范围：3 字起算，最长 8 字（更长的原文请用引号） */
const PHRASE_MIN = 3;
const PHRASE_MAX = 8;
/** 候选里超过这个比例都含有的字面量不计分（「是什么」「怎么办」） */
const MAX_DOC_RATIO = 0.5;

const QUOTE_PATTERN = /「([^」]{2,40})」|『([^』]{2,40})』|“([^”]{2,40})”|"([^"]{2,40})"|《([^》]{2,40})》|【([^】]{2,40})】/gu;
const ALIAS_PATTERN = /(?<![a-z0-9_])#?u(\d{1,4})(?!\d)/gu;
const HAN_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{3,}/gu;
const ASCII_RUN = /[a-z0-9][a-z0-9_.-]*[a-z0-9]|[a-z0-9]/gu;
const NUMBER_PATTERN = /\d+(?:\.\d+)?/gu;
const ASCII_STOPWORDS = new Set([
  'the', 'and', 'for', 'you', 'are', 'what', 'this', 'that', 'with', 'how', 'can', 'not', 'but', 'was',
  'has', 'have', 'its', 'why', 'who', 'all', 'any', 'one', 'http', 'https', 'www', 'com', 'lol', 'ok', 'okay',
]);

function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 从查询里抽字面量。引号里的原文先整体取出再从查询里挖掉，避免同一段话又被拆成短语重复计分。
 * 中文连续片段不切词，交给 scoreExact 在每个候选上做「最长命中」贪心。
 */
export function extractExactTerms(query: string): { terms: ExactTerm[]; hanRuns: string[] } {
  let rest = normalize(query);
  const terms: ExactTerm[] = [];
  const seen = new Set<string>();
  const add = (kind: ExactTermKind, text: string, weight: number): void => {
    const key = `${kind}:${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    terms.push({ kind, text, weight });
  };

  for (const match of rest.matchAll(QUOTE_PATTERN)) {
    const inner = match.slice(1).find((g) => g !== undefined)!.trim();
    if ([...inner].length >= 2) add('quote', inner, WEIGHT.quote);
  }
  rest = rest.replace(QUOTE_PATTERN, ' ');

  for (const match of rest.matchAll(ALIAS_PATTERN)) add('alias', `u${Number(match[1])}`, WEIGHT.alias);
  rest = rest.replace(ALIAS_PATTERN, ' ');

  for (const match of rest.matchAll(ASCII_RUN)) {
    const run = match[0];
    const hasDigit = /\d/.test(run);
    const hasLetter = /[a-z]/.test(run);
    if (hasDigit && hasLetter && run.length >= 4) {
      add('id', run, WEIGHT.id);
    } else if (hasLetter && run.length >= 3 && !ASCII_STOPWORDS.has(run)) {
      add('word', run, WEIGHT.word);
    }
  }
  // 纯数字单独抽：「第 300 条」「3.5 版」；单个数字太常见（「1 个」「2 级」），只要两位以上或带小数
  for (const match of rest.replace(ASCII_RUN, (run) => (/[a-z]/.test(run) ? ' ' : run)).matchAll(NUMBER_PATTERN)) {
    const num = match[0];
    if (num.length >= 2) add('number', num, WEIGHT.number);
  }

  const hanRuns = [...rest.matchAll(HAN_RUN)].map((m) => m[0]);
  return { terms, hanRuns };
}

function phraseWeight(length: number): number {
  return Math.min(2.5, 0.5 * (length - 1));
}

/** 带边界的字面匹配：英文/数字不能是更长词或更长数字的一部分 */
function literalMatcher(term: ExactTerm): (text: string) => boolean {
  switch (term.kind) {
    case 'alias': {
      const re = new RegExp(`(?<![a-z0-9_])#?${escapeRegExp(term.text)}(?!\\d)`, 'u');
      return (text) => re.test(text);
    }
    case 'number': {
      const re = new RegExp(`(?<![\\d.])${escapeRegExp(term.text)}(?![\\d]|\\.\\d)`, 'u');
      return (text) => re.test(text);
    }
    case 'id':
    case 'word': {
      const re = new RegExp(`(?<![a-z0-9_])${escapeRegExp(term.text)}(?![a-z0-9_])`, 'u');
      return (text) => re.test(text);
    }
    default:
      return (text) => text.includes(term.text);
  }
}

/** 片段的所有二字组都在切词表里，才值得做 includes */
function bigramsPresent(phrase: string, terms: ExactDoc['terms']): boolean {
  if (terms === undefined) return true;
  for (let i = 0; i < phrase.length - 1; i++) {
    if (!terms.has(phrase.slice(i, i + 2))) return false;
  }
  return true;
}

/**
 * 在一段文本里对查询的中文片段做贪心最长匹配：从左到右，每个位置取能命中的最长子串（≥3 字），
 * 命中后跳过整段，保证「大肥鱼小课堂」只算一次，不会再拆成「大肥鱼」「肥鱼小」各算一遍。
 */
function matchPhrases(hanRuns: readonly string[], text: string, terms: ExactDoc['terms']): string[] {
  const found: string[] = [];
  for (const run of hanRuns) {
    let i = 0;
    while (i <= run.length - PHRASE_MIN) {
      let hit = 0;
      for (let len = Math.min(PHRASE_MAX, run.length - i); len >= PHRASE_MIN; len--) {
        const phrase = run.slice(i, i + len);
        if (bigramsPresent(phrase, terms) && text.includes(phrase)) {
          hit = len;
          break;
        }
      }
      if (hit > 0) {
        found.push(run.slice(i, i + hit));
        i += hit;
      } else {
        i++;
      }
    }
  }
  return found;
}

/**
 * 给每个候选段打精确分。分数 = Σ 字面量权重 × idf 折扣，idf 在 corpusSize 上算；
 * 超过一半候选都命中的字面量直接不计（候选少于 4 个时不做这个判断，样本太小）。
 * 只返回分数 ≥ EXACT_MIN_SCORE 的段。
 */
export function scoreExact(query: string, docs: readonly ExactDoc[], corpusSize = docs.length): Map<string, ExactScore> {
  const { terms, hanRuns } = extractExactTerms(query);
  const result = new Map<string, ExactScore>();
  if ((terms.length === 0 && hanRuns.length === 0) || docs.length === 0) return result;

  const matchers = terms.map((term) => ({ term, test: literalMatcher(term) }));
  const perDoc = docs.map((doc) => {
    const text = normalize(doc.text);
    const literals = matchers.filter((m) => m.test(text)).map((m) => m.term);
    const phrases = matchPhrases(hanRuns, text, doc.terms).map((p): ExactTerm => ({ kind: 'phrase', text: p, weight: phraseWeight(p.length) }));
    return { id: doc.id, hits: [...literals, ...phrases] };
  });

  const docFreq = new Map<string, number>();
  for (const { hits } of perDoc) {
    for (const key of new Set(hits.map((t) => `${t.kind}:${t.text}`))) docFreq.set(key, (docFreq.get(key) ?? 0) + 1);
  }

  const n = Math.max(corpusSize, docs.length);
  for (const { id, hits } of perDoc) {
    let score = 0;
    const matched: string[] = [];
    const counted = new Set<string>();
    for (const term of hits) {
      const key = `${term.kind}:${term.text}`;
      if (counted.has(key)) continue;
      counted.add(key);
      const df = docFreq.get(key) ?? 1;
      if (docs.length >= 4 && df / docs.length > MAX_DOC_RATIO) continue;
      // 归一化 idf：只在 1 个段出现时为 1，越常见越接近 0
      const idf = n > 1 ? Math.log(1 + n / df) / Math.log(1 + n) : 1;
      score += term.weight * idf;
      matched.push(term.kind === 'alias' ? `#${term.text.toUpperCase()}` : term.text);
    }
    if (score >= EXACT_MIN_SCORE) result.set(id, { score, matched });
  }
  return result;
}
