/**
 * QQ 机器人配置面板 — 必要配置的 UI 编辑
 *
 * UI 复刻 DSW 通用设置（settings-form 原语）的视觉风格：
 * 左对齐设置列、0.5px 行分隔、label 13px/500、控件右置；
 * Switch 为 36×20 aria-checked 结构（thumb translateX 动画）；
 * 三值选择用分段控件（滑动指示器按段数/索引的 CSS 变量定位）；
 * 保存按钮为 DSW 反色主按钮（label-primary 底 + bg-layer-3 字）。
 *
 * 数据流：GET /qqbot/im-qqbot/config 回显当前生效配置（appSecret
 * 已由宿主剔除）→ 表单编辑 → dirty diff → POST 仅提交变更键 →
 * 宿主白名单 + Schema 校验 → 最小写入 profile patch → HMR 重载生效。
 *
 * 字段策略：只开放用户必要的配置；cwd 只读展示；超时与性能调优
 * 类字段走 profile patch / 环境变量。
 */
import { createElement, useCallback, useEffect, useState, type CSSProperties, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import { BIND_CONFIG_PATH } from '../shared/bind-protocol.ts';
import type { BrowserConfig } from '../config.ts';

/** 访问控制配置（与 src/config.ts 的 AccessControlConfig 对应的局部投影） */
interface AccessControlWire {
  c2cMode: 'open' | 'allowlist' | 'disabled';
  c2cAllow: string[];
  groupMode: 'open' | 'allowlist' | 'disabled';
  groupAllow: string[];
}

/** 文件访问白名单（与 src/config.ts 的 FileAccessConfig 对应） */
interface FileAccessWire {
  ownerOnly: boolean;
  extraAllow: string[];
  sensitivePaths: string[];
}

/** 表情收藏配置（与 src/config.ts 的 StickersConfig 对应的局部投影） */
interface StickersWire {
  enabled: boolean;
  root: string;
  extraRoots: string[];
  maxBytes: number;
  maxAutoEntries: number;
}

/** 富媒体理解（与 src/config.ts 的 MediaConfig 对应） */
interface MediaWire {
  enabled: boolean;
  maxMB: number;
  ttlHours: number;
  maxTotalMB: number;
}

/** 视觉理解（与 src/config.ts 的 VisionConfig 对应；apiKey 不涉及） */
interface VisionWire {
  enabled: boolean;
  native: boolean;
  provider: string;
  model: string;
  defaultPrompt: string;
  maxBytes: number;
  maxTokens: number;
  timeoutMs: number;
}

/** 在线语音识别（与 src/config.ts 的 AsrConfig 对应；apiKey 走环境变量/patch，不进表单） */
interface AsrWire {
  enabled: boolean;
  baseUrl: string;
  model: string;
  preferQQ: boolean;
  timeoutMs: number;
  fallback?: AsrFallbackWire;
}

/** 语音识别备用接口（与 src/config.ts 的 AsrFallbackConfig 对应，不含 apiKey） */
interface AsrFallbackWire {
  enabled: boolean;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

/** 视频理解（与 src/config.ts 的 VideoConfig 对应） */
interface VideoWire {
  enabled: boolean;
  ffmpegPath: string;
  maxFrames: number;
  maxSeconds: number;
}

/** 附件发送（与 src/config.ts 的 SendFileConfig 对应） */
interface SendFileWire {
  restrictPaths: boolean;
  extraRoots: string[];
}

/** 语音合成（与 src/config.ts 的 SpeakConfig 对应） */
interface SpeakWire {
  enabled: boolean;
  voice: string;
  rate: string;
  maxChars: number;
  command: string;
  gsvUrl: string;
  gsvSpeed: number;
}

/** 共享笔记库（与 src/config.ts 的 NotesConfig 对应） */
interface NotesWire {
  enabled: boolean;
  root: string;
  autoInject: boolean;
  injectTopK: number;
  injectMaxChars: number;
  injectMinCoverage: number;
  /** 密钥不上表单（GET 回显为空，POST 由服务端回填） */
  semantic?: NotesSemanticWire;
}

/** 笔记语义检索（与 src/config.ts 的 NotesSemanticConfig 对应，不含 apiKey） */
interface NotesSemanticWire {
  enabled: boolean;
  baseUrl: string;
  model: string;
  minSimilarity: number;
  minMargin: number;
  timeoutMs: number;
}

/** 工具权限（与 src/config.ts 的 ToolAccessConfig 对应） */
interface ToolAccessWire {
  enabled: boolean;
  fullAccessGroups: string[];
  fullAccessUsers: string[];
  readRoots: string[];
}

/** 定期清理（rules 不在表单上，保存时由服务端保留旧值） */
interface CleanupWire {
  dryRun: boolean;
}

/** 搜图（与 src/config.ts 的 FanartConfig 对应） */
interface FanartWire {
  enabled: boolean;
  proxy: string;
  poolDir: string;
}

/** 跑团（与 src/config.ts 的 DndConfig 对应） */
interface DndWire {
  enabled: boolean;
  root: string;
  turnButtons: boolean;
  interjections: boolean;
}

/** 回复欲望的模型打分（与 src/config.ts 的 ReplyJudgeConfig 对应） */
interface ReplyJudgeWire {
  enabled: boolean;
  provider: string;
  model: string;
  reasoningEffort: string;
  debounceMs: number;
  maxWaitMs: number;
  contextMessages: number;
  timeoutMs: number;
}

/** 回复欲望门控（与 src/config.ts 的 ReplyDesireConfig 对应） */
interface ReplyDesireWire {
  enabled: boolean;
  threshold: number;
  names: string[];
  engagedMs: number;
  engagedMaxTurns: number;
  judge: ReplyJudgeWire;
}

/** 串模式（与 src/config.ts 的 BanterConfig 对应） */
interface BanterWire {
  enabled: boolean;
  groups: string[];
}

const REPLY_JUDGE_DEFAULTS: ReplyJudgeWire = {
  enabled: false, provider: '', model: '', reasoningEffort: '',
  debounceMs: 2500, maxWaitMs: 15000, contextMessages: 20, timeoutMs: 15000,
};

/** GET 回显的生效配置（appSecret / asr.apiKey 已剔除） */
type ConfigWire = {
  requireMention?: boolean;
  streaming?: boolean;
  showToolResults?: boolean;
  debug?: boolean;
  provider?: string;
  model?: string;
  preset?: string;
  groupPrompt?: string;
  directPrompt?: string;
  groupReplyProbability?: number;
  historyLimit?: number;
  sessionIdleTimeout?: number;
  textChunkLimit?: number;
  maxQueue?: number;
  processingTimeoutMs?: number;
  askTimeoutMs?: number;
  autoCompactTokens?: number;
  autoCompactPrivateRatio?: number;
  autoCompactDeferOnTools?: boolean;
  tmpDir?: string;
  tmpTtlHours?: number;
  tmpMaxTotalMB?: number;
  ownerOpenid?: string;
  adminOpenids?: string[];
  access?: AccessControlWire;
  fileAccess?: FileAccessWire;
  stickers?: StickersWire;
  notes?: NotesWire;
  toolAccess?: ToolAccessWire;
  media?: MediaWire;
  vision?: VisionWire;
  asr?: AsrWire;
  video?: VideoWire;
  sendFile?: SendFileWire;
  speak?: SpeakWire;
  cleanup?: CleanupWire;
  fanart?: FanartWire;
  browser?: BrowserConfig;
  dnd?: DndWire;
  replyDesire?: ReplyDesireWire;
  banter?: BanterWire;
  cwd?: string;
};

/** 样式注入标记（幂等） */
const STYLE_ID = 'im-qqbot-config-panel-styles';

/** DSW 通用设置风格（settings-form / Switch / SegmentedControl 原语复刻） */
function useConfigPanelStyles(): void {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ID) !== null) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
.imqb2-form { display: flex; flex-direction: column; width: 100%; }
.imqb2-group-title {
  padding: 14px 0 2px; font-size: 12px; font-weight: 600; line-height: 18px;
  color: var(--dsw-alias-label-tertiary); text-transform: uppercase; letter-spacing: .04em;
}
.imqb2-field { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; }
.imqb2-field + .imqb2-field { border-top: 0.5px solid var(--dsw-alias-border-l2); }
.imqb2-head { display: flex; align-items: center; gap: 8px; min-height: 28px; }
.imqb2-label {
  flex: 1; min-width: 0; font-size: 13px; font-weight: 500; line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.imqb2-help { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.imqb2-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
/* Switch（aria-checked 驱动，视觉态与无障碍态同源） */
.imqb2-switch {
  box-sizing: border-box; position: relative; flex: 0 0 auto;
  width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 999px;
  background: var(--dsw-alias-border-l3); cursor: pointer; font: inherit;
}
.imqb2-switch[aria-checked='true'] { background: var(--dsw-alias-brand-primary); }
.imqb2-switch:disabled { cursor: default; opacity: 0.5; }
.imqb2-switch:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.imqb2-switch-thumb {
  display: block; width: 16px; height: 16px; border-radius: 50%;
  background: var(--dsw-alias-switch-thumb, #ffffff);
  transition: transform 120ms ease;
}
.imqb2-switch[aria-checked='true'] .imqb2-switch-thumb {
  background: var(--dsw-alias-label-primary-foreground, #ffffff);
  transform: translateX(16px);
}
/* 输入（官方 fields.input 复刻） */
.imqb2-input {
  box-sizing: border-box; width: 100%; height: 34px; padding: 0 12px;
  border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-3); font: inherit; font-size: 13px; line-height: 1.5;
  color: var(--dsw-alias-label-primary); outline: none;
}
.imqb2-input:focus { outline: none; border-color: var(--dsw-alias-state-business-primary); }
.imqb2-input:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
.imqb2-textarea { height: auto; min-height: 68px; padding: 8px 12px; resize: vertical; line-height: 1.5; }
/* 分段控件（官方 SegmentedControl 复刻：指示器按段数/索引定位） */
.imqb2-seg {
  position: relative; display: inline-grid; grid-auto-flow: column; grid-auto-columns: 1fr;
  gap: 2px; padding: 4px; border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-interactive-bg-hover);
}
.imqb2-seg-indicator {
  position: absolute; top: 4px; left: 4px;
  width: calc((100% - 8px - 2px * (var(--imqb2-seg-count) - 1)) / var(--imqb2-seg-count));
  height: calc(100% - 8px);
  border: 0; border-radius: var(--dsw-radius-sm, 6px);
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--dsw-elevation-soft, 0 1px 3px rgba(0,0,0,.08));
  transform: translateX(calc(var(--imqb2-seg-index) * (100% + 2px)));
  transition: transform 160ms ease;
  pointer-events: none;
}
.imqb2-seg-tab {
  box-sizing: border-box; position: relative; z-index: 1; height: 28px; padding: 0 16px;
  border: 0; border-radius: var(--dsw-radius-sm, 6px); background: transparent;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; line-height: 20px;
  font-weight: 500; white-space: nowrap; cursor: pointer; transition: color 120ms ease;
}
.imqb2-seg-tab:hover, .imqb2-seg-tab[aria-selected='true'] { color: var(--dsw-alias-label-primary); }
.imqb2-seg-tab:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -2px;
}
/* 底栏（官方 SettingsForm.footer 复刻） */
.imqb2-footer { display: flex; align-items: center; gap: 8px; padding-top: 16px; }
.imqb2-note { flex: 1; min-width: 0; margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.imqb2-note--error { color: var(--dsw-alias-state-error-primary, var(--dsw-alias-label-error)); }
.imqb2-note--ok { color: var(--dsw-alias-label-secondary); }
.imqb2-save {
  appearance: none; flex: none; border: 1px solid transparent;
  border-radius: var(--dsw-radius-md, 8px); padding: 5px 14px;
  font: inherit; font-size: 13px; line-height: 1.5; cursor: pointer;
  background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-layer-3);
}
.imqb2-save:disabled { opacity: 0.4; cursor: default; }
.imqb2-save:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
}
/* cwd 只读行 */
.imqb2-readonly { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--dsw-alias-label-secondary); word-break: break-all; margin: 0; }
    `;
    document.head.appendChild(style);
    return () => { style.remove(); };
  }, []);
}

/** 开关（官方 Switch 原语结构：aria-checked 驱动视觉态） */
function Switch({ checked, label, onChange }: {
  checked: boolean; label: string; onChange: (next: boolean) => void;
}): ReactNode {
  return createElement('button', {
    type: 'button', role: 'switch', 'aria-checked': checked, 'aria-label': label,
    className: 'imqb2-switch',
    onClick: () => { onChange(!checked); },
  }, createElement('span', { className: 'imqb2-switch-thumb' }));
}

/** 访问模式分段选择（官方 SegmentedControl 结构：CSS 变量定位滑动指示器） */
function Segmented({ value, options, onChange, label }: {
  value: AccessMode; options: ReadonlyArray<{ value: AccessMode; label: string }>;
  onChange: (next: AccessMode) => void; label: string;
}): ReactNode {
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  const trackStyle = {
    '--imqb2-seg-count': options.length,
    '--imqb2-seg-index': index,
  } as CSSProperties;
  return createElement('div', { className: 'imqb2-seg', role: 'tablist', 'aria-label': label, style: trackStyle },
    createElement('span', { className: 'imqb2-seg-indicator' }),
    options.map((o) => createElement('button', {
      key: o.value, type: 'button', role: 'tab', 'aria-selected': o.value === value,
      className: 'imqb2-seg-tab', onClick: () => { onChange(o.value); },
    }, o.label)),
  );
}

/** 开关行（label 左 + Switch 右 + 可选 help） */
function SwitchRow({ label, help, checked, onChange }: {
  label: string; help?: string; checked: boolean; onChange: (next: boolean) => void;
}): ReactNode {
  return createElement('div', { className: 'imqb2-field' },
    createElement('div', { className: 'imqb2-head' },
      createElement('span', { className: 'imqb2-label' }, label),
      createElement(Switch, { checked, label, onChange }),
    ),
    help === undefined ? null : createElement('p', { className: 'imqb2-help' }, help),
  );
}

/** 文本行（label 上 + 输入下，与官方 fields 布局一致） */
function FieldRow({ label, help, value, placeholder, onChange }: {
  label: string; help?: string; value: string; placeholder?: string; onChange: (next: string) => void;
}): ReactNode {
  return createElement('div', { className: 'imqb2-field' },
    createElement('span', { className: 'imqb2-label' }, label),
    createElement('input', {
      className: 'imqb2-input', value, placeholder, spellCheck: false,
      onChange: (event: ChangeEvent<HTMLInputElement>) => { onChange(event.currentTarget.value); },
    }),
    help === undefined ? null : createElement('p', { className: 'imqb2-hint' }, help),
  );
}

/** 数字行（label 上 + number 输入下） */
function NumberRow({ label, help, value, min, max, step, onChange }: {
  label: string; help?: string; value: number; min?: number; max?: number; step?: number;
  onChange: (next: number) => void;
}): ReactNode {
  return createElement('div', { className: 'imqb2-field' },
    createElement('span', { className: 'imqb2-label' }, label),
    createElement('input', {
      className: 'imqb2-input', type: 'number', value, min, max, step,
      onChange: (event: ChangeEvent<HTMLInputElement>) => {
        const next = event.currentTarget.valueAsNumber;
        if (Number.isFinite(next)) onChange(next);
      },
    }),
    help === undefined ? null : createElement('p', { className: 'imqb2-hint' }, help),
  );
}

/** 多行文本行 */
function AreaRow({ label, help, value, rows, onChange }: {
  label: string; help?: string; value: string; rows?: number; onChange: (next: string) => void;
}): ReactNode {
  return createElement('div', { className: 'imqb2-field' },
    createElement('span', { className: 'imqb2-label' }, label),
    createElement('textarea', {
      className: 'imqb2-input imqb2-textarea', value, rows: rows ?? 3,
      onChange: (event: ChangeEvent<HTMLTextAreaElement>) => { onChange(event.currentTarget.value); },
    }),
    help === undefined ? null : createElement('p', { className: 'imqb2-hint' }, help),
  );
}

/** 列表行（每行一条；编辑期保留空行，提交时统一 trim/filter） */
function ListRow({ label, help, value, rows, onChange }: {
  label: string; help?: string; value: readonly string[]; rows?: number; onChange: (next: string[]) => void;
}): ReactNode {
  return createElement(AreaRow, {
    label, help, rows: rows ?? 2,
    value: value.join('\n'),
    onChange: (next: string) => { onChange(next.split('\n').map((line) => line.trim())); },
  });
}

/** 访问模式分段选择行 */
function SegmentedRow({ label, help, value, options, onChange }: {
  label: string; help?: string; value: AccessMode;
  options: ReadonlyArray<{ value: AccessMode; label: string }>; onChange: (next: AccessMode) => void;
}): ReactNode {
  return createElement('div', { className: 'imqb2-field' },
    createElement('div', { className: 'imqb2-head' },
      createElement('span', { className: 'imqb2-label' }, label),
      createElement(Segmented, { value, options, onChange, label }),
    ),
    help === undefined ? null : createElement('p', { className: 'imqb2-hint' }, help),
  );
}

type AccessMode = AccessControlWire['c2cMode'];

function BrowserSelectRow({ label, value, options, onChange }: {
  label: string; value: string; options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}): ReactNode {
  return createElement('label', { className: 'imqb2-field' },
    createElement('span', { className: 'imqb2-label' }, label),
    createElement('select', { value, onChange: (e: ChangeEvent<HTMLSelectElement>) => { onChange(e.target.value); } },
      options.map((o) => createElement('option', { key: o.value, value: o.value }, o.label))),
  );
}

const MODE_OPTIONS: ReadonlyArray<{ value: AccessMode; label: string }> = [
  { value: 'open', label: '所有人' },
  { value: 'allowlist', label: '白名单' },
  { value: 'disabled', label: '禁用' },
];

/** 深比较（表单值与初始回显值的 dirty 判断） */
function shallowEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 配置面板主体。
 *
 * 保存仅提交变更键（服务端按白名单合并），保存成功后提示
 * HMR 重载语义（进行中的机器人会话将重置）。
 */
export function ConfigPanel(): ReactNode {
  useConfigPanelStyles();
  const [initial, setInitial] = useState<ConfigWire | null>(null);
  const [form, setForm] = useState<ConfigWire | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    void fetch(BIND_CONFIG_PATH, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { config: ConfigWire };
        if (stopped) return;
        setInitial(body.config);
        setForm(body.config);
      })
      .catch((err: unknown) => {
        if (!stopped) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => { stopped = true; };
  }, []);

  const patch = useCallback(<K extends keyof ConfigWire>(key: K, value: ConfigWire[K]): void => {
    setForm((current) => current === null ? current : { ...current, [key]: value });
    setResult(null);
  }, []);

  const submit = useCallback((event: FormEvent): void => {
    event.preventDefault();
    if (busy || initial === null || form === null) return;
    const changed: Record<string, unknown> = {};
    for (const key of Object.keys(form) as Array<keyof ConfigWire>) {
      if (!shallowEqual(form[key], initial[key])) {
        changed[key] = form[key];
      }
    }
    if (Object.keys(changed).length === 0) return;

    // 白名单编辑期间保留原始换行/空行（textarea 可正常回车），提交时才规范化
    if (changed.adminOpenids !== undefined) {
      changed.adminOpenids = (changed.adminOpenids as string[]).map((s) => s.trim()).filter(Boolean);
    }
    if (changed.access !== undefined) {
      const a = changed.access as AccessControlWire;
      changed.access = {
        ...a,
        c2cAllow: a.c2cAllow.map((s) => s.trim()).filter(Boolean),
        groupAllow: a.groupAllow.map((s) => s.trim()).filter(Boolean),
      };
    }
    if (changed.fileAccess !== undefined) {
      const f = changed.fileAccess as FileAccessWire;
      changed.fileAccess = {
        ...f,
        extraAllow: f.extraAllow.map((s) => s.trim()).filter(Boolean),
        sensitivePaths: f.sensitivePaths.map((s) => s.trim()).filter(Boolean),
      };
    }
    if (changed.stickers !== undefined) {
      const s = changed.stickers as StickersWire;
      changed.stickers = { ...s, extraRoots: s.extraRoots.map((v) => v.trim()).filter(Boolean) };
    }
    if (changed.toolAccess !== undefined) {
      const t = changed.toolAccess as ToolAccessWire;
      changed.toolAccess = {
        ...t,
        fullAccessGroups: t.fullAccessGroups.map((v) => v.trim()).filter(Boolean),
        fullAccessUsers: t.fullAccessUsers.map((v) => v.trim()).filter(Boolean),
        readRoots: t.readRoots.map((v) => v.trim()).filter(Boolean),
      };
    }
    if (changed.sendFile !== undefined) {
      const s = changed.sendFile as SendFileWire;
      changed.sendFile = { ...s, extraRoots: s.extraRoots.map((v) => v.trim()).filter(Boolean) };
    }
    if (changed.replyDesire !== undefined) {
      const r = changed.replyDesire as ReplyDesireWire;
      changed.replyDesire = { ...r, names: r.names.map((v) => v.trim()).filter(Boolean) };
    }
    if (changed.banter !== undefined) {
      const b = changed.banter as BanterWire;
      changed.banter = { ...b, groups: b.groups.map((v) => v.trim()).filter(Boolean) };
    }

    setBusy(true);
    void fetch(BIND_CONFIG_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(changed),
    })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
        if (res.ok && body.ok === true) {
          setResult({ ok: true, message: body.message ?? '配置已保存，插件将自动重载' });
          setInitial(form);
          return;
        }
        setResult({ ok: false, message: body.error ?? `保存失败（HTTP ${res.status}）` });
      })
      .catch((err: unknown) => {
        setResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => { setBusy(false); });
  }, [busy, form, initial]);

  if (loadError !== null) {
    return createElement('p', { className: 'imqb2-hint', style: { padding: '12px 0' } },
      `配置加载失败：${loadError}`);
  }
  if (initial === null || form === null) {
    return createElement('p', { className: 'imqb2-hint', style: { padding: '12px 0' } }, '正在加载配置…');
  }

  const dirty = (Object.keys(form) as Array<keyof ConfigWire>).some((key) => !shallowEqual(form[key], initial[key]));
  const access: AccessControlWire = form.access ?? { c2cMode: 'open', c2cAllow: [], groupMode: 'open', groupAllow: [] };
  const fileAccess: FileAccessWire = form.fileAccess ?? { ownerOnly: true, extraAllow: [], sensitivePaths: [] };
  const media: MediaWire = form.media ?? { enabled: true, maxMB: 200, ttlHours: 24, maxTotalMB: 1024 };
  const vision: VisionWire = form.vision ?? {
    enabled: false, native: false, provider: '', model: '',
    defaultPrompt: 'Describe this image in detail.', maxBytes: 10 * 1024 * 1024, maxTokens: 1024, timeoutMs: 120000,
  };
  const asr: AsrWire = form.asr ?? {
    enabled: false, baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen3-ASR-1.7B', preferQQ: true, timeoutMs: 30000,
  };
  // 旧配置没有 fallback 组时按默认值显示
  const asrFallback: AsrFallbackWire = asr.fallback ?? {
    enabled: false, baseUrl: 'https://api.siliconflow.cn/v1', model: 'FunAudioLLM/SenseVoiceSmall', timeoutMs: 30000,
  };
  const video: VideoWire = form.video ?? { enabled: true, ffmpegPath: '', maxFrames: 8, maxSeconds: 300 };
  const notes: NotesWire = form.notes ?? {
    enabled: true, root: '', autoInject: true, injectTopK: 2, injectMaxChars: 600, injectMinCoverage: 0.4,
  };
  // 旧配置没有 semantic 组时按默认值显示
  const semantic: NotesSemanticWire = notes.semantic ?? {
    enabled: false, baseUrl: 'https://api.siliconflow.cn/v1', model: 'BAAI/bge-m3', minSimilarity: 0.5, minMargin: 0.16, timeoutMs: 3000,
  };
  const stickers: StickersWire = form.stickers ?? {
    enabled: true, root: '', extraRoots: [], maxBytes: 8 * 1024 * 1024, maxAutoEntries: 200,
  };
  const sendFile: SendFileWire = form.sendFile ?? { restrictPaths: true, extraRoots: [] };
  const speak: SpeakWire = form.speak ?? {
    enabled: true, voice: 'zh-CN-XiaoyiNeural', rate: '+8%', maxChars: 120, command: '', gsvUrl: '', gsvSpeed: 1.0,
  };
  const toolAccess: ToolAccessWire = form.toolAccess ?? {
    enabled: true, fullAccessGroups: [], fullAccessUsers: [], readRoots: [],
  };
  const cleanup: CleanupWire = form.cleanup ?? { dryRun: false };
  const fanart: FanartWire = form.fanart ?? { enabled: true, proxy: '', poolDir: '' };
  const browser: BrowserConfig = form.browser ?? {
    enabled: false, allowedGroups: [], mode: 'local', channel: 'chrome', userDataDir: '', headless: false,
    locale: 'zh-CN', timezoneId: 'Asia/Shanghai', timeoutMs: 30000, maxTextChars: 12000,
  };
  const dnd: DndWire = form.dnd ?? { enabled: true, root: '', turnButtons: true, interjections: true };
  const replyDesire: ReplyDesireWire = {
    enabled: false, threshold: 0.6, names: [], engagedMs: 90000, engagedMaxTurns: 8,
    ...form.replyDesire,
    judge: { ...REPLY_JUDGE_DEFAULTS, ...form.replyDesire?.judge },
  };
  const judge = replyDesire.judge;
  const patchJudge = (next: Partial<ReplyJudgeWire>): void => {
    patch('replyDesire', { ...replyDesire, judge: { ...judge, ...next } });
  };
  const banter: BanterWire = form.banter ?? { enabled: false, groups: [] };

  return createElement('form', { className: 'imqb2-form', onSubmit: submit },
    createElement('div', { className: 'imqb2-group-title' }, '服务范围'),
    createElement(SegmentedRow, {
      label: '私聊', value: access.c2cMode, options: MODE_OPTIONS,
      onChange: (v) => { patch('access', { ...access, c2cMode: v }); },
    }),
    access.c2cMode === 'allowlist'
      ? createElement(AreaRow, {
          label: '私聊白名单', help: '请输入用户 openid，多个请换行输入', rows: 3,
          value: access.c2cAllow.join('\n'),
          onChange: (v) => { patch('access', { ...access, c2cAllow: v.split('\n').map((s) => s.trim()) }); },
        })
      : null,
    createElement(SegmentedRow, {
      label: '群聊', value: access.groupMode, options: MODE_OPTIONS,
      onChange: (v) => { patch('access', { ...access, groupMode: v }); },
    }),
    access.groupMode === 'allowlist'
      ? createElement(AreaRow, {
          label: '群聊白名单', help: '请输入群 openid，多个请换行输入', rows: 3,
          value: access.groupAllow.join('\n'),
          onChange: (v) => { patch('access', { ...access, groupAllow: v.split('\n').map((s) => s.trim()) }); },
        })
      : null,

    createElement('div', { className: 'imqb2-group-title' }, '主人与文件访问'),
    createElement(FieldRow, {
      label: '主人 openid', value: form.ownerOpenid ?? '', placeholder: '留空表示未设置主人',
      help: '用于识别私聊主人；配合下方文件访问白名单限制敏感文件',
      onChange: (v) => { patch('ownerOpenid', v); },
    }),
    createElement(AreaRow, {
      label: '管理员 openid', help: '每行一个；除主人外，允许修改模型/preset 和点击审批按钮', rows: 2,
      value: (form.adminOpenids ?? []).join('\n'),
      onChange: (v) => { patch('adminOpenids', v.split('\n').map((s) => s.trim())); },
    }),
    createElement(SwitchRow, {
      label: '仅主人可访问文件', checked: fileAccess.ownerOnly,
      help: '开启后，只有主人私聊或额外允许的 openid 能收发本地文件',
      onChange: (v) => { patch('fileAccess', { ...fileAccess, ownerOnly: v }); },
    }),
    createElement(AreaRow, {
      label: '额外允许的 openid', help: '每行一个；这些用户也可访问文件', rows: 2,
      value: fileAccess.extraAllow.join('\n'),
      onChange: (v) => { patch('fileAccess', { ...fileAccess, extraAllow: v.split('\n').map((s) => s.trim()) }); },
    }),
    createElement(AreaRow, {
      label: '敏感路径（拦截）', help: '每行一个目录或文件前缀；命中后禁止访问/发送', rows: 3,
      value: fileAccess.sensitivePaths.join('\n'),
      onChange: (v) => { patch('fileAccess', { ...fileAccess, sensitivePaths: v.split('\n').map((s) => s.trim()) }); },
    }),

    createElement('div', { className: 'imqb2-group-title' }, '基础设置'),
    createElement(SwitchRow, {
      label: '群聊仅回复 @机器人的消息', checked: form.requireMention ?? true,
      help: '开启后，机器人仅可回复 @机器人的群聊消息',
      onChange: (v) => { patch('requireMention', v); },
    }),
    createElement(SwitchRow, {
      label: '流式输出', checked: form.streaming ?? true,
      help: '回复内容分段实时推送到聊天',
      onChange: (v) => { patch('streaming', v); },
    }),
    createElement(SwitchRow, {
      label: '显示工具调用结果', checked: form.showToolResults ?? false,
      help: '在聊天中展示 agent 工具调用的结构化结果',
      onChange: (v) => { patch('showToolResults', v); },
    }),
    createElement(NumberRow, {
      label: '群聊未 @ 时回复概率', value: form.groupReplyProbability ?? 0,
      min: 0, max: 1, step: 0.05,
      help: '0 表示只在被 @ 时回复；0.1 表示约 10% 的群消息会主动接话',
      onChange: (v) => { patch('groupReplyProbability', v); },
    }),
    createElement(NumberRow, {
      label: '群历史缓冲条数', value: form.historyLimit ?? 10,
      min: 0, max: 200, step: 1,
      help: '注入到群聊上下文的最近消息条数',
      onChange: (v) => { patch('historyLimit', v); },
    }),
    createElement(NumberRow, {
      label: '会话闲置超时（毫秒）', value: form.sessionIdleTimeout ?? 1800000,
      min: 60000, max: 2592000000, step: 60000,
      help: '超过该时长未活动会回收会话；86400000 = 24 小时',
      onChange: (v) => { patch('sessionIdleTimeout', v); },
    }),
    createElement(NumberRow, {
      label: '单条消息最大字符数', value: form.textChunkLimit ?? 4500,
      min: 200, max: 5000, step: 100,
      help: 'QQ 单条约 5000 字符上限，长回复会拆成多条',
      onChange: (v) => { patch('textChunkLimit', v); },
    }),
    createElement(NumberRow, {
      label: '并发队列上限', value: form.maxQueue ?? 20,
      min: 1, max: 100, step: 1,
      help: '同时排队的消息数，超出会拒绝新消息',
      onChange: (v) => { patch('maxQueue', v); },
    }),
    createElement(NumberRow, {
      label: '单次处理超时（毫秒）', value: form.processingTimeoutMs ?? 1800000,
      min: 10000, max: 21600000, step: 60000,
      help: '超时中断当前 LLM 调用',
      onChange: (v) => { patch('processingTimeoutMs', v); },
    }),
    createElement(NumberRow, {
      label: '待答问题超时（毫秒）', value: form.askTimeoutMs ?? 300000,
      min: 10000, max: 21600000, step: 30000,
      help: 'ask_user_question 等待用户回答的上限',
      onChange: (v) => { patch('askTimeoutMs', v); },
    }),
    createElement(NumberRow, {
      label: '自动压缩阈值（token）', value: form.autoCompactTokens ?? 160000,
      min: 0, max: 1000000, step: 10000,
      help: '群聊上下文超过该值后自动压缩（私聊不低于它）；0 = 插件不自动压缩，交给 dsh 默认阈值',
      onChange: (v) => { patch('autoCompactTokens', v); },
    }),
    createElement(NumberRow, {
      label: '私聊压缩阈值（占模型窗口）', value: form.autoCompactPrivateRatio ?? 0.5,
      min: 0, max: 0.9, step: 0.05,
      help: '私聊做多步任务需要更长上下文：按模型窗口比例算阈值，取不到窗口时用上面的固定值；0 = 与群聊相同',
      onChange: (v) => { patch('autoCompactPrivateRatio', v); },
    }),
    createElement(SwitchRow, {
      label: '工具链进行中推迟压缩', checked: form.autoCompactDeferOnTools ?? true,
      help: '上一轮还在调工具时先不压，等一轮没调工具的收尾轮再压；上下文到阈值 1.5 倍时仍会强制压缩',
      onChange: (v) => { patch('autoCompactDeferOnTools', v); },
    }),
    createElement(SwitchRow, {
      label: '调试模式', checked: form.debug ?? false,
      help: '输出更详细的运行日志',
      onChange: (v) => { patch('debug', v); },
    }),

    createElement('div', { className: 'imqb2-group-title' }, '回复欲望'),
    createElement(SwitchRow, {
      label: '未 @ 时按打分决定是否接话', checked: replyDesire.enabled,
      help: '开启后，群里没 @ bot 的消息按规则打分，过阈值才接；关闭则只回 @ 和按概率随机插嘴',
      onChange: (v) => { patch('replyDesire', { ...replyDesire, enabled: v }); },
    }),
    createElement(NumberRow, {
      label: '放行阈值（0-1）', value: replyDesire.threshold, min: 0, max: 1, step: 0.05,
      help: '越高越安静：点名 bot 得 0.7、窗口内的人 0.6、像提问再 +0.2；默认 0.6',
      onChange: (v) => { patch('replyDesire', { ...replyDesire, threshold: v }); },
    }),
    createElement(ListRow, {
      label: 'bot 的昵称/别名', help: '每行一个；群里提到这些词就算在叫 bot（大小写不敏感）',
      value: replyDesire.names, rows: 2,
      onChange: (v) => { patch('replyDesire', { ...replyDesire, names: v }); },
    }),
    createElement(NumberRow, {
      label: '对话窗口时长（毫秒）', value: replyDesire.engagedMs, min: 5000, max: 600000, step: 5000,
      help: '被 @ 或接话后开窗；窗口内刚聊过的人再说话基本都会被接，默认 90000（90 秒）',
      onChange: (v) => { patch('replyDesire', { ...replyDesire, engagedMs: v }); },
    }),
    createElement(NumberRow, {
      label: '窗口内连续接话轮数上限', value: replyDesire.engagedMaxTurns, min: 0, max: 50, step: 1,
      help: '靠打分接的轮数到上限就关窗（这一条仍接）；0 = 不进入对话窗口，默认 8',
      onChange: (v) => { patch('replyDesire', { ...replyDesire, engagedMaxTurns: v }); },
    }),
    createElement(SwitchRow, {
      label: '规则拿不准时让模型打分', checked: judge.enabled,
      help: '没点名、不在对话窗口的普通文字，交给模型判断要不要接；语气词、表情包、开团期间不调模型',
      onChange: (v) => { patchJudge({ enabled: v }); },
    }),
    ...(judge.enabled ? [
      createElement(FieldRow, {
        label: '打分 provider', value: judge.provider, placeholder: '留空 = 这个群的主模型',
        onChange: (v) => { patchJudge({ provider: v.trim() }); },
      }),
      createElement(FieldRow, {
        label: '打分模型', value: judge.model, placeholder: '留空 = 这个群的主模型',
        onChange: (v) => { patchJudge({ model: v.trim() }); },
      }),
      createElement(FieldRow, {
        label: '推理档位', value: judge.reasoningEffort, placeholder: '留空 = 自动选最低档',
        help: '启动后第一次打分会在日志里列出这个模型支持的档位',
        onChange: (v) => { patchJudge({ reasoningEffort: v.trim() }); },
      }),
      createElement(NumberRow, {
        label: '安静多久才打分（毫秒）', value: judge.debounceMs, min: 0, max: 60000, step: 500,
        help: '连着说的几条只给最后一条打一次分，默认 2500',
        onChange: (v) => { patchJudge({ debounceMs: v }); },
      }),
      createElement(NumberRow, {
        label: '最多攒多久也要打分（毫秒）', value: judge.maxWaitMs, min: 0, max: 300000, step: 1000,
        help: '群里一直有人说话时的上限，默认 15000',
        onChange: (v) => { patchJudge({ maxWaitMs: v }); },
      }),
      createElement(NumberRow, {
        label: '给模型看的消息条数', value: judge.contextMessages, min: 1, max: 100, step: 1,
        help: '越多越准也越贵，默认 20',
        onChange: (v) => { patchJudge({ contextMessages: v }); },
      }),
      createElement(NumberRow, {
        label: '打分超时（毫秒）', value: judge.timeoutMs, min: 1000, max: 120000, step: 1000,
        help: '超时按不接处理，默认 15000',
        onChange: (v) => { patchJudge({ timeoutMs: v }); },
      }),
    ] : []),

    createElement('div', { className: 'imqb2-group-title' }, '串模式'),
    createElement(SwitchRow, {
      label: '启用群聊串模式', checked: banter.enabled,
      help: replyDesire.enabled && judge.enabled
        ? '只在下面列出的群生效；私聊和开团期间不生效'
        : '要主动接话，还需打开上面的「未 @ 时按打分决定是否接话」和「规则拿不准时让模型打分」；否则只改变被 @ 时的语气',
      onChange: (v) => { patch('banter', { ...banter, enabled: v }); },
    }),
    createElement(ListRow, {
      label: '开启串模式的群 openid', help: '每行一个',
      value: banter.groups, rows: 2,
      onChange: (v) => { patch('banter', { ...banter, groups: v }); },
    }),

    createElement('div', { className: 'imqb2-group-title' }, '表情收藏'),
    createElement(SwitchRow, {
      label: '允许 bot 自动收藏表情', checked: stickers.enabled,
      help: '开启后 bot 可在看到喜欢的图时调用 qqbot_save_sticker；收藏会更新索引并进入后续对话的表情清单',
      onChange: (v) => { patch('stickers', { ...stickers, enabled: v }); },
    }),
    createElement(FieldRow, {
      label: '表情包目录', value: stickers.root, placeholder: '留空 = 插件根目录/stickers',
      onChange: (v) => { patch('stickers', { ...stickers, root: v }); },
    }),
    createElement(ListRow, {
      label: '额外允许的收藏来源目录', help: '每行一个；media 目录始终允许', value: stickers.extraRoots, rows: 2,
      onChange: (v) => { patch('stickers', { ...stickers, extraRoots: v }); },
    }),
    createElement(NumberRow, {
      label: '单张表情大小上限（字节）', value: stickers.maxBytes,
      min: 1024, max: 104857600, step: 1048576,
      onChange: (v) => { patch('stickers', { ...stickers, maxBytes: v }); },
    }),
    createElement(NumberRow, {
      label: '自动收藏条目上限', value: stickers.maxAutoEntries,
      min: 0, max: 5000, step: 50,
      help: '防止索引无限增长',
      onChange: (v) => { patch('stickers', { ...stickers, maxAutoEntries: v }); },
    }),

    createElement('div', { className: 'imqb2-group-title' }, '模型'),
    createElement(FieldRow, {
      label: 'Provider', value: form.provider ?? '', placeholder: '留空继承宿主默认',
      onChange: (v) => { patch('provider', v); },
    }),
    createElement(FieldRow, {
      label: 'Model', value: form.model ?? '', placeholder: '留空继承宿主默认',
      onChange: (v) => { patch('model', v); },
    }),
    createElement(FieldRow, {
      label: 'Preset', value: form.preset ?? '', placeholder: 'Agent preset id',
      onChange: (v) => { patch('preset', v); },
    }),

    createElement('div', { className: 'imqb2-group-title' }, '个性化提示词'),
    createElement(AreaRow, {
      label: '群聊额外 system prompt', value: form.groupPrompt ?? '',
      onChange: (v) => { patch('groupPrompt', v); },
    }),
    createElement(AreaRow, {
      label: '私聊额外 system prompt', value: form.directPrompt ?? '',
      onChange: (v) => { patch('directPrompt', v); },
    }),

    createElement('div', { className: 'imqb2-group-title' }, '图片与媒体'),
    createElement(SwitchRow, {
      label: '启用富媒体理解', checked: media.enabled,
      help: '下载聊天里的图片/视频并交给模型或工具分析；关闭后只保留文本',
      onChange: (v) => { patch('media', { ...media, enabled: v }); },
    }),
    createElement(NumberRow, {
      label: '单个媒体大小上限（MB）', value: media.maxMB, min: 1, max: 2048, step: 10,
      help: '超过上限的图片/视频不下载',
      onChange: (v) => { patch('media', { ...media, maxMB: v }); },
    }),
    createElement(NumberRow, {
      label: '媒体保留时长（小时）', value: media.ttlHours, min: 0, max: 720, step: 1,
      help: '超过后自动清理；0 = 永不清理',
      onChange: (v) => { patch('media', { ...media, ttlHours: v }); },
    }),
    createElement(NumberRow, {
      label: '媒体目录总量上限（MB）', value: media.maxTotalMB, min: 0, max: 102400, step: 128,
      help: '超出时从最旧的开始删；0 = 不限',
      onChange: (v) => { patch('media', { ...media, maxTotalMB: v }); },
    }),

    createElement('div', { className: 'imqb2-group-title' }, '视觉理解'),
    createElement(SwitchRow, {
      label: '启用视觉理解', checked: vision.enabled,
      help: '注册 qqbot_describe_image；关闭后不能识图（原生看图另见下一项）',
      onChange: (v) => { patch('vision', { ...vision, enabled: v }); },
    }),
    createElement(SwitchRow, {
      label: '把图片直接交给主模型', checked: vision.native,
      help: '主模型路由必须声明支持 image 输入，否则会报错',
      onChange: (v) => { patch('vision', { ...vision, native: v }); },
    }),
    createElement(FieldRow, {
      label: '视觉模型 Provider', value: vision.provider, placeholder: '如 deepseek-vision',
      onChange: (v) => { patch('vision', { ...vision, provider: v }); },
    }),
    createElement(FieldRow, {
      label: '视觉模型 Model', value: vision.model, placeholder: '如 deepseek-v4-flash',
      onChange: (v) => { patch('vision', { ...vision, model: v }); },
    }),
    createElement(AreaRow, {
      label: '默认描述 prompt', value: vision.defaultPrompt, rows: 2,
      onChange: (v) => { patch('vision', { ...vision, defaultPrompt: v }); },
    }),
    createElement(NumberRow, {
      label: '图片字节上限', value: vision.maxBytes, min: 1024, max: 104857600, step: 1048576,
      onChange: (v) => { patch('vision', { ...vision, maxBytes: v }); },
    }),
    createElement(NumberRow, {
      label: '输出 token 上限', value: vision.maxTokens, min: 64, max: 32768, step: 64,
      onChange: (v) => { patch('vision', { ...vision, maxTokens: v }); },
    }),
    createElement(NumberRow, {
      label: '视觉调用超时（毫秒）', value: vision.timeoutMs, min: 10000, max: 600000, step: 5000,
      onChange: (v) => { patch('vision', { ...vision, timeoutMs: v }); },
    }),

    createElement('div', { className: 'imqb2-group-title' }, '视频理解'),
    createElement(SwitchRow, {
      label: '启用视频理解', checked: video.enabled,
      help: '注册 qqbot_describe_video：抽帧宫格 + 音轨转写；需要视觉模型和 ffmpeg',
      onChange: (v) => { patch('video', { ...video, enabled: v }); },
    }),
    createElement(FieldRow, {
      label: 'ffmpeg 路径', value: video.ffmpegPath, placeholder: '留空 = PATH 里的 ffmpeg',
      help: '路径里有空格也直接填；ffprobe 取同目录',
      onChange: (v) => { patch('video', { ...video, ffmpegPath: v }); },
    }),
    createElement(NumberRow, {
      label: '最多抽帧数', value: video.maxFrames, min: 1, max: 24, step: 1,
      onChange: (v) => { patch('video', { ...video, maxFrames: v }); },
    }),
    createElement(NumberRow, {
      label: '最多分析前多少秒', value: video.maxSeconds, min: 10, max: 3600, step: 10,
      onChange: (v) => { patch('video', { ...video, maxSeconds: v }); },
    }),

    createElement('div', { className: 'imqb2-group-title' }, '语音识别'),
    createElement(SwitchRow, {
      label: '启用在线语音识别', checked: asr.enabled,
      help: 'QQ 没给识别文本时，把语音发给转写接口；密钥请用环境变量 QQBOT_ASR_API_KEY 或 patch 配置',
      onChange: (v) => { patch('asr', { ...asr, enabled: v }); },
    }),
    createElement(FieldRow, {
      label: '接口地址', value: asr.baseUrl, placeholder: 'https://api.siliconflow.cn/v1',
      onChange: (v) => { patch('asr', { ...asr, baseUrl: v }); },
    }),
    createElement(FieldRow, {
      label: '转写模型', value: asr.model, placeholder: 'Qwen/Qwen3-ASR-1.7B',
      onChange: (v) => { patch('asr', { ...asr, model: v }); },
    }),
    createElement(SwitchRow, {
      label: '优先用 QQ 自带识别文本', checked: asr.preferQQ,
      onChange: (v) => { patch('asr', { ...asr, preferQQ: v }); },
    }),
    createElement(NumberRow, {
      label: '转写超时（毫秒）', value: asr.timeoutMs, min: 5000, max: 120000, step: 5000,
      onChange: (v) => { patch('asr', { ...asr, timeoutMs: v }); },
    }),
    createElement(SwitchRow, {
      label: '主接口连不上时改用备用接口', checked: asrFallback.enabled,
      help: '如本机 whisper 优先、在线服务兜底；只在连不上或服务端 5xx 时切换。密钥同样用 QQBOT_ASR_API_KEY 或 patch 配置',
      onChange: (v) => { patch('asr', { ...asr, fallback: { ...asrFallback, enabled: v } }); },
    }),
    createElement(FieldRow, {
      label: '备用接口地址', value: asrFallback.baseUrl, placeholder: 'https://api.siliconflow.cn/v1',
      onChange: (v) => { patch('asr', { ...asr, fallback: { ...asrFallback, baseUrl: v } }); },
    }),
    createElement(FieldRow, {
      label: '备用转写模型', value: asrFallback.model, placeholder: 'FunAudioLLM/SenseVoiceSmall',
      onChange: (v) => { patch('asr', { ...asr, fallback: { ...asrFallback, model: v } }); },
    }),
    createElement(NumberRow, {
      label: '备用接口超时（毫秒）', value: asrFallback.timeoutMs, min: 5000, max: 120000, step: 5000,
      onChange: (v) => { patch('asr', { ...asr, fallback: { ...asrFallback, timeoutMs: v } }); },
    }),

    createElement('div', { className: 'imqb2-group-title' }, '共享笔记'),
    createElement(SwitchRow, {
      label: '启用共享笔记库', checked: notes.enabled,
      help: 'qqbot_notes_search / qqbot_notes_save + 自动召回',
      onChange: (v) => { patch('notes', { ...notes, enabled: v }); },
    }),
    createElement(FieldRow, {
      label: '笔记目录', value: notes.root, placeholder: '留空 = 工作目录/notes',
      onChange: (v) => { patch('notes', { ...notes, root: v }); },
    }),
    createElement(SwitchRow, {
      label: '自动注入相关笔记', checked: notes.autoInject,
      help: '每条消息前检索并注入相关片段',
      onChange: (v) => { patch('notes', { ...notes, autoInject: v }); },
    }),
    createElement(NumberRow, {
      label: '最多注入片段数', value: notes.injectTopK, min: 0, max: 8, step: 1,
      onChange: (v) => { patch('notes', { ...notes, injectTopK: v }); },
    }),
    createElement(NumberRow, {
      label: '注入总字数上限', value: notes.injectMaxChars, min: 0, max: 4000, step: 50,
      onChange: (v) => { patch('notes', { ...notes, injectMaxChars: v }); },
    }),
    createElement(NumberRow, {
      label: '最低查询词覆盖率', value: notes.injectMinCoverage, min: 0, max: 1, step: 0.05,
      help: '0-1，越高越保守',
      onChange: (v) => { patch('notes', { ...notes, injectMinCoverage: v }); },
    }),
    createElement(SwitchRow, {
      label: '语义检索（向量）', checked: semantic.enabled,
      help: '关键词和字面匹配之外再按意思找笔记（同义词、换种说法）；密钥请用环境变量 QQBOT_EMBEDDING_API_KEY 或 patch 配置',
      onChange: (v) => { patch('notes', { ...notes, semantic: { ...semantic, enabled: v } }); },
    }),
    createElement(FieldRow, {
      label: '向量接口地址', value: semantic.baseUrl, placeholder: 'https://api.siliconflow.cn/v1',
      onChange: (v) => { patch('notes', { ...notes, semantic: { ...semantic, baseUrl: v } }); },
    }),
    createElement(FieldRow, {
      label: '向量模型', value: semantic.model, placeholder: 'BAAI/bge-m3',
      onChange: (v) => { patch('notes', { ...notes, semantic: { ...semantic, model: v } }); },
    }),
    createElement(NumberRow, {
      label: '高出全库中位数至少', value: semantic.minMargin, min: 0, max: 1, step: 0.01,
      help: '主门槛：片段要比这条消息对全部笔记的一般相似度明显更高；过门槛的片段即使没有关键词命中也会注入',
      onChange: (v) => { patch('notes', { ...notes, semantic: { ...semantic, minMargin: v } }); },
    }),
    createElement(NumberRow, {
      label: '最低语义相似度', value: semantic.minSimilarity, min: 0, max: 1, step: 0.05,
      help: '绝对下限兜底（笔记很少时中位数不可靠）',
      onChange: (v) => { patch('notes', { ...notes, semantic: { ...semantic, minSimilarity: v } }); },
    }),
    createElement(NumberRow, {
      label: '向量请求超时（毫秒）', value: semantic.timeoutMs, min: 500, max: 30000, step: 500,
      help: '超时的那条消息只用关键词检索，不会卡住回复',
      onChange: (v) => { patch('notes', { ...notes, semantic: { ...semantic, timeoutMs: v } }); },
    }),

    createElement('div', { className: 'imqb2-group-title' }, '工具权限'),
    createElement(SwitchRow, {
      label: '按会话限制工具', checked: toolAccess.enabled,
      help: '关闭后所有 QQ 会话都能用终端、读写任意路径',
      onChange: (v) => { patch('toolAccess', { ...toolAccess, enabled: v }); },
    }),
    createElement(ListRow, {
      label: '可完全访问的群 openid', help: '每行一个；这些群里能用终端、读写任意路径',
      value: toolAccess.fullAccessGroups, rows: 2,
      onChange: (v) => { patch('toolAccess', { ...toolAccess, fullAccessGroups: v }); },
    }),
    createElement(ListRow, {
      label: '可完全访问的用户 openid', help: '每行一个；主人私聊始终可以',
      value: toolAccess.fullAccessUsers, rows: 2,
      onChange: (v) => { patch('toolAccess', { ...toolAccess, fullAccessUsers: v }); },
    }),
    createElement(ListRow, {
      label: '受限会话可读目录', help: '每行一个；media、表情库、临时目录始终允许',
      value: toolAccess.readRoots, rows: 3,
      onChange: (v) => { patch('toolAccess', { ...toolAccess, readRoots: v }); },
    }),

    createElement('div', { className: 'imqb2-group-title' }, '文件发送'),
    createElement(SwitchRow, {
      label: '启用路径白名单', checked: sendFile.restrictPaths,
      help: '只允许 media、工作目录和额外目录里的文件；关闭后任意路径都能发',
      onChange: (v) => { patch('sendFile', { ...sendFile, restrictPaths: v }); },
    }),
    createElement(ListRow, {
      label: '额外允许的根目录', help: '每行一个绝对路径', value: sendFile.extraRoots, rows: 2,
      onChange: (v) => { patch('sendFile', { ...sendFile, extraRoots: v }); },
    }),

    createElement('div', { className: 'imqb2-group-title' }, '语音合成'),
    createElement(SwitchRow, {
      label: '启用 qqbot_speak', checked: speak.enabled,
      help: '让 bot 用自己的声音说一两句；依赖本机的 edge-tts（pip install edge-tts）',
      onChange: (v) => { patch('speak', { ...speak, enabled: v }); },
    }),
    createElement(FieldRow, {
      label: '音色', value: speak.voice, placeholder: 'zh-CN-XiaoyiNeural',
      help: 'edge-tts 音色名，如 zh-CN-XiaoyiNeural、zh-CN-XiaoxiaoNeural',
      onChange: (v) => { patch('speak', { ...speak, voice: v.trim() }); },
    }),
    createElement(FieldRow, {
      label: '语速', value: speak.rate, placeholder: '+8%',
      help: '带符号的百分比，如 +8% / -5%；留空用引擎默认',
      onChange: (v) => { patch('speak', { ...speak, rate: v.trim() }); },
    }),
    createElement(NumberRow, {
      label: '单条字数上限', value: speak.maxChars, min: 10, max: 600, step: 10,
      help: 'QQ 语音最长约 60 秒，超过上限会被拒绝',
      onChange: (v) => { patch('speak', { ...speak, maxChars: v }); },
    }),
    createElement(FieldRow, {
      label: 'edge-tts 命令', value: speak.command, placeholder: '留空 = 自动探测',
      help: '填可执行文件路径，比如 conda 里的 Scripts\\edge-tts.exe',
      onChange: (v) => { patch('speak', { ...speak, command: v.trim() }); },
    }),
    createElement(FieldRow, {
      label: '本地语音服务', value: speak.gsvUrl, placeholder: 'http://127.0.0.1:8765（留空 = edge-tts）',
      help: '填了优先用本机 GPT-SoVITS 服务发声，服务没起来会自动退回 edge-tts',
      onChange: (v) => { patch('speak', { ...speak, gsvUrl: v.trim() }); },
    }),
    createElement(NumberRow, {
      label: '本地服务语速', value: speak.gsvSpeed, min: 0.5, max: 2, step: 0.01,
      help: '倍率，1 = 原速；和上面 edge-tts 的百分比语速互不影响',
      onChange: (v) => { patch('speak', { ...speak, gsvSpeed: v }); },
    }),

    createElement('div', { className: 'imqb2-group-title' }, '临时目录与清理'),
    createElement(FieldRow, {
      label: '临时目录', value: form.tmpDir ?? '', placeholder: '留空 = 工作目录/tmp',
      help: '下载、抽帧、截图等中间文件放这里',
      onChange: (v) => { patch('tmpDir', v); },
    }),
    createElement(NumberRow, {
      label: '临时文件保留（小时）', value: form.tmpTtlHours ?? 72, min: 0, max: 8760, step: 1,
      help: '0 = 不按时间清理',
      onChange: (v) => { patch('tmpTtlHours', v); },
    }),
    createElement(NumberRow, {
      label: '临时目录总量上限（MB）', value: form.tmpMaxTotalMB ?? 4096, min: 0, max: 1048576, step: 256,
      help: '0 = 不限',
      onChange: (v) => { patch('tmpMaxTotalMB', v); },
    }),
    createElement(SwitchRow, {
      label: '清理只记日志（dry run）', checked: cleanup.dryRun,
      help: '自定义清理规则（cleanup.rules）只能在 cordis.patch.yml 里配',
      onChange: (v) => { patch('cleanup', { ...cleanup, dryRun: v }); },
    }),

    createElement('div', { className: 'imqb2-group-title' }, '浏览器'),
    createElement(SwitchRow, {
      label: '启用 Playwright 浏览', checked: browser.enabled,
      help: '主人私聊及白名单群可用，请先配置 ownerOpenid。第一次打开网站后在浏览器中手动登录。',
      onChange: (v) => { patch('browser', { ...browser, enabled: v }); },
    }),
    createElement(ListRow, {
      label: '浏览群白名单', value: browser.allowedGroups ?? [], rows: 3,
      help: '每行一个群 openid（不是 QQ 群号）；留空仅主人私聊可用。授权群内所有成员均可调用，各群登录态与主人私聊隔离。',
      onChange: (v) => { patch('browser', { ...browser, allowedGroups: v }); },
    }),
    createElement(BrowserSelectRow, {
      label: '连接方式', value: browser.mode,
      options: [{ value: 'local', label: '本机浏览器' }, { value: 'cdp', label: '指纹浏览器 CDP' }],
      onChange: (v) => { patch('browser', { ...browser, mode: v as BrowserConfig['mode'] }); },
    }),
    createElement('p', { className: 'imqb2-help' }, 'CDP 地址请设环境变量 QQBOT_BROWSER_CDP_ENDPOINT；代理可设 QQBOT_BROWSER_PROXY_SERVER。本机模式保存登录态，指纹由外接浏览器管理。'),
    createElement(BrowserSelectRow, {
      label: '本机浏览器', value: browser.channel,
      options: [{ value: 'chrome', label: 'Chrome' }, { value: 'msedge', label: 'Edge' }, { value: 'chromium', label: 'Chromium' }],
      onChange: (v) => { patch('browser', { ...browser, channel: v as BrowserConfig['channel'] }); },
    }),
    createElement(FieldRow, {
      label: '独立配置目录', value: browser.userDataDir, placeholder: '留空 = 工作目录/.qqbot-browser',
      help: '不要填写日常使用的 Chrome 用户目录；此目录包含登录凭据，请勿提交或共享。',
      onChange: (v) => { patch('browser', { ...browser, userDataDir: v }); },
    }),
    createElement(SwitchRow, {
      label: '无头模式', checked: browser.headless, help: '首次登录请关闭，以便在窗口中扫码或验证。',
      onChange: (v) => { patch('browser', { ...browser, headless: v }); },
    }),
    createElement(FieldRow, {
      label: '语言', value: browser.locale,
      onChange: (v) => { patch('browser', { ...browser, locale: v }); },
    }),
    createElement(FieldRow, {
      label: '时区', value: browser.timezoneId,
      onChange: (v) => { patch('browser', { ...browser, timezoneId: v }); },
    }),
    createElement(NumberRow, {
      label: '操作超时（毫秒）', value: browser.timeoutMs, min: 1000, max: 120000, step: 1000,
      onChange: (v) => { patch('browser', { ...browser, timeoutMs: v }); },
    }),
    createElement(NumberRow, {
      label: '返回文本上限', value: browser.maxTextChars, min: 1000, max: 50000, step: 1000,
      onChange: (v) => { patch('browser', { ...browser, maxTextChars: v }); },
    }),

    createElement('div', { className: 'imqb2-group-title' }, '搜图'),
    createElement(SwitchRow, {
      label: '启用 qqbot_fanart_pick', checked: fanart.enabled,
      onChange: (v) => { patch('fanart', { ...fanart, enabled: v }); },
    }),
    createElement(FieldRow, {
      label: 'HTTP 代理', value: fanart.proxy, placeholder: '留空 = HTTPS_PROXY 或系统代理',
      onChange: (v) => { patch('fanart', { ...fanart, proxy: v }); },
    }),
    createElement(FieldRow, {
      label: 'CP 池目录', value: fanart.poolDir, placeholder: '留空 = 插件根目录/scripts',
      onChange: (v) => { patch('fanart', { ...fanart, poolDir: v }); },
    }),

    createElement('div', { className: 'imqb2-group-title' }, '跑团'),
    createElement(SwitchRow, {
      label: '启用跑团', checked: dnd.enabled,
      help: '/dnd 命令与 dnd_* 工具',
      onChange: (v) => { patch('dnd', { ...dnd, enabled: v }); },
    }),
    createElement(FieldRow, {
      label: '跑团数据目录', value: dnd.root, placeholder: '留空 = 工作目录/dnd',
      onChange: (v) => { patch('dnd', { ...dnd, root: v }); },
    }),
    createElement(SwitchRow, {
      label: '回合按钮', checked: dnd.turnButtons,
      help: '轮到 PC 时发「结束回合 / 查看状态」按钮',
      onChange: (v) => { patch('dnd', { ...dnd, turnButtons: v }); },
    }),
    createElement(SwitchRow, {
      label: '开团后允许随机插嘴', checked: dnd.interjections,
      help: '只吐槽、不结算；关闭后开团后只回 @',
      onChange: (v) => { patch('dnd', { ...dnd, interjections: v }); },
    }),

    form.cwd !== undefined
      ? createElement('div', { className: 'imqb2-field' },
          createElement('div', { className: 'imqb2-head' },
            createElement('span', { className: 'imqb2-label' }, 'Agent 工作目录'),
            createElement('span', { className: 'imqb2-hint' }, '只读'),
          ),
          createElement('p', { className: 'imqb2-readonly' }, form.cwd),
        )
      : null,

    createElement('div', { className: 'imqb2-footer' },
      result !== null
        ? createElement('p', { className: `imqb2-note${result.ok ? ' imqb2-note--ok' : ' imqb2-note--error'}` },
            (result.ok ? '' : '⚠️ ') + result.message)
        : dirty
          ? createElement('p', { className: 'imqb2-note' }, '保存后插件将重载，进行中的机器人会话将重置')
          : createElement('p', { className: 'imqb2-note' }),
      createElement('button', { className: 'imqb2-save', type: 'submit', disabled: busy || !dirty },
        busy ? '正在保存…' : '保存'),
    ),
  );
}
