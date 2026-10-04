import { createHash } from 'node:crypto';

export type EcosystemVendor =
  | 'openai'
  | 'anthropic'
  | 'ollama'
  | 'meta-llama'
  | 'github-copilot'
  | 'mcp'
  | 'other';

export type ChangeKind =
  | 'DOCS'
  | 'PATCH'
  | 'MINOR'
  | 'MAJOR'
  | 'MODEL'
  | 'TOOL'
  | 'API'
  | 'PROTOCOL'
  | 'PRICING'
  | 'SECURITY'
  | 'UNKNOWN';

export type PromotionAction = 'AUTO_PROMOTE' | 'SANDBOX_EVAL' | 'HOLD';

export interface EcosystemChange {
  readonly vendor: EcosystemVendor;
  readonly sourceId: string;
  readonly kind: ChangeKind;
  readonly summary: string;
  readonly breaking: boolean;
  readonly costImpact: 'ZERO_COST_VERIFIED' | 'NO_CHANGE' | 'PAID' | 'UNKNOWN';
  readonly securityImpact: 'IMPROVES' | 'NO_CHANGE' | 'WEAKENS' | 'UNKNOWN';
}

export interface EvaluationEvidence {
  readonly testsPass: boolean;
  readonly evalsPass: boolean;
  readonly backwardCompatible: boolean;
  readonly zeroCostVerified: boolean;
  readonly securityNonRegressive: boolean;
  readonly noKnownRegression: boolean;
}

export interface PromotionDecision {
  readonly action: PromotionAction;
  readonly reasons: readonly string[];
}

export const CORE_ECOSYSTEM: readonly EcosystemVendor[] = [
  'openai',
  'anthropic',
  'ollama',
  'meta-llama',
  'github-copilot',
  'mcp',
] as const;

export function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function normalizeSignals(values: readonly string[]): string[] {
  return [...new Set(
    values
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => value.replace(/\s+/g, ' ')),
  )].sort((a, b) => a.localeCompare(b));
}

export function decidePromotion(
  change: EcosystemChange,
  evidence?: EvaluationEvidence,
): PromotionDecision {
  const reasons: string[] = [];

  if (change.costImpact === 'PAID' || change.costImpact === 'UNKNOWN') {
    reasons.push(change.costImpact === 'PAID' ? 'PAID_ROUTE_OR_COST_CHANGE' : 'UNKNOWN_COST_IMPACT');
    return { action: 'HOLD', reasons };
  }

  if (change.securityImpact === 'WEAKENS' || change.securityImpact === 'UNKNOWN') {
    reasons.push(change.securityImpact === 'WEAKENS' ? 'SECURITY_REGRESSION' : 'UNKNOWN_SECURITY_IMPACT');
    return { action: 'HOLD', reasons };
  }

  if (change.kind === 'PRICING' || change.kind === 'SECURITY') {
    reasons.push('POLICY_SENSITIVE_CHANGE');
    return { action: 'HOLD', reasons };
  }

  if (change.kind === 'MAJOR' || change.breaking) {
    reasons.push('BREAKING_OR_MAJOR_CHANGE');
    return { action: 'HOLD', reasons };
  }

  if (change.kind === 'DOCS' || change.kind === 'PATCH') {
    reasons.push('LOW_RISK_ADDITIVE_CHANGE');
    return { action: 'AUTO_PROMOTE', reasons };
  }

  if (change.kind === 'UNKNOWN') {
    reasons.push('UNCLASSIFIED_CHANGE');
    return { action: 'HOLD', reasons };
  }

  if (!evidence) {
    reasons.push('EVALUATION_REQUIRED');
    return { action: 'SANDBOX_EVAL', reasons };
  }

  const failed: string[] = [];
  if (!evidence.testsPass) failed.push('TESTS_FAILED');
  if (!evidence.evalsPass) failed.push('EVALS_FAILED');
  if (!evidence.backwardCompatible) failed.push('BACKWARD_COMPATIBILITY_FAILED');
  if (!evidence.zeroCostVerified) failed.push('ZERO_COST_NOT_VERIFIED');
  if (!evidence.securityNonRegressive) failed.push('SECURITY_NON_REGRESSION_FAILED');
  if (!evidence.noKnownRegression) failed.push('KNOWN_REGRESSION');

  if (failed.length) {
    return { action: 'HOLD', reasons: failed };
  }

  return { action: 'AUTO_PROMOTE', reasons: ['SANDBOX_TESTS_AND_EVALS_PASS'] };
}
