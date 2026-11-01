import { describe, expect, it } from 'vitest';
import { toSpeechText } from './speak-tool.ts';

describe('toSpeechText', () => {
  it('代码块整段丢掉，行内 code 只留内容', () => {
    const out = toSpeechText('跑这个 ```bash\nnpm run build\n``` 还有 `git status` 也行');
    expect(out).not.toContain('npm run build');
    expect(out).toContain('git status');
  });

  it('markdown 符号和换行抹平', () => {
    expect(toSpeechText('**重点**来了\n下一行')).toBe('重点 来了，下一行');
  });

  it('链接换成「链接」两个字，md 链接只留标题', () => {
    expect(toSpeechText('看 https://example.com/a 这个')).toBe('看 链接 这个');
    expect(toSpeechText('[文档](https://example.com)')).toBe('文档');
  });

  it('纯代码没有可念的内容', () => {
    expect(toSpeechText('```python\nprint(1)\n```')).toBe('');
  });
});
