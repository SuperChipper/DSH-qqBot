/**
 * 清理命令：/bot-cleanup（仅 owner/admin）
 *
 *   /bot-cleanup       查看最近一次清理后的各目录占用
 *   /bot-cleanup run   立即清理一轮
 *   /bot-cleanup dry   试跑：列出会删什么，不删除
 */
import type { CommandDeps, CategorizedCommand } from './types.ts';
import { formatRelativeTime, isPrivilegedSender } from '../shared/index.ts';
import { formatBytes, getCleanupService, type CleanupReport } from '../media/cleanup.ts';

/** 试跑时每条规则最多列出的条目数 */
const MAX_LISTED = 8;

/** 把一轮报告渲染成文本 */
export function renderCleanupReport(report: CleanupReport, rules: ReadonlyArray<{ name: string; ttlHours: number; maxTotalMB?: number }>): string {
  const lines = [report.dryRun ? '🧹 清理试跑（未删除）' : `🧹 清理报告（${formatRelativeTime(report.at)}）`];
  for (const r of report.results) {
    const rule = rules.find(x => x.name === r.rule);
    const limits = [
      rule && rule.ttlHours > 0 ? `${rule.ttlHours}h` : '不按时间',
      rule?.maxTotalMB ? `上限 ${formatBytes(rule.maxTotalMB * 1024 * 1024)}` : '',
    ].filter(Boolean).join('，');
    let line = `· ${r.rule}：${r.remaining} 项 ${formatBytes(r.remainingBytes)}（${limits}）`;
    if (r.removed > 0) line += `，本轮删 ${r.removed} 项 ${formatBytes(r.freedBytes)}`;
    if (r.error) line += `，出错：${r.error}`;
    lines.push(line);
    if (r.wouldRemove.length > 0) {
      const shown = r.wouldRemove.slice(0, MAX_LISTED).join('、');
      const more = r.wouldRemove.length > MAX_LISTED ? ` 等 ${r.wouldRemove.length} 项` : '';
      lines.push(`  会删：${shown}${more}`);
    }
  }
  return lines.join('\n');
}

/** /bot-cleanup — 查看/触发定期清理 */
export function cleanupCommand({ config }: CommandDeps): CategorizedCommand {
  return {
    name: 'bot-cleanup',
    category: 'qqbot',
    description: '查看或立即执行临时文件清理（run 立即清理，dry 试跑）',
    authorized: (ctx) => isPrivilegedSender(ctx.message.senderId, config)
      || '⚠️ 只有 bot 主人或管理员可以查看和执行清理。',
    handler: async (cmdCtx) => {
      const service = getCleanupService();
      if (service === undefined) return '清理服务未启动';
      const arg = (cmdCtx.command?.raw ?? '').trim().toLowerCase();
      if (arg === 'run' || arg === 'dry') {
        const report = await service.run(arg === 'dry' ? true : undefined);
        return renderCleanupReport(report, service.rules);
      }
      if (arg !== '') return '用法：/bot-cleanup [run|dry]';
      const last = service.lastReport;
      return last ? renderCleanupReport(last, service.rules) : '还没有完成过清理，稍后再看，或发 /bot-cleanup run';
    },
  };
}
