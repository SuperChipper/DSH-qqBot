import { describe, it, expect } from 'vitest';
import { findDmSecret } from './campaign-secrets.ts';

const monsters = ['水池地精3', '红标恶棍1', '红标恶棍3', '巨鼠'];

describe('findDmSecret', () => {
  it('DC 数值、点名 DM 笔记/机密被拦', () => {
    expect(findDmSecret('门锁 DC 15 才开得了', monsters)).toBe('含有 DC 数值');
    expect(findDmSecret('潜行 dc:12', monsters)).toBe('含有 DC 数值');
    expect(findDmSecret('DM 笔记：地窖里还有两个人', monsters)).toBe('含有 DM 笔记/机密内容');
    expect(findDmSecret('（勿念）箱子是空的', monsters)).toBe('含有 DM 笔记/机密内容');
  });

  it('怪物的 HP/AC 数值被拦，编号不同也算同一种怪', () => {
    expect(findDmSecret('- 红标恶棍2 还剩 HP 4', monsters)).toBe('含有「红标恶棍」的 HP/AC 数值');
    expect(findDmSecret('巨鼠 AC 12，生命值 7', monsters)).toBe('含有「巨鼠」的 HP/AC 数值');
  });

  it('玩家角色的 HP/AC、不带数值的 DC/AC 字样、已发现的暗门照常可记', () => {
    expect(findDmSecret('卡厄斯 HP 20/20 AC 18；恩佐 AC 14', monsters)).toBeUndefined();
    expect(findDmSecret('旧教训：不报 DC/AC/怪物 HP', monsters)).toBeUndefined();
    expect(findDmSecret('刻德温发现了地窖的暗门；红标恶棍1 已被击败', monsters)).toBeUndefined();
    expect(findDmSecret('# 沉钟修道院跑团 · DM 操作约定', monsters)).toBeUndefined();
  });

  it('点名玩家角色的行里的法术豁免 DC 放行；门锁、陷阱 DC，同行有怪物或没点名角色仍拦', () => {
    const pcs = ['维斯珀', '卡厄斯'];
    expect(findDmSecret('- 维斯珀 游侠2：感知施法 DC12/攻击+4\n- 卡厄斯 圣武士2：魅力 DC13', monsters, pcs)).toBeUndefined();
    expect(findDmSecret('卡厄斯 撬门，门锁 DC 15', [], pcs)).toBe('含有 DC 数值');
    expect(findDmSecret('卡厄斯 面对巨鼠的毒 DC 11', monsters, pcs)).toBe('含有 DC 数值');
    expect(findDmSecret('门锁 DC 15', monsters, pcs)).toBe('含有 DC 数值');
  });

  it('怪物 HP 和名字不在同一行不算', () => {
    expect(findDmSecret('红标恶棍1 跑了\n卡厄斯 HP 9', monsters)).toBeUndefined();
  });
});
