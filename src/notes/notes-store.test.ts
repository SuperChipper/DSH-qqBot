import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { NotesStore, chatKeyOf, chunkMarkdown, formatNotesHint, tokenize } from './notes-store.ts';
import { looksLikeCampaignNote } from './notes-tools.ts';

const SAMPLE = [
  '# 大肥鱼小课堂 · 课堂笔记',
  '',
  '- 系列：卡布奇诺ultra《大肥鱼小课堂 DSH》',
  '',
  '## 一、逐集笔记',
  '',
  '### 04 这三句话已被人类拉黑',
  '- 新词：鱼八股——一眼就能看出是模板',
  '- 三句固定句式被公开拉黑',
  '',
  '### 08 哈哈哈哈',
  '- 两个哈 = 敷衍；四个以上才是真笑',
  '',
  '### 10 明天开家长会',
  '- 300 条全是好话 = 这孩子很活跃',
].join('\n');

function tempNotes(files: Record<string, string> = { '课堂笔记.md': SAMPLE }): string {
  const root = mkdtempSync(join(tmpdir(), 'notes-'));
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content, 'utf8');
  }
  return root;
}

const hintOptions = { topK: 2, maxChars: 600, minCoverage: 0.4 };

describe('tokenize', () => {
  it('中文取二字组，英文取小写词，单个数字保留', () => {
    expect(tokenize('鱼八股 DSH 第4集')).toEqual(['鱼八', '八股', 'dsh', '第', '4', '集']);
  });
});

describe('chunkMarkdown', () => {
  it('按 #/##/### 切段，带标题路径', () => {
    const chunks = chunkMarkdown('a.md', SAMPLE);
    expect(chunks.map((c) => c.heading)).toEqual([
      '大肥鱼小课堂 · 课堂笔记',
      '大肥鱼小课堂 · 课堂笔记 › 一、逐集笔记 › 04 这三句话已被人类拉黑',
      '大肥鱼小课堂 · 课堂笔记 › 一、逐集笔记 › 08 哈哈哈哈',
      '大肥鱼小课堂 · 课堂笔记 › 一、逐集笔记 › 10 明天开家长会',
    ]);
  });

  it('没有标题的文件用文件名当标题；标题跳级不出现 undefined', () => {
    expect(chunkMarkdown('dir/随手记.md', '一段话')[0]!.heading).toBe('随手记');
    expect(chunkMarkdown('x.md', '### 小节\n内容')[0]!.heading).toBe('x › x › 小节');
  });
});

describe('NotesStore.search', () => {
  it('按相关度返回段落', () => {
    const store = new NotesStore(tempNotes());
    const [top] = store.search('你还记得鱼八股是什么吗');
    expect(top!.heading).toContain('04 这三句话已被人类拉黑');
    expect(top!.file).toBe('课堂笔记.md');
  });

  it('递归索引子目录，跳过隐藏文件和非 md 文件', () => {
    const root = tempNotes({ 'sub/群.md': '# 群规\n周五晚上开黑', '.hidden.md': '# 开黑', 'x.txt': '开黑' });
    const hits = new NotesStore(root).search('开黑');
    expect(hits.map((h) => h.file)).toEqual(['sub/群.md']);
  });

  it('目录不存在时返回空', () => {
    expect(new NotesStore(join(tmpdir(), 'no-such-notes-dir-xyz')).search('任何')).toEqual([]);
  });

  it('别的会话的私有笔记检索不到；本会话和本机会话都看得到', () => {
    const root = tempNotes({
      '共享.md': '# 跑团入门\n沉钟修道院是新手模组',
      'chats/group_A/沉钟.md': '# 沉钟修道院\n队伍已升 2 级',
      'chats/group_B/沉钟.md': '# 沉钟修道院\n还没开团',
    });
    const store = new NotesStore(root);
    const files = (key?: string): string[] => store.search('沉钟修道院', 5, key).map((h) => h.file).sort();

    expect(files('group_A')).toEqual(['chats/group_A/沉钟.md', '共享.md']);
    expect(files('group_C')).toEqual(['共享.md']);
    expect(files(undefined)).toHaveLength(3);
  });
});

