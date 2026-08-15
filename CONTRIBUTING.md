# Contributing

感谢你对 `dsh-plugin-ai-bridge` 的关注！欢迎提交 issue 与 PR。

## 开发环境

```sh
npm install        # 安装依赖
npm run typecheck  # 类型检查（严格模式）
npm run build      # 编译到 lib/
npm test           # 编译并运行全部测试
```

## 提交规范

- 一个 PR 只做一件事，附上清晰的动机说明。
- 新增行为请补充对应测试（`test/*.test.mjs`）。
- 保持 TypeScript `strict` 无错误，测试全绿。
- 提交信息采用 [Conventional Commits](https://www.conventionalcommits.org/)。

## 代码结构

见 [README · 架构](README.md#architecture)。外部模型协议改动集中在 `src/client.ts`，
提示词集中在 `src/prompts.ts`，命令分发集中在 `src/commands.ts`。

## 版权

本项目为 Apache-2.0 许可的独立实现，受 OpenAI `codex-plugin-cc` 启发但与 OpenAI 无关联。
请勿引入任何第三方专有代码；新增依赖需在 PR 中说明其许可证。
