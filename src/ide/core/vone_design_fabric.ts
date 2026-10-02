export class VOneDesignFabric {
    public buildProfessionalViewport(projectName: string, activeAgentStatus: string): string {
        return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <title>V-ONE SUPREME PLATFORM</title>
    <style>
        body { background: #0f172a; color: #f8fafc; font-family: sans-serif; display: flex; height: 100vh; margin:0; }
        .editor { flex:1; background: #0b0f19; padding:20px; border-right: 1px solid #334155; }
        .sidebar { width:250px; background: #1e293b; padding:20px; }
        .emerald-text { color: #10b981; font-weight: bold; }
        #canvas3d { width: 100%; height: 300px; background: #090d16; border: 1px solid #334155; margin-top:20px; border-radius:8px; }
    </style>
    <!-- Importando Three.js de forma estável para render geométrico 3D da extrusora -->
    <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
</head>
<body>
    <div class="sidebar">
        <h3>V-ONE WORKSPACE</h3>
        <p>Status: <span class="emerald-text">${activeAgentStatus}</span></p>
        <p>Projeto: ${projectName}</p>
    </div>
    <div class="editor">
        <h2>Visualizador de Hardware & Criação Espacial</h2>
        <div id="canvas3d"></div>
    </div>
    <script>
        // Inicialização do Motor Gráfico Three.js (Geometria Real da Extrusora Cerâmica de Alta Velocidade)
        const container = document.getElementById('canvas3d');
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x090d16);

        const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 1000);
        camera.position.set(0, 5, 10);

        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setSize(container.clientWidth, container.clientHeight);
        container.appendChild(renderer.domElement);

        // Iluminação de Estúdio Fotorrealista Semântica
        const light = new THREE.DirectionalLight(0x10b981, 1.5);
        light.position.set(5, 10, 7);
        scene.add(light);
        scene.add(new THREE.AmbientLight(0x334155, 0.8));

        // Construção Paramétrica do Bloco de Aquecimento Cerâmico da Extrusora (3D Real Buffer)
        const blockGeo = new THREE.BoxGeometry(2, 1.5, 2);
        const blockMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.2, metalness: 0.8 });
        const blockMesh = new THREE.Mesh(blockGeo, blockMat);
        scene.add(blockMesh);

        // Bico de Latão/Cerâmica da Extrusora (Cone Geométrico)
        const nozzleGeo = new THREE.ConeGeometry(0.6, 1, 4);
        const nozzleMat = new THREE.MeshStandardMaterial({ color: 0x10b981, roughness: 0.1, metalness: 0.9 });
        const nozzleMesh = new THREE.Mesh(nozzleGeo, nozzleMat);
        nozzleMesh.position.y = -1.25;
        nozzleMesh.rotation.x = Math.PI;
        scene.add(nozzleMesh);

        camera.lookAt(0, 0, 0);

        // Loop de Renderização e Animação Cinemática Espacial
        function animate() {
            requestAnimationFrame(animate);
            blockMesh.rotation.y += 0.01;
            nozzleMesh.rotation.y += 0.01;
            renderer.render(scene, camera);
        }
        animate();

        window.addEventListener('resize', () => {
            camera.aspect = container.clientWidth / container.clientHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(container.clientWidth, container.clientHeight);
        });
    </script>
</body>
</html>`;
    }
}