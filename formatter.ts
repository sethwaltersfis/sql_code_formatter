import { format as sqlFormat, FormatOptionsWithLanguage } from 'sql-formatter';
import type { SqlStyle } from './styleFile';

interface FormatterContext {
  dialect: string;
  editorTabSize: number;
  insertSpaces: boolean;
  overrideTabSize?: number;
  log?: (message: string) => void;
}

const KEYWORD_CLAUSES = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN',
  'FULL JOIN', 'CROSS JOIN', 'OUTER APPLY', 'CROSS APPLY', 'ON', 'AND', 'OR', 'WHEN', 'THEN', 'ELSE', 'END',
  'VALUES', 'SET', 'UNION', 'UNION ALL'
];

export function formatSql(input: string, style: SqlStyle, ctx: FormatterContext): string {
  const tabWidth = ctx.overrideTabSize ?? style.whitespace?.numberOfSpacesInTabs ?? ctx.editorTabSize ?? 2;
  const keywordCase = mapCase(style.casing?.reservedKeywords, 'upper');
  const dataTypeCase = mapCase(style.casing?.builtInDataTypes, 'upper');
  const functionCase = mapCase(style.casing?.builtInFunctions, 'upper');
  const logicalOperatorNewline = style.operators?.andOr?.alignment === 'rightAligned' ? 'before' : 'after';
  const newlineBeforeSemicolon = style.whitespace?.whiteSpaceBeforeSemiColon === 'newLineBefore';
  const expressionWidth = style.whitespace?.wrapLinesLongerThan ?? 300;

  const options: FormatOptionsWithLanguage = {
    language: normalizeDialect(ctx.dialect),
    keywordCase,
    dataTypeCase,
    functionCase,
    tabWidth,
    useTabs: !ctx.insertSpaces,
    expressionWidth,
    logicalOperatorNewline,
    newlineBeforeSemicolon,
    linesBetweenQueries: 1,
    denseOperators: false
  };

  ctx.log?.(`Formatting with options: ${JSON.stringify(options)}`);

  let formatted = sqlFormat(input, options);
  if (style.dml?.addNewLineAfterDistinctAndTopClauses) formatted = forceLineBreakAfterDistinctAndTop(formatted);
  if (style.joinStatements?.on?.placeOnNewLine === false) formatted = keepOnWithJoin(formatted);
  if (style.lists?.placeCommasBeforeItems) formatted = convertTrailingToLeadingCommas(formatted);
  if (style.lists?.alignAliases) formatted = alignAliases(formatted);
  if (style.lists?.alignComments) formatted = alignComments(formatted);
  if (style.operators?.comparison?.align) formatted = alignComparisonOperators(formatted);
  formatted = normalizeKeywordClauses(formatted);
  formatted = cleanupBlankLines(formatted);
  return formatted.endsWith('\n') ? formatted : `${formatted}\n`;
}

function mapCase(
  value: string | undefined,
  fallback: 'upper' | 'lower'
): 'preserve' | 'upper' | 'lower' {
  switch ((value || '').toLowerCase()) {
    case 'uppercase':
    case 'upper':
      return 'upper';

    case 'lowercase':
    case 'lower':
      return 'lower';

    case 'preserve':
      return 'preserve';

    default:
      return fallback;
  }
}

function normalizeDialect(value: string): FormatOptionsWithLanguage['language'] {
  switch ((value || '').toLowerCase()) {
    case 'transactsql':
    case 'tsql':
    case 'sql': return 'transactsql';
    case 'postgres':
    case 'postgresql': return 'postgresql';
    case 'mysql': return 'mysql';
    case 'plsql': return 'plsql';
    case 'sqlite': return 'sqlite';
    case 'snowflake': return 'snowflake';
    default: return 'transactsql';
  }
}

function forceLineBreakAfterDistinctAndTop(text: string): string {
  return text
    .replace(/SELECT\s+DISTINCT\s+/gi, m => m.replace(/\s+$/, '') + '\n  ')
    .replace(/TOP\s*\([^)]*\)\s+/gi, m => m.replace(/\s+$/, '') + '\n  ')
    .replace(/TOP\s+\d+\s+/gi, m => m.replace(/\s+$/, '') + '\n  ');
}

function keepOnWithJoin(text: string): string {
  return text.replace(/\n(\s*)ON/g, ' ON');
}

