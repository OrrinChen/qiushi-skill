# 平台接入

核心资产只有三样：`skills/`、`commands/`、`hooks/`。任何能读 Markdown skill 的宿主都能用；下面只说每个平台把文件放到哪里。

## 一条命令装到任何平台

```bash
npx qiushi-skill                      # 交互式，自动检测已安装的宿主
npx qiushi-skill install --target <platform> --scope user|project
npx qiushi-skill install --target codex --scope user --adopt-legacy
npx qiushi-skill uninstall --target <platform>
npx qiushi-skill validate
```

| `--target` | 复制内容 | 用户级目标目录 |
|---|---|---|
| `claude-code` | 完整 plugin bundle（skills、commands、agents、hooks） | `~/.claude/plugins/qiushi-skill` |
| `cursor` | 完整 plugin bundle | `~/.cursor/plugins/qiushi-skill` |
| `codex` | `skills/*` | `~/.codex/skills`（或 `$CODEX_HOME/skills`） |
| `opencode` | `skills/*` + `commands/*.md` | `~/.config/opencode/skills` 与 `~/.config/opencode/commands` |
| `openclaw` | `skills/*` | `~/.openclaw/skills/qiushi-skill` |
| `hermes` | `skills/*` | `~/.hermes/skills/qiushi-skill` |
| `nanobot` | `skills/*` | `~/.nanobot/workspace/skills` |
| `all` | 以上全部 | |

`--scope project` 改为写入当前目录下对应的 `.claude/`、`.cursor/`、`.codex/`、`.opencode/`、`.hermes/`、`.nanobot/` 或 `skills/`。skills-only 与 skills+commands 目标会写入 `.qiushi-skill-install.json`，卸载时只删除 CLI 管理过的条目。Claude Code 与 Cursor 的专用 bundle 目录按事务整体更新；该专用目录不能是符号链接，卸载会删除整个 `qiushi-skill` bundle 目录。

`--adopt-legacy` 只用于首次接管受支持的旧版手动复制型、skills-only 安装（当前包括 1.3.1 官方快照，例如 Codex）。完整 skill 目录树必须与受支持的官方快照一致（Markdown 的 CRLF/LF 换行差异不影响识别）；安装器会先备份到目标目录下的 `.qiushi-skill-backups/`，有额外文件或内容修改则停止而不覆盖。

## 平台原生入口

- **Claude Code**：`/plugin marketplace add HughYau/qiushi-skill` 然后 `/plugin install qiushi-skill@qiushi-skill`；源码方式 `claude --plugin-dir .`。SessionStart hook 会自动注入入口 skill。
- **OpenClaw**：也可走其 marketplace：`openclaw plugins install qiushi-skill --marketplace HughYau/qiushi-skill`，然后 `openclaw plugins enable qiushi-skill`。
- **Hermes Agent**：安装后 `hermes skills list` 确认，启动时带上 `--toolsets "skills,terminal"`。
- **其他宿主**：把 `skills/` 下的目录复制到宿主的 skills 目录即可；支持 Markdown slash command 的宿主再复制 `commands/`。

## 没有 Node.js 时

直接复制目录即可：

```bash
cp -R skills/* <宿主的 skills 目录>/
```

macOS / Linux 的 SessionStart hook 需要 Bash。Windows 上 `hooks/run-hook.cmd` 会优先执行 `hooks/session-start.ps1`，不需要 Git Bash 或 WSL。仓库自检可用 `tests/validate.sh` 或 `tests/validate.ps1`。
