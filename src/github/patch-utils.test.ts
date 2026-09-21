import { describe, expect, it } from 'vitest';
import { applyUnifiedPatch, parseUnifiedDiff } from './patch-utils.js';

describe('GitHub unified patches', () => {
  it('applies a modification', () => {
    const [file] = parseUnifiedDiff(
      'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+three'
    );
    expect(file).toBeDefined();
    expect(applyUnifiedPatch('one\ntwo', file!.hunks)).toBe('one\nthree');
  });

  it('recognizes additions and deletions', () => {
    const files = parseUnifiedDiff(
      'diff --git a/new.txt b/new.txt\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+new\ndiff --git a/old.txt b/old.txt\n--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-old'
    );
    expect(files[0]).toMatchObject({ newPath: 'new.txt', isNewFile: true });
    expect(files[1]).toMatchObject({ oldPath: 'old.txt', isDeletedFile: true });
    expect(applyUnifiedPatch('', files[0]!.hunks)).toBe('new');
    expect(applyUnifiedPatch('old', files[1]!.hunks)).toBe('');
  });

  it('rejects mismatched context', () => {
    const [file] = parseUnifiedDiff(
      'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-nope\n+yes'
    );
    expect(() => applyUnifiedPatch('other', file!.hunks)).toThrow('Patch removal mismatch');
  });
});
