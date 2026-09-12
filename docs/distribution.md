# 构建与分发

> 定位：danmubox 在 macOS / Windows / Android 三端的构建、签名、打包、安装与自用更新方式。
> 读者：在本机执行构建 / 重新打包 / 装机的开发者（通常是仓库所有者本人）。
> 更新时机：新增目标平台、更换包标识或版本策略、新增签名或安装步骤、产物路径变化时必须同步本文。

## 1. 范围与前提

| 项 | 约定 |
|---|---|
| 分发范围 | **自用，不对外分发**：产物只装自己的设备 |
| 目标平台 | macOS / Windows / Android |
| 不做 | iOS 端（后期 enhancement）、Fold8 / 折叠屏适配、自动更新、后台保活 |
| 包标识 bundle id | `dev.kksk.danmubox`（全平台统一，不得改动语义） |
| 前端产物 | `apps/desktop/ui/` 由 Vite 构建，嵌入 Tauri 应用（React + TS，见 `architecture.md`） |
| 引擎 | `danmubox-core`（Rust），薄封装见 `architecture.md` |

> **本文所有命令均为「规划命令」**：仓库当前处于文档阶段，代码尚未开始。命令按 Tauri 2 CLI 的既有约定书写，用于后续实现时对齐；路径与命令若与首次构建的实际输出不符，以实际输出为准并回改本文（见 §9 待实测校准表）。

### 1.1 `<target-dir>` 的定义

Rust 产物目录在 workspace 下由 Cargo 决定，本文统一用 `<target-dir>` 表示，避免硬编码：

| 场景 | `<target-dir>` |
|---|---|
| workspace 统一 target（默认，`target-dir` 未覆盖） | `<repo>/target` |
| `apps/desktop/src-tauri` 使用独立 target 目录 | `<repo>/apps/desktop/src-tauri/target` |
| 显式指定平台 target 时 | 上述目录下的 `<triple>/release/...` |

首次构建后确认一次实际目录，并在 §9 记录。

## 2. 工具链前置条件（对照 Tauri 官方 Prerequisites）

Tauri 官方把依赖分为「系统依赖 + Rust + 移动端附加依赖」三类。下表逐项对齐，**桌面端与移动端要求不同，不要互推**。

| 组件 | 适用平台 | 安装方式 | 必需的判定依据 |
|---|---|---|---|
| Rust（rustup） | 三端 | `curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf \| sh` | 官方把 Rust 列为通用必需项；版本由 `rust-toolchain.toml` 固定 |
| Node.js LTS | 三端（前端构建 + Tauri CLI） | nodejs.org 下载 LTS | 前端为 React + Vite，需 Node 构建工具链 |
| Xcode Command Line Tools | macOS 桌面 | `xcode-select --install` | 官方明确：**仅开发桌面目标时用 CLT 即可**，无需完整 Xcode |
| Visual Studio C++ Build Tools | Windows | 安装器勾选「Desktop development with C++」 | 官方列为 Windows 开发必需项 |
| WebView2 Runtime | Windows（开发机 + 目标机） | Evergreen Bootstrapper | 官方：Tauri 用 Edge WebView2 渲染，开发与运行都需要 |
| VBSCRIPT 可选功能 | Windows（仅打 MSI 时） | 设置 → 应用 → 可选功能 → 更多 Windows 功能 → 勾选 VBSCRIPT | 官方：缺它时 `light.exe` 报错 |
| Android Studio | Android | developer.android.com/studio | 官方移动端第一步 |
| Android SDK 组件 | Android | SDK Manager 安装 Android SDK Platform / Platform-Tools / Build-Tools / Command-line Tools | 官方逐项列出 |
| NDK (Side by side) | Android | SDK Manager 安装 | 官方逐项列出 |
| `JAVA_HOME` | Android | 指向 Android Studio 自带 JBR，如 `export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"` | 官方要求显式设置 |
| `ANDROID_HOME` / `NDK_HOME` | Android | `export ANDROID_HOME="$HOME/Library/Android/sdk"`；`NDK_HOME="$ANDROID_HOME/ndk/<版本>"` | 官方要求显式设置 |
| rustup 四个 Android ABI target | Android | `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android` | 官方列出的四个目标，缺一则对应 ABI 构建失败 |
| Tauri CLI | 三端 | 前端脚本内 `@tauri-apps/cli`（`npm run tauri ...`） | 仓库不额外要求全局安装 `cargo-tauri` |

