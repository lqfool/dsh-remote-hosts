# dsh-remote-hosts

在 DeepSeek Harness 的左侧栏加一个「远程主机」面板：点一下连接，就在那台机器上跑它自己的 DSH Web GUI，你在浏览器里操作的是**远端**的工作目录、终端和工具。

本机只做一件事：一条 SSH 端口转发。

- 远端进程按**登录者自己的账户**运行，工作目录 `/user/<你的用户名>`，配置在 `/user/<用户名>/.dsh`
- 账户在连接时自动识别，不需要在配置里写自己叫什么
- 一键把本机的模型 provider、默认模型和 API key 同步到远端

## 它是怎么工作的

```
你的电脑                          远端主机
┌──────────────┐                ┌────────────────────────────┐
│ DSH GUI      │   SSH -L       │ dsh web --host 127.0.0.1   │
│ 127.0.0.1:   │ ─────────────► │        --port 60727        │
│   60728      │                │ 以 <账户> 身份运行          │
└──────────────┘                │ DSH_HOME=/user/<账户>/.dsh │
                                └────────────────────────────┘
```

连接时这个插件会：

1. 探测远端是否已经有一个 `dsh web` 在目标端口上应答（有就直接复用，不重启）
2. 没有的话，清掉同端口的旧监听进程，再启动一个新的
3. 建一条本地端口到远端端口的 SSH 隧道，把带 token 的 URL 交给面板

## 账户是怎么自动识别的

不做任何配置时，连接/同步的第一步是确定"这个人对应远端哪个目录"：

1. 配置里显式写了 `remoteHome` → 直接用（最高优先级，不做猜测）
2. 否则按顺序产生候选名：
   - 主机上写的 `user`
   - Teleport 身份：`tsh status --format=json` 的 `active.username`（其次 `traits.user_id`）
   - 目标机名里嵌的用户名片段（`devspace-alice-lq-dev-gpu-1` → `alice`）
   - SSH 登录名
3. 候选名逐个在远端验证 `[ -d /user/<候选> ]`，**第一个真实存在的**被采用
4. 一个都不存在时，退回登录账户自己的 `$HOME`

关键点：候选项必须**在远端真的存在**才算数。所以配置写错了名字，也不会把某个人送进别人的目录，而是继续往后找。

确定账户后，插件会生成一个该账户专属的启动器（已存在则覆盖）：

```bash
# /usr/local/bin/dsh-<账户>
#!/bin/bash
set -a; . /user/<账户>/.dsh/env; set +a
cd /user/<账户>
exec /user/<账户>/.local/bin/dsh "$@"   # 没有就用 PATH 里的 dsh
```

`/usr/local/bin` 不可写时退到 `/user/<账户>/.local/bin/dsh-<账户>`。

## 首次连接会自己装

如果那个账户下还没有 DSH，点「连接」时插件会自己装好，不需要你上机器操作：

```
/user/<账户>/.local       ← @deepseek-ai/dsh 装在账户自己的前缀下
/user/<账户>/.npm-cache   ← npm 缓存也放在账户下，不污染系统
/user/<账户>/.dsh         ← 全部状态：sessions / storages / profiles / env
```

**不会往系统前缀写任何东西**，别人的安装和你的互不影响。

安装是**后台任务**：一次要下几个 G，不能卡在一个 HTTP 响应里。所以点连接后会立刻返回、状态变成「安装 DSH 中…」，面板每 5 秒轮询，装完自动继续启动，最终变「在线」。耗时取决于网速（内网缓存命中时约 2 分钟）。

前提是远端有 `node` 和 `npm`（没有的话会明确报错，不会静默失败）。需要哪些包的安装脚本能跑，用 `install.allowScripts` 控制——不跑这些脚本，终端和子进程这类原生模块会缺，远端 GUI 起来也干不了活。

```yaml
install:
  version: latest          # 或固定成某个版本
  allowScripts:            # 允许执行安装脚本的包
    - node-pty
    - koffi
    - '@deepseek-ai/dsh-subprocess-local'
    - '@google/genai'
    - protobufjs
  timeoutMs: 1800000
```

> 账户目录本身不会被创建。`/user` 在多数集群上对普通写入是只读的，插件因此只**探测已存在的** `/user/<名字>`，不会替你 `mkdir`——那应该是集群管理员的事。探测不到就退回登录账户自己的 `$HOME`。

## 安装

拿到源码或仓库地址都能装。下面四步是从零到能用的全过程。

### 1. 装进你的 profile

