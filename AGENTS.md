# dsh-qqbot — 仓库约定

QQ Bot IM 插件（Cordis 插件，宿主为 deepseek-harness）。服务端 `src/`，浏览器侧
`src/client/`，构建产物 `dist/`（宿主）与 `lib/client.js`（Web 客户端，均有 gitignore）。

## 改配置项时：三处必须同步

`src/config.ts` 的 `ConfigSchema` 是唯一真源，但**只改它不会出现在设置页**。新增/修改字段时逐项检查：

1. `src/config.ts` — 字段 + 默认值 + 子 Schema（嵌套组导出成 `XxxSchema`，便于复用）。
2. `src/setup/bind-routes.ts` — `EDITABLE_CONFIG_KEYS` 加键、`EDITABLE_CONFIG_SCHEMAS` 挂校验；
   缺了这一步，设置页保存直接 400「不支持的字段」。
3. `src/client/config-panel.ts` — 加对应控件与 `ConfigWire` 字段；缺了这一步，配置只能手改
   `cordis.patch.yml`，设置页看不到（这个漂移已经发生过：notes、replyDesire 都是先漏了 UI）。
4. `src/setup/bind-routes.test.ts` — 至少覆盖：新键合法值通过、越界/类型错误被拒。

自查：`grep -n "<键名>" src/config.ts src/setup/bind-routes.ts src/client/config-panel.ts`，
三处都要有。嵌套组里**不上表单**的字段（密钥、复杂规则数组）必须在 POST 处从当前生效配置
回填，否则 Schema 默认值会把用户已保存的值冲掉（参考 `asr.apiKey`、`cleanup.rules`）。

## 密钥不上表单、不回传

`GET /qqbot/im-qqbot/config` 会剔除 `appSecret`，`asr.apiKey` 同样脱敏；新增密钥类字段照此处理，
表单只给「用环境变量/patch 配置」的提示。

## 构建与测试

```bash
npm run build            # tsc + tsdown，产出 dist/ 与 lib/client.js
npm run typecheck:client # 浏览器侧单独类型检查（tsconfig.client.json）
npx vitest run --pool=threads   # 默认沙箱里 video-tool 的真实 ffmpeg 用例会 EPERM，属环境限制
```

改了 `dist/` 或 `lib/client.js` 后，宿主**不会**自动重载插件代码：需要一次 profile 重组
（保存一次设置、或用插件管理器操作）才生效；只刷新浏览器只能拿到新的客户端 bundle。

## 约定

- 提交信息：`feat(scope): ...` / `fix(scope): ...`，scope 如 `settings` `media` `dnd` `notes`。
- 注释写「为什么」；不写复述代码的注释。
- 写回 `cordis.patch.yml` 遵守最小写入：只写用户提交的顶层键，不固化默认值。
- 纯规则逻辑（如回复欲望打分）优先放 `src/features/`，保持可单测、不依赖宿主。