要点：

- **macOS 桌面只需 Xcode CLT**（本期不做 iOS 端）。
- **Windows 目标机需要 WebView2 运行时**。Windows 10/11 较新版本通常已预装；缺失时按 §5 处理。
- **Android 的四个 ABI target 与 NDK 缺一不可**；`--split-per-abi` 只影响打包粒度，不影响编译目标是否已安装。

## 3. 三端构建步骤（规划）

### 3.1 通用准备（规划）

```bash
# 仓库根目录
npm install                     # 安装前端依赖（规划）
cargo build --workspace         # 先单独编译 Rust 侧，便于定位问题（规划）

# 开发期热重载运行桌面应用（规划）
npm run tauri dev
```

### 3.2 macOS（规划）

```bash
cd apps/desktop
npm run tauri build -- --bundles app,dmg     # 规划
```

| 产物 | 路径（规划） |
|---|---|
| 应用包 | `<target-dir>/release/bundle/macos/danmubox.app` |
| 安装镜像 | `<target-dir>/release/bundle/dmg/danmubox_0.1.0_<arch>.dmg` |

- `<arch>` 由构建机架构决定（Apple Silicon 为 `aarch64`，Intel 为 `x64`）。
- 交叉架构可在 Apple Silicon 上追加 `--target x86_64-apple-darwin`，产物落在 `<target-dir>/x86_64-apple-darwin/release/bundle/` 下。
- 本地运行不需要 DMG，直接双击 `danmubox.app` 或 `npm run tauri dev`。

### 3.3 Windows（规划）

```bash
cd apps/desktop
npm run tauri build                          # 规划：默认同时产出 msi 与 nsis
npm run tauri build -- --target x86_64-pc-windows-msvc   # 规划：显式 64 位
```

| 产物 | 路径（规划） |
|---|---|
| WiX MSI | `<target-dir>/release/bundle/msi/danmubox_0.1.0_x64_en-US.msi` |
| NSIS 安装器 | `<target-dir>/release/bundle/nsis/danmubox_0.1.0_x64-setup.exe` |

- 官方明确：`.msi` **只能在 Windows 上构建**（WiX 仅支持 Windows）；NSIS 可在其他平台交叉构建，但属于「最后手段」，本文不采用。
- 自用只保留 NSIS 安装器与免安装可执行文件即可；MSI 留一份作为备用安装路径。
- 首次安装后从「应用和功能」可正常卸载（见 `operations.md` §4）。

### 3.4 Android（规划）

```bash
cd apps/desktop
npm run tauri android init                   # 规划：首次生成 gen/android 工程，只跑一次
npm run tauri android build -- --apk         # 规划：产出通用 APK
npm run tauri android build -- --apk --split-per-abi   # 规划：按 ABI 拆分 APK
npm run tauri dev -- --device <serial>       # 规划：真机热重载调试
```

| 产物 | 路径（规划） |
|---|---|
| 通用 APK | `apps/desktop/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk` |
| 分 ABI APK | `apps/desktop/src-tauri/gen/android/app/build/outputs/apk/<abi>/release/app-<abi>-release.apk` |

- 自用装机只装 APK（不生成 AAB）。
- 默认构建包含官方支持的四个 ABI；自用设备通常只需 `arm64`，可用 `--target aarch64` 缩短构建时间。
- 最低 Android 版本由 Tauri 决定（官方当前为 Android 7.0 / SDK 24），需要提高时在 `bundle.android.minSdkVersion` 配置。

