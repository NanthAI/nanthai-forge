// SPDX-License-Identifier: Apache-2.0
// What an agent action actually runs, for any client (d8cf81b4). Tool inputs arrive as
//   - raw shell text (scripted agents),
//   - JSON (Claude Bash/Write, Codex function calls, local_shell_call), or
//   - JavaScript source (Codex code-mode `exec`: text(await tools.exec_command({cmd:"gh api …"}))).
// `commandText` turns each into the plain command text with real line breaks; `shellCommands`
// splits that text into simple commands with quotes resolved, so a rule sees `gh api …` as the
// words it is and not as `{cmd:"gh` or `main"));`. Pure text work: no I/O, no network.

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
/** Tools whose input is file content or a patch, not a command: nothing to run in it. */
const FILE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit|apply_patch)$/i;
/** Argument names that carry a place or a setting, not a command. */
const NOT_COMMAND_KEYS = new Set(['workdir', 'cwd', 'shell', 'session_id', 'cell_id', 'justification']);

// ---- JavaScript (Codex code-mode exec) -------------------------------------------------

const ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };

/** Tokens of a JavaScript source, enough to find string literals and the calls they sit in:
 * { t: 'str', v } strings (quotes and template literals, escapes decoded), { t: 'id', v }
 * names and { t: 'p', v } single punctuation characters. Comments and regexes are skipped. */
function jsTokens(src) {
  const tokens = [];
  const n = src.length;
  let i = 0;
  const last = () => tokens[tokens.length - 1];
  const regexAllowed = () => {
    const l = last();
    return (
      !l ||
      (l.t === 'p' && !')]}'.includes(l.v)) ||
      (l.t === 'id' && /^(return|typeof|case|of|in)$/.test(l.v))
    );
  };
  /** Decode a quoted string whose opening quote is at i; returns [value, indexAfter]. */
  const quoted = (q, from) => {
    let v = '';
    let j = from + 1;
    while (j < n && src[j] !== q) {
      const c = src[j];
      if (c === '\\') {
        const d = src[j + 1];
        if (d === 'x' && /^[0-9a-fA-F]{2}$/.test(src.slice(j + 2, j + 4))) {
          v += String.fromCharCode(parseInt(src.slice(j + 2, j + 4), 16));
          j += 4;
        } else if (d === 'u' && src[j + 2] === '{') {
          const end = src.indexOf('}', j);
          v += String.fromCodePoint(parseInt(src.slice(j + 3, end), 16) || 0xfffd);
          j = end + 1;
        } else if (d === 'u' && /^[0-9a-fA-F]{4}$/.test(src.slice(j + 2, j + 6))) {
          v += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
          j += 6;
        } else if (d === '\n') j += 2;
        else {
          v += d in ESCAPES ? ESCAPES[d] : (d ?? '');
          j += 2;
        }
      } else if (q === '`' && c === '$' && src[j + 1] === '{') {
        // Keep the expression text; it is not evaluated.
        let depth = 1;
        let k = j + 2;
        while (k < n && depth) {
          if (src[k] === '{') depth++;
          else if (src[k] === '}') depth--;
          k++;
        }
        v += src.slice(j, k);
        j = k;
      } else {
        v += c;
        j++;
      }
    }
    return [v, j + 1];
  };
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) i++;
    else if (c === '/' && src[i + 1] === '/') i = src.indexOf('\n', i) < 0 ? n : src.indexOf('\n', i);
    else if (c === '/' && src[i + 1] === '*')
      i = src.indexOf('*/', i + 2) < 0 ? n : src.indexOf('*/', i + 2) + 2;
    else if (c === '"' || c === "'" || c === '`') {
      const [v, next] = quoted(c, i);
      tokens.push({ t: 'str', v });
      i = next;
    } else if (c === '/' && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      while (j < n && (src[j] !== '/' || inClass) && src[j] !== '\n') {
        if (src[j] === '\\') j++;
        else if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        j++;
      }
      i = j + 1;
      tokens.push({ t: 'id', v: 'regex' });
    } else if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(src[j])) j++;
      tokens.push({ t: 'id', v: src.slice(i, j) });
      i = j;
    } else if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(src[j])) j++;
      tokens.push({ t: 'num', v: src.slice(i, j) });
      i = j;
    } else {
      tokens.push({ t: 'p', v: c });
      i++;
    }
  }
  return tokens;
}

