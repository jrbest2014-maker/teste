import assert from 'node:assert/strict';
import { validateCatalog, validateSkill, type VOneSkill } from './vone_skill_contract';

const VALID: VOneSkill = {
    id: 'my-skill',
    title: 'My Skill',
    description: 'A description long enough to pass the minimum length check.',
    version: '1.0.0',
    triggers: ['do thing'],
    body: 'Do the thing.',
};

function main(): void {
    assert.deepEqual(validateSkill(VALID), []);

    assert.ok(validateSkill({ ...VALID, id: 'Not_Kebab' }).some((p) => p.includes('kebab-case')));
    assert.ok(validateSkill({ ...VALID, id: '-leading-dash' }).some((p) => p.includes('kebab-case')));

    assert.ok(validateSkill({ ...VALID, title: '   ' }).some((p) => p.includes('title')));

    assert.ok(validateSkill({ ...VALID, description: 'short' }).some((p) => p.includes('description')));

    assert.ok(validateSkill({ ...VALID, version: '1.0' }).some((p) => p.includes('version')));
    assert.ok(validateSkill({ ...VALID, version: 'v1.0.0' }).some((p) => p.includes('version')));

    assert.ok(validateSkill({ ...VALID, triggers: [] }).some((p) => p.includes('triggers')));
    assert.ok(validateSkill({ ...VALID, triggers: ['  '] }).some((p) => p.includes('trigger')));

    assert.ok(validateSkill({ ...VALID, body: '' }).some((p) => p.includes('body')));

    assert.ok(validateSkill({ ...VALID, implementedBy: [''] }).some((p) => p.includes('implementedBy')));

    // validateCatalog: duplicate id detection, and problems are prefixed per-skill.
    const dup = validateCatalog([VALID, VALID]);
    assert.ok(dup.some((p) => p.includes('duplicate skill id')));

    const mixed = validateCatalog([VALID, { ...VALID, id: 'other-skill', title: '' }]);
    assert.ok(mixed.some((p) => p.startsWith('other-skill:')));
    assert.ok(!mixed.some((p) => p.startsWith('my-skill:')));

    console.log('vone_skill_contract: all assertions passed');
}

main();
