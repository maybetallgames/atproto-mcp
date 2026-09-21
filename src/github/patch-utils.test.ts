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

  it('relocates a hunk when preceding edits make its line number stale', () => {
    const [file] = parseUnifiedDiff(
      '--- a/a.txt\n+++ b/a.txt\n@@ -2,2 +2,2 @@\n target\n-old\n+new'
    );
    expect(file).toBeDefined();
    expect(applyUnifiedPatch('inserted\nelsewhere\ntarget\nold', file!.hunks)).toBe(
      'inserted\nelsewhere\ntarget\nnew'
    );
  });

  it('preserves CRLF line endings while matching LF patch context', () => {
    const [file] = parseUnifiedDiff(
      '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+three'
    );
    expect(file).toBeDefined();
    expect(applyUnifiedPatch('one\r\ntwo', file!.hunks)).toBe('one\r\nthree');
  });

  it('rejects ambiguous relocated context', () => {
    const [file] = parseUnifiedDiff(
      '--- a/a.txt\n+++ b/a.txt\n@@ -20 +20 @@\n-old\n+new'
    );
    expect(file).toBeDefined();
    expect(() => applyUnifiedPatch('old\nother\nold', file!.hunks)).toThrow(
      'Patch context is ambiguous'
    );
  });

  it('rejects mismatched context', () => {
    const [file] = parseUnifiedDiff(
      'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-nope\n+yes'
    );
    expect(() => applyUnifiedPatch('other', file!.hunks)).toThrow('Patch removal mismatch');
  });

  it('accepts unprefixed paths and a patch without a diff --git header', () => {
    const [file] = parseUnifiedDiff(
      '--- Assets/MayBeTall/LobbyManager.cs\n+++ Assets/MayBeTall/LobbyManager.cs\n@@ -1 +1,2 @@\n existing\n+using System.Collections;'
    );
    expect(file).toMatchObject({
      oldPath: 'Assets/MayBeTall/LobbyManager.cs',
      newPath: 'Assets/MayBeTall/LobbyManager.cs',
    });
    expect(applyUnifiedPatch('existing', file!.hunks)).toBe('existing\nusing System.Collections;');
  });

  it('rejects shorthand @@ markers with a useful error', () => {
    expect(() =>
      parseUnifiedDiff(
        '--- Assets/MayBeTall/LobbyManager.cs\n+++ Assets/MayBeTall/LobbyManager.cs\n@@\n+using System.Collections;'
      )
    ).toThrow('has no valid hunks');
  });
});
