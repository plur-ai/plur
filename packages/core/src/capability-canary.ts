export type Capability = {
  id: string
  description: string
  fix?: string
}

export type CanaryStatus = {
  capability: string
  registered: boolean
  firedCount: number
  healthy: boolean
  warning?: string
}

type CapabilityEntry = Capability & { firedCount: number }

/**
 * Detects when a registered hook is silently blocked by the host platform.
 * Integrations register expected capabilities and signal when they fire.
 * After `threshold` ticks with no firing, the capability is flagged as unhealthy.
 */
export class CapabilityCanary {
  private readonly threshold: number
  private ticks = 0
  private capabilities = new Map<string, CapabilityEntry>()

  constructor(opts: { threshold?: number } = {}) {
    this.threshold = opts.threshold ?? 3
  }

  expect(capability: Capability): void {
    if (!this.capabilities.has(capability.id)) {
      this.capabilities.set(capability.id, { ...capability, firedCount: 0 })
    }
  }

  signal(id: string): void {
    const entry = this.capabilities.get(id)
    if (entry) entry.firedCount++
  }

  tick(): void {
    this.ticks++
  }

  status(): CanaryStatus[] {
    return Array.from(this.capabilities.values()).map((entry) => {
      const healthy = entry.firedCount > 0 || this.ticks < this.threshold
      const status: CanaryStatus = {
        capability: entry.id,
        registered: true,
        firedCount: entry.firedCount,
        healthy,
      }
      if (!healthy) {
        const fix = entry.fix ? `\n  Fix: ${entry.fix}` : ''
        status.warning = `⚠️ PLUR capability '${entry.id}' (${entry.description}) has not fired after ${this.ticks} turns. It may be silently blocked.${fix}`
      }
      return status
    })
  }

  warnings(): string {
    return this.status()
      .filter((s) => !s.healthy && s.warning)
      .map((s) => s.warning!)
      .join('\n')
  }

  reset(): void {
    this.ticks = 0
    for (const entry of this.capabilities.values()) {
      entry.firedCount = 0
    }
  }
}
