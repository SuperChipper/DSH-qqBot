import { describe, expect, it } from 'vitest';
import { extractPseudoStickerCalls, sanitizePseudoStickerText, sanitizePseudoToolText } from './pseudo-sticker-call.ts';

describe('extractPseudoStickerCalls', () => {
  it('剥离完整伪调用并解析出收藏参数', () => {
    const text = `这图我收了，下次用。

<qqbot_save_sticker">
<image>C:/media/cat.jpg</image>
<emotion>被压扁</emotion>
<note>被踩扁还带笑</note>
</qqbot_save_sticker>`;

    const result = extractPseudoStickerCalls(text);
    expect(result.visible).toBe('这图我收了，下次用。');
    expect(result.calls).toEqual([{
      image: 'C:/media/cat.jpg',
      emotion: '被压扁',
      note: '被踩扁还带笑',
    }]);
  });

  it('兼容开标签带杂散引号的模型输出', () => {
    const text = '文字\n<qqbot_save_sticker">\n<image>C:/media/cat.jpg</image>\n<emotion>无语</emotion>\n</qqbot_save_sticker>';
    const result = extractPseudoStickerCalls(text);
    expect(result.visible).toBe('文字');
    expect(result.calls[0]).toMatchObject({ image: 'C:/media/cat.jpg', emotion: '无语' });
  });

  it('流式未闭合块先整体扣住，不把 XML 碎片发给用户', () => {
    const partial = '文字开始\n<qqbot_save_sticker>\n<image>C:/media/cat.jpg</image>';
    expect(sanitizePseudoStickerText(partial)).toBe('文字开始');
  });

  it('末尾半截开标签也会被扣住', () => {
    expect(sanitizePseudoStickerText('文字<qqbot_save_stic')).toBe('文字');
    expect(sanitizePseudoStickerText('普通文字<qq')).toBe('普通文字<qq');
  });

  it('普通文本原样保留，多个伪调用都能解析', () => {
    const text = `一\n<qqbot_save_sticker><image>a.png</image><emotion>一</emotion></qqbot_save_sticker>二\n<qqbot_save_sticker><image>b.png</image><emotion>二</emotion></qqbot_save_sticker>三`;
    const result = extractPseudoStickerCalls(text);
    expect(result.visible).toBe('一\n二\n三');
    expect(result.calls.map((call) => call.image)).toEqual(['a.png', 'b.png']);
  });

  it('支持属性写法', () => {
    const text = '文字\n<qqbot_save_sticker image="c.png" emotion="开心" note="test"></qqbot_save_sticker>';
    const result = extractPseudoStickerCalls(text);
    expect(result.visible).toBe('文字');
    expect(result.calls[0]).toEqual({ image: 'c.png', emotion: '开心', note: 'test' });
  });

  it('剥离 qqbot_send_file 伪标签（不重复执行发送）', () => {
    const text = '文字\n<qqbot_send_file">\n<file_path>C:/x.png</file_path>\n</qqbot_send_file>';
    expect(sanitizePseudoToolText(text)).toBe('文字');
    expect(sanitizePseudoToolText('文字<qqbot_send_file')).toBe('文字');
  });
});
