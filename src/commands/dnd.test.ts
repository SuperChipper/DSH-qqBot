import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { dndCommand } from './dnd.ts';
import { DndService } from '../dnd/dnd-service.ts';
import { CampaignStore } from '../dnd/campaign.ts';
import { AdventureLibrary } from '../dnd/adventure.ts';

function setup(openCheckIn?: (...args: unknown[]) => Promise<boolean>) {
  const root = mkdtempSync(join(tmpdir(), 'dnd-cmd-'));
  const dndService = new DndService({ store: new CampaignStore(join(root, 'campaigns')), library: new AdventureLibrary(), mapDir: root });
  const dndButtons = openCheckIn === undefined ? undefined : { openCheckIn: vi.fn(openCheckIn) };
  const manager = { dndService, dndButtons, sessionKey: (s: string, id: string) => `${s}:${id}` };
  const cmd = dndCommand({ manager, config: {} } as never);
  const run = (raw: string, kind: 'group' | 'c2c' = 'group') => cmd.handler({
    message: { kind, groupOpenid: 'G1', senderId: 'U1', messageId: 'M1' },
    command: { raw },
  } as never);
  return { run, dndButtons };
}

describe('/dnd 子命令只认英文', () => {
  it('search / spells 可用，中文子命令不再认', async () => {
    const { run } = setup();
    expect(await run('search 火球术')).toContain('search=%E7%81%AB%E7%90%83%E6%9C%AF');
    expect(await run('spells 牧师')).toContain('牧师法表');
    expect(await run('查 火球术')).toContain('用法：');
    expect(await run('法表 牧师')).toContain('用法：');
    expect(await run('help')).not.toMatch(/\/dnd (查|法表|签到)/);
  });

  it('群里开团：开团文字交给签到消息一起发，命令本身不再回复', async () => {
    const { run, dndButtons } = setup(() => Promise.resolve(true));
    expect(await run('start sunken-bell')).toEqual({ kind: 'noop' });
    const [key, target, text, reset] = dndButtons!.openCheckIn.mock.calls[0]!;
    expect(key).toBe('group:G1');
    expect(target).toMatchObject({ scope: 'group', targetId: 'G1', msgId: 'M1' });
    expect(text).toContain('🎲 开团');
    expect(reset).toBe(true);
  });

  it('按钮发不出去时退回纯文字；私聊不发签到', async () => {
    const failing = setup(() => Promise.resolve(false));
    expect(await failing.run('start sunken-bell')).toContain('🎲 开团');
    const dm = setup(() => Promise.resolve(true));
    expect(await dm.run('start sunken-bell', 'c2c')).toContain('🎲 开团');
    expect(dm.dndButtons!.openCheckIn).not.toHaveBeenCalled();
  });

  it('new 用 blank 不带旧角色卡', async () => {
    const { run } = setup();
    expect(await run('new sunken-bell blank', 'c2c')).toContain('🎲 开团');
  });
});
