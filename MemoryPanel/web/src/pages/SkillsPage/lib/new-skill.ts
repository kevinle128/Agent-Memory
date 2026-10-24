/** Build and check the input of the "New Skill" dialog. No React, so tests can load it. */
import type { KnownProject, SkillScope } from './skill-scope';

export interface NewSkillInput {
  name: string;
  description: string;
  body: string;
  scope: SkillScope;
  /** Project hash; required when scope is "project". */
  projectHash: string;
  agentId: string;
}

export type NewSkillIssue = 'name' | 'nameLength' | 'nameLines' | 'agent' | 'project';

/** Every problem of the input, in form order. Empty when the input is valid. */
export function validateNewSkillAll(input: NewSkillInput): NewSkillIssue[] {
  const issues: NewSkillIssue[] = [];
  const name = input.name.trim();
  if (!name) issues.push('name');
  else if (name.length > 64) issues.push('nameLength');
  else if (/[\r\n]/.test(name)) issues.push('nameLines');
  if (!input.agentId) issues.push('agent');
  if (input.scope === 'project' && !input.projectHash) issues.push('project');
  return issues;
}

/** First problem of the input, or null. */
export function validateNewSkill(input: NewSkillInput): NewSkillIssue | null {
  return validateNewSkillAll(input)[0] ?? null;
}

/** SKILL.md text. The frontmatter name must equal the skill name. */
export function buildSkillContent(input: Pick<NewSkillInput, 'name' | 'description' | 'body'>): string {
  const name = input.name.trim();
  const description = input.description.replace(/\s+/g, ' ').trim();
  const front = ['---', `name: ${name}`, ...(description ? [`description: ${JSON.stringify(description)}`] : []), '---'];
  const body = input.body.trim() || `# ${name}`;
  return `${front.join('\n')}\n\n${body}\n`;
}

/** Scope fields for the create request. Global skills send none. */
export function placementFor(
  scope: SkillScope,
  projectHash: string,
  projects: KnownProject[],
): { scope: SkillScope; project_hash?: string; project_key?: string; project_name?: string } {
  if (scope === 'global') return { scope: 'global' };
  const p = projects.find((x) => x.hash === projectHash);
  return {
    scope: 'project',
    project_hash: projectHash,
    ...(p?.key ? { project_key: p.key } : {}),
    ...(p?.label ? { project_name: p.label } : {}),
  };
}
