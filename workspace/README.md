# 演示工作目录（agent 的沙箱）

这个目录是给 **agent** 用的沙箱，不是给人放代码的地方。

`bundles/core.json` 里 `tools.workspace` 指向它，于是 agent 的
`read_file` / `write_file` / `list_dir` / `delete_file` 全都只能在这个目录内活动 ——
越界路径（`../outside.txt`、绝对路径）会被 `kernel/builtin-tools.ts` 的
`resolveInsideWorkspace` 和 `guard` 插件的 `pathGuard` 两道关卡挡下来。

## 为什么它要进版本库

因为它必须**存在**：`node src/apps/cli.ts "..."` 的第一步就是 `list_dir`，
目录不存在的话第一次工具调用就失败了。仓库里放一个空目录是做不到的
（git 不跟踪空目录），所以这里放了三个小文件。

运行产物不会污染仓库 —— `.sessions/`、`.checkpoints/`、`guard-demo/`
都在 `.gitignore` 里。

## 里面的文件

| 文件 | 用途 |
| --- | --- |
| `README.md` | 这份说明；也是 CLI 演示里被 `read_file` 读的那个文件 |
| `important.txt` | 守卫的拦截目标：`delete_file` 属于不可逆操作，默认审批人一律拒绝 |
| `notes.txt` | 让 `list_dir` 有多条结果可看 |

## 想清理它

```powershell
# 只删运行产物，保留上面三个文件
Remove-Item -Recurse -Force workspace/.sessions, workspace/.checkpoints, workspace/guard-demo
```
