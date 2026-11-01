import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserSchema } from '../config.ts';
import { BrowserService, browserUrl, validateBrowserArgs } from './browser-service.ts';

const mocks = vi.hoisted(() => {
  const page = {
    isClosed: vi.fn(() => false), on: vi.fn(), close: vi.fn(async () => {}),
    goto: vi.fn(async () => {}), url: vi.fn(() => 'https://x.com/'), title: vi.fn(async () => 'X'),
    locator: vi.fn(() => ({ innerText: async () => 'a'.repeat(2000), ariaSnapshot: async () => '- link "Search"',
      click: vi.fn(), fill: vi.fn(), press: vi.fn() })),
    keyboard: { press: vi.fn() }, mouse: { wheel: vi.fn() }, screenshot: vi.fn(),
  };
  const context = { newPage: vi.fn(async () => page), close: vi.fn(async () => {}),
    on: vi.fn(), setDefaultTimeout: vi.fn(), setDefaultNavigationTimeout: vi.fn() };
  const browser = { contexts: () => [context], newContext: vi.fn(async () => context), close: vi.fn(async () => {}) };
  return { page, context, browser, launch: vi.fn(async () => context), connect: vi.fn(async () => browser) };
});
vi.mock('playwright-core', () => ({ chromium: { launchPersistentContext: mocks.launch, connectOverCDP: mocks.connect } }));
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(async () => {}) }));

afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

describe('browser input', () => {
  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,test', 'https://user:password@x.com'])('拒绝 %s', (url) => {
    expect(() => browserUrl(url)).toThrow();
  });
  it.each([{ action: 'eval' }, { action: 'open' }, { action: 'click' }, { action: 'fill', selector: 'input' },
    { action: 'press', key: '' }, { action: 'scroll', direction: 'left' }])('拒绝非法操作 %j', (args) => {
    expect(() => validateBrowserArgs(args)).toThrow();
  });
});

describe('BrowserService', () => {
  it('按需启动、独立目录、输出截断与复用标签页', async () => {
    const service = new BrowserService(BrowserSchema({ maxTextChars: 1000 }), 'C:/bot', 'C:/bot/tmp');
    expect(mocks.launch).not.toHaveBeenCalled();
    const result = await service.run({ action: 'open', url: 'https://x.com' });
    await service.run({ action: 'read' });
    expect(mocks.launch).toHaveBeenCalledWith(expect.stringContaining('.qqbot-browser'), expect.objectContaining({ channel: 'chrome', headless: false }));
    expect(mocks.context.newPage).toHaveBeenCalledTimes(1);
    expect((result.text as string).length).toBe(1000);
    await service.dispose();
    expect(mocks.context.close).toHaveBeenCalledOnce();
    await expect(service.run({ action: 'read' })).rejects.toThrow('已关闭');
  });

  it('中止后不导航', async () => {
    const service = new BrowserService(BrowserSchema({}), 'C:/bot', 'C:/bot/tmp');
    const abort = new AbortController();
    abort.abort();
    await expect(service.run({ action: 'open', url: 'https://x.com' }, abort.signal)).rejects.toThrow();
    expect(mocks.launch).not.toHaveBeenCalled();
    await service.dispose();
  });

  it('导航未完成时后续命令排队，避免同时改变页面', async () => {
    let release!: () => void;
    mocks.page.goto.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const service = new BrowserService(BrowserSchema({}), 'C:/bot', 'C:/bot/tmp');
    const first = service.run({ action: 'open', url: 'https://x.com' });
    await vi.waitFor(() => expect(mocks.page.goto).toHaveBeenCalledOnce());
    const second = service.run({ action: 'scroll' });
    await Promise.resolve();
    expect(mocks.page.mouse.wheel).not.toHaveBeenCalled();
    release();
    await Promise.all([first, second]);
    expect(mocks.page.mouse.wheel).toHaveBeenCalledWith(0, 800);
    await service.dispose();
  });

  it('运行中的导航收到取消时关闭自有页面', async () => {
    let fail!: (err: Error) => void;
    mocks.page.goto.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    mocks.page.close.mockImplementationOnce(async () => { fail(new Error('Page closed')); });
    const service = new BrowserService(BrowserSchema({}), 'C:/bot', 'C:/bot/tmp');
    const abort = new AbortController();
    const task = service.run({ action: 'open', url: 'https://x.com' }, abort.signal);
    const rejected = expect(task).rejects.toThrow('Page closed');
    await vi.waitFor(() => expect(mocks.page.goto).toHaveBeenCalledOnce());
    abort.abort();
    await rejected;
    expect(mocks.page.close).toHaveBeenCalledOnce();
    await service.dispose();
  });

  it('CDP 新建标签页，退出时只关闭自己的页面并断开连接', async () => {
    vi.stubEnv('QQBOT_BROWSER_CDP_ENDPOINT', 'http://localhost:9222');
    const service = new BrowserService(BrowserSchema({ mode: 'cdp' }), 'C:/bot', 'C:/bot/tmp');
    await service.run({ action: 'read' });
    await service.dispose();
    expect(mocks.context.newPage).toHaveBeenCalledOnce();
    expect(mocks.page.close).toHaveBeenCalledOnce();
    expect(mocks.browser.close).toHaveBeenCalledOnce();
    expect(mocks.context.close).not.toHaveBeenCalled();
  });

  it('CDP 异常不泄露带 token 的地址', async () => {
    vi.stubEnv('QQBOT_BROWSER_CDP_ENDPOINT', 'ws://localhost:9222/token-secret');
    mocks.connect.mockRejectedValueOnce(new Error('token-secret'));
    const service = new BrowserService(BrowserSchema({ mode: 'cdp' }), 'C:/bot', 'C:/bot/tmp');
    await expect(service.run({ action: 'read' })).rejects.toThrow('CDP 连接失败');
    await service.dispose();
  });
  it('群聊 CDP 创建并关闭隔离 context，不复用主人登录态', async () => {
    vi.stubEnv('QQBOT_BROWSER_CDP_ENDPOINT', 'http://localhost:9222');
    const service = new BrowserService(BrowserSchema({ mode: 'cdp' }), 'C:/bot', 'C:/bot/tmp', true);
    await service.run({ action: 'read' });
    expect(mocks.browser.newContext).toHaveBeenCalledWith({ acceptDownloads: false });
    await service.dispose();
    expect(mocks.context.close).toHaveBeenCalledOnce();
    expect(mocks.browser.close).toHaveBeenCalledOnce();
  });
});
