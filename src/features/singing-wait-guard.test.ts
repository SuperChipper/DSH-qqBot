import { describe, expect, it } from 'vitest';
import { singingWaitGuard } from './singing-wait-guard.ts';

const agent = { session: { events: [] as Array<{ type: string; data: { jobId: string; label?: string } }> } };
const guard = singingWaitGuard((value) => value === agent);

describe('singingWaitGuard', () => {
  it.each([
    '.\\env\\python.exe scripts\\sing_client.py wait abc --timeout 900',
    '& "C:\\some dir\\sing_client.py" wait abc',
    'python scripts/sing_client.py --ensure wait abc',
    'python sing_client.py --url "http://127.0.0.1:8766" wait abc',
  ])('拒绝前台唱歌等待，即使显式给了长超时：%s', (command) => {
    expect(guard({ name: 'pwsh', agent, arguments: { command, timeoutMs: 960000 } })).toContain('run_in_background=true');
    expect(guard({ name: 'pwsh', agent, arguments: { command, run_in_background: true } })).toBeUndefined();
  });

  it('只管 QQ 会话和唱歌等待，提交、查状态、其他终端任务不受影响', () => {
    for (const command of ['python sing_client.py submit --song song.wav', 'python sing_client.py status abc', 'npm run build']) {
      expect(guard({ name: 'pwsh', agent, arguments: { command } })).toBeUndefined();
    }
    expect(guard({ name: 'pwsh', agent: {}, arguments: { command: 'python sing_client.py wait abc' } })).toBeUndefined();
    expect(guard({ name: 'pwsh', arguments: { command: 'python sing_client.py wait abc' } })).toBeUndefined();
  });

  it('拒绝把正在后台等待的唱歌作业重新阻塞等回来，完成后正常取结果', () => {
    const localAgent = { session: { events: [
      { type: 'job/registered', data: { jobId: 'pwsh-song', label: 'python sing_client.py wait abc' } },
      { type: 'job/registered', data: { jobId: 'pwsh-build', label: 'npm run build' } },
    ] } };
    const localGuard = singingWaitGuard((a) => a === localAgent);
    const output = (id: string, wait: boolean) => localGuard({ name: 'job_output', agent: localAgent, arguments: { job_id: id, wait } });
    expect(output('pwsh-song', true)).toContain('不要立即 job_output');
    expect(output('pwsh-song', false)).toBeUndefined();
    expect(output('pwsh-build', true)).toBeUndefined();
    localAgent.session.events.push({ type: 'job/settled', data: { jobId: 'pwsh-song', label: '' } });
    expect(output('pwsh-song', true)).toBeUndefined();
  });

  it('支持宿主 snapshotEvents 接口；缺少事件或参数不抛错', () => {
    const a = { session: { snapshotEvents: () => [{ type: 'job/registered', data: { jobId: 'j', label: 'python sing_client.py wait abc' } }] } };
    const localGuard = singingWaitGuard(() => true);
    expect(localGuard({ name: 'job_output', agent: a, arguments: { job_id: 'j', wait: true } })).toBeDefined();
    expect(localGuard({ name: 'job_output', agent: {}, arguments: { job_id: 'j', wait: true } })).toBeUndefined();
    expect(localGuard({ name: 'pwsh', agent: {}, arguments: null })).toBeUndefined();
  });
});
