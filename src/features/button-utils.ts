/**
 * 按钮渲染与 button_data 编码的共享工具（QuestionChannel / ApprovalChannel 共用）。
 *
 * 统一 button_data 编码：所有回调按钮的 data 都带顶层 `t` 判别字段，
 * 供 `dispatchInteraction` 分发器统一路由到对应 channel，避免多通道
 * 各自 try 导致误判。
 */
import type { InlineKeyboard } from '@tencent-connect/qqbot-nodejs';

/** QQ 按钮 label 有长度限制，超长截断（正文保留完整文本；多列布局下阈值更短） */
export const BUTTON_LABEL_MAX = 10;

/** 单选按钮每行个数（多列布局，减少选项多时的刷屏） */
export const BUTTONS_PER_ROW = 2;

/** 截断按钮 label，超长补省略号 */
export function buttonLabel(text: string | undefined): string {
  const s = String(text ?? '').trim();
  return s.length > BUTTON_LABEL_MAX ? s.slice(0, BUTTON_LABEL_MAX - 1) + '…' : s;
}

// ── button_data 统一编码 ──

/** 问答按钮：q=问题 id，i=选项下标 */
export interface QuestionButtonData {
  t: 'question';
  q: string;
  i: number;
}

/** 审批按钮：d=决策，n=这张卡片的 nonce（点击时要和等待中的审批对上） */
export interface ApprovalButtonData {
  t: 'approval';
  d: 'allow' | 'deny';
  n: string;
}

/**
 * 跑团按钮：a=动作（end 结束回合 / status 查看状态 / in 签到 / go 开场 / roster 发名单 / react 用反应 / pass 不用反应），
 * n=角色名，r=轮次，react/pass 时是待结算序号（防止点到过期的旧按钮），i=待结算名单里的下标
 */
export interface DndButtonData {
  t: 'dnd';
  a: 'end' | 'status' | 'in' | 'go' | 'roster' | 'react' | 'pass';
  n?: string;
  r?: number;
  i?: number;
}

/** 终端白名单确认按钮：p=待确认申请 id，d=决策（只认主人点击） */
export interface AccessButtonData {
  t: 'access';
  p: string;
  d: 'allow' | 'deny';
}

export interface BrowserAccessButtonData {
  t: 'browser-access';
  p: string;
  d: 'allow' | 'deny';
}

/** 人设卡片按钮：a=动作（use 切换 / page 翻页），p=人设 id，n=页码 */
export interface PersonaButtonData {
  t: 'persona';
  a: 'use' | 'page';
  p?: string;
  n?: number;
}

export type ButtonData = QuestionButtonData | ApprovalButtonData | DndButtonData | AccessButtonData | BrowserAccessButtonData | PersonaButtonData;

/** 编码 button_data（JSON 字符串） */
export function encodeButtonData(data: ButtonData): string {
  return JSON.stringify(data);
}

/** 解码 button_data；非法 JSON 或缺少合法 `t` 时返回 undefined */
export function decodeButtonData(raw: string): ButtonData | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<ButtonData>;
    if (parsed !== null && typeof parsed === 'object' && (parsed.t === 'question' || parsed.t === 'approval' || parsed.t === 'dnd' || parsed.t === 'access' || parsed.t === 'browser-access' || parsed.t === 'persona')) {
      return parsed as ButtonData;
    }
  } catch {
    // fall through
  }
  return undefined;
}

/** 构建内联键盘的行数组（供 buildKeyboard/buildApprovalKeyboard 复用类型） */
export type KeyboardRows = InlineKeyboard['content']['rows'];
