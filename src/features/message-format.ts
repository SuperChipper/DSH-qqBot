/**
 * 群聊消息里给模型看的发送者 / 时间标注。
 *
 * 入站组装（transport/inbound）、排队合并（gateway/middleware-setup）和 system prompt 共用这一套写法：
 * 三处各写各的时，合并消息里第一个发送者的后续行没有标签，模型就把它算到上一个人头上。
 * 标签里只放群内短别名（#U3，见 sender-alias），不放完整 openid；跑团 DM 守则和 dnd_* 工具的
 * declared_by / player_id 都按「#U 编号」取人，由工具换回 openid。
 */

/** 发送者标签：`[昵称 #U3]`；没有昵称时只有 `[#U3]` */
export function senderTag(alias: string, senderName?: string): string {
  const name = senderName?.trim();
  return name ? `[${name} #${alias}]` : `[#${alias}]`;
}

/** 给定群内别名函数，生成 openid → 标签 的函数 */
export type SenderLabeler = (senderId: string, senderName?: string) => string;

export function makeSenderLabeler(aliasOf: (senderId: string) => string): SenderLabeler {
  return (senderId, senderName) => senderTag(aliasOf(senderId), senderName);
}

/** 当前消息被 @ 的标记；跑团 DM 守则按它区分「行动宣告」和「插嘴」 */
export const MENTION_MARK = '(@you)';

/** 引用块开头：带上被引用那条的发送者标签，查不到时明说未知，免得模型把引用原文算到当前发言人头上 */
export function quoteHeader(senderLabel: string | undefined): string {
  return `[Quoted message from ${senderLabel ?? '未知发送者'}]`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * 消息时间：当天只写 HH:mm，跨天带上月-日（群记忆能回灌几天前的消息，只写钟点会让模型以为是刚才说的）。
 * 按本机时区，和群友看到的时间一致。无效时间返回空串，调用方据此省略。
 */
export function formatMessageTime(at: number | string | undefined, now: number = Date.now()): string {
  if (at === undefined || at === '') return '';
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date(now);
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const sameDay = date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate();
  return sameDay ? clock : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
}

/** 群聊 system prompt：说明消息里各个标注的含义 */
export const GROUP_MESSAGE_FORMAT_PROMPT = [
  '【群消息格式】',
  '群里每条消息前都有发送者标签「[昵称 #U3]」（没有昵称时只有「[#U3]」）。#U 编号是这个人在本群里固定的编号，不会变；昵称可能重名、改名或缺失。认人一律按 #U 编号，不按昵称。',
  '同一个 #U 编号就是同一个人，编号不同就是不同的人，哪怕昵称一样。称呼对方用昵称，别把编号念出来。',
  '一行一个标签；没有标签的续行属于它上面最近的那个标签。几个人排队的话被合并成一条时，每行按自己的标签算发送者。',
  '[Chat history begins] … [Chat history ends] 之间是之前的群聊记录，行首的「HH:mm」或「MM-DD HH:mm」是发送时间。',
  '[Current message] 下面那一条才是要你回复的消息；你的回复会自动发给它的发送者，不需要你写编号或 @ 谁。标签后带 (@you) 表示这个人 @ 了你，不带就是你随机冒泡或主动接话。',
  '[Quoted message from …] … [Quoted message ends] 是当前消息引用的那条，from 后面是被引用那条的发送者标签；写「未知发送者」时是没查到（多半是引用你自己之前发的话，或很早的消息），别凭内容硬猜是谁说的。',
  '工具参数要指定某个群成员时（如跑团的 declared_by、player_id），填他标签里的编号，例如 U3。',
].join('\n');
