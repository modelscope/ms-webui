<h1 align="center">ms-webui: ms-swift 的网页工作台</h1>

<p align="center">
    <img src="webui/public/ms-webui5.png" width="360"/>
</p>
<p align="center">
<br>
        <a href="README.md">English</a>&nbsp ｜ &nbsp中文&nbsp
</p>

<p align="center">
<img src="https://img.shields.io/badge/node-%E2%89%A518-5be.svg">
<img src="https://img.shields.io/badge/react-18-61dafb.svg">
<a href="https://www.npmjs.com/package/@modelscope/ms-webui"><img src="https://img.shields.io/npm/v/@modelscope/ms-webui"></a>
<img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg">
<a href="https://github.com/modelscope/ms-webui/pulls"><img src="https://img.shields.io/badge/PR-welcome-55EB99.svg"></a>
</p>

## ✨ ms-webui 是什么？

ms-webui 是 [ms-swift](https://github.com/modelscope/ms-swift) 5.x 的网页界面。
它把模型工作的完整流程收进一个入口：创建并监控训练、评测、导出、部署任务，
通过带工具和技能的 agent 循环与模型对话，运行长周期的研究会话，以及在节点
画布上编排多步流水线。界面和后端是同一个程序：dev server 承载任务执行器、
模型配置和对话代理，全部状态落在磁盘上，因此关闭页面不影响正在运行的任务。

🧩 <b>完整任务生命周期</b>：train / eval / export / deploy / script 五类任务，均有创建表单、实时日志、指标曲线与历史记录。<br>
🤖 <b>Agent 对话</b>：工具调用带会话级审批开关，支持多模型并排对比与流式输出。<br>
🔬 <b>研究会话</b>：agent 围绕研究目标跨轮次迭代，每轮结论记入会话账本，可追溯、可继续。<br>
🕸️ <b>工作流编辑器</b>：把训练、评测、合并、部署步骤拼成节点图；每次运行是独立实例，有自己的日志与定义快照。<br>
📁 <b>文件即状态</b>：任务状态由 <code>SWIFT_WEBUI_HOME</code>（默认 <code>~/.swift/webui</code>）下的文件推导；webui 停止不影响在跑任务，每个任务目录里的 <code>run.sh</code> 可以脱离 webui 直接重放。<br>
🌍 <b>双语界面</b>：中英文切换，支持浅色 / 深色主题。<br>

## 安装

webui 驱动的是一个提供 ms-swift 5.x 的 Python 环境。启动命令会在绑定端口
之前校验这一前提，因此请先安装 ms-swift（与你运行 `swift` 命令所用的环境
一致）。Node.js 18 及以上仅在从源码运行时需要。

### 使用 npm 安装：

```shell
npm install -g @modelscope/ms-webui
ms-webui
```

`ms-webui` 命令先校验当前 Python 环境中 `ms-swift >= 5.0`，然后启动服务并
打印访问地址。浏览器打开即可使用，不需要单独的后端进程。

### 从源码运行：

```shell
git clone https://github.com/modelscope/ms-webui.git
cd ms-webui/webui
npm install
npm run dev
```

## 功能

- **训练**：创建表单带并行规格规划与显存估算，实时输出日志，来自
  `metrics.jsonl` 的 loss / lr 曲线，以及跨运行的对比页面。
- **评测、导出、部署**：与训练相同的创建 / 列表 / 详情模式；部署是一个
  attached 的 `swift deploy` 进程，就绪后 endpoint 自动登记进模型配置，
  对话页可直接选用。
- **对话**：与已配置的模型 endpoint 对话；agent 工具循环带审批门（可按会话
  关闭）；对比模式把每一轮同时发给多个模型。
- **研究**：独立的列表与详情页；会话记录研究目标、agent 的工具调用与每轮
  结论，可以继续推进。
- **工作流**：节点面板覆盖训练、评测、LoRA 合并、部署步骤；定义以 YAML
  存储，每次运行是独立目录，含启动时定义的快照。
- **模型、插件、技能**：模型页配置模型 endpoint（API 服务或本地部署）；
  插件与技能扩展 agent 的能力面。

## 技能

对话 agent 可以加载技能——教它如何使用某个工具或某套领域流程的说明文档。
技能不在本仓库内编写：构建时 `scripts/fetch-skills.mjs` 会从
[ms-swift](https://github.com/modelscope/ms-swift) 仓库和
[modelscope-skills](https://github.com/modelscope/modelscope-skills) 仓库
拷贝到 `public/skills/`，两个源仓库保持唯一事实源。`SWIFT_SKILLS_REF` 与
`MODELSCOPE_SKILLS_REF` 用于选择拉取的 ref。

## 许可证

Apache License 2.0。
