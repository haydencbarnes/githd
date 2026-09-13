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

// Raw commit details of `git blame --incremental` output, shared by all the lines of the commit.
export interface GitBlameCommit {
  hash: string;
  author: string;
  email: string;
  committerTime: string;
  summary: string;
}

// The attribution of one line (0-based line numbers).
export interface GitBlameLine {
  commit: GitBlameCommit;
  originalLine: number;
  // path of the file the line is attributed to, relative to the repository root
  filename: string;
}

interface BlameGroup {
  commit: GitBlameCommit;
  originalLine: number;
  line: number;
  count: number;
  filename: string;
}

const blameHeader = /^([0-9a-f]{40,64}) (\d+) (\d+) (\d+)$/;

// Parses `git blame --incremental` output into [final line, attribution]. Every group of lines
// starts with a header `<hash> <original line> <final line> <count>`, followed by the commit
// details the first time the commit is seen and by the `filename` of the group.
export function parseBlameIncremental(output: string): Map<number, GitBlameLine> {
  const commits = new Map<string, GitBlameCommit>();
  const groups: BlameGroup[] = [];
  let group: BlameGroup | undefined;
  for (const line of output.split(/\r?\n/g)) {
    const header = blameHeader.exec(line);
    if (header) {
      const [, hash, originalLine, finalLine, count] = header;
      let commit = commits.get(hash);
      if (!commit) {
        commit = { hash, author: '', email: '', committerTime: '', summary: '' };
        commits.set(hash, commit);
      }
      group = {
        commit,
        originalLine: Number(originalLine) - 1,
        line: Number(finalLine) - 1,
        count: Number(count),
        filename: ''
      };
      groups.push(group);
    } else if (group) {
      parseBlameDetail(group, line);
    }
  }

  const lines = new Map<number, GitBlameLine>();
  for (const { commit, originalLine, line, count, filename } of groups) {
    for (let i = 0; i < count; i++) {
      lines.set(line + i, { commit, originalLine: originalLine + i, filename });
    }
  }
  return lines;
}

function parseBlameDetail(group: BlameGroup, line: string): void {
  const name = line.split(' ')[0];
  if (name === 'filename') {
    group.filename = parseGitPath(line.substring(name.length + 1));
    return;
  }
  const value = line.substring(name.length).trim();
  if (!value) {
    return;
  }
  switch (name) {
    case 'author':
      group.commit.author = value;
      break;
    case 'author-mail':
      group.commit.email = value;
      break;
    case 'committer-time':
      group.commit.committerTime = value;
      break;
    case 'summary':
      group.commit.summary = value;
      break;
    default:
      break;
  }
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
