import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { memberIdsFor, normalizeAlias, SenderAliasStore } from './sender-alias.ts';

const A = 'E4F4AEA33253A2797FB897C50B81D7ED';
const B = '5CA9498C76494A478EA5F9342725E63A';
const C = '0B1C2D3E4F5061728394A5B6C7D8E9F0';

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'sender-alias-'));
}

describe('SenderAliasStore', () => {
  it('按第一次出现的顺序分配 U1、U2…，同一个人再出现时别名不变', () => {
    const store = new SenderAliasStore(freshDir());
    expect(store.aliasFor('app', 'G1', A)).toBe('U1');
    expect(store.aliasFor('app', 'G1', B)).toBe('U2');
    expect(store.aliasFor('app', 'G1', A)).toBe('U1');
    expect(store.aliasFor('app', 'G1', C)).toBe('U3');
  });

  it('重启（新实例读同一目录）后别名不变，新成员接着往后编号', () => {
    const dir = freshDir();
    const first = new SenderAliasStore(dir);
    first.aliasFor('app', 'G1', A);
    first.aliasFor('app', 'G1', B);

    const restarted = new SenderAliasStore(dir);
    expect(restarted.aliasFor('app', 'G1', B)).toBe('U2');
    expect(restarted.aliasFor('app', 'G1', A)).toBe('U1');
    expect(restarted.aliasFor('app', 'G1', C)).toBe('U3');
    expect(restarted.resolve('app', 'G1', 'U2')).toBe(B);
  });

  it('不同群各自编号，互不影响；不同 appId 也分开', () => {
    const store = new SenderAliasStore(freshDir());
    store.aliasFor('app', 'G1', A);
    store.aliasFor('app', 'G1', B);
    expect(store.aliasFor('app', 'G2', B)).toBe('U1');
    expect(store.aliasFor('app', 'G2', A)).toBe('U2');
    expect(store.resolve('app', 'G1', 'U1')).toBe(A);
    expect(store.resolve('app', 'G2', 'U1')).toBe(B);
    expect(store.aliasFor('other', 'G1', C)).toBe('U1');
  });

  it('别名换回 openid：接受 U3 / #U3 / u3 / 带空格', () => {
    const store = new SenderAliasStore(freshDir());
    store.aliasFor('app', 'G1', A);
    store.aliasFor('app', 'G1', B);
    for (const v of ['U2', '#U2', 'u2', ' #u2 ', '# U2']) {
      expect(store.resolve('app', 'G1', v)).toBe(B);
    }
  });

  it('未知别名、陌生字符串返回 undefined；本群已知的 openid 原样放行（旧会话历史里还是 openid）', () => {
    const store = new SenderAliasStore(freshDir());
    store.aliasFor('app', 'G1', A);
    expect(store.resolve('app', 'G1', 'U9')).toBeUndefined();
    expect(store.resolve('app', 'G1', '阿乙')).toBeUndefined();
    expect(store.resolve('app', 'G1', C)).toBeUndefined();
    expect(store.resolve('app', 'G1', A)).toBe(A);
  });

  it('peekAlias 只查不分配', () => {
    const store = new SenderAliasStore(freshDir());
    expect(store.peekAlias('app', 'G1', A)).toBeUndefined();
    expect(store.aliasFor('app', 'G1', B)).toBe('U1');
  });

  it('表文件损坏时从空表开始，不抛错', () => {
    const dir = freshDir();
    writeFileSync(join(dir, 'app-G1.aliases.json'), '{not json', 'utf8');
    const store = new SenderAliasStore(dir);
    expect(store.aliasFor('app', 'G1', A)).toBe('U1');
    expect(JSON.parse(readFileSync(join(dir, 'app-G1.aliases.json'), 'utf8'))).toEqual({ aliases: { U1: A } });
  });
});

describe('normalizeAlias', () => {
  it('规范成 U<n>，不是别名写法返回 undefined', () => {
    expect(normalizeAlias('#u07')).toBe('U7');
    expect(normalizeAlias('U12')).toBe('U12');
    expect(normalizeAlias('U')).toBeUndefined();
    expect(normalizeAlias(A)).toBeUndefined();
  });
});

describe('memberIdsFor', () => {
  it('群会话按别名换算；私聊原样', () => {
    const store = new SenderAliasStore(freshDir());
    const ids = memberIdsFor(store, 'app');
    const group = { scope: 'group', peerId: 'G1' };
    expect(ids.display(group, A)).toBe('U1');
    expect(ids.toOpenid(group, 'U1')).toBe(A);
    expect(ids.toOpenid(group, 'U5')).toBeUndefined();
    const c2c = { scope: 'c2c', peerId: A };
    expect(ids.toOpenid(c2c, ` ${A} `)).toBe(A);
    expect(ids.display(c2c, A)).toBeUndefined();
  });
});
