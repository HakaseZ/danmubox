#!/bin/sh
# =============================================================================
# danmubox · 项目内 Android 工具链引导脚本
# =============================================================================
#
# 用途
#   danmubox 的 Tauri 2 Android 目标需要 JDK / Android SDK / NDK / Rust 交叉工具链。
#   本脚本把这些东西**全部装进仓库内的 .android-env/**，不碰宿主机任何目录
#   （不写 /Applications、~/Library、~/.gradle、~/.rustup、~/.cargo/registry …），
#   因此整套环境随时可以一条 `clean` 彻底删除、不留痕迹。
#
# 用法
#   . scripts/android-env.sh          # 导出环境变量到当前 shell（必须 source，直接执行无效）
#   scripts/android-env.sh bootstrap  # 从零安装整套工具链（可重复执行，已装好的会跳过）
#   scripts/android-env.sh clean      # 停 gradle daemon / adb server 后删除整个 .android-env
#   scripts/android-env.sh help       # 显示本段用法
#
# 导出的环境变量（全部落在 .android-env/ 内）
#   JAVA_HOME                         默认 .android-env/jdk17；`ANDROID_JDK=21` 可切到 jdk21
#   ANDROID_HOME / ANDROID_SDK_ROOT   .android-env/sdk
#   NDK_HOME / ANDROID_NDK_HOME       .android-env/sdk/ndk/<版本>
#   GRADLE_USER_HOME                  .android-env/gradle-home（内含 gradle.properties）
#   RUSTUP_HOME / CARGO_HOME          .android-env/rustup、.android-env/cargo
#   ANDROID_USER_HOME / ANDROID_AVD_HOME  .android-env/android-user（AVD 也放这里）
#   npm_config_cache                  .android-env/npm-cache
#   TMPDIR                            .android-env/tmp
#   PATH                              前置 .android-env 下各 bin 目录（重复 source 不会叠加）
#
# 注意
#   * 本脚本要能同时在 bash / zsh / sh(dash) 下被 source 与被执行，所以**顶层绝不 set -e**
#     （source 时会污染调用者的 shell 选项）；子命令内部在自己的子 shell 里开 set -eu。
#   * 定位仓库根优先按脚本自身路径，退化方案是从 $PWD 向上找 scripts/android-env.sh；
#     若两者都失败（例如从仓库外 source 绝对路径），可用 `DANMUBOX_ROOT=/path/to/danmubox` 显式指定。
#   * Tauri 官方 Android 构建命令（见 docs/operations.md §5）：
#       cd apps/desktop && ./ui/node_modules/.bin/tauri android build --apk
#   * NDK 的预编译目录叫 darwin-x86_64，但里面几乎都是 x86_64+arm64 通用二进制，Apple Silicon 原生可跑
#     （实测 53 个可执行文件只有 yasm 是纯 x86_64），只有用到 yasm 的构建才依赖 Rosetta 2。
# =============================================================================

# -----------------------------------------------------------------------------
# 常量
# -----------------------------------------------------------------------------
DANMUBOX_ANDROID_ENV_NAME=".android-env"
# 安装进 SDK 的包；system-image 会先探测包名是否存在，不存在则自动降级（见 _dmb_pick_system_image）
# 注意：cmdline-tools 23.0 起 sdkmanager 已被新的 Android CLI 接管，包名一律写成 "/" 形式
#（旧版 sdkmanager 的 "platforms;android-35" 与 "platforms/android-35" 一一对应，`sdkmanager --list` 也只输出本形式）
DANMUBOX_SDK_PACKAGES="platform-tools platforms/android-35 platforms/android-36 build-tools/35.0.0 ndk/27.0.12077973 emulator"
DANMUBOX_SYSTEM_IMAGE_CANDIDATES="system-images/android-35/google_apis/arm64-v8a system-images/android-34/google_apis/arm64-v8a system-images/android-35/default/arm64-v8a system-images/android-34/default/arm64-v8a"
DANMUBOX_NDK_VERSION="27.0.12077973"
# NDK 里的 clang 包装器名字形如 <triple><api>-clang；API 24 与 Tauri 默认 minSdk 24 对齐
DANMUBOX_ANDROID_API="24"
# Rust 交叉编译的四个 android target（前两个对应 32/64 位 arm，后两个对应模拟器）
DANMUBOX_RUST_TARGETS="aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android"
DANMUBOX_RUST_TOOLCHAIN="stable"
# NDK 预编译工具链目录：macOS 上固定叫 darwin-x86_64（里面多数是通用二进制，见文件头说明）
DANMUBOX_NDK_TOOLCHAIN_DIR="darwin-x86_64"

