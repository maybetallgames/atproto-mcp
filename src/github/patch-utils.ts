export interface IPatchHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

export interface IFilePatch {
  oldPath: string;
  newPath: string;
  hunks: IPatchHunk[];
  isNewFile: boolean;
  isDeletedFile: boolean;
}

const parseHeaderPath = (header: string, marker: '---' | '+++', prefix: 'a/' | 'b/'): string => {
  const path = header.slice(marker.length).trim().split('\t', 1)[0] ?? '';
  if (path === '/dev/null') return path;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
};

export function parseUnifiedDiff(diff: string): IFilePatch[] {
  const files: IFilePatch[] = [];
  const chunks = /^diff --git /m.test(diff) ? diff.split(/^diff --git /gm).filter(Boolean) : [diff];

  for (const chunk of chunks) {
    const lines = chunk.split('\n');
    const oldHeader = lines.find(line => line.startsWith('--- '));
    const newHeader = lines.find(line => line.startsWith('+++ '));

    if (!oldHeader || !newHeader) continue;

    const oldPath = parseHeaderPath(oldHeader, '---', 'a/');
    const newPath = parseHeaderPath(newHeader, '+++', 'b/');

    const hunks: IPatchHunk[] = [];
    let current: IPatchHunk | null = null;

    for (const line of lines) {
      const match = line.match(/^@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/);
      if (match) {
        current = {
          oldStart: Number(match[1]),
          oldCount: Number(match[2] === '' ? 1 : match[2]),
          newStart: Number(match[3]),
          newCount: Number(match[4] === '' ? 1 : match[4]),
          lines: [],
        };
        hunks.push(current);
        continue;
      }

      if (current && /^[ +-]/.test(line)) {
        current.lines.push(line);
      }
    }

    if (hunks.length === 0) {
      throw new Error(
        `Patch for ${newPath === '/dev/null' ? oldPath : newPath} has no valid hunks`
      );
    }

    files.push({
      oldPath,
      newPath,
      hunks,
      isNewFile: oldPath === '/dev/null',
      isDeletedFile: newPath === '/dev/null',
    });
  }

  return files;
}

const hunkMatchesAt = (source: string[], hunk: IPatchHunk, index: number): boolean => {
  let sourceIndex = index;

  for (const line of hunk.lines) {
    if (line[0] !== '+' && source[sourceIndex++] !== line.slice(1)) return false;
  }

  return true;
};

const findHunkTarget = (source: string[], hunk: IPatchHunk, minimum: number): number => {
  const expected = Math.max(minimum, hunk.oldStart - 1);
  if (hunkMatchesAt(source, hunk, expected)) return expected;

  const matches: number[] = [];
  for (let index = minimum; index <= source.length; index++) {
    if (hunkMatchesAt(source, hunk, index)) matches.push(index);
  }

  if (matches.length === 1) return matches[0]!;

  if (matches.length > 1) {
    throw new Error(
      `Patch context is ambiguous: hunk expected near line ${hunk.oldStart} matches ${matches.length} locations`
    );
  }

  throw new Error(`Patch context mismatch near line ${hunk.oldStart}`);
};

export function applyUnifiedPatch(original: string, hunks: IPatchHunk[]): string {
  const lineEnding = original.includes('\r\n') ? '\r\n' : '\n';
  const source = original ? original.replace(/\r\n/g, '\n').split('\n') : [];
  const output: string[] = [];
  let sourceIndex = 0;

  for (const hunk of hunks) {
    const target = findHunkTarget(source, hunk, sourceIndex);

    while (sourceIndex < target) {
      const line = source[sourceIndex++];
      if (line === undefined) throw new Error('Patch hunk starts beyond the end of the file');
      output.push(line);
    }

    for (const line of hunk.lines) {
      const type = line[0];
      const content = line.slice(1);

      if (type === ' ') {
        output.push(content);
        sourceIndex++;
      } else if (type === '-') {
        sourceIndex++;
      } else if (type === '+') {
        output.push(content);
      }
    }
  }

  while (sourceIndex < source.length) {
    const line = source[sourceIndex++];
    if (line !== undefined) output.push(line);
  }

  return output.join(lineEnding);
}
