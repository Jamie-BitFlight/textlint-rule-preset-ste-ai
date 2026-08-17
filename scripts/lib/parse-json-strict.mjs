/**
 * `JSON.parse` keeps the last of a repeated key and discards the rest without a word, so the bytes
 * on disk and the value every check sees can disagree. That is not a hypothetical: a review inserted
 *
 *     "reviewer": "dr-jane-doe-cert-ste-auditor",
 *     "reviewerKind": "human",
 *     "reviewer": "rewriter-a",
 *     "reviewerKind": "agent",
 *
 * into a committed annotation. `prettier --check` called the file clean, every gate passed, the
 * content digest was unchanged — and the file reads to a person as though a named human auditor
 * signed off on it. Anything that hashes parsed values rather than bytes inherits this, so the
 * duplicate has to be refused at the point of reading.
 *
 * Bytes are not hashed directly instead because the repository sets no `.gitattributes`, so a
 * checkout is free to hand us CRLF and a byte digest would fail for everyone on Windows.
 */

/**
 * Read one string literal starting at `start`, returning its decoded value and the index one past
 * the closing quote. The text has already survived `JSON.parse`, so the literal is well formed and
 * `JSON.parse` on the slice decodes the escapes exactly.
 */
function readString(text, start) {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === '"') {
      i += 1;
      break;
    }
    i += 1;
  }
  return { value: JSON.parse(text.slice(start, i)), end: i };
}

/**
 * Throw if any object in `text` names the same key twice. A string is a key when the container it
 * sits in is an object and the next non-space character is a colon; every `{` gets its own set, so
 * repeating a key in a *sibling* object is fine and repeating it in the same one is not.
 *
 * The `isObject` half of that test is unreachable when the caller is `parseJsonStrict`, which runs
 * `JSON.parse` first: a string sitting directly inside an array can never be followed by a colon in
 * valid JSON — `{"a":["x": 1]}` is a syntax error. A review flagged that no test pins it, and none
 * can without invalid input, so it is recorded here rather than covered by a case that would only
 * appear to test something. It is kept for any caller that scans text `JSON.parse` has not seen.
 */
export function assertNoDuplicateKeys(text, label) {
  const stack = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const { value, end } = readString(text, i);
      i = end;
      let j = i;
      while (j < text.length && /\s/.test(text[j] ?? '')) j += 1;
      const container = stack.at(-1);
      if (text[j] === ':' && container?.isObject === true) {
        if (container.keys.has(value)) {
          throw new Error(`${label}: duplicate key ${JSON.stringify(value)}`);
        }
        container.keys.add(value);
      }
      continue;
    }
    if (ch === '{') stack.push({ isObject: true, keys: new Set() });
    else if (ch === '[') stack.push({ isObject: false, keys: new Set() });
    else if (ch === '}' || ch === ']') stack.pop();
    i += 1;
  }
}

/** `JSON.parse`, plus the guarantee that the value returned accounts for every key in the text. */
export function parseJsonStrict(text, label) {
  const value = JSON.parse(text);
  assertNoDuplicateKeys(text, label);
  return value;
}
