#!/usr/bin/env ts-node
import fs from 'node:fs';
import path from 'node:path';
import { SKILL_CATALOG } from '../src/core/vone_skill_catalog';
import { validateCatalog } from '../src/core/vone_skill_contract';
import { generateSkillMarkdown } from '../src/core/vone_skill_md_generator';

/**
 * Writes skills/<id>/SKILL.md for every entry in SKILL_CATALOG - the
 * portable package format (frontmatter name/description + markdown body)
 * that both Claude's and ChatGPT's skill loaders accept. This is the ONLY
 * writer of that directory: everything under skills/ is generated, so
 * hand-editing a SKILL.md there is pointless - it gets overwritten on the
 * next export. Edit src/core/vone_skill_catalog.ts instead.
 */
function main(): void {
    const problems = validateCatalog(SKILL_CATALOG);
    if (problems.length > 0) {
        console.error('export-skills: catalog is invalid, aborting:');
        for (const p of problems) console.error(`  - ${p}`);
        process.exitCode = 1;
        return;
    }

    const repoRoot = path.resolve(__dirname, '..');
    const skillsRoot = path.join(repoRoot, 'skills');
    fs.mkdirSync(skillsRoot, { recursive: true });

    for (const skill of SKILL_CATALOG) {
        const dir = path.join(skillsRoot, skill.id);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'SKILL.md'), generateSkillMarkdown(skill));
        console.log(`export-skills: wrote skills/${skill.id}/SKILL.md`);
    }

    const readmePath = path.join(skillsRoot, 'README.md');
    fs.writeFileSync(
        readmePath,
        [
            '# Generated - do not edit by hand',
            '',
            'Every SKILL.md under this directory is generated from',
            '`src/core/vone_skill_catalog.ts` by `npm run export:skills`.',
            'Edit the catalog entry (and its backing module, if any) and',
            're-run the export instead of editing a file here directly -',
            'it will be overwritten on the next export.',
            '',
        ].join('\n'),
    );
    console.log(`export-skills: wrote skills/README.md (${SKILL_CATALOG.length} skill(s) exported)`);
}

main();
