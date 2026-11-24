/**
 * AxeBuilder for a @playwright/test page.
 *
 * npm resolves two copies of playwright-core here: 1.64.1 (nested under @playwright/test → playwright) and 1.65.1
 * (hoisted, required by @axe-core/playwright 4.14.0). Their `Page` types are structurally different, so TypeScript
 * rejects passing one for the other although the runtime object is the same page. This is the one place that bridges
 * them, so `npm run typecheck` and `npm run build` stay green without touching tsconfig.json.
 */
import { AxeBuilder } from '@axe-core/playwright'
import type { Page } from '@playwright/test'

type AxePage = ConstructorParameters<typeof AxeBuilder>[0]['page']

export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']

export function axe(page: Page): AxeBuilder {
  return new AxeBuilder({ page: page as unknown as AxePage }).withTags(AXE_TAGS)
}
