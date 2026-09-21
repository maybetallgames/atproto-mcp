export interface PatchHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

export interface FilePatch {
  oldPath: string;
  newPath: string;
  hunks: PatchHunk[];
  isNewFile: boolean;
  isDeletedFile: boolean;
}

export function parseUnifiedDiff(diff: string): FilePatch[] {
  const files: FilePatch[] = [];
  const chunks = diff.split(/^diff --git /gm).filter(Boolean);

  for (const chunk of chunks) {
    const lines = chunk.split('\n');
    const oldHeader = lines.find((line) => line.startsWith('--- '));
    const newHeader = lines.find((line) => line.startsWith('+++ '));

    if (!oldHeader || !newHeader) continue;

    const oldPath = oldHeader.includes('/dev/null')
      ? '/dev/null'
      : oldHeader.replace('--- a/', '').trim();
    const newPath = newHeader.includes('/dev/null')
      ? '/dev/null'
      : newHeader.replace('+++ b/', '').trim();

    const hunks: PatchHunk[] = [];
    let current: PatchHunk | null = null;

    for (const line of lines) {
      const match = line.match(/^@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/);
      if (match) {
        current = {
          oldStart: Number(match[1]),
          oldCount: Number(match[2] || 1),
          newStart: Number(match[3]),
          newCount: Number(match[4] || 1),
          lines: [],
        };
        hunks.push(current);
        continue;
      }

      if (current && /^[ +\-]/.test(line)) {
        current.lines.push(line);
      }
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

export function applyUnifiedPatch(original: string, hunks: PatchHunk[]): string {
  const source = original ? original.split('\n') : [];
  const output: string[] = [];
  let sourceIndex = 0;

  for (const hunk of hunks) {
    const target = hunk.oldStart - 1;

    while (sourceIndex < target) {
      output.push(source[sourceIndex++]);
    }

    for (const line of hunk.lines) {
      const type = line[0];
      const content = line.slice(1);

      if (type === ' ') {
        if (source[sourceIndex] !== content) {
          throw new Error(`Patch context mismatch at line ${sourceIndex + 1}`);
        }
        output.push(content);
        sourceIndex++;
      } else if (type === '-') {
        if (source[sourceIndex] !== content) {
          throw new Error(`Patch removal mismatch at line ${sourceIndex + 1}`);
        }
        sourceIndex++;
      } else if (type === '+') {
        output.push(content);
      }
    }
  }

  while (sourceIndex < source.length) {
    output.push(source[sourceIndex++]);
  }

  return output.join('\n');
}
