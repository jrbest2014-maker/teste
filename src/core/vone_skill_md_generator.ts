import type { VOneSkill } from './vone_skill_contract';

/**
 * Renders a VOneSkill as a portable SKILL.md: YAML frontmatter (name,
 * description, version, triggers, implemented-by) followed by the skill's
 * body. This is the ONLY place that produces the exported package format -
 * skills/<id>/SKILL.md - so there is one function to keep correct instead
 * of a hand-maintained file per skill that can quietly drift from the code.
 */

function yamlScalar(value: string): string {
    // Frontmatter values here are single-line (title/description/path); a
    // literal newline would break the YAML block, so refuse rather than
    // silently mangle it.
    if (value.includes('\n')) {
        throw new Error('YAML frontmatter scalar must not contain a newline');
    }
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function yamlList(values: readonly string[]): string {
    return `[${values.map(yamlScalar).join(', ')}]`;
}

export function generateSkillMarkdown(skill: VOneSkill): string {
    const lines = [
        '---',
        `name: ${skill.id}`,
        `description: ${yamlScalar(skill.description)}`,
        `version: ${yamlScalar(skill.version)}`,
        `triggers: ${yamlList(skill.triggers)}`,
    ];
    if (skill.implementedBy && skill.implementedBy.length > 0) {
        lines.push(`implemented-by: ${yamlList(skill.implementedBy)}`);
    }
    lines.push('---', '', `# ${skill.title}`, '', skill.body.trim(), '');

    return lines.join('\n');
}