function convertTrailingToLeadingCommas(text: string): string {
  const lines = text.split(/\n?\n/);
  for (let i = 0; i < lines.length - 1; i++) {
    const current = lines[i];
    if (/,(\s*(--.*)?)?$/.test(current)) {
      const nextIndex = findNextContentLine(lines, i + 1);
      if (nextIndex > -1 && !/^\s*,/.test(lines[nextIndex])) {
        lines[i] = current.replace(/,(\s*(--.*)?)?$/, '$1');
        lines[nextIndex] = lines[nextIndex].replace(/^(\s*)/, '$1, ');
      }
    }
  }
  return lines.join('\n');
}

function findNextContentLine(lines: string[], start: number): number {
  for (let i = start; i < lines.length; i++) if (lines[i].trim() !== '') return i;
  return -1;
}

function alignAliases(text: string): string {
  return alignBlocks(text, /^([ 	]*,?\s*)(.+?)(\s+AS\s+|\s+)(\[[^\]]+\]|"[^"]+"|`[^`]+`|[A-Za-z_][\w$#@]*)\s*(--.*)?$/i, match => ({
    prefix: match[1], left: match[2].trimEnd(), joiner: /AS/i.test(match[3]) ? ' AS ' : ' ', right: match[4], comment: match[5] ?? ''
  }));
}

function alignComments(text: string): string {
  return alignBlocks(text, /^([ 	]*,?\s*)(.*?)(\s*)(--.*)$/i, match => {
    if (!match[4]) return null;
    return { prefix: match[1], left: match[2].trimEnd(), joiner: ' ', right: '', comment: match[4] };
  });
}

function alignComparisonOperators(text: string): string {
  const blocks = splitIntoBlocks(text.split(/\n?\n/));
  const rebuilt: string[] = [];
  for (const block of blocks) {
    const parsed = block.map(line => {
      const m = line.match(/^(\s*)(.+?)\s*(=|<>|!=|>=|<=|>|<)\s*(.+)$/);
      if (!m) return null;
      return { indent: m[1], left: m[2].trimEnd(), op: m[3], right: m[4].trimStart() };
    });
    if (parsed.filter(Boolean).length < 2) { rebuilt.push(...block); continue; }
    const width = Math.max(...parsed.filter(Boolean).map(x => (x as NonNullable<typeof x>).left.length));
    for (let i = 0; i < block.length; i++) {
      const row = parsed[i];
      if (!row) { rebuilt.push(block[i]); continue; }
      rebuilt.push(`${row.indent}${row.left.padEnd(width)} ${row.op} ${row.right}`);
    }
  }
  return rebuilt.join('\n');
}

function alignBlocks(
  text: string,
  pattern: RegExp,
  project: (match: RegExpMatchArray) => { prefix: string; left: string; joiner: string; right: string; comment: string } | null
): string {
  const lines = text.split(/\n?\n/);
  const blocks = splitIntoBlocks(lines);
  const output: string[] = [];
  for (const block of blocks) {
    const rows = block.map(line => { const m = line.match(pattern); return m ? project(m) : null; });
    const qualifying = rows.filter(Boolean) as Array<{ prefix: string; left: string; joiner: string; right: string; comment: string }>;
    if (qualifying.length < 2) { output.push(...block); continue; }
    const leftWidth = Math.max(...qualifying.map(r => r.left.length));
    const rightWidth = Math.max(...qualifying.map(r => r.right.length));
    for (let i = 0; i < block.length; i++) {
      const row = rows[i];
      if (!row) { output.push(block[i]); continue; }
      const left = row.left.padEnd(leftWidth);
      const right = row.right ? row.right.padEnd(rightWidth) : '';
      const comment = row.comment ? ` ${row.comment.trimStart()}` : '';
      output.push(`${row.prefix}${left}${row.joiner}${right}${comment}`.trimEnd());
    }
  }
  return output.join('\n');
}

function splitIntoBlocks(lines: string[]): string[][] {
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.trim() === '') {
      if (current.length) { blocks.push(current); current = []; }
      blocks.push([line]);
      continue;
    }
    current.push(line);
  }
  if (current.length) blocks.push(current);
  return blocks;
}

function normalizeKeywordClauses(text: string): string {
  let result = text;
  for (const clause of KEYWORD_CLAUSES.sort((a, b) => b.length - a.length)) {
    const escaped = clause.replace(/\s+/g, '\s+');
    const re = new RegExp(`\b${escaped}\b`, 'gi');
    result = result.replace(re, clause);
  }
  return result;
}

function cleanupBlankLines(text: string): string {
  return text.replace(/[ 	]+$/gm, '').replace(/\n{3,}/g, '\n\n').replace(/\n+$/g, '\n');
}