```bash
cd ~/.dsh/profiles/<profile>

# 直接从 GitHub（公开仓库，无需登录）
pnpm add github:lqfool/dsh-remote-hosts

# 或者本地检出
pnpm add link:/path/to/dsh-remote-hosts

# 或者发布到 npm 之后
pnpm add dsh-remote-hosts
```

也可以走 DSH 的插件管理界面，它会替你跑 pnpm。

### 2. 启用 bundle

把它加进该 profile `package.json` 的 `dsh.profile.bundles`：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-remote-hosts"
      ]
    }
  }
}
```

（用插件管理界面打开的话，这一步它会帮你写。）

### 3. 配置你要连的机器

在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里加一行，示例见下一节。

### 4. 重启应用

左侧栏出现「远程主机」面板即成功。点「连接」，插件会自己识别账户、装 DSH、起服务。

### 配置

本仓库的 `cordis.patch.yml` **故意不带任何主机**：机器名属于使用者，不属于包。

在自己的 profile 层 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里覆盖这一行（按 id 覆盖时 `config` 是整体替换，不深合并，所以要写全）：

```yaml
- id: remote-hosts
  name: 'dsh-remote-hosts'
  config:
    tsh: /usr/local/bin/tsh          # 从 Finder 启动的应用 PATH 很干净，建议写绝对路径
    hosts:
      - id: dev
        label: 开发机
        target: my-teleport-host     # tsh ssh 的目标
        login: root                  # SSH 登录名
        localPort: 60728             # 本机监听端口
        remotePort: 60727            # 远端 dsh web 端口
        # 以下都可省略，省略即自动识别
        # user: alice
        # remoteHome: /user/alice
        # remoteDsh: /usr/local/bin/dsh-alice   # 指定后就不再生成启动器
    sync:
      userRoot: /user                # 每人一个目录的父目录
      profile: desktop               # 从本机哪个 profile 取模型配置
      rows:                          # 取哪些配置行，原样推送
        - agent-default-model
        - llm-pi-ai
      profiles:                      # 推到远端哪些 profile
        - web
        - tui
        - headless
    install:
      version: latest                # 首次连接时装哪个版本
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `tsh` / `ssh` | `tsh` / `ssh` | 客户端可执行文件，建议绝对路径 |
| `hosts[].transport` | `tsh` | `tsh` 或 `ssh` |
| `hosts[].user` | — | 账户名候选，仍需在远端存在 |
| `hosts[].remoteHome` | — | 直接指定目录，不做识别 |
| `hosts[].remoteDsh` | — | 指定启动器，指定后不生成 |
| `hosts[].localPort` | `60728 + 序号` | 本机监听端口 |
| `hosts[].remotePort` | `60727` | 远端 dsh web 端口 |
| `sync.userRoot` | `/user` | 账户目录的父目录 |
| `install.version` | `latest` | 首次连接时装哪个版本 |
| `install.allowScripts` | 见上 | 允许执行安装脚本的包，缺了原生模块会不可用 |
| `install.timeoutMs` | `1800000` | 安装超时（30 分钟） |
| `connectTimeoutMs` | `90000` | 等待远端起服务的时间 |

## 自动发现机器

不用把机器名写死。打开 `discover` 后，插件自己跑 `tsh ls` 拉取集群节点，新机器出现就自动进面板，下线就自动消失：

