# ADR 0009：Android 工具链整包装进仓库内的 `.android-env/`，不用 Android Studio + 全局 SDK

> 定位：确定 Android 构建工具链的**落点与形态**（装哪儿、谁导出环境、怎么删干净），以及它与「`gen/android` 工程入库」这条相邻选择的边界。
> 读者：在本机出 Android 包的人、需要在一台新机器上复现构建的 AI agent、评估磁盘与备份影响的人。
> 更新时机：工具链落点或引导方式变化（例如改用容器 / CI 出包）、`scripts/android-env.sh` 的用法或导出变量集合变化、目标平台增减（iOS / Windows 端开工）。

| 项 | 值 |
|---|---|
| 状态 | Accepted |
| 日期 | 2026-09-15 |
| 决策者 | 项目作者 |
| 影响面 | `scripts/android-env.sh`、根 `.gitignore`、`apps/desktop/src-tauri/gen/android/`、`docs/operations.md` §5、`README.md` §8、`AGENT.md` §2/§3 |
| 相关文档 | [`0001-tauri-over-flutter.md`](0001-tauri-over-flutter.md)、[`0008-frontend-stack.md`](0008-frontend-stack.md)、[`../operations.md`](../operations.md) §5.3–§5.7、§5.12、[`../roadmap.md`](../roadmap.md) §2.2 |

## Context

阶段 5 要出 Android 产物，而官方路径（Tauri 2 Prerequisites）要求一串**装进宿主机**的东西：

| 官方要求 | 官方给的安装方式 |
|---|---|
| Android Studio | developer.android.com/studio |
| Android SDK（Platform / Platform-Tools / Build-Tools / Command-line Tools）与 NDK | Android Studio 的 SDK Manager |
| `JAVA_HOME` | 指向 Android Studio 自带的 JBR |
| `ANDROID_HOME` / `NDK_HOME` | 手工 `export`，指向 `~/Library/Android/sdk` 之类 |
| Rust 的四个 Android ABI target | `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android` |

当时的约束与已排除项：

- **本项目自用、不发布**，没有「团队成员环境对齐」这种需求，但**有**「换机器 / 隔一阵子回来还能一键重建」的需求（`docs/operations.md` 与 `AGENT.md` 的存在本身就是为了这个）。
- **宿主侧要尽量不动**：本项目是自用客户端，使用者（即作者）不希望为了出一个 APK 在 `/Applications`、`~/Library/Android`、`~/.gradle`、`~/.rustup` 里铺一层全局状态——全局状态的代价是「删不干净」与「以后很难判断某次构建依赖了哪一层」。
- **本项目不需要 IDE**：Android 侧的工程改动集中在一个薄壳（入口、数据目录、`open_url`、签名配置），出包是命令行行为；Android Studio 提供的价值（IDE、模拟器管理器 UI、模板向导）对本项目都非必需。
- **需要在「同一台机器上并存两套 Android 工具链」这件事上留后路**（换 ndk / targetSdk 时试新版本、出问题时退回旧版本），因此工具链的位置要是「可整包丢弃」的。
- **官方文档就是本仓库的对照表**：`docs/operations.md` §5.4 逐项对齐官方 Prerequisites，改口径必须同时留下「为什么偏离官方」。

Android 端此前从未构建过（`docs/roadmap.md` §2.2 把「缺工具链」列为待拍板项），因此这是**第一次**决定工具链落点。

## Decision

把整套 Android 工具链装进**仓库目录内**的 `.android-env/`，由 `scripts/android-env.sh` 引导；宿主侧不装任何东西。

| 项 | 选择 |
|---|---|
| 落点 | `<repo>/.android-env/`（根 `.gitignore` 忽略；不进仓库、不进版本控制） |
| 引导 | `scripts/android-env.sh`：`. scripts/android-env.sh`（source 导出）/ `bootstrap`（从零安装，可重复执行）/ `clean`（停 gradle daemon 与 adb server 后整包删除）/ `help` |
| JDK | Temurin **17.0.20.1**（默认）与 **21.0.12.1**（备选，`ANDROID_JDK=21` 切换），都在 `.android-env/jdk17` / `jdk21` |
| SDK | `.android-env/sdk`：`build-tools;35.0.0`、`cmdline-tools;latest 23.0.0`、`emulator;37.1.11`、`ndk;27.0.12077973`、`platform-tools;37.0.1`、`platforms;android-35`、`platforms;android-36`、`system-images;android-35;google_apis;arm64-v8a` |
| Rust | 项目内 `RUSTUP_HOME` / `CARGO_HOME`：rustc & cargo **1.98.1** + 四个 android target |
| Gradle | `GRADLE_USER_HOME=.android-env/gradle-home`，写入 `org.gradle.daemon=false` |
| 设备侧 | `ANDROID_USER_HOME` / `ANDROID_AVD_HOME` 也在 `.android-env/`（AVD 建在仓库内） |
| 总量 | 约 **14 GB**，一条 `clean` 全部消失 |
| 宿主足迹 | 无（`~/.gradle`、`~/Library/Android`、`~/.rustup` 都不会被创建）；例外只有宿主自身那份 `cargo` 跑过本 workspace 时产生的几 KB 索引元数据 |

与相邻但**不同**的一条选择（一并记在这里，避免以后被混为一谈）：**`apps/desktop/src-tauri/gen/android/` 是要入库的源码**（长期维护，只有每次构建都会重生的 `gen/schemas/` 被忽略），而 `.android-env/` 是**不入库的一次性环境**。前者是「工程」，后者是「工具」。

## Consequences

### 正面

