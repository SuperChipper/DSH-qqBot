import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../types.ts';
import { DEFAULT_PERSONA_ID, parsePersona, PersonaStore } from './persona-store.ts';

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'qqbot-persona-'));
  const dir = join(base, 'personas');
  mkdirSync(dir);
  const statePath = join(base, 'state.json');
  const warn = vi.fn();
  const open = () => new PersonaStore({ dir, statePath, logger: { warn, info: vi.fn() } as unknown as Logger });
  return { dir, open, warn };
}

describe('parsePersona', () => {
  it('读文件头的 name、names，正文作为 prompt', () => {
    const persona = parsePersona('maid', '---\nname: 冷面女仆\nnames: [女仆, 小女仆]\n---\n【身份】女仆\n');
    expect(persona).toEqual({ id: 'maid', name: '冷面女仆', names: ['女仆', '小女仆'], prompt: '【身份】女仆' });
  });

  it('没有文件头时用文件名，CRLF 也能解析', () => {
    expect(parsePersona('maid', '【身份】女仆').name).toBe('maid');
    expect(parsePersona('maid', '---\r\nname: 女仆\r\n---\r\n正文\r\n')).toMatchObject({ name: '女仆', prompt: '正文' });
  });

  it('正文为空或文件头写坏时报错', () => {
    expect(() => parsePersona('maid', '---\nname: 女仆\n---\n')).toThrow(/正文为空/);
    expect(() => parsePersona('maid', '---\nname: [\n---\n正文')).toThrow();
    expect(() => parsePersona('maid', '---\n- a\n---\n正文')).toThrow(/键值对/);
  });
});

describe('PersonaStore', () => {
  it('放进目录就能选，_ 开头和坏文件不算人设，坏文件只警告一次', () => {
    const { dir, open, warn } = setup();
    const store = open();
    expect(store.list()).toEqual([]);
    writeFileSync(join(dir, 'maid.md'), '---\nname: 女仆\n---\n女仆正文');
    writeFileSync(join(dir, '_common.md'), '共用规则');
    writeFileSync(join(dir, 'broken.md'), '   ');
    writeFileSync(join(dir, 'note.txt'), '不是人设');
    expect(store.list().map((persona) => persona.id)).toEqual(['maid']);
    store.list();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(store.find('女仆')?.id).toBe('maid');
    expect(store.find('maid')?.name).toBe('女仆');
    expect(store.find('../maid')).toBeUndefined();
  });

  it('按群选择并持久化，别的群不受影响', () => {
    const { dir, open } = setup();
    writeFileSync(join(dir, 'maid.md'), '女仆正文');
    const store = open();
    expect(store.currentId('g1')).toBe(DEFAULT_PERSONA_ID);
    store.select('g1', 'maid');
    expect(store.current('g1')?.prompt).toBe('女仆正文');
    expect(store.current('g2')).toBeUndefined();
    expect(open().currentId('g1')).toBe('maid');
    store.select('g1', DEFAULT_PERSONA_ID);
    expect(open().current('g1')).toBeUndefined();
  });

  it('选中的文件被删后回到默认人设', () => {
    const { dir, open } = setup();
    const file = join(dir, 'maid.md');
    writeFileSync(file, '女仆正文');
    const store = open();
    store.select('g1', 'maid');
    writeFileSync(file, '');
    expect(store.currentId('g1')).toBe(DEFAULT_PERSONA_ID);
  });

  it('按群和人设记会话并持久化', () => {
    const { open } = setup();
    const store = open();
    store.rememberSession('g1', 'maid', 's1');
    expect(open().sessionFor('g1', 'maid')).toBe('s1');
    expect(store.sessionFor('g1', DEFAULT_PERSONA_ID)).toBeUndefined();
    expect(store.sessionFor('g2', 'maid')).toBeUndefined();
  });
});