describe('NotesStore.save', () => {
  it('新标题建文件，带记录时间与来源；随后可检索到', () => {
    const root = tempNotes({});
    const store = new NotesStore(root);
    const result = store.save({ title: '群友小明', content: '小明养了一只橘猫叫团子', source: '群聊' });

    expect(result.created).toBe(true);
    expect(result.file).toBe('群友小明.md');
    const text = readFileSync(join(root, '群友小明.md'), 'utf8');
    expect(text).toMatch(/^# 群友小明\n\n> 记录于 \d{4}-\d{2}-\d{2} · 来源：群聊\n\n小明养了一只橘猫叫团子\n$/);
    expect(store.search('小明的猫叫什么')[0]!.file).toBe('群友小明.md');
  });

  it('指定已有文件时追加小节', () => {
    const root = tempNotes();
    const store = new NotesStore(root);
    const result = store.save({ title: '11 评论区的钓鱼佬', content: '先撒白米饭再喊鱼', file: '课堂笔记.md' });

    expect(result.created).toBe(false);
    expect(readFileSync(join(root, '课堂笔记.md'), 'utf8')).toContain('\n## 11 评论区的钓鱼佬\n');
  });

  it('文件名去掉路径穿越，补 .md', () => {
    const root = tempNotes({});
    const result = new NotesStore(root).save({ title: 't', content: 'c', file: '../../evil' });
    expect(result.file).toBe('evil.md');
  });

  it('空标题/空内容/超长内容报错', () => {
    const store = new NotesStore(tempNotes({}));
    expect(() => store.save({ title: ' ', content: 'x' })).toThrow();
    expect(() => store.save({ title: 'x', content: ' ' })).toThrow();
    expect(() => store.save({ title: 'x', content: 'a'.repeat(9000) })).toThrow(/过长/);
  });

  it('带 chatKey 时写到 chats/<会话>/ 下，只有该会话检索得到', () => {
    const root = tempNotes({});
    const store = new NotesStore(root);
    const key = chatKeyOf('group', 'A215');
    const result = store.save({ title: '沉钟修道院 队伍', content: '刻德温是战争牧师', chatKey: key });

    expect(result.message).toContain('只有本会话');
    expect(readFileSync(join(root, 'chats', 'group_A215', '沉钟修道院 队伍.md'), 'utf8')).toContain('刻德温');
    expect(store.search('刻德温是什么职业', 5, key)).toHaveLength(1);
    expect(store.search('刻德温是什么职业', 5, chatKeyOf('group', 'D609'))).toEqual([]);
  });

  it('人手改文件后重新索引（mtime/大小变化）', () => {
    vi.useFakeTimers();
    try {
      const root = tempNotes();
      const store = new NotesStore(root);
      expect(store.search('橘猫团子')).toEqual([]);
      writeFileSync(join(root, '新.md'), '# 猫\n橘猫团子', 'utf8');
      vi.advanceTimersByTime(5000);
      expect(store.search('橘猫团子')[0]!.file).toBe('新.md');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('formatNotesHint', () => {
  const store = new NotesStore(tempNotes());

  it('相关问题注入片段', () => {
    const hint = formatNotesHint(store.search('被人类拉黑的三句话是哪三句', 4), hintOptions);
    expect(hint).toContain('[共享笔记 · 可能相关]');
    expect(hint).toContain('04 这三句话已被人类拉黑');
  });

  it('只撞上一个词的短消息不注入', () => {
    expect(formatNotesHint(store.search('哈哈哈哈', 4), hintOptions)).toBe('');
    expect(formatNotesHint(store.search('今天吃什么', 4), hintOptions)).toBe('');
  });

  it('本会话私有笔记标成 [本会话]，不暴露目录名', () => {
    const scoped = new NotesStore(tempNotes({ 'chats/group_A/团.md': '# 沉钟修道院\n队伍已升两级，下次开矿坑' }));
    const hint = formatNotesHint(scoped.search('沉钟修道院下次开哪里', 4, 'group_A'), hintOptions);
    expect(hint).toContain('- [本会话] 团.md › 沉钟修道院');
    expect(hint).not.toContain('group_A');
  });

  it('按 maxChars 截断', () => {
    const hint = formatNotesHint(store.search('明天开家长会怎么办', 4), { ...hintOptions, maxChars: 80, topK: 1 });
    const body = hint.split('\n')[2]!;
    expect(body.length).toBeLessThanOrEqual(85);
  });
});

describe('looksLikeCampaignNote', () => {
  it('跑团存档/约定默认只记到本会话', () => {
    expect(looksLikeCampaignNote('沉钟修道院跑团 · DM 操作约定', '默认先上引导术')).toBe(true);
    expect(looksLikeCampaignNote('2 级队伍配置', '一环位 3 个，20 HP')).toBe(true);
  });

  it('普通梗和知识不算', () => {
    expect(looksLikeCampaignNote('网络缩写小抄', 'ltp、admin、php 的意思')).toBe(false);
    expect(looksLikeCampaignNote('奶蛙迷因档案', '2026 年初在 B 站爆红')).toBe(false);
  });
});
