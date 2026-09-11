// Windows 下隐藏控制台窗口；其余平台直接调用库入口。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    danmubox_desktop::run();
}