## 4. macOS 本地运行与签名策略

自用不发布，因此**不购买 Apple Developer 账号、不做公证（notarization）**：公证需要 Apple 账号凭据（`APPLE_ID` / `APPLE_API_KEY` 等），自用场景不引入该依赖。

| 场景 | 做法 | 结果 |
|---|---|---|
| 本机构建本机运行 | 不配置 `signingIdentity`，Tauri 做 ad-hoc 签名（等价 `codesign -s -`） | 可直接启动；Apple Silicon 上 ad-hoc 签名是二进制可执行的前提 |
| 拷到另一台自己的 Mac | 用「右键 → 打开」或系统设置 → 隐私与安全性 → 仍要打开；也可 `xattr -dr com.apple.quarantine /path/danmubox.app` | Gatekeeper 首次拦截后可正常运行 |

验证命令：

```bash
codesign -dv --verbose=4 /path/danmubox.app   # 确认为 adhoc 签名
spctl -a -vv /path/danmubox.app               # 查看 Gatekeeper 评估结果
xattr -l /path/danmubox.app                   # 查看隔离属性
```

- **证书与密钥不进仓库**：签名材料一律留在本机钥匙串，禁止写入仓库或文档。

## 5. Windows SmartScreen 处理

未签名的安装器从浏览器下载后被打上 Mark-of-the-Web，首次运行触发 SmartScreen「Windows 已保护你的电脑」。自用不发布，**不购买 OV / EV 证书**（都需付费与身份材料，EV 另有硬件令牌要求），产物保持未签名。

| 场景 | 处理方式 |
|---|---|
| 自用本机构建、本机运行 | 从本机构建目录直接运行，**不经过浏览器下载**，通常不触发；若触发，走下一行 |
| 已经出现警告 | 点「更多信息」→「仍要运行」 |
| 拷贝到另一台自用机器 | 先解除文件锁定：文件属性 → 勾选「解除锁定」，或 PowerShell `Unblock-File .\danmubox_0.1.0_x64-setup.exe`，再运行安装器 |

- 官方明确：签名只是减少警告的手段，**不是运行的必要条件**——只要愿意忽略 SmartScreen 警告，未签名也可运行。
- 安装器默认在缺少 WebView2 时下载 WebView2 Bootstrapper（需要联网）。若目标机常年离线，可改为随包内嵌安装器，代价是安装器体积按官方给出的量级显著增大（见 §9）。
- 打包 MSI 报 `failed to run light.exe` 时，检查 §2 表中的 VBSCRIPT 可选功能。

## 6. Android APK 安装

签名材料（keystore 与口令）**只存本机**，不进仓库、不进日志、不进文档（安全红线见 `operations.md` §3）。**同一 `dev.kksk.danmubox` 的后续安装必须使用同一签名**，否则无法覆盖安装、只能先卸载（卸载会清数据，且 `config.toml` 凭据一并丢失，见 `operations.md` §4）。

```bash
adb devices                                  # 确认设备已授权
adb install -r app-universal-release.apk     # 覆盖安装，保留应用数据
```

| 情况 | 处置 |
|---|---|
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | 签名与已装版本不一致 → 先 `adb uninstall dev.kksk.danmubox`（会清数据）再安装 |
| `INSTALL_FAILED_OLDER_SDK` | 设备 Android 版本低于最低支持版本 → 提高设备系统或调整 `minSdkVersion` 后重建 |
| 手机上提示「不允许安装未知应用」 | 在「安装未知应用」权限中允许 USB 安装来源 |
| 不想用 USB | 把 APK 传到手机后用文件管理器安装（同样需要未知来源权限） |
| 只装单一 ABI | `adb install -r` 前确认 APK 的 ABI 与设备匹配（此处指 arm64 / x86_64） |

