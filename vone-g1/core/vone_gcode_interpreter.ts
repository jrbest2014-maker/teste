import { VOneVFSSandbox } from './vone_vfs_sandbox';

export interface ExtruderSafetyLimits {
    maxTemperature: number;
    maxVelocity: number;
}

export class VOneGCodeInterpreter {
    constructor(private sandbox: VOneVFSSandbox, private limits: ExtruderSafetyLimits) {}

    public validateGCodeStream(gcodeLines: string[]): { safe: boolean; errors: string[] } {
        const errors: string[] = [];
        gcodeLines.forEach((line, i) => {
            const clean = line.trim().toUpperCase();
            if (clean.startsWith('M104') || clean.startsWith('M109')) {
                const match = clean.match(/S(\d+)/);
                if (match && parseInt(match[1], 10) > this.limits.maxTemperature) {
                    errors.push(`Linha ${i + 1}: Temperatura excede o limite físico.`);
                }
            }
        });
        return { safe: errors.length === 0, errors };
    }
}