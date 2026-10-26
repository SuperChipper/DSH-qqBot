/**
 * 通用工具函数
 *
 * 纯函数与常量，供插件入口与其他模块复用。
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const PLUGIN_ROOT = resolve(__dirname, '../..');

/** 插件版本号（从 package.json 读取，供 help/version 等展示真实版本） */
export const PLUGIN_VERSION = readPluginVersion();

function readPluginVersion(): string {
  try {
    const pkgPath = resolve(PLUGIN_ROOT, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * 构造 User-Agent 头
 *
 * 格式: dsh-qqbot/{version} (Node/{nodeVersion}; {platform})
 */
export function buildUserAgent(): string {
  return `dsh-qqbot/${PLUGIN_VERSION} (Node/${process.versions.node}; ${os.platform()})`;
}

/**
 * 从插件安装路径推导 profile 目录
 *
 * 主策略：逐级向上探测 profile 标志文件（cordis.patch.yml / pnpm-workspace.yaml）。
 * Desktop profile 使用 pnpm workspace 布局（profiles/desktop/dependencies/
 * node_modules/.pnpm/<pkg>/node_modules/...），插件嵌套于多级 node_modules，
 * 仅按 node_modules 匹配会命中内层目录而返回错误位置。
 *
 * 兜底：无标志文件时沿用旧启发式（名为 node_modules 的目录的父目录），
 * 覆盖 CLI profile 的浅层 npm 布局与未写入过 patch 的全新 profile。
 *
 * @param baseDir - 起始目录，缺省为插件根（可注入便于测试）
 */
/**
 * 解析当前插件所属 profile 目录。
 *
 * 优先使用 Cordis 注入的 `ctx.baseUrl`（Loader 根，即 profile 的
 * cordis.yml 所在目录）——它对链接安装同样成立；否则回落到环境变量
 * 与路径探测。返回目录必须带 package.json，避免把源码 checkout 误判为
 * profile。
 */
export function resolveProfileDir(baseUrl?: string): string | null {
  if (baseUrl !== undefined && baseUrl !== '') {
    try {
      const dir = baseUrl.startsWith('file:') ? fileURLToPath(baseUrl) : resolve(baseUrl);
      for (const candidate of [dir, dirname(dir)]) {
        if (isProfileDir(candidate)) return candidate;
      }
    } catch {
      // 非法 baseUrl 回落到后续策略
    }
  }
  return getProfileDir();
}

export function getProfileDir(baseDir: string = PLUGIN_ROOT): string | null {
  // 首选：宿主显式注入的当前 profile 目录。`link:` / workspace 安装下
  // ESM 会把插件解析到真实源码路径（不在任何 node_modules 之下），
  // 只靠路径探测会落空；DSH_PROFILE_DIR 是宿主对「本进程属于哪个
  // profile」最准确的表述，也让配置面板与扫码写入落到正确的 patch。
  // 仅在调用方未指定起点时使用，避免覆盖测试/显式探测。
  if (baseDir === PLUGIN_ROOT) {
    const fromEnv = profileDirFromEnv();
    if (fromEnv !== null) return fromEnv;
  }

  // 主策略：跨过 node_modules 边界后，优先命中 cordis.patch.yml（凭据写入
  // 目标），其次 pnpm-workspace.yaml。跨越守卫是关键——插件包自身随包携带
  // cordis.patch.yml（dsh.bundle.patch 分发物）、源码 checkout 根也有同名
  // 仓库文件，二者都会让「从 PLUGIN_ROOT 起步的探测」命中插件自己；只有
  // 位于 node_modules 之上的目录才可能是拥有该插件的 profile。
  const byPatch = findProfileAncestor(baseDir, (dir) =>
    existsSync(resolve(dir, 'cordis.patch.yml')) ? dir : null);
  if (byPatch !== null) return byPatch;

  const byWorkspace = findProfileAncestor(baseDir, (dir) =>
    existsSync(resolve(dir, 'pnpm-workspace.yaml')) ? dir : null);
  if (byWorkspace !== null) return byWorkspace;

  // 兜底：npm 浅层布局 / 尚未写入任何标志文件的全新 profile
  // （第一个 node_modules 目录的父目录，与旧版行为一致）
  let dir = baseDir;
  for (let i = 0; i < 32; i++) {
    if (basename(dir) === 'node_modules') return dirname(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * 宿主注入的 profile 目录。
 *
 * 依次尝试 `DSH_PROFILE_DIR`、`DSH_HOME/profiles/DSH_PROFILE`，最后在
 * `DSH_HOME/profiles` 中寻找把本包链接到当前源码的 profile（`link:` /
 * workspace 安装下路径探测会因 realpath 落在 node_modules 之外而失效）。
 * 只接受带 package.json 的目录。
 */
function profileDirFromEnv(): string | null {
  const home = process.env.DSH_HOME ?? join(os.homedir(), '.dsh');
  const candidates: string[] = [];
  if (process.env.DSH_PROFILE_DIR) candidates.push(resolve(process.env.DSH_PROFILE_DIR));
  if (process.env.DSH_PROFILE) candidates.push(resolve(home, 'profiles', process.env.DSH_PROFILE));
  for (const dir of candidates) {
    if (isProfileDir(dir)) return dir;
  }
  return profileDirFromInstalledLink(home);
}

/**
 * 目录是否为一个 dsh profile：package.json 声明 `dsh.profile`（或沿用
 * `dsh-profile-*` 命名）。用来排除「插件源码根」这类同样带 package.json
 * 的目录，避免把配置写进插件仓库。
 */
function isProfileDir(dir: string): boolean {
  const manifestPath = join(dir, 'package.json');
  if (!existsSync(manifestPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      name?: unknown;
      dsh?: { profile?: unknown };
    };
    if (pkg.dsh?.profile !== undefined) return true;
    return typeof pkg.name === 'string' && pkg.name.startsWith('dsh-profile-');
  } catch {
    return false;
  }
}

/** 在 `$DSH_HOME/profiles` 中找选中本包、且依赖解析到当前源码的 profile */
function profileDirFromInstalledLink(home: string): string | null {
  const profilesRoot = join(home, 'profiles');
  let entries;
  try {
    entries = readdirSync(profilesRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  const ownRoot = safeRealpath(PLUGIN_ROOT);
  const packageName = readPluginName();
  if (packageName === null) return null;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(profilesRoot, entry.name);
    const manifestPath = join(dir, 'package.json');
    if (!existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        dsh?: { profile?: { bundles?: unknown } };
      };
    } catch {
      continue;
    }
    const bundles = manifest.dsh?.profile?.bundles;
    if (!Array.isArray(bundles) || !bundles.includes(packageName)) continue;

    const installed = join(dir, 'node_modules', ...packageName.split('/'));
    const resolved = safeRealpath(installed);
    // 链接安装：依赖解析到当前源码；注册表副本则交给路径探测。
    if (ownRoot !== null && resolved === ownRoot) return dir;
  }
  return null;
}

function readPluginName(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(resolve(PLUGIN_ROOT, 'package.json'), 'utf8')) as { name?: unknown };
    return typeof pkg.name === 'string' && pkg.name.length > 0 ? pkg.name : null;
  } catch {
    return null;
  }
}

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * 沿目录树向上探测 profile 候选：仅接受「已经跨过至少一个名为
 * node_modules 的路径组件」之后命中的目录（兼容 Windows 分隔符与
 * pnpm 嵌套结构；dev 源码 checkout 不跨边界 → 返回 null → 环境变量引导）。
 */
function findProfileAncestor(baseDir: string, probe: (dir: string) => string | null): string | null {
  let crossedNodeModules = false;
  let dir = baseDir;
  for (let i = 0; i < 32; i++) {
    if (basename(dir) === 'node_modules') crossedNodeModules = true;
    if (crossedNodeModules) {
      const hit = probe(dir);
      if (hit !== null) return hit;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * 解析环境变量占位配置
 */
export function resolveEnv(configValue: string, envKey: string): string {
  if (configValue && configValue !== '__FROM_ENV__' && !configValue.startsWith('process.env')) {
    return configValue;
  }
  return process.env[envKey] ?? '';
}

/**
 * 格式化相对时间
 */
export function formatRelativeTime(ts?: number): string {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s 前`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m 前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h 前`;
  return `${Math.floor(diff / 86_400_000)}d 前`;
}