/** Quote a word for a shell line so the words of an argv survive being joined. */
const shellQuote = word => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);

/** The command texts of a Codex code-mode exec payload: the string values of every
 * `tools.<name>(…)` call (cmd, command, chars, arrays of argv words, "a"+"b" concatenations),
 * except patches. When a command is not a literal (`cmd` is a variable), every string literal
 * of the payload outside patches is added, so nothing a script builds from literals is lost. */
function jsCommands(src, grouped = false) {
  const tokens = jsTokens(src);
  const out = [],
    groups = [];
  const inCalls = new Set();
  let unresolved = false;
  for (let i = 0; i + 4 < tokens.length; i++) {
    const [a, dot, name, open, open2] = tokens.slice(i, i + 5);
    if (!(a.t === 'id' && a.v === 'tools')) continue;
    const bracket = dot.v === '[' && name.t === 'str' && open.v === ']' && open2.v === '(';
    if (!((dot.v === '.' && name.t === 'id' && open.v === '(') || bracket)) continue;
    const tool = name.v;
    const firstOutput = out.length;
    const start = bracket ? i + 5 : i + 4;
    let depth = 1;
    let end = start;
    while (end < tokens.length && depth) {
      if (tokens[end].t === 'p' && '([{'.includes(tokens[end].v)) depth++;
      else if (tokens[end].t === 'p' && ')]}'.includes(tokens[end].v)) depth--;
      end++;
    }
    for (let k = i; k < end; k++) inCalls.add(k);
    if (FILE_TOOLS.test(tool)) continue;
    // Walk the arguments: key: value pairs and bare values.
    let key = null;
    for (let k = start; k < end - 1; k++) {
      const tk = tokens[k];
      const next = tokens[k + 1];
      if ((tk.t === 'id' || tk.t === 'str') && next?.v === ':' && next.t === 'p') {
        key = tk.v;
        k++;
        continue;
      }
      if (tk.t === 'str') {
        // "a" + "b" + "c"
        let v = tk.v;
        while (tokens[k + 1]?.v === '+' && tokens[k + 2]?.t === 'str') {
          v += tokens[k + 2].v;
          k += 2;
        }
        if (!NOT_COMMAND_KEYS.has(key)) out.push(v);
        key = null;
      } else if (tk.t === 'p' && tk.v === '[') {
        // an argv array of strings
        const words = [];
        let j = k + 1;
        for (; j < end - 1 && !(tokens[j].t === 'p' && tokens[j].v === ']'); j++)
          if (tokens[j].t === 'str') words.push(tokens[j].v);
        if (words.length && !NOT_COMMAND_KEYS.has(key)) out.push(argvLine(words));
        k = j;
        key = null;
      } else if (key && ['cmd', 'command', 'chars'].includes(key) && (tk.t === 'id' || tk.t === 'p')) {
        if (tk.t === 'id') unresolved = true;
        key = null;
      } else if (
        tk.t === 'id' &&
        (next?.v === ',' || next?.v === '}') &&
        ['cmd', 'command', 'chars'].includes(tk.v)
      ) {
        unresolved = true; // shorthand { cmd }
      }
    }
    groups.push({
      tool,
      input: tokens
        .slice(start, end - 1)
        .map(t => (t.t === 'str' ? JSON.stringify(t.v) : t.v))
        .join(' '),
      command: out.slice(firstOutput).join('\n'),
    });
  }
  if (unresolved)
    tokens.forEach((tk, k) => {
      if (tk.t === 'str' && !inCalls.has(k) && tokens[k + 1]?.v !== ':') out.push(tk.v);
    });
  return grouped ? groups : out;
}

