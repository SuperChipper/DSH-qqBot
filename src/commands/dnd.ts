/**
 * 跑团命令：/dnd — 开团、结团、看团况、列地城
 *
 * 开团后这个会话每回合注入 DM 守则和团况，模型用 dnd_* 工具裁定；结团后恢复普通聊天。
 */
import type { CommandDeps, CategorizedCommand } from './types.ts';
import { getScopePeer } from '../shared/index.ts';
import { playerStatus } from '../dnd/campaign.ts';

const USAGE = [
  '用法：',
  '/dnd start [地城id] — 开团（同一地城的旧团会接着跑）',
  '/dnd new [地城id] — 存档旧团，从头开新团',
  '/dnd status — 看团况',
  '/dnd end — 暂停（让 DM 写摘要请直接说「今天先到这」）',
  '/dnd dungeons — 列出可用地城',
  '/dnd 查 <词条> — 查 wiki（法术、技能、职业、专长、怪物…），如 /dnd 查 火球术',
  '/dnd 法表 [职业] — 职业法术列表，如 /dnd 法表 牧师',
  '/dnd help — 怎么玩',
].join('\n');

const RULES_WIKI = 'https://dnd.huijiwiki.com/wiki/';

/**
 * 灰机 wiki 查询链接。wiki 前面有 Cloudflare 验证，机器人抓不到正文，只发链接：
 * MediaWiki 搜索词和标题完全一致时会直接跳到词条页，否则给搜索结果。
 */
export function wikiSearchUrl(query: string): string {
  return `https://dnd.huijiwiki.com/index.php?search=${encodeURIComponent(query.trim())}`;
}

const SPELL_CLASSES = ['吟游诗人', '牧师', '德鲁伊', '圣武士', '游侠', '术士', '邪术师', '法师', '奇械师'];

const HELP = [
  '🎲 跑团怎么玩',
  '',
  '【说行动】',
  '· 要 @我，并说清角色做什么：「卡厄斯用巨剑砍地精3」「恩佐潜行到门口听动静」。',
  '· 不 @ 的话、吐槽、问规则、「查询状态」都不算行动，不会掷骰也不消耗动作。',
  '· 只能控制自己的角色。想让别人做什么，跟他本人说。',
  '· 骰子都由我掷，点数会写出来；DC、怪物 AC 和血量不报，只说伤势。',
  '',
  '【战斗】',
  '· 按先攻顺序来，轮到你时我会发一条带按钮的消息。',
  '· 动作、附赠动作、移动都说完了，点「结束回合」。只有这个角色的玩家本人点才算。',
  '· 「查看状态」：看大家的血量、资源和行动顺序。',
  '· 没轮到你就先说，我记下来，等你的回合再结算。借机攻击、反应随时可以喊。',
  '',
  '【分头行动】',
  '· 只有说了要去的人才会过去，其他人留在原地。',
  '',
  '【资源与休息】',
  '· 法术位、圣疗、诗人激励、生命骰都有记录，用之前说一声「用掉 xx」。',
  '· 「短休」「长休」直接说，我会结算。',
  '',
  '【判错了】',
  '· 大家同意的话说「卷回到 xx 之前」，我会把状态回滚，不会硬改数字。',
  '',
  '【查规则】',
  '· /dnd 查 火球术：给出 wiki 词条链接，法术、技能、职业特性、专长、怪物都能查。',
  '· /dnd 法表 牧师：职业法术列表。',
  '· 回合按钮里的「查询」会在输入框里预填 /dnd 查。',
  `· wiki 首页：${RULES_WIKI}`,
  '',
  '命令：/dnd start｜new｜status｜end｜dungeons｜查｜法表｜help',
].join('\n');

export function dndCommand({ manager }: CommandDeps): CategorizedCommand {
  return {
    name: 'dnd',
    category: 'qqbot',
    description: '跑团：开团/结团/团况/玩法说明（用法: /dnd start|new|status|end|dungeons|help）',
    handler: async (cmdCtx) => {
      const service = manager.dndService;
      if (service === undefined) return '跑团功能未启用（配置 dnd.enabled）';
      const { scope, peerId } = getScopePeer(cmdCtx);
      const key = manager.sessionKey(scope, peerId);
      const [sub = '', arg, ...more] = (cmdCtx.command?.raw ?? '').trim().split(/\s+/);
      const rest = [arg, ...more].filter((s): s is string => s !== undefined && s.length > 0).join(' ');

      // 查规则不需要开团，也不需要启用跑团服务之外的东西
      if (sub === '查' || sub === 'wiki' || sub === 'search') {
        if (rest.length === 0) return `用法：/dnd 查 <词条>，如 /dnd 查 火球术\nwiki 首页：${RULES_WIKI}`;
        return `📖 ${rest}：${wikiSearchUrl(rest)}`;
      }
      if (sub === '法表' || sub === 'spells') {
        if (rest.length === 0) {
          return ['📖 职业法表（点开是 wiki 搜索，标题对上会直接跳到词条页）：', ...SPELL_CLASSES.map((cls) => `${cls}：${wikiSearchUrl(`${cls}法术列表`)}`)].join('\n');
        }
        return `📖 ${rest}法表：${wikiSearchUrl(`${rest}法术列表`)}`;
      }

      if (sub === 'dungeons') {
        return ['可用地城：', ...service.library.list().map((d) => `- ${d.id}：${d.name}（${d.rooms.length} 个房间）`)].join('\n');
      }

      if (sub === 'start' || sub === 'new') {
        try {
          const { dungeon, resumed, campaign } = service.start(key, arg, sub === 'new');
          const party = campaign.characters.filter((ch) => ch.kind === 'pc').map((ch) => ch.name);
          const lines = [
            `🎲 ${resumed ? '继续' : '开团'}：${dungeon.name}`,
            resumed ? `队伍：${party.join('、') || '还没有角色'}` : dungeon.hook,
            '',
            scope === 'group' ? '跑团期间 @ 我说你的行动；还没有角色的先 @ 我说名字和职业来建卡。' : '直接说你的行动；还没有角色就先告诉我名字和职业。',
          ];
          return lines.join('\n');
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      }

      if (sub === 'end') {
        const stopped = service.stop(key);
        return stopped === undefined ? '现在没有进行中的团。' : '⏸ 已暂停，进度和角色卡都保存了。下次 /dnd start 接着跑。';
      }

      if (sub === 'status') {
        const found = service.active(key);
        if (found === undefined) return '现在没有进行中的团。';
        return `🎲 ${found.dungeon.name}\n${playerStatus(found.campaign, found.dungeon)}`;
      }

      if (sub === 'help') return HELP;

      return USAGE;
    },
  };
}
