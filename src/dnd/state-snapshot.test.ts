import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { AdventureLibrary } from './adventure.ts';
import { CampaignStore, addSummary, applyDamage, startInitiative, upsertCharacter } from './campaign.ts';
import { DndService } from './dnd-service.ts';
import { dndStateText, isRuntimeContextEvent, promptEpoch } from '../session/session-manager.ts';
import type { DshAgent, SessionRecord } from '../session/index.ts';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'dnd-snapshot-'));
  const service = new DndService({ store: new CampaignStore(join(root, 'campaigns')), library: new AdventureLibrary(), mapDir: root });
  const key = 'qqbot:app:group:G1';
  service.start(key, 'sunken-bell', false);
  service.store.update(key, (c) => {
    upsertCharacter(c, { name: '卡厄斯', maxHp: 12 });
    upsertCharacter(c, { name: '巨鼠1', kind: 'monster', maxHp: 7, room: c.currentRoom });
  });
  return { service, key };
}

describe('团况快照', () => {
  it('扣血、推进回合只改快照，system prompt 一个字不变（否则后面的历史全部失去缓存）', () => {
    const { service, key } = setup();
    const sections = service.promptSections(key);
    const snapshot = service.stateSnapshot(key);

    service.store.update(key, (c) => {
      startInitiative(c, () => 10);
      applyDamage(c, '巨鼠1', 3);
    });

    expect(service.promptSections(key)).toEqual(sections);
    const after = service.stateSnapshot(key);
    expect(after).not.toBe(snapshot);
    expect(after).toContain('战斗第 1 轮');
  });

  it('局面没变时快照文字不变：宿主据此不追加新消息', () => {
    const { service, key } = setup();
    expect(service.stateSnapshot(key)).toBe(service.stateSnapshot(key));
  });

  it('快照放会变的团况，上次进度和守则留在 system prompt', () => {
    const { service, key } = setup();
    service.store.update(key, (c) => addSummary(c, '队伍在门口'));
    const system = service.promptSections(key).map((s) => s.text).join('\n');
    const snapshot = service.stateSnapshot(key);
    expect(system).toContain('上次进度：队伍在门口');
    expect(system).toContain('Current runtime context');
    expect(system).not.toContain('【团况 · DM 视角】\n');
    expect(snapshot).toContain('【团况 · DM 视角】');
    expect(snapshot).not.toContain('上次进度');
  });

  it('结团后快照为空：宿主会发一条作废旧快照的消息', () => {
    const { service, key } = setup();
    service.stop(key);
    expect(service.stateSnapshot(key)).toBe('');
  });
});

describe('system prompt 背景按 epoch 锁住', () => {
  const background = (service: DndService, key: string, epoch?: string) =>
    service.promptSections(key, epoch).find((s) => s.name === 'qqbot:dnd-background')?.text ?? '';

  it('存档不改 system prompt（模型刚写过，在对话里），压缩后 epoch 变了才换新', () => {
    const { service, key } = setup();
    service.store.update(key, (c) => addSummary(c, '第一版进度'));
    const first = service.promptSections(key, 's:0');
    service.store.update(key, (c) => addSummary(c, '第二版进度'));
    expect(service.promptSections(key, 's:0')).toEqual(first);
    expect(service.stateSnapshot(key)).not.toContain('第二版进度');
    expect(background(service, key, 's:1')).toContain('第二版进度');
  });

  it('开团时还没有存档：第一次存档也不让 system prompt 变', () => {
    const { service, key } = setup();
    const first = service.promptSections(key, 's:0');
    service.store.update(key, (c) => addSummary(c, '第一版进度'));
    expect(service.promptSections(key, 's:0')).toEqual(first);
  });

  it('换场景后 system prompt 不变，新规则写进快照', () => {
    const root = mkdtempSync(join(tmpdir(), 'dnd-snapshot-'));
    const service = new DndService({ store: new CampaignStore(join(root, 'campaigns')), library: new AdventureLibrary(), mapDir: root });
    const key = 'qqbot:app:group:G2';
    service.start(key, 'sunken-bell', false);
    const adventure = service.require(key).adventure;
    adventure.sites[0]!.features = '旧场景规则';
    const first = service.promptSections(key, 's:0');
    adventure.sites[0]!.features = '新场景规则';
    expect(service.promptSections(key, 's:0')).toEqual(first);
    expect(service.stateSnapshot(key)).toContain('新场景规则');
    expect(service.stateSnapshot(key)).not.toContain('旧场景规则');
    expect(background(service, key, 's:1')).toContain('新场景规则');
    expect(service.stateSnapshot(key)).not.toContain('新场景规则');
  });

  it('重新开团不沿用上一次锁住的进度', () => {
    const { service, key } = setup();
    service.store.update(key, (c) => addSummary(c, '旧进度'));
    service.promptSections(key, 's:0');
    service.stop(key);
    service.start(key, 'sunken-bell', false);
    service.store.update(key, (c) => addSummary(c, '新进度'));
    expect(background(service, key, 's:0')).toContain('新进度');
  });
});

describe('promptEpoch', () => {
  const recordOf = (session: object) => ({ agent: { session } }) as unknown as SessionRecord;

  it('由会话和 contentGeneration 决定；宿主没暴露时按 0', () => {
    expect(promptEpoch(recordOf({ id: 's', surface: { contentGeneration: 3 } }))).toBe('s:3');
    expect(promptEpoch(recordOf({ id: 's' }))).toBe('s:0');
  });
});

describe('dndStateText', () => {
  const agent = {} as DshAgent;
  const record = { sessionKey: 'k' } as SessionRecord;

  it('按 agent 找到会话取快照', () => {
    const dnd = { stateSnapshot: vi.fn(() => '团况') };
    expect(dndStateText(agent, () => record, dnd, logger as never)).toBe('团况');
    expect(dnd.stateSnapshot).toHaveBeenCalledWith('k');
  });

  it('没有 agent、不是 QQ 会话（如子 agent）、没启用跑团都返回空串', () => {
    const dnd = { stateSnapshot: vi.fn(() => '团况') };
    expect(dndStateText(undefined, () => record, dnd, logger as never)).toBe('');
    expect(dndStateText(agent, () => undefined, dnd, logger as never)).toBe('');
    expect(dndStateText(agent, () => record, undefined, logger as never)).toBe('');
    expect(dnd.stateSnapshot).not.toHaveBeenCalled();
  });

  it('读团档出错不影响这次请求', () => {
    const dnd = { stateSnapshot: () => { throw new Error('坏档'); } };
    expect(dndStateText(agent, () => record, dnd, logger as never)).toBe('');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('坏档'));
  });
});

describe('isRuntimeContextEvent', () => {
  it('认得宿主事件形态（source 在 data 上）和 message 形态', () => {
    expect(isRuntimeContextEvent({ type: 'user/message', data: { source: { kind: 'runtime-context' } } })).toBe(true);
    expect(isRuntimeContextEvent({ type: 'user/message', message: { source: { kind: 'runtime-context' } } })).toBe(true);
  });

  it('玩家消息不算', () => {
    expect(isRuntimeContextEvent({ type: 'user/message', data: { source: { kind: 'user' } } })).toBe(false);
    expect(isRuntimeContextEvent({ type: 'user/message', message: { content: [] } })).toBe(false);
  });
});
