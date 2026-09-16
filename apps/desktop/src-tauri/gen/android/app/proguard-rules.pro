# 一键诊断的原生插件：类与它的 @Command 方法都由**反射**按名字找
# （Rust 侧 `api.register_android_plugin` → JNI `find_class`，方法靠 `@Command` 注解遍历），
# 代码里没有任何静态引用，release 的 R8 会把它整类删掉 —— 必须显式保住。
-keep class dev.kksk.danmubox.DiagnosePlugin { *; }
-keep class dev.kksk.danmubox.WriteDownloadArgs { *; }

# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile