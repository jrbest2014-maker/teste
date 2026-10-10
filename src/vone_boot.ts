import { VOneVFSSandbox } from './core/vone_vfs_sandbox';
import { VOneIPCBridge } from './ide/network/vone_ipc_bridge';
import { VOneDesignFabric } from './ide/core/vone_design_fabric';

async function bootstrap() {
    console.log("⚡ [V-ONE BOOT]: Inicializando todos os servidores e viewports...");
    const sandbox = new VOneVFSSandbox();
    const ipc = new VOneIPCBridge();
    await ipc.start();
    
    const ui = new VOneDesignFabric();
    const html = ui.buildProfessionalViewport("V-ONE SUPREME PLATFORM", "ACTIVE");
    sandbox.writeFile("vone_ide_viewport.html", html);
    
    console.log("🚀 [V-ONE CORE]: Sistema de pé! Viewport gerada em vone_ide_viewport.html com render 3D Three.js ativo.");
    ipc.close();
}
bootstrap();