# -----------------------------------------------------------------------------
# 顶层探测：脚本路径 / 是否被 source
#   必须在函数**外**执行：zsh 在函数体内会把 $0 换成函数名。
# -----------------------------------------------------------------------------
if [ -n "${BASH_SOURCE:-}" ]; then
	# bash（含以 sh 之名运行的 bash）：source 时 BASH_SOURCE 是本文件，$0 是调用者的 shell
	_dmb_self_path="${BASH_SOURCE}"
	if [ "${BASH_SOURCE}" = "${0}" ]; then
		_dmb_sourced=0
	else
		_dmb_sourced=1
	fi
elif [ -n "${ZSH_VERSION:-}" ]; then
	# zsh：$0 始终是被 source / 被执行的文件；用 ZSH_EVAL_CONTEXT 判断调用方式
	_dmb_self_path="${0}"
	case "${ZSH_EVAL_CONTEXT:-}" in
	*file*) _dmb_sourced=1 ;;
	*) _dmb_sourced=0 ;;
	esac
else
	# 其它 POSIX shell：$0 通常是本脚本；无法可靠区分 source/执行，按“执行”处理
	_dmb_self_path="${0}"
	_dmb_sourced=0
fi

# 仓库根：优先按脚本自身路径推导（脚本固定位于 <root>/scripts/android-env.sh）
_dmb_resolve_root() {
	if [ -n "${DANMUBOX_ROOT:-}" ] && [ -d "${DANMUBOX_ROOT}" ]; then
		printf '%s\n' "${DANMUBOX_ROOT}"
		return 0
	fi
	_dmb_p="${_dmb_self_path:-}"
	# 相对路径（如 `sh scripts/android-env.sh`）先按 $PWD 展开
	case "${_dmb_p}" in
	/*) ;;
	*/*) _dmb_p="${PWD}/${_dmb_p}" ;;
	*) _dmb_p="" ;;
	esac
	if [ -n "${_dmb_p}" ]; then
		_dmb_d=$(dirname "${_dmb_p}")
		if [ -f "${_dmb_d}/android-env.sh" ]; then
			cd "${_dmb_d}/.." 2>/dev/null && pwd && return 0
		fi
	fi
	# 退化：从当前目录向上找 scripts/android-env.sh（覆盖 `cd 任意子目录后 . 相对路径 source` 的情形）
	_dmb_d="${PWD}"
	while [ "${_dmb_d}" != "/" ] && [ -n "${_dmb_d}" ]; do
		if [ -f "${_dmb_d}/scripts/android-env.sh" ]; then
			printf '%s\n' "${_dmb_d}"
			return 0
		fi
		_dmb_d=$(dirname "${_dmb_d}")
	done
	printf '%s\n' "${PWD}"
}

DANMUBOX_ROOT=$(_dmb_resolve_root)
DANMUBOX_ANDROID_ENV_ROOT="${DANMUBOX_ROOT}/${DANMUBOX_ANDROID_ENV_NAME}"
export DANMUBOX_ROOT DANMUBOX_ANDROID_ENV_ROOT

# sdkmanager --list 的缓存文件（一次 bootstrap 只查一次远端索引，很慢）
DANMUBOX_SDK_LIST_CACHE="${DANMUBOX_ANDROID_ENV_ROOT}/tmp/sdkmanager-list.txt"

# -----------------------------------------------------------------------------
# 小工具
# -----------------------------------------------------------------------------
_dmb_info() { printf '[android-env] %s\n' "$*"; }
_dmb_warn() { printf '[android-env] 警告：%s\n' "$*" >&2; }
_dmb_err() { printf '[android-env] 错误：%s\n' "$*" >&2; }

# 终止当前调用：被 source 时只能 return，否则会把调用者的 shell 一起杀掉
_dmb_stop() {
	# $1 = 退出码
	if [ "${_dmb_sourced}" = "1" ]; then
		return "$1"
	fi
	exit "$1"
}

