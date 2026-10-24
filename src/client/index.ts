/**
 * im-qqbot 浏览器半边 —— QQ Bot 端内扫码绑定入口
 *
 * 宿主插件在凭据缺失时注册 /qqbot/im-qqbot/bind 状态路由；本插件在
 * Web / Desktop 提供两个展示位：
 *
 * 1. 设置页「QQ Bot」栏目（settings.section 席位）——注册即展示，
 *    无 Session surface 时序依赖，待绑定/已绑定状态常驻可见；
 * 2. 右侧栏「QQ Bot 绑定」页（sidebarRightTabs）——Start 页入口 +
 *    待绑定时自动打开（失败随轮询重试）。
 *
 * 运行时依赖仅 react（客户端平台种子表提供）；宿主服务经 cordis inject
 * 声明访问（声明缺失时插件保持 inactive，不阻塞浏览器启动）。
 */
import type { Context } from '@deepseek-ai/cordis';
import { createElement, type ReactNode } from 'react';
import { BIND_STATE_PATH } from '../shared/bind-protocol.ts';
import { BindPanelBody } from './bind-page.ts';
import { ConfigPanel } from './config-panel.ts';

export const name = 'im-qqbot-client';
export const inject = ['slots', 'sidebarRight', 'sidebarRightTabs'];

/** 侧栏 Tab 类型（ui-sidebar-right 契约的局部投影） */
const TAB_KIND = 'qqbot-bind';
/** 席位注册 key（Tab 类型 id，席位按其分发；只需全局唯一，与包名解耦） */
const TAB_ID = 'im-qqbot/bind';

/** ui-sidebar-right 的 Tab 注册表服务（局部投影） */
interface TabRegistryLike {
  register(definition: {
    id: string;
    kind: string;
    title: (address: string) => string;
    guide?: ReadonlyArray<{
      id: string;
      order: number;
      title: () => string;
      description: () => string;
      icon: unknown;
    }>;
  }): () => void;
}

/** ui-sidebar-right 的导航控制器服务（局部投影） */
interface SidebarRightLike {
  openTab(kind: string, options?: Record<string, unknown>): unknown;
}

/** ui-slots 的席位系统服务（局部投影） */
interface SlotsLike {
  inject(slotName: string, register: () => (() => void)): () => void;
  register(spec: Record<string, unknown>, component: unknown): () => void;
}

/** 绑定入口图标（QQ 机器人，跟随主题图标色变量） */
function BindGuideIcon(): ReactNode {
  return createElement('svg', {
    width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true,
  },
    createElement('path', {
      d: 'M9.50039 11.1504C9.96983 11.1504 10.3504 11.5309 10.3504 12.0004V14.0004C10.3504 14.4698 9.96983 14.8504 9.50039 14.8504C9.03095 14.8504 8.65039 14.4698 8.65039 14.0004V12.0004C8.65039 11.5309 9.03095 11.1504 9.50039 11.1504Z',
      fill: 'var(------icon_primary, #1A1A1A)',
    }),
    createElement('path', {
      d: 'M14.5004 11.1504C14.9698 11.1504 15.3504 11.5309 15.3504 12.0004V14.0004C15.3504 14.4698 14.9698 14.8504 14.5004 14.8504C14.0309 14.8504 13.6504 14.4698 13.6504 14.0004V12.0004C13.6504 11.5309 14.0309 11.1504 14.5004 11.1504Z',
      fill: 'var(------icon_primary, #1A1A1A)',
    }),
    createElement('path', {
      fillRule: 'evenodd',
      clipRule: 'evenodd',
      d: 'M12.8504 5.3109C13.5299 4.99138 14.0004 4.30063 14.0004 3.5C14.0004 2.39543 13.1049 1.5 12.0004 1.5C10.8958 1.5 10.0004 2.39543 10.0004 3.5C10.0004 4.30065 10.4708 4.99141 11.1504 5.31092V6.18851C6.38487 6.61795 2.65039 10.6231 2.65039 15.5004V17.0004C2.65039 19.679 4.82181 21.8504 7.50039 21.8504H16.5004C19.179 21.8504 21.3504 19.679 21.3504 17.0004V15.5004C21.3504 10.6231 17.6159 6.61795 12.8504 6.18851V5.3109ZM12.0004 7.85039C7.77541 7.85039 4.35039 11.2754 4.35039 15.5004V17.0004C4.35039 18.7401 5.76069 20.1504 7.50039 20.1504H16.5004C18.2401 20.1504 19.6504 18.7401 19.6504 17.0004V15.5004C19.6504 11.2754 16.2254 7.85039 12.0004 7.85039Z',
      fill: 'var(------icon_primary, #1A1A1A)',
    }),
  );
}

/** 设置页「QQ Bot」栏目：面板常驻展示绑定状态 */
function QQBotSettingsSection(): ReactNode {
  return createElement('div', null,
    createElement(BindPanelBody),
    createElement(ConfigPanel),
  );
}

export function apply(ctx: Context): void {
  const tabs = (ctx as unknown as { sidebarRightTabs?: TabRegistryLike }).sidebarRightTabs;
  const right = (ctx as unknown as { sidebarRight?: SidebarRightLike }).sidebarRight;
  const slots = (ctx as unknown as { slots?: SlotsLike }).slots;

  const disposers: Array<() => void> = [];

  // 1. 设置页「QQ Bot」栏目（主展示位：注册即展示，无时序依赖）
  if (slots !== undefined) {
    disposers.push(    slots.inject('settings.section', () => slots.register(
      { name: 'settings.section', id: 'qqbot', order: 7, label: 'QQ 机器人' },
      QQBotSettingsSection,
    )));
  }

  // 2. 侧栏绑定页（快捷展示位：Start 页入口 + 待绑定自动打开）
  if (tabs !== undefined && slots !== undefined) {
    disposers.push(tabs.register({
      id: TAB_ID,
      kind: TAB_KIND,
      title: () => 'QQ 机器人绑定',
      guide: [{
        id: 'bind',
        order: 90,
        title: () => 'QQ 机器人绑定',
        description: () => '扫码或手动填写，绑定 QQ 机器人',
        icon: BindGuideIcon,
      }],
    }));
    disposers.push(slots.inject('sidebar.right.pane.tab', () => slots.register(
      { name: 'sidebar.right.pane.tab', key: TAB_ID },
      BindPanelBody,
    )));
    // 待绑定检测与自动引导
    disposers.push(watchAndPrompt(right));
  }

  (ctx as unknown as { effect(fn: () => () => void, name?: string): void }).effect(() => () => {
    for (const dispose of disposers.reverse()) dispose();
  }, 'im-qqbot-client.binding');
}

/**
 * 轮询绑定状态：待绑定时自动打开绑定页。
 *
 * - 页面隐藏时降频轮询（可见时立即恢复节拍）
 * - 404（已绑定/未安装）时退避到 30s，保持低成本常驻探测
 * - 每次页面加载至多打开一次（用户手动关闭后不打扰）；
 *   打开失败（如启动早期 Session surface 尚未挂载）不消费机会，
 *   由下一轮轮询（3s）自动重试
 */
function watchAndPrompt(right: SidebarRightLike | undefined): () => void {
  let stopped = false;
  let opened = right === undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (ms: number): void => {
    timer = setTimeout(() => { void tick(); }, ms);
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      schedule(5000);
      return;
    }
    try {
      const res = await fetch(BIND_STATE_PATH, { cache: 'no-store' });
      if (res.ok) {
        const body = (await res.json()) as { phase?: string };
        if (body.phase === 'waiting' && !opened && right !== undefined) {
          try {
            right.openTab(TAB_KIND);
            opened = true;
          } catch (err) {
            // 启动早期 Session surface 可能尚未挂载：保留机会，3s 后随轮询重试
            console.error('[im-qqbot] 打开绑定页失败，稍后重试', err);
          }
        }
        schedule(3000);
        return;
      }
      // 404：已绑定或插件未启用
      schedule(30000);
      return;
    } catch {
      // 宿主暂不可达（启动窗口期）：退避重试
    }
    schedule(10000);
  };

  void tick();
  return () => { stopped = true; if (timer !== undefined) clearTimeout(timer); };
}
