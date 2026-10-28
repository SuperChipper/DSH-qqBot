import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { resolveTmpDir } from './tmp-dir.ts';

describe('resolveTmpDir', () => {
  it('默认 cwd/tmp；相对路径按 cwd；绝对路径原样', () => {
    expect(resolveTmpDir({ cwd: 'C:/w', tmpDir: '' })).toBe(resolve('C:/w', 'tmp'));
    expect(resolveTmpDir({ cwd: 'C:/w', tmpDir: 'scratch' })).toBe(resolve('C:/w', 'scratch'));
    expect(resolveTmpDir({ cwd: 'C:/w', tmpDir: 'D:/t' })).toBe('D:/t');
  });
});
