import type { DshAgent } from '../session/types.ts';

/** QQ 的 watchdog 只能取消自己交给 agent 的活动，收敛后立即解绑。 */
export async function runInboundTurn(
  agent: Pick<DshAgent, 'followup' | 'whenIdle' | 'cancel'>,
  message: unknown,
  signal: AbortSignal,
  onSubmitted: () => void,
): Promise<void> {
  // 附件下载、会话恢复可能已经耗尽了超时，不能再启动一个迟到的回合。
  if (signal.aborted) return;
  const cancel = () => agent.cancel({ kind: 'user' });
  signal.addEventListener('abort', cancel, { once: true });
  try {
    agent.followup(message);
    onSubmitted();
    await agent.whenIdle();
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}
