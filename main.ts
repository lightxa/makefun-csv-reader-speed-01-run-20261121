// Fast drop-in for csv-reader 1.0.0 (make.fun): answers {columns, rows, errors}
// for {text, header} exactly as the reference does, but parses with
// indexOf/slice bulk scans instead of one character at a time.
//
// Reference semantics (verified against vendor/csv-reader/index.js):
// - U+FEFF at the very start is dropped.
// - A record ends at LF or CRLF; a line left with no characters is no record.
// - Outside quotes a CR not followed by LF is dropped (error stray_cr, no line++).
// - A field opening with '"' runs to the next non-doubled '"'; "" inside is one
//   '"'; each CRLF or lone CR inside is read as LF (and counts a line).
//   What follows the closing quote up to the next comma or line break is
//   appended as it stands (error quote_junk when the field ends, if any
//   characters were kept). A quote that never closes is a literal '"', and
//   the text after it is re-read as unquoted (error unterminated_quote).
// - A quote inside an unquoted field is a literal character.
// - columns is the first record when header is true, else null; rows are the
//   records after it, each padded with "" (short_row, fields: its count) or
//   cut (long_row, extra: the cut fields) to the first record's width.
// - Each error is {code, line, row} in the order met; line is the 1-based
//   line the record starts on (counting every LF, CRLF and lone CR inside
//   quotes), row is the record's index in rows (null for the header).
// - A record's short_row/long_row error is pushed when the record ends,
//   after that record's field errors.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--no-incremental-marking');

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