## 7. 版本号策略

| 项 | 规则 |
|---|---|
| 版本格式 | SemVer `MAJOR.MINOR.PATCH`，当前基线 `0.1.0`（见 `../CHANGELOG.md`） |
| 单一事实源 | Tauri 配置中的 `version` 为准，三端产物名由它派生 |
| bundle id | `dev.kksk.danmubox`，三端一致；**一旦装机后不再更改**，否则 Android 无法覆盖安装、数据目录也会错位 |
| Android versionCode | 采用官方派生规则 `major*1000000 + minor*1000 + patch`；需要连续递增时在 `bundle.android.versionCode` 显式指定 |
| 预发布 | 自用不做预发布通道；`0.x` 期间 minor 变更允许破坏兼容 |
| 文档同步 | 每次发版更新 `../CHANGELOG.md`；影响安装 / 数据目录 / 命令的改动同时更新本文与 `operations.md` |
| 本地文件兼容 | 无迁移；升级不影响 `config.toml` 与 `prefs.json`，弹幕缓冲是内存态、退出即丢（契约 §4.3） |

## 8. 自用更新方式

不做自动更新：不引入 updater 插件、不搭更新服务器——自用单机，后端发布通道本身是额外维护面。升级即用新产物覆盖安装。

| 平台 | 更新步骤 | 数据是否保留 |
|---|---|---|
| macOS | 退出应用 → 用新 `danmubox.app` 整体替换旧应用 → 重新启动 | 保留（数据在 `~/Library/Application Support/danmubox/`，不在 .app 内） |
| Windows | 退出应用 → 运行新安装器覆盖安装 | 保留（数据在 `%APPDATA%\danmubox\`） |
| Android | `adb install -r <新 APK>` | 保留（同包名 + 同签名）；换签名或降 versionCode 会失败 |

回滚方式：保留上一版产物（安装器 / APK / .app），直接覆盖回去。无迁移，回滚不涉及数据格式转换；但若升级时应用重写过 `config.toml` / `prefs.json`，回滚后以当前文件为准。

## 9. 产物体积与内存目标（量级，非精确值）

本项目在文档阶段**没有实测数据**，因此只给量级与来源，不写具体数字。写下预期量级的目的是给实现阶段一个可比的锚点。

| 指标 | 预期量级 | 依据与来源 | 校准方式（见下表） |
|---|---|---|---|
| 应用本体（不含内嵌 WebView2 安装器） | 10¹ MB | Tauri 的定位是「小包体」；sidecar 方案已在 `decisions/0001-tauri-over-flutter.md` 否决——它会把包体推回 40MB+，抵消 Tauri 的体积优势 | 见校准表第 1~3 行 |
| Windows 安装器额外体积 | 0 / ~1.8MB / ~127MB / ~180MB 四档 | Tauri 官方 `webviewInstallMode` 对照表给出的增量：`downloadBootstrapper` 0MB、`embedBootstrapper` ~1.8MB、`offlineInstaller` ~127MB、`fixedVersion` ~180MB | 见校准表第 2 行 |
| 常驻内存 | 10² MB | 结构上由「WebView 渲染进程 + Rust 引擎」构成，其中 WebView 通常是大头；弹幕仅在内存环形缓冲内保存（单房间上限 5000 条），不是主要占用；无实测数据，不做精确断言 | 见校准表第 4 行 |

### 待实测校准表

| # | 待测项 | 预期量级 | 核对方法 | 责任人动作 |
|---|---|---|---|---|
| 1 | macOS 产物体积 | 10¹ MB | `du -sh <target-dir>/release/bundle/macos/danmubox.app`；`ls -lh .../dmg/*.dmg` | 首次出包后把实测值填入本表，并注明构建配置（release） |
| 2 | Windows 安装器体积 | 见上表四档 | `Get-Item .\danmubox_0.1.0_x64-setup.exe \| Select-Object Length`，并记录当前 `webviewInstallMode` | 同上；改安装模式时重测 |
| 3 | Android APK 体积 | 10¹ MB | `ls -lh app-universal-release.apk`；分 ABI 时逐个记录 | 同上；记录是否 `--split-per-abi` 与 `--target` |
| 4 | 三端常驻内存 | 10² MB | macOS：活动监视器 / `ps -o rss= -p <pid>`；Windows：任务管理器「内存」；Android：`adb shell dumpsys meminfo dev.kksk.danmubox` | 在「单房间、持续收弹幕」状态下采样，记录房间数与消息速率 |
| 5 | 冷启动到首屏 | 未定 | 秒表 / `time` 包一层启动命令；Android 用 `adb shell am start -W` | 至少记录三次取范围，不写单次值 |
| 6 | `<target-dir>` 实际位置 | 见 §1.1 | 首次构建后 `readlink` / 观察 CLI 输出 | 确认后回改 §1.1 与 §3 的路径 |

规则：**校准表里的数字必须来自实测**。表格空着是允许的（表示尚未测量），但不得填入推测值、不得编造精确数字。

## 10. 出包前检查清单（自用，一次性）

| # | 检查项 | 通过标准 |
|---|---|---|
| 1 | 版本号一致 | Tauri 配置、`../CHANGELOG.md`、产物文件名三者一致 |
| 2 | 包标识一致 | 三端均为 `dev.kksk.danmubox` |
| 3 | 三端均可启动 | macOS 双击 / Windows 安装后启动 / Android 安装后启动 |
| 4 | 核心链路可用 | 按 `testing.md` 的三端手工冒烟清单逐条执行 |
| 5 | 本地文件就位 | 数据目录出现 `config.toml`（权限 `0600`）与 `prefs.json`；应用为纯客户端形态，不启动任何本地服务（见 `operations.md` §1） |
| 6 | 无敏感信息外泄 | 产物目录、日志、崩溃输出中不含 `SESSDATA` / `bili_jct` / `DedeUserID` 明文（安全红线）；仓库中无签名材料、`.p12`、Cookie、`config.toml` |
| 7 | 卸载可用 | 按 `operations.md` §4 能清干净残留 |

## 11. 相关文档

| 文档 | 关联点 |
|---|---|
| [`../README.md`](../README.md) | 项目定位、三端目标、文档索引 |
| [`../AGENT.md`](../AGENT.md) | 构建 / 测试 / lint 命令的规划值 |
| [`../CHANGELOG.md`](../CHANGELOG.md) | 版本号与发版记录的唯一事实源 |
| [`architecture.md`](architecture.md) | 进程拓扑、core 复用方式、可观测性 |
| [`testing.md`](testing.md) | 三端手工冒烟清单 |
| [`operations.md`](operations.md) | 日常操作、排障、数据文件位置与卸载清理 |

参考来源（官方文档，核对日期 2026-09-11）：Tauri 2 Prerequisites、macOS Application Bundle、Windows Installer（WebView2 安装模式与体积对照）、Android 打包（versionCode 派生规则与产物路径）。

### Android 前置条件（2026-09-12 实际核查）

要在本机构建 Android 端，当前**缺**以下东西（已装的只有 `adb` 与 `java`）：

| 需要 | 现状 |
|---|---|
| Android SDK（`sdkmanager`） | **缺**；`ANDROID_HOME` 未设置 |
| Android NDK | **缺**；`ANDROID_NDK_HOME` 未设置 |
| Gradle | **缺** |
| Rust 的 Android target（`aarch64-linux-android` 等） | **缺**（当前只装了 `aarch64-apple-darwin`）|
| `adb`、`java`/`javac` | 已有 |

Windows 端同理需要先加 `x86_64-pc-windows-msvc`（或 `-gnu`）target 与对应的链接器/工具链。
两端都属于独立工程，开工前先补齐这些前置条件。
