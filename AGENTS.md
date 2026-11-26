# 抖音主页口播文案项目

- 用户给出抖音博主主页或分享短链时，在项目目录运行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\run.ps1 -Profile "<链接>"`。只需作品清单时加 `-CollectOnly`。
- 初次使用运行 `setup.ps1`。如果需要登录，打开 `login.ps1` 的可见浏览器，等用户在窗口内登录，再继续采集。登录资料保存在项目的 `.auth/`。
- 采集脚本通过可见浏览器滚动加载作品，并用主页计数核对作品覆盖。核对失败时先检查登录或重试，按实际采到的数量汇报。
- 转写跑在本机。已采齐作品而转写中断时，对相同的输入加 `-Resume` 续跑。结束时核对 `runs/<任务标识>/transcripts.csv` 的行数和「中文文案」非空数，必要时报告 `transcript-failures.csv`。
- 提交到 Git 的内容是源码和文档。保持 `.auth/`、`runs/`、`.cache/` 和本地依赖目录被忽略。