export function run(input: any): any {
  const text = String(input.text);
  const header = input.header === true;
  const errors: any[] = [];
  const rows: string[][] = [];
  let columns: string[] | null = null;
  let width = -1;
  const n = text.length;
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  // Current record's line/row, used by every error pushed while reading it.
  let curLine = 1;
  let curRow: number | null = null;
  // Position of the next LF at or after pos, or n when none remains.
  // Recomputed only once pos has passed it, so an unquoted field needs
  // just one indexOf (for the next comma) instead of two.
  let lineEnd = -1;

  function finishRecord(fields: string[]): void {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: curLine, row: curRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: curLine, row: curRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  // Reads unquoted characters onto `value` up to the next comma or line
  // break. Returns the field, how it ended, and how many characters were
  // kept (for quote_junk). A stray CR is dropped with a stray_cr error.
  function readUnquoted(value: string): { value: string; ended: number; added: number } {
    let added = 0;
    for (;;) {
      if (pos >= n) return { value, ended: END, added };
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        return { value, ended: COMMA, added };
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      if (c === 13) {
        if (text.charCodeAt(pos + 1) === 10) {
          pos += 2;
          line += 1;
          return { value, ended: LINE_BREAK, added };
        }
        errors.push({ code: 'stray_cr', line: curLine, row: curRow });
        pos += 1;
        continue;
      }
      // Bulk scan to the next comma or LF (the LF position is cached per
      // record, so this is one indexOf). Any CR inside that span is stray,
      // except a trailing CR just before the LF, which is the CRLF break.
      if (lineEnd < pos) {
        const x = text.indexOf('\n', pos);
        lineEnd = x === -1 ? n : x;
      }
      const comma = text.indexOf(',', pos);
      const lf = lineEnd === n ? -1 : lineEnd;
      let end = n;
      let isComma = false;
      let isLF = false;
      if (comma !== -1 && (lf === -1 || comma < lf)) {
        end = comma;
        isComma = true;
      } else if (lf !== -1) {
        end = lf;
        isLF = true;
      }
      const seg = text.slice(pos, end);
      const cr = seg.indexOf('\r');
      if (cr === -1) {
        value += seg;
        added += seg.length;
        pos = end;
        if (isComma) {
          pos += 1;
          return { value, ended: COMMA, added };
        }
        if (isLF) {
          pos += 1;
          line += 1;
          return { value, ended: LINE_BREAK, added };
        }
        return { value, ended: END, added };
      }
      // Slow path: stray CR(s) inside the span. A CR at the very end of
      // the span just before an LF is the CRLF break, not a stray CR.
      for (let i = 0; i < seg.length; i++) {
        const ch = seg.charCodeAt(i);
        if (ch === 13) {
          if (isLF && i === seg.length - 1) continue;
          errors.push({ code: 'stray_cr', line: curLine, row: curRow });
          continue;
        }
        value += seg[i];
        added += 1;
      }
      pos = end;
      if (isComma) {
        pos += 1;
        return { value, ended: COMMA, added };
      }
      if (isLF) {
        pos += 1;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      return { value, ended: END, added };
    }
  }

  // Normalises one span inside a quoted field: CRLF and lone CR each
  // become one LF, and counts the line breaks it holds into `line`.
  function quotedSpan(a: number, b: number): string {
    if (a >= b) return '';
    // Fast branch: no LF inside the span. Then a CR in it is always lone
    // (a CR followed by LF would put that LF inside the span), so the
    // span either copies as-is or normalises lone CRs to LF.
    const nl = text.indexOf('\n', a);
    if (nl === -1 || nl >= b) {
      const s = text.slice(a, b);
      const cr = s.indexOf('\r');
      if (cr === -1) return s;
      let cnt = 0;
      let i = cr;
      while (i !== -1) {
        cnt += 1;
        i = s.indexOf('\r', i + 1);
      }
      line += cnt;
      return s.replaceAll('\r', '\n');
    }
    const s = text.slice(a, b);
    const cr = s.indexOf('\r');
    if (cr === -1) {
      // No CR: only LFs can raise the line count.
      let i = s.indexOf('\n');
      if (i === -1) return s;
      let cnt = 0;
      while (i !== -1) {
        cnt += 1;
        i = s.indexOf('\n', i + 1);
      }
      line += cnt;
      return s;
    }
    let out = '';
    let cnt = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i);
      if (ch === 13) {
        out += '\n';
        cnt += 1;
        if (s.charCodeAt(i + 1) === 10) i += 1;
      } else {
        if (ch === 10) cnt += 1;
        out += s[i];
      }
    }
    line += cnt;
    return out;
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted(): { value: string; ended: number } {
    const open = pos;
    const openLine = line;
    let value = '';
    let scan = pos + 1;
    for (;;) {
      const q = text.indexOf('"', scan);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: curLine, row: curRow });
        return readUnquoted('"');
      }
      if (text.charCodeAt(q + 1) === 34) {
        value += quotedSpan(scan, q);
        value += '"';
        scan = q + 2;
        continue;
      }
      value += quotedSpan(scan, q);
      pos = q + 1;
      break;
    }
    if (pos >= n) return { value, ended: END };
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return { value, ended: COMMA };
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    // What follows the closing quote is appended as it stands.
    const junk = readUnquoted(value);
    if (junk.added > 0) errors.push({ code: 'quote_junk', line: curLine, row: curRow });
    return junk;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    curLine = line;
    curRow = header && columns === null ? null : rows.length;

    // Fast path: this record's line holds no quoted field (every '"' in
    // it sits inside an unquoted field, where it is literal) and no stray
    // CR. Then the whole line splits on commas at once. A field-start
    // quote is detected first with one indexOf, so records that need the
    // general path never pay for slicing and scanning the line.
    const lf = text.indexOf('\n', pos);
    const segEnd = lf === -1 ? n : lf;
    const q0 = text.indexOf('"', pos);
    if (q0 === -1 || q0 >= segEnd || (q0 !== pos && text.charCodeAt(q0 - 1) !== 44)) {
      let segEndAdj = segEnd;
      if (lf !== -1 && segEnd > pos && text.charCodeAt(segEnd - 1) === 13) segEndAdj = segEnd - 1;
      const seg = text.slice(pos, segEndAdj);
      let fast = seg.indexOf('\r') === -1;
      if (fast) {
        let q = q0 !== -1 && q0 < segEndAdj ? q0 - pos : -1;
        while (q !== -1) {
          if (q === 0 || seg.charCodeAt(q - 1) === 44) {
            fast = false;
            break;
          }
          q = seg.indexOf('"', q + 1);
        }
      }
      if (fast) {
        const fields = seg.split(',');
        pos = lf === -1 ? n : lf + 1;
        if (lf !== -1) line += 1;
        finishRecord(fields);
        continue;
      }
    }

    // General path: one field at a time.
    const fields: string[] = [];
    let ended = END;
    let quoted = false;
    do {
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        const f = readQuoted();
        fields.push(f.value);
        ended = f.ended;
      } else {
        quoted = false;
        const f = readUnquoted('');
        fields.push(f.value);
        ended = f.ended;
      }
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no
    // record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;
    finishRecord(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
const answers: unknown[] = [];
for (const c of cases) answers.push(run(c.input));
mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answers));
