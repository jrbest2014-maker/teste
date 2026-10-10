import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SKILL_CATALOG } from './vone_skill_catalog';
import { validateCatalog } from './vone_skill_contract';
import { generateSkillMarkdown } from './vone_skill_md_generator';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function main(): void {
    assert.ok(SKILL_CATALOG.length > 0, 'catalog must not be empty');

    assert.deepEqual(validateCatalog(SKILL_CATALOG), []);

    for (const skill of SKILL_CATALOG) {
        for (const relativePath of skill.implementedBy ?? []) {
            const absolute = path.join(REPO_ROOT, relativePath);
            assert.ok(
                fs.existsSync(absolute),
                `${skill.id}: implementedBy path does not exist on disk: ${relativePath}`,
            );
        }
        // Every catalog entry must also render without throwing - this is
        // the same call export:skills makes, so a bad entry fails here
        // before it ever reaches the export script.
        const md = generateSkillMarkdown(skill);
        assert.ok(md.includes(`name: ${skill.id}`));
    }

    // No two skills may claim the same implementing file - that would mean
    // one of the two descriptions is describing something it doesn't own.
    const seenPaths = new Set<string>();
    for (const skill of SKILL_CATALOG) {
        for (const relativePath of skill.implementedBy ?? []) {
            assert.ok(!seenPaths.has(relativePath), `implementedBy path claimed by more than one skill: ${relativePath}`);
            seenPaths.add(relativePath);
        }
    }

    console.log(`vone_skill_catalog: all assertions passed (${SKILL_CATALOG.length} skills)`);
}

main();
