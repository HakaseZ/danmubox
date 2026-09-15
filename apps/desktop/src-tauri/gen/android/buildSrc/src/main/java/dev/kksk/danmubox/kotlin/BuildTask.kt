import java.io.File
import org.apache.tools.ant.taskdefs.condition.Os
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.logging.LogLevel
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.TaskAction

open class BuildTask : DefaultTask() {
    @Input
    var rootDirRel: String? = null
    @Input
    var target: String? = null
    @Input
    var release: Boolean? = null

    @TaskAction
    fun assemble() {
        val executable = """node""";
        try {
            runTauriCli(executable)
        } catch (e: Exception) {
            if (Os.isFamily(Os.FAMILY_WINDOWS)) {
                // Try different Windows-specific extensions
                val fallbacks = listOf(
                    "$executable.exe",
                    "$executable.cmd",
                    "$executable.bat",
                )
                
                var lastException: Exception = e
                for (fallback in fallbacks) {
                    try {
                        runTauriCli(fallback)
                        return
                    } catch (fallbackException: Exception) {
                        lastException = fallbackException
                    }
                }
                throw lastException
            } else {
                throw e;
            }
        }
    }

    fun runTauriCli(executable: String) {
        val rootDirRel = rootDirRel ?: throw GradleException("rootDirRel cannot be null")
        val target = target ?: throw GradleException("target cannot be null")
        val release = release ?: throw GradleException("release cannot be null")
        // 模板原样是 `node tauri android android-studio-script`：node 会把 `tauri` 当**路径**相对
        // workingDir 解析，因此只有在 workingDir（= `rootDirRel`，即 `apps/desktop/src-tauri`）里
        // 能按 node 模块规则找到 `tauri` 时才成立——也就是要求 app 根目录是个 npm 工程
        // （`package.json` 里带 `tauri` 脚本，`npm run … tauri` 才会被渲染进来）。
        // 本仓库没有 app 根目录的 package.json，前端工程在 `apps/desktop/ui`，于是上游模板必然报
        // `Cannot find module '<…>/src-tauri/tauri'`（2026-09-15 实测）。这里改成直接跑 ui 里的 CLI 入口。
        val appDir = File(project.projectDir, rootDirRel).canonicalFile
        val tauriCli = File(appDir.parentFile, "ui/node_modules/@tauri-apps/cli/tauri.js")
        if (!tauriCli.isFile) {
            throw GradleException(
                "找不到 Tauri CLI：$tauriCli（本仓库的前端工程在 apps/desktop/ui，先 npm --prefix apps/desktop/ui install）"
            )
        }
        val args = listOf(tauriCli.absolutePath, "android", "android-studio-script");

        project.exec {
            workingDir(appDir)
            executable(executable)
            args(args)
            if (project.logger.isEnabled(LogLevel.DEBUG)) {
                args("-vv")
            } else if (project.logger.isEnabled(LogLevel.INFO)) {
                args("-v")
            }
            if (release) {
                args("--release")
            }
            args(listOf("--target", target))
        }.assertNormalExitValue()
    }
}