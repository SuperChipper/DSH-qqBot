interface Execution {
  name: string;
  arguments: unknown;
  agent?: unknown;
}

interface JobEvent {
  type: string;
  data?: { jobId?: string; label?: string };
}

const SING_WAIT = /\bsing_client\.py["']?\s+(?:(?:--ensure|--url\s+(?:"[^"]*"|'[^']*'|[^\s;|]+))\s+)*wait(?:\s|$)/i;
const BACKGROUND_HINT = '唱歌已交给独立服务，前台等待会阻塞本聊天。请用 pwsh(run_in_background=true) 执行 sing_client.py wait <id>，拿到后台 job ID 后结束当前回合；完成通知到达后再取输出和发送成品，不要立即 job_output(wait=true)。';

function isPendingSingingWait(agent: unknown, id: string): boolean {
  const session = (agent as { session?: { events?: readonly JobEvent[]; snapshotEvents?: () => readonly JobEvent[] } }).session;
  const events = session?.events ?? session?.snapshotEvents?.() ?? [];
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.data?.jobId !== id) continue;
    if (event.type === 'job/settled') return false;
    if (event.type === 'job/registered') return SING_WAIT.test(event.data.label ?? '');
  }
  return false;
}

/** 调度约束放在工具入口，不依赖模型是否记得笔记，也不改角色表达。 */
export function singingWaitGuard(isQQAgent: (agent: unknown) => boolean): (exec: Execution) => string | undefined {
  return (exec) => {
    if (exec.agent === undefined || !isQQAgent(exec.agent)) return undefined;
    if (exec.arguments === null || typeof exec.arguments !== 'object') return undefined;
    const args = exec.arguments as Record<string, unknown>;
    if ((exec.name === 'pwsh' || exec.name === 'bash') && typeof args.command === 'string'
      && SING_WAIT.test(args.command) && args.run_in_background !== true) return BACKGROUND_HINT;
    if (exec.name === 'job_output' && args.wait === true && typeof args.job_id === 'string'
      && isPendingSingingWait(exec.agent, args.job_id)) return BACKGROUND_HINT;
    return undefined;
  };
}
