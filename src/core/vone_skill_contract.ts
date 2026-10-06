/**
 * A "hard skill" in V-ONE is executable, tested code living in src/core -
 * never a markdown file maintained on its own. Its catalog entry
 * (vone_skill_catalog.ts) is the single source of truth; the portable
 * SKILL.md package (vone_skill_md_generator.ts, skills/<id>/SKILL.md) is
 * *generated* from that entry, so the exported package can never drift
 * from what the code actually does - there is nothing to hand-sync.
 */

export interface VOneSkill {
    /** kebab-case; becomes the skills/<id>/ directory name on export. */
    readonly id: string;
    /** Human-readable name, 2-4 words recommended. */
    readonly title: string;
    /** One paragraph: what it does and when an agent should use it. */
    readonly description: string;
    /** semver (major.minor.patch). */
    readonly version: string;
    /** Keywords/phrases that should cause this skill to be invoked. */
    readonly triggers: readonly string[];
    /** The instructions/markdown body of the skill. */
    readonly body: string;
    /**
     * Repo-relative paths of the TS module(s) that actually implement this
     * skill's behavior - omitted only for a skill that is pure instructions
     * with no backing code. vone_skill_catalog.test.ts asserts every path
     * listed here exists on disk, so this can't silently rot.
     */
    readonly implementedBy?: readonly string[];
}

const ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
const MIN_DESCRIPTION_LENGTH = 10;

/** Returns a list of problems; an empty list means the skill is valid. */
export function validateSkill(skill: VOneSkill): string[] {
    const problems: string[] = [];

    if (!ID_PATTERN.test(skill.id)) {
        problems.push(`id must be lowercase kebab-case (e.g. "my-skill"): got ${JSON.stringify(skill.id)}`);
    }
    if (skill.title.trim().length === 0) {
        problems.push('title must not be empty');
    }
    if (skill.description.trim().length < MIN_DESCRIPTION_LENGTH) {
        problems.push(`description must be at least ${MIN_DESCRIPTION_LENGTH} characters`);
    }
    if (!SEMVER_PATTERN.test(skill.version)) {
        problems.push(`version must be semver major.minor.patch: got ${JSON.stringify(skill.version)}`);
    }
    if (skill.triggers.length === 0) {
        problems.push('triggers must not be empty');
    }
    for (const trigger of skill.triggers) {
        if (trigger.trim().length === 0) {
            problems.push('trigger must not be an empty string');
            break;
        }
    }
    if (skill.body.trim().length === 0) {
        problems.push('body must not be empty');
    }
    if (skill.implementedBy) {
        for (const path of skill.implementedBy) {
            if (path.trim().length === 0) {
                problems.push('implementedBy entries must not be empty strings');
                break;
            }
        }
    }

    return problems;
}

/** Validates every skill plus catalog-wide invariants (no duplicate ids). */
export function validateCatalog(skills: readonly VOneSkill[]): string[] {
    const problems: string[] = [];
    const seenIds = new Set<string>();

    for (const skill of skills) {
        const label = skill.id || '(missing id)';
        for (const problem of validateSkill(skill)) {
            problems.push(`${label}: ${problem}`);
        }
        if (seenIds.has(skill.id)) {
            problems.push(`${label}: duplicate skill id`);
        }
        seenIds.add(skill.id);
    }

    return problems;
}
