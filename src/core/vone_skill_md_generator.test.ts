import assert from 'node:assert/strict';
import { generateSkillMarkdown } from './vone_skill_md_generator';
import type { VOneSkill } from './vone_skill_contract';

const SKILL: VOneSkill = {
    id: 'my-skill',
    title: 'My Skill',
    description: 'Does the thing, with a "quoted" word.',
    version: '1.0.0',
    triggers: ['do thing', 'other trigger'],
    implementedBy: ['src/core/example.ts'],
    body: '  Do the thing.\n  Then stop.  ',
};

function main(): void {
    const md = generateSkillMarkdown(SKILL);

    assert.ok(md.startsWith('---\n'));
    assert.ok(md.includes('name: my-skill\n'));
    assert.ok(md.includes('description: "Does the thing, with a \\"quoted\\" word."\n'));
    assert.ok(md.includes('version: "1.0.0"\n'));
    assert.ok(md.includes('triggers: ["do thing", "other trigger"]\n'));
    assert.ok(md.includes('implemented-by: ["src/core/example.ts"]\n'));
    assert.ok(md.includes('# My Skill'));
    assert.ok(md.includes('Do the thing.\n  Then stop.'));
    // body is trimmed before being embedded, so no leading blank line after the heading
    assert.ok(!md.includes('# My Skill\n\n\n'));

    // No implementedBy -> no implemented-by line at all.
    const noImpl = generateSkillMarkdown({ ...SKILL, implementedBy: undefined });
    assert.ok(!noImpl.includes('implemented-by:'));

    // A newline in a frontmatter scalar must fail loudly, not corrupt the YAML.
    assert.throws(() => generateSkillMarkdown({ ...SKILL, description: 'line one\nline two' }), /newline/);

    console.log('vone_skill_md_generator: all assertions passed');
}

main();
