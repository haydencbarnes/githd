// Parsers for machine-readable git output.

export interface GitLineCounts {
  insertions: number;
  deletions: number;
  binary: boolean;
}

export interface GitFileChange {
  status: string;
  oldPath: string;
  newPath: string;
}

const namedEscapes: Record<string, string> = {
  a: '\x07',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v'
};

// Decodes a path quoted by git (see core.quotePath), e.g. "caf\303\251.txt" -> café.txt.
// Unquoted values are returned as is.
export function parseGitPath(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) {
    return value;
  }
  return value.slice(1, -1).replace(/(?:\\[0-7]{3})+|\\(.)/g, (escape: string, character?: string) => {
    if (character !== undefined) {
      return namedEscapes[character] ?? character;
    }
    // A run of octal escapes is the UTF-8 byte sequence of the original characters.
    const bytes = escape
      .split('\\')
      .filter(octal => octal)
      .map(octal => parseInt(octal, 8));
    return Buffer.from(bytes).toString('utf8');
  });
}

// Parses `--name-status -z` output of git diff, git show and git stash show:
//   STATUS\0path\0                for A, D, M and T
//   RNNN\0old_path\0new_path\0    for renames (R) and copies (C)
// Merge commits report one status letter per parent (e.g. MM); the first one is used.
// git show may print header lines (e.g. signature verification) ahead of the first status; since
// they are newline terminated, the status is taken from the last line of the token.
const nameStatusCodes = new Set(['M', 'A', 'D', 'T', 'R', 'C']);

export function parseNameStatus(output: string): GitFileChange[] {
  const changes: GitFileChange[] = [];
  const tokens = output.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const match = /^([A-Z])[A-Z]*\d*$/.exec(token.slice(token.lastIndexOf('\n') + 1).trim());
    if (!match) {
      continue;
    }
    const status = match[1];
    if (!nameStatusCodes.has(status)) {
      throw new Error('Cannot parse ' + tokens.slice(i, i + 2).join(' '));
    }
    const oldPath = tokens[++i];
    const newPath = status === 'R' || status === 'C' ? tokens[++i] : oldPath;
    if (!oldPath || !newPath) {
      break; // truncated output
    }
    changes.push({ status, oldPath, newPath });
  }
  return changes;
}

// Parses `git diff --numstat -z` output into [new path, line counts]:
//   insertions\tdeletions\tpath\0
//   insertions\tdeletions\t\0old_path\0new_path\0    for renames and copies
// Binary files report '-' for both counts.
export function parseNumStat(output: string): Map<string, GitLineCounts> {
  const lineCounts = new Map<string, GitLineCounts>();
  const tokens = output.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(tokens[i]);
    if (!match) {
      continue;
    }
    const [, insertions, deletions, filePath] = match;
    let gitRelativePath = filePath;
    if (!gitRelativePath) {
      i += 2;
      gitRelativePath = tokens[i];
    }
    if (!gitRelativePath) {
      break; // truncated output
    }
    lineCounts.set(
      gitRelativePath,
      insertions === '-' || deletions === '-'
        ? { insertions: 0, deletions: 0, binary: true }
        : { insertions: Number(insertions), deletions: Number(deletions), binary: false }
    );
  }
  return lineCounts;
}
