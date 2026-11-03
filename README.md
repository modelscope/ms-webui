<h1 align="center">ms-webui: Web workbench for ms-swift</h1>

<p align="center">
    <img src="webui/public/ms-webui5.png" width="360"/>
</p>
<p align="center">
<br>
        English&nbsp ｜ &nbsp<a href="README_ZH.md">中文</a>&nbsp
</p>

<p align="center">
<img src="https://img.shields.io/badge/node-%E2%89%A518-5be.svg">
<img src="https://img.shields.io/badge/react-18-61dafb.svg">
<a href="https://www.npmjs.com/package/@modelscope/ms-webui"><img src="https://img.shields.io/npm/v/@modelscope/ms-webui"></a>
<img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg">
<a href="https://github.com/modelscope/ms-webui/pulls"><img src="https://img.shields.io/badge/PR-welcome-55EB99.svg"></a>
</p>

## ✨ What is ms-webui?

ms-webui is the web interface of [ms-swift](https://github.com/modelscope/ms-swift) 5.x and twinkle.
It covers the full model workflow in one place: creating and monitoring training,
evaluation, export and deployment tasks, chatting with models through an agent
loop with tools and skills, running long-form research sessions, and composing
multi-step pipelines on a node canvas. The interface and the backend are one
program: the dev server hosts the task executors, model configuration and the
chat proxy, and all state lives on disk, so running jobs are not affected when
the page is closed.

🧩 <b>Full Task Lifecycle</b>: train / eval / export / deploy / script tasks, each with creation forms, live logs, metrics curves and history.<br>
🤖 <b>Agent Chat</b>: tool calling with per-session approval control, side-by-side multi-model comparison, streaming responses.<br>
🔬 <b>Research Sessions</b>: the agent iterates over a research goal across turns, with every conclusion recorded and traceable in a session ledger.<br>
🕸️ <b>Workflow Editor</b>: compose training, eval, merge and deploy steps as a node graph; each run is a separate instance with its own logs and snapshot.<br>
📁 <b>File-Based State</b>: task state is derived from files under <code>SWIFT_WEBUI_HOME</code> (default <code>~/.swift/webui</code>); jobs keep running when the webui stops, and every task directory contains a <code>run.sh</code> that can be replayed without the webui.<br>
🌍 <b>Bilingual Interface</b>: English and Chinese, with light / dark themes.<br>

## Installation

The webui drives a Python environment that provides ms-swift 5.x. The startup
command checks this requirement before binding a port, so install ms-swift
first (the same environment you would use for `swift` commands). Node.js 18 or
newer is needed only when running from source.

### Install from npm:

```shell
npm install -g @modelscope/ms-webui
ms-webui
```

The `ms-webui` command verifies `ms-swift >= 5.0` in the active Python
environment, then starts the server and prints its address. Point a browser at
it and you are done; no separate backend process is required.

### Run from source:

```shell
git clone https://github.com/modelscope/ms-webui.git
cd ms-webui/webui
npm install
npm run dev
```

## Features

- **Training**: creation form with parallelism planning and memory estimation,
  live output log, loss / lr curves from `metrics.jsonl`, and a comparison page
  across runs.
- **Evaluation, export, deployment**: the same create / list / detail pattern;
  a deployment is an attached `swift deploy` process, and once ready its
  endpoint is registered in the model configuration and selectable in chat.
- **Chat**: conversations against configured model endpoints, agent tool loop
  with an approval gate that can be disabled per session, and a compare mode
  that sends each turn to several models at once.
- **Research**: dedicated list and detail pages; sessions record the goal, the
  agent's tool calls and conclusions per iteration, and can be resumed.
- **Workflow**: node palette covering training, evaluation, LoRA merge and
  deploy steps; definitions are stored as YAML, runs are separate directories
  with a snapshot of the definition at launch time.
- **Models, plugins, skills**: model endpoints (API services or local
  deployments) are configured in the models page; plugins and skills extend
  what the agent can do.

## Skills

The chat agent can load skills — instruction documents that teach it how to
use a tool or a domain workflow. Skills are not authored in this repository:
at build time, `scripts/fetch-skills.mjs` copies them from the
[ms-swift](https://github.com/modelscope/ms-swift) repository and the
[modelscope-skills](https://github.com/modelscope/modelscope-skills)
repository into `public/skills/`, so the two source repositories remain the
single source of truth. `SWIFT_SKILLS_REF` and `MODELSCOPE_SKILLS_REF` select
which ref to fetch.

## License

Apache License 2.0.
