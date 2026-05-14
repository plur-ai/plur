/**
 * CapabilityCanary — detect when registered hooks are silently blocked.
 *
 * Platform-agnostic. Each PLUR integration (claw, MCP, future) registers
 * expected capabilities and signals when they fire. After a threshold of
 * ticks (turns, sessions) with zero signals, the canary reports the
 * capability as unhealthy with an actionable fix.
 */

export interface Capability {
  id: string
  description: string
  fix?: string
}

export interface CanaryStatus {
  capability: string
  description: string
  registered: boolean
  firedCount: number
  tickCount: number
  healthy: boolean
  warning?: string
}

export class CapabilityCanary {
  private capabilities = new Map<string, Capability>()
  private fired = new Map<string, number>()
  private ticks = 0
  private threshold: number

  constructor(opts: { threshold?: number } = {}) {
    this.threshold = opts.threshold ?? 3
  }

  /** Register an expected capability. */
  expect(capability: Capability): void {
    this.capabilities.set(capability.id, capability)
    if (!this.fired.has(capability.id)) {
      this.fired.set(capability.id, 0)
    }
  }

  /** Signal that a capability fired (call from hook handlers). */
  signal(id: string): void {
    this.fired.set(id, (this.fired.get(id) ?? 0) + 1)
  }

  /** Signal that a turn/session completed (call from the "tick" hook). */
  tick(): void {
    this.ticks++
  }

  /** Get current health status for all capabilities. */
  status(): CanaryStatus[] {
    return Array.from(this.capabilities.entries()).map(([id, cap]) => {
      const firedCount = this.fired.get(id) ?? 0
      const healthy = firedCount > 0 || this.ticks < this.threshold
      const warning = healthy ? undefined : this._buildWarning(cap, firedCount)
      return {
        capability: id,
        description: cap.description,
        registered: true,
        firedCount,
        tickCount: this.ticks,
        healthy,
        warning,
      }
    })
  }

  /** Get concatenated warning text for unhealthy capabilities. Empty string if all healthy. */
  warnings(): string {
    return this.status()
      .filter(s => !s.healthy)
      .map(s => s.warning!)
      .join('\n\n')
  }

  /** Reset all counters (e.g. after config hot-reload recovery). */
  reset(): void {
    this.ticks = 0
    for (const id of this.fired.keys()) {
      this.fired.set(id, 0)
    }
  }

  private _buildWarning(cap: Capability, firedCount: number): string {
    const lines = [
      `PLUR WARNING: "${cap.description}" has not fired after ${this.ticks} turns (expected at least 1).`,
    ]
    if (cap.fix) lines.push(`Fix: ${cap.fix}`)
    return lines.join('\n')
  }
}
