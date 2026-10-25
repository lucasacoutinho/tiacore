import type { RunPlan, RunPlanDecision } from '../core/runtime.ts'

function baselineLabel(plan: RunPlan): string {
  const baseline = plan.baseline
  if (baseline.origin === 'none') {
    return `TIA baseline: none (${baseline.reason}).`
  }

  const source = baseline.source === null ? '' : ` ${baseline.source}`
  const sha = baseline.sha === null ? '' : ` at ${baseline.sha.slice(0, 12)}`
  const provider =
    baseline.provider === undefined ? '' : ` from ${baseline.provider}`
  return `TIA baseline: ${baseline.origin}${source} graph${sha}${provider} (${baseline.reason}).`
}

function decisionLabel(decision: RunPlanDecision): string {
  if (decision.target === 'run') {
    return 'full run'
  }
  if (decision.target === 'test-case') {
    return `${decision.file}#${decision.id}`
  }
  return decision.file
}

export function formatRunPlanDetails(
  plan: RunPlan,
  maximumDecisions = 20,
): string[] {
  const lines = [baselineLabel(plan)]
  if (plan.mode !== 'replay' || plan.decisions.length === 0) {
    return lines
  }

  const decisions = plan.decisions.slice(0, maximumDecisions)
  for (const decision of decisions) {
    lines.push(
      `TIA selected ${decisionLabel(decision)}: ${decision.reasons.join('; ')}.`,
    )
  }
  const omitted = plan.decisions.length - decisions.length
  if (omitted > 0) {
    lines.push(
      `TIA selection: ${omitted} additional decision${
        omitted === 1 ? '' : 's'
      } omitted.`,
    )
  }
  return lines
}
