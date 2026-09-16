// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(result) = app_lib::run_nats_store_preparation_child() {
        if let Err(error) = result {
            eprintln!("NATS store preparation failed: {error}");
            std::process::exit(1);
        }
        return;
    }
    app_lib::run();
}
