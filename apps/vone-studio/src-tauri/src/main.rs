// Shell desktop: nenhuma lógica própria aqui de propósito. A UI inteira
// (chat, tool-calls, codespace) é a mesma build web de ../dist - este
// binário só abre uma janela nativa apontando pra ela. Qualquer comando
// nativo real (abrir pasta do SO, notificações) entra aqui depois, exposto
// via tauri::command, nunca duplicando o que já existe na camada web.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o V-ONE Studio (desktop)");
}