/** Code-mode child commands, in execution/output order, including resumed commands. */
export function commandInvocations(input) {
  return jsCommands(String(input), true);
}

/** One shell line for an argv array: `["bash","-lc","script"]` is just the script. */
function argvLine(words) {
  if (SHELLS.has(words[0].replace(/^.*\//, '')) && /^-\w*c$/.test(words[1] ?? '') && words.length > 2)
    return words.slice(2).join(' ');
  return words.map(shellQuote).join(' ');
}

/** Does this look like Codex code-mode source rather than shell text? */
const CODEX_JS = /\btools\s*(?:\.\s*[A-Za-z_]\w*\s*\(|\[\s*["'][^"']+["']\s*\]\s*\()/;

/** The text an action carries, as plain command lines: JSON string values (argv arrays become
 * one shell line), the command strings of a Codex exec script, or the raw text. `tool` lets
 * file writes and patches (content, not commands) read as empty. */
export function commandText(input, tool) {
  const text = String(input);
  if (FILE_TOOLS.test(String(tool ?? ''))) return '';
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return CODEX_JS.test(text) ? jsCommands(text).join('\n') : text;
  }
  if (parsed === null || typeof parsed !== 'object') return text;
  const out = [];
  (function walk(v) {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v) && v.length && v.every(x => typeof x === 'string')) out.push(argvLine(v));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  })(parsed);
  return out.join('\n');
}

// ---- Shell text -------------------------------------------------------------------------

/** Index just past the `)` that closes the `$(`/`<(` whose body starts at `from`, skipping
 * quotes and heredoc bodies. */
function closeParen(text, from) {
  const n = text.length;
  let depth = 1;
  let i = from;
  const pending = [];
  while (i < n && depth) {
    const c = text[i];
    if (c === '\\') i += 2;
    else if (c === "'") {
      const e = text.indexOf("'", i + 1);
      i = e < 0 ? n : e + 1;
    } else if (c === '"') i = closeDouble(text, i + 1);
    else if (c === '`') {
      const e = text.indexOf('`', i + 1);
      i = e < 0 ? n : e + 1;
    } else if (c === '<' && text[i + 1] === '<' && text[i + 2] !== '<') {
      const spec = heredocSpec(text, i);
      if (spec) {
        pending.push(spec);
        i = spec.end;
      } else i += 2;
    } else if (c === '\n') {
      i++;
      for (const spec of pending.splice(0)) i = skipHeredoc(text, i, spec).next;
    } else {
      if (c === '(') depth++;
      else if (c === ')') depth--;
      i++;
    }
  }
  return i;
}

/** Index just past the `"` that closes a double-quoted string whose body starts at `from`. */
function closeDouble(text, from) {
  const n = text.length;
  let i = from;
  while (i < n && text[i] !== '"') {
    if (text[i] === '\\') i += 2;
    else if (text[i] === '$' && text[i + 1] === '(') i = closeParen(text, i + 2);
    else if (text[i] === '`') {
      const e = text.indexOf('`', i + 1);
      i = e < 0 ? n : e + 1;
    } else i++;
  }
  return i + 1;
}

/** `<<[-]'DELIM'` at text[i]: { delim, strip, end } or null. */
function heredocSpec(text, i) {
  const m = /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([^\s;&|<>()'"]+))/.exec(text.slice(i, i + 200));
  if (!m) return null;
  return { delim: m[2] ?? m[3] ?? m[4], strip: m[1] === '-', end: i + m[0].length };
}

/** Body lines of a heredoc starting at text[from], and the index after its delimiter line. */
function skipHeredoc(text, from, { delim, strip }) {
  const lines = [];
  let i = from;
  while (i < text.length) {
    const e = text.indexOf('\n', i);
    const line = text.slice(i, e < 0 ? text.length : e);
    i = e < 0 ? text.length : e + 1;
    if ((strip ? line.replace(/^\t+/, '') : line) === delim) return { body: lines.join('\n'), next: i };
    lines.push(line);
  }
  return { body: lines.join('\n'), next: i };
}

const WRAPPERS = new Set(['sudo', 'command', 'exec', 'nohup', 'time', 'builtin', 'noglob']);
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}', 'fi', 'done']);

/** Drop leading keywords, env assignments and wrappers (`sudo`, `env -i`, `nice -n 5`,
 * `timeout 30`) off a command's words. */
function stripLeading(words) {
  let i = 0;
  for (;;) {
    const w = words[i];
    if (w === undefined) break;
    if (KEYWORDS.has(w) || WRAPPERS.has(w) || /^[A-Za-z_]\w*=/.test(w)) i++;
    else if (w === 'env') {
      i++;
      while (words[i] !== undefined && (words[i].startsWith('-') || /^[A-Za-z_]\w*=/.test(words[i]))) {
        i += words[i] === '-u' || words[i] === '-C' ? 2 : 1;
      }
    } else if (w === 'nice') i += words[i + 1] === '-n' ? 3 : words[i + 1]?.startsWith('-') ? 2 : 1;
    else if (w === 'timeout') {
      i++;
      while (words[i]?.startsWith('-')) i++;
      i++; // the duration
    } else break;
  }
  return words.slice(i);
}

/** Simple commands of a shell text: [{ words, body, text }]. Quotes are resolved (one word
 * per argument), `;` `&&` `||` `|` `&` newlines and subshell parentheses separate commands,
 * `$(…)`, backticks and `bash -c '…'`/`eval` bodies are commands of their own, redirections
 * are dropped, and a heredoc body stays with the command it feeds (`body`), because
 * `python3 - <<'EOF' … EOF` runs that body. `text` is the words plus the body. */
export function shellCommands(source, depth = 0) {
  const text = String(source);
  const commands = [];
  if (depth > 4) return commands;
  const n = text.length;
  let cur = { words: [], body: '' };
  let word = '';
  let inWord = false;
  let quotedWord = false;
  let skipNext = null; // 'drop' after a bare redirection, 'body' after <<<
  const pending = []; // heredocs waiting for the end of their line: { spec, cmd }

  const flushWord = () => {
    if (!inWord) return;
    const w = word;
    const quoted = quotedWord;
    word = '';
    inWord = false;
    quotedWord = false;
    if (skipNext) {
      if (skipNext === 'body') cur.body += `${cur.body ? '\n' : ''}${w}`;
      skipNext = null;
      return;
    }
    if (!quoted) {
      const m = /^(?:\d*|&)(?:>>?|<&?|>&|&>>?)(.*)$/.exec(w);
      if (m) {
        if (!m[1]) skipNext = 'drop';
        return;
      }
    }
    cur.words.push(w);
  };
  const raw = []; // commands as written; heredoc bodies attach after their line ends
  const endCommand = () => {
    flushWord();
    skipNext = null;
    if (cur.words.length || cur.body) {
      raw.push(cur);
      cur = { words: [], body: '' };
    } else cur.words = [];
  };
  const add = cmd => {
    const words = stripLeading(cmd.words);
    cmd.words = words;
    if (!words.length) return;
    const head = words[0].replace(/^.*\//, '');
    // bash -lc '…' / eval '…': the script is the command.
    if (SHELLS.has(head)) {
      const flag = words.findIndex((w, k) => k > 0 && /^-\w*c\w*$/.test(w));
      if (flag > 0 && words[flag + 1] !== undefined) {
        commands.push(...shellCommands(words[flag + 1], depth + 1));
        if (cmd.body) commands.push(...shellCommands(cmd.body, depth + 1));
        return;
      }
      if (cmd.body) {
        commands.push(...shellCommands(cmd.body, depth + 1));
        return;
      }
    } else if (head === 'eval') {
      commands.push(...shellCommands(words.slice(1).join(' '), depth + 1));
      return;
    }
    cmd.text = words.join(' ') + (cmd.body ? `\n${cmd.body}` : '');
    commands.push(cmd);
  };
  const sub = inner => commands.push(...shellCommands(inner, depth + 1));

  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '\\') {
      if (text[i + 1] === '\n') i += 2;
      else {
        word += text[i + 1] ?? '';
        inWord = true;
        i += 2;
      }
    } else if (c === "'") {
      const e = text.indexOf("'", i + 1);
      const end = e < 0 ? n : e;
      word += text.slice(i + 1, end);
      inWord = quotedWord = true;
      i = end + 1;
    } else if (c === '"') {
      const end = closeDouble(text, i + 1);
      const body = text.slice(i + 1, Math.max(i + 1, end - 1));
      // Resolve escapes; $(…) and backticks inside are commands of their own.
      let v = '';
      for (let k = 0; k < body.length; k++) {
        if (body[k] === '\\' && '\\"$`\n'.includes(body[k + 1] ?? '')) {
          if (body[k + 1] !== '\n') v += body[k + 1];
          k++;
        } else if (body[k] === '$' && body[k + 1] === '(') {
          const close = closeParen(body, k + 2);
          sub(body.slice(k + 2, close - 1));
          v += body.slice(k, close);
          k = close - 1;
        } else if (body[k] === '`') {
          const close = body.indexOf('`', k + 1);
          const stop = close < 0 ? body.length : close;
          sub(body.slice(k + 1, stop));
          v += body.slice(k, stop + 1);
          k = stop;
        } else v += body[k];
      }
      word += v;
      inWord = quotedWord = true;
      i = end;
    } else if ((c === '$' || c === '<' || c === '>') && text[i + 1] === '(') {
      const close = closeParen(text, i + 2);
      sub(text.slice(i + 2, close - 1));
      word += text.slice(i, close);
      inWord = true;
      i = close;
    } else if (c === '`') {
      const e = text.indexOf('`', i + 1);
      const stop = e < 0 ? n : e;
      sub(text.slice(i + 1, stop));
      word += text.slice(i, stop + 1);
      inWord = true;
      i = stop + 1;
    } else if (c === '<' && text[i + 1] === '<' && text[i + 2] === '<') {
      flushWord();
      skipNext = 'body';
      i += 3;
    } else if (c === '<' && text[i + 1] === '<') {
      const spec = heredocSpec(text, i);
      if (spec) {
        flushWord();
        pending.push({ spec, cmd: cur });
        i = spec.end;
      } else {
        word += '<<';
        inWord = true;
        i += 2;
      }
    } else if (c === '\n') {
      endCommand();
      i++;
      for (const { spec, cmd } of pending.splice(0)) {
        const { body, next } = skipHeredoc(text, i, spec);
        cmd.body += `${cmd.body ? '\n' : ''}${body}`;
        i = next;
      }
    } else if (
      c === ';' ||
      c === '|' ||
      c === '(' ||
      c === ')' ||
      (c === '&' && text[i + 1] !== '>' && text[i - 1] !== '>')
    ) {
      // `2>&1` and `>&2` keep their `&`; `&>` is a redirection.
      if (c === '&' && text[i + 1] === '&') i++;
      else if (c === '|' && text[i + 1] === '|') i++;
      endCommand();
      i++;
    } else if (c === '#' && !inWord && !/\d/.test(text[i + 1] ?? '')) {
      const e = text.indexOf('\n', i);
      i = e < 0 ? n : e;
    } else if (c === ' ' || c === '\t' || c === '\r') {
      flushWord();
      i++;
    } else {
      word += c;
      inWord = true;
      i++;
    }
  }
  endCommand();
  raw.forEach(add);
  return commands;
}
