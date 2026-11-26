# 抖音主页口播文案提取

输入一个抖音博主主页或分享短链，采集作品列表，逐条在本机转写视频里的口播。结果是一份 UTF-8 CSV，含发布日期、标题、点赞、评论、转发、视频链接和中文口播文案，可在 Excel 打开。

## Windows 首次使用

安装 Node.js 22 或更新版本、Python 3.11（带 Python Launcher）和 Git。克隆仓库或解压 ZIP，再在项目目录打开 PowerShell。运行安装脚本，接着在弹出的浏览器里登录抖音，回到终端按 Enter 保存登录状态。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\login.ps1
```

安装脚本会安装 Playwright、Chromium、FFmpeg、yt-dlp 和本地语音识别依赖。首次转写会下载约 900 MB 的 SenseVoice 模型，之后复用 `.cache/asr`。转写用电脑的 CPU，无需独立显卡或付费 API。

## 提取文案

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\run.ps1 -Profile "这里粘贴抖音博主主页或分享短链"
```

采集阶段会打开可见浏览器，通过滚动主页加载作品。脚本会核对主页显示的作品数与实际获取的链接，并对视频做转写。图文和文章只计入作品数。转写结果在 `runs/<任务标识>/transcripts.csv`，脚本结束时会打印完整路径。文案由模型自动识别，可按需校对。

同一个输入使用同一个任务目录。只需要视频清单时，在命令末尾加 `-CollectOnly`。如果作品采集已经完成而转写中断，使用同一个主页输入，加 `-Resume` 继续。结束后可查看同目录的 `transcript-failures.csv`。如遇到登录过期，重新运行 `login.ps1`。常用主页应保留同一种链接形式，以便复用进度。

## 换电脑或交给本机 Codex

在新电脑登录 GitHub 后克隆私有仓库，或从 GitHub 下载 ZIP 解压。把项目目录添加到 Codex，就可以告诉它「用这个项目提取这个抖音主页的口播文案」，并附上主页链接。项目内的 `AGENTS.md` 写明了入口和结果怎么核对。

GitHub 保存工具源码。新电脑按上面的步骤安装依赖并登录抖音。转写仍在本机执行。迁移时可以单独复制 `.cache/asr` 来复用模型，将旧 CSV 按需要自行保留。登录状态、模型、音频和运行结果由 `.gitignore` 排除。
