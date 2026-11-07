// A small, conservative reader for the Bash commands agents run. It splits a command line into simple
// commands (words, redirect targets, here-doc bodies) so the gate can look at each one. It does not
// expand anything; where a construct could hide what runs (command substitution, eval), it says so.

export interface SimpleCommand {
  words: string[];
  redirects: string[]; // files written to or read from with >, >>, <
  heredocs: string[]; // here-document bodies fed to this command's stdin
  /** The operators around it ('' at either end of the line, '\n' for a new line): what runs it, and in which shell. */
  before: string;
  after: string;
  /** How many parentheses it is inside: a subshell's variables never reach the line around it. */
  depth: number;
  /** The parentheses opened and closed since the command before it, in order: where subshells begin and end. */
  parens: string;
  /** Words (and redirect targets) with a quoted or escaped `$`, which the shell leaves as it is. */
  literalDollar: { words: number[]; redirects: number[] };
}

export type ShellParse = { ok: true; commands: SimpleCommand[] } | { ok: false; reason: string };

const newCommand = (): SimpleCommand => ({ words: [], redirects: [], heredocs: [], before: '', after: '', depth: 0, parens: '', literalDollar: { words: [], redirects: [] } });

export function parseShell(source: string): ShellParse {
  const commands: SimpleCommand[] = [];
  const pendingHeredocs: Array<{ delimiter: string; stripTabs: boolean; command: SimpleCommand }> = [];
  let current = newCommand();
  let word = '';
  let inWord = false;
  let nextIs: 'word' | 'redirect' | 'data' = 'word';
  let literalDollar = false; // the word being read has a `$` the shell will not expand
  let before = '';
  let depth = 0;
  let parens = '';
  let i = 0;

  const fail = (reason: string): ShellParse => ({ ok: false, reason });

  const pushWord = (): void => {
    if (!inWord) return;
    if (nextIs === 'redirect') {
      if (literalDollar) current.literalDollar.redirects.push(current.redirects.length);
      current.redirects.push(word);
    } else if (nextIs === 'word') {
      if (literalDollar) current.literalDollar.words.push(current.words.length);
      current.words.push(word);
    }
    nextIs = 'word';
    word = '';
    inWord = false;
    literalDollar = false;
  };

  /** Ends the command at an operator (or the end of the line, ''), and notes the operator for the next one. */
  const endCommand = (operator = ''): void => {
    pushWord();
    if (current.words.length || current.redirects.length) {
      commands.push({ ...current, before, after: operator, depth, parens });
      parens = '';
    }
    current = newCommand();
    before = operator;
  };

  const readHeredocBodies = (): void => {
    for (const doc of pendingHeredocs.splice(0)) {
      const lines: string[] = [];
      while (i < source.length) {
        const end = source.indexOf('\n', i);
        const line = source.slice(i, end < 0 ? source.length : end);
        i = end < 0 ? source.length : end + 1;
        if ((doc.stripTabs ? line.replace(/^\t+/, '') : line) === doc.delimiter) break;
        lines.push(line);
      }
      doc.command.heredocs.push(lines.join('\n'));
    }
  };

  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];

    if (c === '\\') {
      if (next === '\n') {
        i += 2;
        continue;
      }
      if (next === '$') literalDollar = true;
      word += next ?? '';
      inWord = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = source.indexOf("'", i + 1);
      if (end < 0) return fail('unterminated quote');
      if (source.slice(i + 1, end).includes('$')) literalDollar = true;
      word += source.slice(i + 1, end);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      inWord = true;
      i++;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          if (source[i + 1] === '$') literalDollar = true;
          word += source[i + 1];
          i += 2;
          continue;
        }
        if (source[i] === '`' || (source[i] === '$' && source[i + 1] === '(')) return fail('command substitution');
        word += source[i];
        i++;
      }
      if (i >= source.length) return fail('unterminated quote');
      i++;
      continue;
    }
    if (c === '`' || (c === '$' && next === '(')) return fail('command substitution');
    if ((c === '<' || c === '>') && next === '(') return fail('process substitution');
    if (c === '#' && !inWord) {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (c === '\n') {
      endCommand('\n');
      i++;
      readHeredocBodies();
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      pushWord();
      i++;
      continue;
    }
    if (c === '&' && next === '>') {
      pushWord();
      nextIs = 'redirect';
      i += source[i + 2] === '>' ? 3 : 2;
      continue;
    }
    if (c === ';' || c === '|' || c === '&' || c === '(' || c === ')') {
      const operator = (c === '&' || c === '|' || c === ';') && next === c ? c + c : c;
      endCommand(operator);
      if (c === '(') depth++;
      else if (c === ')') depth = Math.max(0, depth - 1);
      if (c === '(' || c === ')') parens += c;
      i += operator.length;
      continue;
    }
    if (c === '<' || c === '>') {
      // A file descriptor number right before the operator belongs to it: 2>err.log
      if (inWord && /^\d+$/.test(word)) {
        word = '';
        inWord = false;
      } else pushWord();
      if (c === '<' && next === '<' && source[i + 2] === '<') {
        i += 3;
        nextIs = 'data'; // here-string: the next word is text, not a file
        continue;
      }
      if (c === '<' && next === '<') {
        i += 2;
        const stripTabs = source[i] === '-';
        if (stripTabs) i++;
        while (source[i] === ' ' || source[i] === '\t') i++;
        let delimiter = '';
        while (i < source.length && !/[\s;&|<>()]/.test(source[i]!)) {
          if (source[i] !== "'" && source[i] !== '"' && source[i] !== '\\') delimiter += source[i];
          i++;
        }
        if (!delimiter) return fail('here-document without a delimiter');
        pendingHeredocs.push({ delimiter, stripTabs, command: current });
        continue;
      }
      i++;
      if (source[i] === '>' || source[i] === '|') i++;
      if (source[i] === '&') {
        // Duplicating a descriptor (2>&1, >&2) touches no file.
        i++;
        while (i < source.length && /[0-9-]/.test(source[i]!)) i++;
        continue;
      }
      nextIs = 'redirect';
      continue;
    }
    word += c;
    inWord = true;
    i++;
  }
  endCommand();
  readHeredocBodies();
  return { ok: true, commands };
}