```yaml
config:
  tsh: '/path/to/tsh'
  hosts: []                 # 可以留空
  discover:
    match: 'devspace-*'     # 只发现匹配的节点；* 是通配，不含 * 时按子串匹配
    login: root
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `discover.match` | 全部 | 主机名过滤，支持 `*`，可写多个 |
| `discover.exclude` | — | 命中就不显示 |
| `discover.clusters` | 全部 | 按 Teleport 集群标签过滤（`huhehaote`、`zhuhai` 之类） |
| `discover.login` | `root` | 发现出来的机器用哪个登录名 |
| `discover.ttlMs` | `30000` | 多久重新拉一次，最少 5 秒 |

行为说明：

- **`hosts` 里的条目优先**。发现结果和它 target 相同的会被跳过，所以想给某台机器固定标签或端口，照旧写一条进去即可
- `tsh ls` 失败（登录过期、代理不通）时**保留上一次的列表**，面板不会突然清空
- 发现的主机端口同样按 id 固定，机器增减不会让已有机器的端口乱跳

> 前提：`tsh ls` 要能跑通。用 Teleport 的人本来就有这个能力，不是额外依赖。

## 改主机不用重启

面板每 5 秒轮询一次，服务端顺带重读 `cordis.patch.yml`：新增、删除、改顺序的主机**下一次轮询就生效**，不用重启应用。

- 改动检测是内容比对，文件没变就不解析，轮询开销可以忽略
- 删掉正在连接的主机，会一并断开它的隧道
- 文件写坏（YAML 语法错）时保持上一次可用的配置，面板不会变空
- 自动分配的 `localPort` 按 id 记住：往列表中间插一台机器，已有主机的端口不会被挪动；显式写了 `localPort` 的以你写的为准

> 这条通道依赖 `DSH_PROFILE_DIR`（Host 进程自带）来定位你的 profile 目录。拿不到该变量时，热重载静默失效，退回到"重启后生效"，其它功能不受影响。

## 同步按钮

面板上每台机器有一个「同步配置」按钮，**手动触发**，不会在连接时自动跑：

- 读本机 `~/.dsh/profiles/<sync.profile>/cordis.patch.yml` 里 `sync.rows` 指定的行，原样推送
- 读本机 `~/.dsh/.credentials.yaml` 里的 `refs:`，以 `export KEY='...'` 写进远端的 env 文件（权限 600）
- 推到 `remoteHome/.dsh/profiles/<profile>/cordis.patch.yml` 和 `remoteHome/.dsh/env`

**以本机为准，远端这些文件会被整体覆盖。** 在远端正手改过的东西，同步一次就没了。

为什么用 env 文件而不是复制 `.credentials.yaml`：远端读取 provider key 走的是环境变量（`apiKeyEnv`），凭据文件在那边不生效。

## 多台主机同时用

每台主机一条独立的 SSH 转发，各占一个本地端口，可以同时开着：

```
你的 Mac                                远端
127.0.0.1:60728 ──ssh -L──>  主机A  127.0.0.1:60727  (dsh web)
127.0.0.1:60729 ──ssh -L──>  主机B  127.0.0.1:60727  (dsh web)
```

- `localPort` 默认 `60728 + 序号`，自动错开；想固定就显式写
- `remotePort` 默认 `60727`。不同机器上同名端口互不冲突
- 浏览器里各开一个标签页，互不干扰

已实测：两台主机并发连接同时 `online`，断开其中一台不影响另一台。

互不干扰的原因不是端口，而是 cookie 名带实例标识（`dsh-auth-<哈希>`），所以多个 `127.0.0.1` 端口不会互相顶掉登录态。

两个注意：

1. **同一台机器配两次时 `remotePort` 必须错开**。连接时会按端口 `pkill` 远端进程，端口相同就会互相踢下线。
2. 关掉 DSH 应用会停掉所有转发；但远端的 dsh 是 `setsid nohup` 起的，不会跟着退，下次连接是秒连。

## 发布到 npm（可选）

仓库地址已经够用；如果想让别人写 `pnpm add dsh-remote-hosts` 就行，发布一次：

```bash
npm login            # 用你自己的账号
cd /path/to/dsh-remote-hosts
npm publish
```

`dsh-remote-hosts` 这个名字在 npm 上目前是空的。若已被占用，改用 scope：

```bash
npm publish --access public        # 名字改成 @<org>/dsh-remote-hosts 后
```

改 scope 时**三处必须同步**：`package.json` 的 `name`、`cordis.patch.yml` 里 `insert.name`、`client.js` 顶部的模块 `id`。三处不一致的话，面板会加载不出来。

发布包只带 `index.js`、`client.js`、`cordis.patch.yml`、`locale/`、`icon.svg`、`README.md`、`LICENSE`（约 19 KB），不会带任何本机配置。

## 安全说明

- 本机的 API key 是**明文**推送到远端的 `env` 文件（权限 `600`），和远端原本存 key 的方式一致
- 同步会覆盖远端同名文件，包括你在远端加过的 provider
- 远端 `dsh web` 只监听 `127.0.0.1`，靠 SSH 隧道访问；不要把 `--host` 改成 `0.0.0.0`
- 面板的接口受 DSH 的 connection 信任栅栏保护，只接受同源请求

## 已知限制

- 一个主机一条隧道：同一台机器配成两个 host 时，`remotePort` 必须错开，否则连接时按端口 pkill 会互相踢下线
- 退出应用不会回收隧道进程。插件启动时会按 `-L 本地端口:…` 精确匹配清掉上一次留下的隧道；如果那个端口被别的东西占着，报错会直接说明
- 断线不会自动重连，重新点「连接」即可
- 只在 Linux 远端 + macOS 客户端上验证过

## License

MIT