- **可无痕删除**：`scripts/android-env.sh clean` 一条命令回到「这台机器上没做过 Android」的状态，且它不会碰签名材料（`gen/android/keystore.*` 不在 `.android-env/` 内，见 [`../operations.md`](../operations.md) §5.7、§5.12）。
- **换机器 / 新 agent 可一键复现**：`bootstrap` → `source` → 出包，三步；不需要读官方 Prerequisites 再手工决定装到哪儿。
- **不使用 Android Studio**：命令行即可完成构建，仓库里没有任何 IDE 配置需要维护。
- **两套 JDK 并存**：`ANDROID_JDK=21` 切换，互不覆盖；换 NDK / targetSdk 时同样可以「再装一份、对比、丢弃」。
- **构建状态可判定**：出问题时「工具链就是 `.android-env` 那一份」，不存在「某次构建偷偷用了宿主 SDK」这种难以自查的情形。
- **重装成本明确写进文档**：删掉后要重新下载数 GB，这件事在 `operations.md` §5.12 写明，不需要临场判断。

### 负面

- **磁盘占用记在仓库目录上**（约 14 GB）：备份 / 同步工具若扫仓库目录会多扫这 14 GB（构建产物 `target/` 与 `.android-env/` 都要靠 ignore 规则挡住）。
- **新克隆的仓库不是「开箱可出包」**：`.android-env/` 不入库，因此每个新机器都要重跑 `bootstrap`（数 GB 下载）。
- **脚本要多环境兼容**：`source` 会污染调用者 shell，因此顶层绝不能 `set -e`，子命令要在自己的子 shell 里开严格模式；同时要能跑在 bash / zsh / dash 下——这层复杂度是这条决策直接买来的。
- **NDK 的 `darwin-x86_64` 目录名与 Apple Silicon 不一致**：里面绝大多数是通用二进制，原生化没问题，但用到 `yasm` 的构建才需要 Rosetta 2（实测 53 个可执行文件里只有 `yasm` 是纯 x86_64）。
- **AVD 与 emulator 也在仓库内**：好处是自包含，代价是 AVD 的镜像与快照会挤进仓库目录（且 `clean` 会一起删）。

### 风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| 误以为「仓库自带工具链」 | `.android-env/` 被 ignore，`git clone` 后并不存在 | `operations.md` §5.4 明写「前置条件 = 先 bootstrap」；§5.12 给重建命令 |
| `clean` 被误当成「连签名一起清掉」 | 签名材料在 `gen/android/` 下、不在 `.android-env/` 内 | 两处文档都点了名（§4.3、§5.7、§5.12）；`gen/android/.gitignore` 里也写了同一条注 |
| 工具链与仓库目录耦合 | 将来若把仓库放到网络盘 / 同步盘，14 GB 与 AVD 会很难受 | 届时改用容器或宿主级工具链；本 ADR 的 Alternatives 里已记下重新启用的条件 |
| 脚本长期不跑而腐烂 | `bootstrap` 依赖上游包名与仓库地址 | 包名集中在脚本顶部常量；`clean` / `bootstrap` 的失败路径只告警不静默成功 |

## Alternatives considered

### 1. 官方路径：Android Studio + 全局 SDK / NDK / `ANDROID_HOME`

否决理由：为了出包在 `/Applications` 与 `~/Library/Android` 铺一层全局状态，而本项目用不到 IDE 的任何能力（工程改动是一个薄壳，构建是命令行行为）；全局状态一旦铺开，删除与「这次构建到底用了哪一层」都更难判定，与本项目「自用、可核对、可复现」的口径相悖。

重新启用的条件：需要长期做 Android 侧复杂原生开发（自定义 Kotlin 模块、调试 JNI），从而真正用得上 IDE 的调试与检查能力时——那时可以把 IDE 当**附加工具**，工具链仍留在仓库内。

### 2. 用宿主包管理器装（Homebrew 的 temurin / android-commandlinetools / android-ndk）

否决理由：虽然比 Android Studio 轻，但同样把版本与存在性交给宿主（版本会随 `brew upgrade` 漂移，且 `brew` 装不了指定版本的 NDK 组合）；与「两套并存的试探」也不兼容——同一时刻只能有一个 `temurin@17`。跨机器复现时还得再记一串 `brew` 命令。

重新启用的条件：工具链体积成为硬约束（例如磁盘紧张）而构建复现的确定性可以退让。

### 3. 只在 CI 上出包，本地不装工具链

否决理由：本项目自用、产物只装自己的设备（[`0001-tauri-over-flutter.md`](0001-tauri-over-flutter.md) 的「自用不发布」口径）；把出包挪到 CI 要新增一条与「自用单机」不相称的发布通道，且失败时的排障（logcat、模拟器截图）在本地更直接。此外 iOS 端未开工、Windows 端 `macOS 无法交叉编译`，CI 也解决不了全部平台。

重新启用的条件：Android 端需要产出可追溯的固定版本构建（例如给多台设备发同一份包）。

### 4. 容器 / 虚拟环境（Docker 镜像内装工具链）

否决理由：容器里跑 Gradle 与模拟器需要额外的设备直通与显示方案，而本项目要的只是「出个能装的 APK + 一个本地 AVD」；引入容器把「一条 `clean`」换成「维护一份 Dockerfile」，收益不足。且 macOS 上的容器不能原生跑 arm64 Android 模拟器的那套加速路径。

重新启用的条件：需要与「宿主完全无关」的构建（例如替别人出一份可复现的包）。

### 5. 把工具链提交进仓库（或做成 git-lfs 资产）

否决理由：14 GB 二进制进版本控制不可接受（clone 成本、diff 噪音、许可与再分发问题）；而 `.android-env/` 的「不入库 + 一条 `bootstrap` 重建」已经覆盖了「新机器可复现」这条真实需求。

重新启用的条件：不成立。若将来需要离网复现，正确做法是缓存下载产物（脚本可重复执行），而不是把 SDK 提交进仓库。