# 把 $1 目录前置进 PATH；目录不存在则不动（避免往 PATH 里塞空目录）
_dmb_path_prepend() {
	[ -d "${1}" ] || return 0
	case ":${PATH}:" in
	*":${1}:"*) ;;
	*) PATH="${1}:${PATH}" ;;
	esac
}

# 清掉 PATH 里所有指向 .android-env 的条目，保证重复 source 不叠加、切换 JDK 不残留
_dmb_path_purge_own() {
	_dmb_newpath=""
	_dmb_oldifs="${IFS}"
	IFS=:
	for _dmb_e in ${PATH}; do
		case "${_dmb_e}" in
		"${DANMUBOX_ANDROID_ENV_ROOT}"/*) ;;
		*) _dmb_newpath="${_dmb_newpath}${_dmb_newpath:+:}${_dmb_e}" ;;
		esac
	done
	IFS="${_dmb_oldifs}"
	PATH="${_dmb_newpath}"
}

# JDK 家目录：macOS 的 tar.gz 解出来是 <jdk>/Contents/Home/，但留一手兼容扁平布局
_dmb_jdk_home() {
	_dmb_base="${DANMUBOX_ANDROID_ENV_ROOT}/jdk${1}"
	if [ -x "${_dmb_base}/Contents/Home/bin/java" ]; then
		printf '%s\n' "${_dmb_base}/Contents/Home"
	elif [ -x "${_dmb_base}/bin/java" ]; then
		printf '%s\n' "${_dmb_base}"
	else
		printf '%s\n' "${_dmb_base}/Contents/Home"
	fi
}

# 已安装的 NDK 目录：优先固定版本，其次 sdk/ndk 下唯一的那个
_dmb_ndk_home() {
	_dmb_pinned="${DANMUBOX_ANDROID_ENV_ROOT}/sdk/ndk/${DANMUBOX_NDK_VERSION}"
	if [ -d "${_dmb_pinned}" ]; then
		printf '%s\n' "${_dmb_pinned}"
		return 0
	fi
	for _dmb_d in "${DANMUBOX_ANDROID_ENV_ROOT}"/sdk/ndk/*; do
		if [ -d "${_dmb_d}" ]; then
			printf '%s\n' "${_dmb_d}"
			return 0
		fi
	done
	printf '%s\n' "${_dmb_pinned}"
}

_dmb_sdkmanager() { printf '%s\n' "${DANMUBOX_ANDROID_ENV_ROOT}/sdk/cmdline-tools/latest/bin/sdkmanager"; }

# -----------------------------------------------------------------------------
# 导出环境变量（source 的核心动作，也供 bootstrap 复用）
# -----------------------------------------------------------------------------
_dmb_export_env() {
	# JDK：默认 17，ANDROID_JDK=21 可切到备选
	DANMUBOX_JDK_VERSION="${ANDROID_JDK:-17}"
	JAVA_HOME=$(_dmb_jdk_home "${DANMUBOX_JDK_VERSION}")
	export JAVA_HOME DANMUBOX_JDK_VERSION

	ANDROID_HOME="${DANMUBOX_ANDROID_ENV_ROOT}/sdk"
	ANDROID_SDK_ROOT="${ANDROID_HOME}"
	export ANDROID_HOME ANDROID_SDK_ROOT

	NDK_HOME=$(_dmb_ndk_home)
	ANDROID_NDK_HOME="${NDK_HOME}"
	export NDK_HOME ANDROID_NDK_HOME

	GRADLE_USER_HOME="${DANMUBOX_ANDROID_ENV_ROOT}/gradle-home"
	RUSTUP_HOME="${DANMUBOX_ANDROID_ENV_ROOT}/rustup"
	CARGO_HOME="${DANMUBOX_ANDROID_ENV_ROOT}/cargo"
	ANDROID_USER_HOME="${DANMUBOX_ANDROID_ENV_ROOT}/android-user"
	ANDROID_AVD_HOME="${ANDROID_USER_HOME}/avd"
	# npm（tauri CLI 装到 apps/desktop/ui）的缓存也别落到 ~/.npm
	npm_config_cache="${DANMUBOX_ANDROID_ENV_ROOT}/npm-cache"
	TMPDIR="${DANMUBOX_ANDROID_ENV_ROOT}/tmp"
	export GRADLE_USER_HOME RUSTUP_HOME CARGO_HOME ANDROID_USER_HOME ANDROID_AVD_HOME npm_config_cache TMPDIR
	# 没跑过 bootstrap 时这个目录还不存在，TMPDIR 会指向空目录，提前提醒而不是让后续工具报怪错
	if [ ! -d "${TMPDIR}" ]; then
		_dmb_warn "还没 bootstrap：${TMPDIR} 不存在，请先执行 scripts/android-env.sh bootstrap"
	fi

	# PATH：先清掉自己的旧条目再加，保证幂等
	_dmb_path_purge_own
	_dmb_path_prepend "${CARGO_HOME}/bin"
	_dmb_path_prepend "${JAVA_HOME}/bin"
	_dmb_path_prepend "${ANDROID_HOME}/cmdline-tools/latest/bin"
	_dmb_path_prepend "${ANDROID_HOME}/platform-tools"
	_dmb_path_prepend "${ANDROID_HOME}/emulator"
	_dmb_path_prepend "${NDK_HOME}/toolchains/llvm/prebuilt/${DANMUBOX_NDK_TOOLCHAIN_DIR}/bin"
	export PATH
}

# -----------------------------------------------------------------------------
# bootstrap 子步骤
# -----------------------------------------------------------------------------
_dmb_mkdirs() {
	mkdir -p \
		"${DANMUBOX_ANDROID_ENV_ROOT}/tmp" \
		"${DANMUBOX_ANDROID_ENV_ROOT}/jdk17" \
		"${DANMUBOX_ANDROID_ENV_ROOT}/jdk21" \
		"${DANMUBOX_ANDROID_ENV_ROOT}/sdk" \
		"${DANMUBOX_ANDROID_ENV_ROOT}/gradle-home" \
		"${DANMUBOX_ANDROID_ENV_ROOT}/rustup" \
		"${DANMUBOX_ANDROID_ENV_ROOT}/cargo" \
		"${DANMUBOX_ANDROID_ENV_ROOT}/android-user" \
		"${DANMUBOX_ANDROID_ENV_ROOT}/npm-cache"
}

_dmb_fetch() {
	# $1 = URL，$2 = 目标文件
	if [ -s "${2}" ]; then
		_dmb_info "已存在下载缓存，跳过：$(basename "${2}")"
		return 0
	fi
	_dmb_info "下载 $(basename "${2}")"
	curl -fL --retry 3 --retry-delay 2 -o "${2}.part" "${1}"
	mv "${2}.part" "${2}"
}

_dmb_install_jdk() {
	# $1 = 17 | 21
	_dmb_ver="${1}"
	_dmb_dest="${DANMUBOX_ANDROID_ENV_ROOT}/jdk${_dmb_ver}"
	if [ -x "${_dmb_dest}/Contents/Home/bin/javac" ] && [ "${DANMUBOX_FORCE:-0}" != "1" ]; then
		_dmb_info "JDK ${_dmb_ver} 已安装，跳过"
	else
		_dmb_tar="${DANMUBOX_ANDROID_ENV_ROOT}/tmp/jdk${_dmb_ver}.tar.gz"
		_dmb_fetch "https://api.adoptium.net/v3/binary/latest/${_dmb_ver}/ga/mac/aarch64/jdk/hotspot/normal/eclipse" "${_dmb_tar}"
		_dmb_info "解压 JDK ${_dmb_ver} → ${_dmb_dest}"
		rm -rf "${_dmb_dest}"
		mkdir -p "${_dmb_dest}"
		# Temurin 的 tar.gz 顶层是 jdk-<版本>+/ 一个目录，去掉它让 Contents/Home 直接落在 jdk<ver>/ 下
		tar -xzf "${_dmb_tar}" -C "${_dmb_dest}" --strip-components=1
		rm -f "${_dmb_tar}"
	fi
	_dmb_home=$(_dmb_jdk_home "${_dmb_ver}")
	"${_dmb_home}/bin/java" -version
	"${_dmb_home}/bin/javac" -version
}

_dmb_install_cmdline_tools() {
	_dmb_sm=$(_dmb_sdkmanager)
	if [ -x "${_dmb_sm}" ] && [ "${DANMUBOX_FORCE:-0}" != "1" ]; then
		_dmb_info "cmdline-tools 已安装，跳过"
		return 0
	fi
	_dmb_zip="${DANMUBOX_ANDROID_ENV_ROOT}/tmp/commandlinetools.zip"
	_dmb_fetch "https://dl.google.com/android/repository/commandlinetools-mac_arm64-16111833_latest.zip" "${_dmb_zip}"
	_dmb_info "解压 cmdline-tools → sdk/cmdline-tools/latest"
	# zip 内层就是 cmdline-tools/，必须落成 cmdline-tools/latest/，否则 sdkmanager 找不到自己的根
	rm -rf "${DANMUBOX_ANDROID_ENV_ROOT}/tmp/cmdline-tools-unzip"
	mkdir -p "${DANMUBOX_ANDROID_ENV_ROOT}/tmp/cmdline-tools-unzip"
	unzip -q "${_dmb_zip}" -d "${DANMUBOX_ANDROID_ENV_ROOT}/tmp/cmdline-tools-unzip"
	rm -rf "${DANMUBOX_ANDROID_ENV_ROOT}/sdk/cmdline-tools/latest"
	mkdir -p "${DANMUBOX_ANDROID_ENV_ROOT}/sdk/cmdline-tools"
	mv "${DANMUBOX_ANDROID_ENV_ROOT}/tmp/cmdline-tools-unzip/cmdline-tools" "${DANMUBOX_ANDROID_ENV_ROOT}/sdk/cmdline-tools/latest"
	rm -rf "${DANMUBOX_ANDROID_ENV_ROOT}/tmp/cmdline-tools-unzip"
	rm -f "${_dmb_zip}"
	_dmb_sm=$(_dmb_sdkmanager)
	[ -x "${_dmb_sm}" ] || { _dmb_err "sdkmanager 未落到 ${_dmb_sm}"; return 1; }
	# cmdline-tools 23.0 的 bin/sdkmanager 只是薄壳，真正干活的是新 Android CLI（bin/android）。
	# 它首次运行会把 ~84MB 的 android-cli 自解到 $ANDROID_USER_HOME/bin/ —— 因为上面已经导出
	# ANDROID_USER_HOME=$ENV/android-user，所以这份自解包也落在仓库内，而不是 ~/.android/bin。
	# 反过来说：不 source 本脚本就直接跑 sdkmanager，会把东西写进 ~/.android，切勿这么干。
	"${_dmb_sm}" --version
}

# sdkmanager --list 里查包名是否存在（列表行的格式是 "  <包名> | <版本> | ..."）
# --list 每次都要拉远端仓库索引、很慢，所以整个 bootstrap 期间只取一次并落成缓存文件。
# 注意：这里必须用文件而不是普通变量——_dmb_sdkmanager_has 在 $(...) 子 shell 里被调用，
# 子 shell 里赋的变量不会回传给父 shell，只有文件能跨子 shell 共享。
_dmb_sdkmanager_list() {
	if [ -s "${DANMUBOX_SDK_LIST_CACHE}" ]; then
		return 0
	fi
	mkdir -p "${DANMUBOX_ANDROID_ENV_ROOT}/tmp"
	"$(_dmb_sdkmanager)" --sdk_root="${ANDROID_HOME}" --list >"${DANMUBOX_SDK_LIST_CACHE}" 2>/dev/null
}

_dmb_sdkmanager_has() {
	_dmb_sdkmanager_list
	# 新 CLI 的列表行形如 "  build-tools/35.0.0    35.0.0    Android SDK Build-Tools 35"（空白分列，不是旧版的 "|"）
	# 包名后必须紧跟空白，避免 "platform-tools" 误匹配到 "platform-tools-foo"
	grep -E "^[[:space:]]*$1[[:space:]]" "${DANMUBOX_SDK_LIST_CACHE}" >/dev/null 2>&1
}

_dmb_pick_system_image() {
	for _dmb_pkg in ${DANMUBOX_SYSTEM_IMAGE_CANDIDATES}; do
		if _dmb_sdkmanager_has "${_dmb_pkg}"; then
			printf '%s\n' "${_dmb_pkg}"
			return 0
		fi
		_dmb_warn "system-image 不存在，试下一个：${_dmb_pkg}"
	done
	return 1
}

_dmb_install_sdk_packages() {
	# 每次安装都重新拉一次包索引，避免复用上次遗留的陈旧缓存
	rm -f "${DANMUBOX_SDK_LIST_CACHE}"
	_dmb_sm=$(_dmb_sdkmanager)
	# 逐条确认包名存在再装，避免 --install 因为一个笔误整批失败
	_dmb_pkgs=""
	for _dmb_pkg in ${DANMUBOX_SDK_PACKAGES}; do
		if _dmb_sdkmanager_has "${_dmb_pkg}"; then
			_dmb_pkgs="${_dmb_pkgs} ${_dmb_pkg}"
		else
			_dmb_err "sdkmanager 列表里没有这个包：${_dmb_pkg}"
			return 1
		fi
	done
	_dmb_img=$(_dmb_pick_system_image) || { _dmb_err "所有候选 system-image 都不存在"; return 1; }
	_dmb_info "system-image 选定：${_dmb_img}"
	_dmb_pkgs="${_dmb_pkgs} ${_dmb_img}"

	_dmb_info "接受 SDK 许可"
	# sdkmanager 会反复问 y/n；yes 提供无限 y，管道退出码取最后一个命令。
	# cmdline-tools 23.0 起 `--licenses` 已是空操作（新 CLI 只输出 "The --licenses option is no longer needed."，rc=0）；
	# 许可哈希改由随后的 --install 自动落盘：实测会生成 $ANDROID_HOME/licenses/{android-sdk-license,
	# android-sdk-arm-dbt-license}，所以 Gradle/AGP 那边不会因“未接受许可”报错。保留这一步只是为了兼容旧版 cmdline-tools。
	yes | "${_dmb_sm}" --sdk_root="${ANDROID_HOME}" --licenses >/dev/null || _dmb_warn "licenses 步骤返回非 0，继续尝试安装"

	_dmb_info "安装 SDK 组件：${_dmb_pkgs}"
	# shellcheck disable=SC2086 # 这里就是要按空格拆成多个包名
	"${_dmb_sm}" --sdk_root="${ANDROID_HOME}" --install ${_dmb_pkgs}
}

_dmb_install_rust() {
	if [ -x "${CARGO_HOME}/bin/rustup" ] && [ "${DANMUBOX_FORCE:-0}" != "1" ]; then
		_dmb_info "rustup 已安装，跳过"
	else
		_dmb_init="${DANMUBOX_ANDROID_ENV_ROOT}/tmp/rustup-init"
		_dmb_fetch "https://static.rust-lang.org/rustup/dist/aarch64-apple-darwin/rustup-init" "${_dmb_init}"
		chmod +x "${_dmb_init}"
		_dmb_info "安装 rustup（RUSTUP_HOME/CARGO_HOME 均在 .android-env 内）"
		# 只装 rustup 本体，默认工具链留空；--no-modify-path 保证不动任何 shell profile
		RUSTUP_HOME="${RUSTUP_HOME}" CARGO_HOME="${CARGO_HOME}" \
			"${_dmb_init}" -y --profile minimal --default-toolchain none --no-modify-path
	fi
	# 在仓库根执行，好让 rust-toolchain.toml（channel=stable, components=rustfmt,clippy）生效
	cd "${DANMUBOX_ROOT}" || return 1
	_dmb_info "安装 Rust 工具链 ${DANMUBOX_RUST_TOOLCHAIN}"
	"${CARGO_HOME}/bin/rustup" toolchain install "${DANMUBOX_RUST_TOOLCHAIN}" --profile minimal --component rustfmt --component clippy
	_dmb_info "添加 android target：${DANMUBOX_RUST_TARGETS}"
	# shellcheck disable=SC2086 # 同上，需要拆成多个 target
	"${CARGO_HOME}/bin/rustup" target add --toolchain "${DANMUBOX_RUST_TOOLCHAIN}" ${DANMUBOX_RUST_TARGETS}
}

# 写项目内 CARGO_HOME 的 config.toml：四个 android target 的 linker/ar/ranlib 指向 NDK
_dmb_write_cargo_config() {
	_dmb_ndk=$(_dmb_ndk_home)
	_dmb_bin="${_dmb_ndk}/toolchains/llvm/prebuilt/${DANMUBOX_NDK_TOOLCHAIN_DIR}/bin"
	[ -d "${_dmb_bin}" ] || { _dmb_err "NDK 工具链目录不存在：${_dmb_bin}"; return 1; }
	mkdir -p "${CARGO_HOME}"
	_dmb_cfg="${CARGO_HOME}/config.toml"
	_dmb_info "写 ${_dmb_cfg}"
	cat >"${_dmb_cfg}" <<EOF
# 由 scripts/android-env.sh bootstrap 生成 —— 项目内 CARGO_HOME 专用配置，不入库（.android-env/ 整体被忽略）。
# linker/ar/ranlib 全部指向仓库内 NDK 的 clang 包装器；API 级别 ${DANMUBOX_ANDROID_API} 与 Tauri 默认 minSdk 24 对齐。
# 注意：cargo 对 ranlib 的类型要求与 linker/ar 不同——linker/ar 是字符串，ranlib 必须是 { path = "..." } 表，
#       写成裸字符串会直接报 "expected a table, but found a string for target.*.ranlib" 并让整个构建失败。
# 关于 Rosetta：NDK 的预编译目录名叫 darwin-x86_64，但实测里面 53 个可执行文件有 52 个是 x86_64+arm64 通用二进制，
# 只有 yasm 是纯 x86_64；也就是说 clang/llvm-ar/ld.lld 在 Apple Silicon 上原生运行，不用 Rosetta。

[target.aarch64-linux-android]
linker = "${_dmb_bin}/aarch64-linux-android${DANMUBOX_ANDROID_API}-clang"
ar = "${_dmb_bin}/llvm-ar"
ranlib = { path = "${_dmb_bin}/llvm-ranlib" }

[target.armv7-linux-androideabi]
# Rust 的 triple 是 armv7-linux-androideabi，NDK 的 clang 名字却是 armv7a-linux-androideabi
linker = "${_dmb_bin}/armv7a-linux-androideabi${DANMUBOX_ANDROID_API}-clang"
ar = "${_dmb_bin}/llvm-ar"
ranlib = { path = "${_dmb_bin}/llvm-ranlib" }

[target.i686-linux-android]
linker = "${_dmb_bin}/i686-linux-android${DANMUBOX_ANDROID_API}-clang"
ar = "${_dmb_bin}/llvm-ar"
ranlib = { path = "${_dmb_bin}/llvm-ranlib" }

[target.x86_64-linux-android]
linker = "${_dmb_bin}/x86_64-linux-android${DANMUBOX_ANDROID_API}-clang"
ar = "${_dmb_bin}/llvm-ar"
ranlib = { path = "${_dmb_bin}/llvm-ranlib" }
EOF
}

# 写项目内 GRADLE_USER_HOME 的 gradle.properties
_dmb_write_gradle_properties() {
	mkdir -p "${GRADLE_USER_HOME}"
	_dmb_props="${GRADLE_USER_HOME}/gradle.properties"
	_dmb_info "写 ${_dmb_props}"
	cat >"${_dmb_props}" <<'EOF'
# 由 scripts/android-env.sh bootstrap 生成 —— 项目内 GRADLE_USER_HOME 专用配置，不入库。
# 关掉常驻 daemon：构建完不留后台进程，`scripts/android-env.sh clean` 才能干净地删掉一切。
org.gradle.daemon=false
org.gradle.parallel=true
org.gradle.jvmargs=-Xmx3g -XX:MaxMetaspaceSize=1g
EOF
}

_dmb_bootstrap() {
	# 在子 shell 里开 set -eu：不会污染（可能正在 source 本脚本的）调用者 shell
	set -eu
	_dmb_info "仓库根：${DANMUBOX_ROOT}"
	_dmb_info "工具链目录：${DANMUBOX_ANDROID_ENV_ROOT}"
	_dmb_mkdirs
	_dmb_export_env

	_dmb_install_jdk 17
	_dmb_install_jdk 21
	# 21 装完 JAVA_HOME 会被后面的 export 覆盖回默认 17
	_dmb_export_env

	_dmb_install_cmdline_tools
	_dmb_export_env
	_dmb_install_sdk_packages
	# NDK 装好后重新导出，让 NDK_HOME / PATH 指向真实目录
	_dmb_export_env

	_dmb_install_rust
	_dmb_export_env

	_dmb_write_cargo_config
	_dmb_write_gradle_properties

	_dmb_info "已完成。用 . scripts/android-env.sh 导出环境，或 scripts/android-env.sh clean 整包删除。"
	_dmb_sm=$(_dmb_sdkmanager)
	"${_dmb_sm}" --sdk_root="${ANDROID_HOME}" --list_installed
}

# -----------------------------------------------------------------------------
# clean 子命令：停掉后台进程后整包删除
# -----------------------------------------------------------------------------
_dmb_clean() {
	set -eu
	if [ ! -d "${DANMUBOX_ANDROID_ENV_ROOT}" ]; then
		_dmb_info "没有 ${DANMUBOX_ANDROID_ENV_ROOT}，无需清理"
		return 0
	fi

	# gradle daemon：gradle-home/gradle.properties 里已关 daemon，但生成工程可能覆盖配置，尽力而为
	_dmb_gradlew="${DANMUBOX_ROOT}/apps/desktop/src-tauri/gen/android/gradlew"
	if [ -x "${_dmb_gradlew}" ]; then
		_dmb_info "停止 gradle daemon：${_dmb_gradlew} --stop"
		(cd "$(dirname "${_dmb_gradlew}")" && ./gradlew --stop) || _dmb_warn "gradlew --stop 失败，忽略并继续"
	else
		_dmb_info "未发现 ${_dmb_gradlew}，跳过 gradle daemon 停止"
	fi

	# adb server
	_dmb_adb="${DANMUBOX_ANDROID_ENV_ROOT}/sdk/platform-tools/adb"
	if [ -x "${_dmb_adb}" ]; then
		_dmb_info "停止 adb server"
		"${_dmb_adb}" kill-server >/dev/null 2>&1 || _dmb_warn "adb kill-server 失败，忽略并继续"
	else
		_dmb_info "未发现 adb，跳过 adb server 停止"
	fi

	_dmb_info "删除前占用："
	du -sh "${DANMUBOX_ANDROID_ENV_ROOT}"
	for _dmb_d in "${DANMUBOX_ANDROID_ENV_ROOT}"/*; do
		[ -d "${_dmb_d}" ] || continue
		printf '  %s\t%s\n' "$(du -sh "${_dmb_d}" 2>/dev/null | cut -f1)" "$(basename "${_dmb_d}")"
	done

	_dmb_size=$(du -sh "${DANMUBOX_ANDROID_ENV_ROOT}" | cut -f1)
	rm -rf "${DANMUBOX_ANDROID_ENV_ROOT}"
	_dmb_info "已删除 ${DANMUBOX_ANDROID_ENV_ROOT}（释放 ${_dmb_size}）"
	_dmb_info "提示：本 shell 里之前导出的 JAVA_HOME/ANDROID_HOME/PATH 已失效，需要时重新 bootstrap + source"
}

_dmb_usage() {
	cat <<'EOF'
用法：
  . scripts/android-env.sh           # 把工具链环境导出到当前 shell（必须 source）
  scripts/android-env.sh bootstrap   # 从零安装 JDK17/21、Android SDK/NDK、Rust android target
  scripts/android-env.sh clean       # 停 gradle daemon / adb server 后删除整个 .android-env
  scripts/android-env.sh help        # 显示本用法

说明：
  * 所有东西都装在仓库内的 .android-env/，删掉它就等于卸载干净。
  * source 时可用 ANDROID_JDK=21 切到 JDK 21（默认 17）。
  * 详细说明见 docs/operations.md §5。
EOF
}

# -----------------------------------------------------------------------------
# 分发
# -----------------------------------------------------------------------------
_dmb_sub="${1:-}"

case "${_dmb_sub}" in
"")
	if [ "${_dmb_sourced}" = "1" ]; then
		# source 用法：只导出环境变量
		_dmb_export_env
	else
		_dmb_err "直接执行无法把环境变量导给父 shell，请用 . scripts/android-env.sh 或选择子命令"
		_dmb_usage
		_dmb_stop 1
	fi
	;;
bootstrap)
	( _dmb_bootstrap )
	_dmb_stop $?
	;;
clean)
	( _dmb_clean )
	_dmb_stop $?
	;;
help | -h | --help)
	_dmb_usage
	_dmb_stop 0
	;;
*)
	_dmb_err "未知子命令：${_dmb_sub}"
	_dmb_usage >&2
	_dmb_stop 1
	;;
esac
