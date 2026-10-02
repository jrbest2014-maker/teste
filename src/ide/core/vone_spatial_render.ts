export class VOneSpatialRenderEngine {
    public generateVRayMaterialConfig(name: string): string {
        return JSON.stringify({ material: name, render: 'GGX_FOTORREALISTA' });
    }
}