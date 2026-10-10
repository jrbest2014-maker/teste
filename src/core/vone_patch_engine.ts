import * as crypto from 'crypto';
import { VOneVFSSandbox } from './vone_vfs_sandbox';

export interface VOnePatchOptions {
    expectedSha256?: string;
}

export interface VOnePatchResult {
    beforeSha256: string;
    afterSha256: string;
    replacements: number;
}

export class VOnePatchEngine {
    constructor(private readonly sandbox: VOneVFSSandbox) {}

    public applyBlockPatch(relativePath: string, patchContent: string, options: VOnePatchOptions = {}): VOnePatchResult {
        const originalContent = this.sandbox.readFile(relativePath);
        const beforeSha256 = this.sha256(originalContent);

        if (options.expectedSha256 && options.expectedSha256 !== beforeSha256) {
            throw new Error(`[PATCH ERROR]: SHA-256 precondition failed for ${relativePath}.`);
        }

        const blocks = this.extractBlocks(patchContent);
        const normalizedOriginal = this.normalizeEol(originalContent);
        const normalizedSearch = this.normalizeEol(blocks.search);
        const normalizedReplace = this.normalizeEol(blocks.replace);

        if (!normalizedSearch.length) {
            throw new Error('[PATCH ERROR]: SEARCH block cannot be empty.');
        }

        const matches = this.countOccurrences(normalizedOriginal, normalizedSearch);
        if (matches === 0) {
            throw new Error('[PATCH ERROR]: SEARCH block not found.');
        }
        if (matches !== 1) {
            throw new Error(`[PATCH ERROR]: SEARCH block is ambiguous (${matches} matches).`);
        }

        const updatedNormalized = normalizedOriginal.replace(normalizedSearch, normalizedReplace);
        const originalEol = originalContent.includes('\r\n') ? '\r\n' : '\n';
        const updatedContent = originalEol === '\r\n'
            ? updatedNormalized.replace(/\n/g, '\r\n')
            : updatedNormalized;

        this.sandbox.writeFile(relativePath, updatedContent);
        return {
            beforeSha256,
            afterSha256: this.sha256(updatedContent),
            replacements: 1,
        };
    }

    private extractBlocks(text: string): { search: string; replace: string } {
        const normalized = this.normalizeEol(text);
        const pattern = /<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE(?:\n|$)/;
        const match = normalized.match(pattern);
        if (!match) {
            throw new Error('[PATCH ERROR]: Invalid patch format.');
        }
        return { search: match[1], replace: match[2] };
    }

    private countOccurrences(haystack: string, needle: string): number {
        let count = 0;
        let offset = 0;
        while (true) {
            const index = haystack.indexOf(needle, offset);
            if (index === -1) break;
            count += 1;
            offset = index + Math.max(needle.length, 1);
        }
        return count;
    }

    private normalizeEol(value: string): string {
        return value.replace(/\r\n/g, '\n');
    }

    private sha256(value: string): string {
        return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
    }
}
