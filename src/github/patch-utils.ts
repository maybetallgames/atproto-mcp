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
}

export function parseUnifiedDiff(diff: string): FilePatch[] {
  const files: FilePatch[] = [];
  const chunks = diff.split(/^diff --git /gm).filter(Boolean);

  for (const chunk of chunks) {
    const lines = chunk.split('\n');
    const oldPath = lines.find((line) => line.startsWith('--- a/'))?.slice(6).trim();
    const newPath = lines.find((line) => line.startsWith('+++ b/'))?.slice(6).trim();

    if (!oldPath || !newPath) continue;

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

    files.push({ oldPath, newPath, hunks });
  }

  return files;
}

export function applyUnifiedPatch(original: string, hunks: PatchHunk[]): string {
  const source = original.split('\n');
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
    output.push(source[sourceIndex++]);
  }

  return output.join('\n');
}
