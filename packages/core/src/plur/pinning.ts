import { Plur } from '../index.js'


import { type ChangeRecord } from '../change-journal.js'
import { DEFAULT_PINNED_HARD_RATIO } from '../inject.js'
import { type Engram } from '../schemas/engram.js'
import { type LlmFunction } from '../types.js'
import { type PendingPinRequest, type PinActor, type PinDecision, PinDeniedError, type PinFitReport, computePinFitReport, pinDecision, pinRequestOf, withoutPinRequest } from '../pin-policy.js'
import { type PinApplyOutcome, type PinAuditProposal, auditPins as auditPinsImpl, planPinApply } from '../pin-audit.js'
import { detectSecrets } from '../secrets.js'
import { parseNamespacedId } from '../engrams.js'
import { resolvePinningConfig } from '../schemas/config.js'
export interface PinningMethods {
  /**
   * Set who this instance writes for when a call names no actor: the MCP
   * server sets `agent`, the CLI `owner`. `undefined` clears it (the pinning
   * policy then applies to every pin).
   */
  setDefaultActor(actor: PinActor | undefined): void

  /** What `pinning.agents` decides for a pin by this caller (`owner` is always allowed). */
  pinPolicyFor(actor?: PinActor): PinDecision

  /** @internal */
  _pinDecisionFor(actor: PinActor | undefined): PinDecision

  /** @internal */
  _remotePinRefusal(id: string, via: string): PinDeniedError

  /**
   * Engrams waiting for the owner to approve a pin (`pinning.agents:
   * request`), oldest request first. The session-start notice prints
   * `formatPendingPinRequestsLine(await plur.pendingPinRequests())`.
   */
  pendingPinRequests(): Promise<PendingPinRequest[]>

  /**
   * Approve a pending pin request: pin the engram (with the tier and
   * priority the request asked for) and clear the request. An owner action:
   * the actor is the one given, else this instance's default actor, and one
   * the pin policy restricts is refused (S4) — pass `actor: 'owner'`.
   */
  approvePinRequest(id: string, options?: { actor?: PinActor }): Promise<Engram | null>

  /** Reject a pending pin request: clear it, leaving the engram unpinned. */
  rejectPinRequest(id: string, options?: { actor?: PinActor }): Promise<Engram | null>

  /**
   * The actor reviewing a pin request (S4): the one given, else this
   * instance's default actor — never an assumed owner. Reviewing is an owner
   * action, so a caller the pin policy restricts is refused.
   */
  /** @internal */
  _pinReviewActor(id: string, verb: 'approve' | 'reject', given?: PinActor): PinActor | undefined

  /**
   * Set the injection priority of a pin (1–100, higher loads first; default
   * 50). Refuses an engram that is not pinned.
   */
  setPinPriority(id: string, priority: number, options?: { actor?: PinActor }): Promise<Engram | null>

  /**
   * The pinned set against its share of the injection budget (overhaul D3):
   * each pin's priority and cost, and which do not fit. Computed with the
   * injection's own selector; `budget` defaults to `injection_budget`.
   */
  pinFitReport(options?: { budget?: number }): Promise<PinFitReport>

  /**
   * Pin audit (overhaul W3): ask the host model (`llm`) to sort each pin of
   * the LOCAL store into every-task or situational and propose short forms.
   * Changes nothing; returns the proposal.
   */
  auditPins(llm: LlmFunction, options?: { model?: string; batchSize?: number; onProgress?: (done: number, total: number) => void }): Promise<PinAuditProposal>

  /**
   * Apply a reviewed pin audit proposal as ONE journalled change (undo with
   * `undoChange(change.id)`). Unpins situational pins and sets short forms
   * (original kept in `structured_data.original_statement`); a prohibition's
   * short form needs `approved: true` on its item. `limit` caps the applied
   * items (the one-item trial is `limit: 1`).
   */
  applyPinAudit(proposal: PinAuditProposal, options?: { limit?: number; actor?: PinActor }): Promise<{ change: ChangeRecord | null; outcomes: PinApplyOutcome[] }>
}

export const pinningMethods: PinningMethods & ThisType<Plur> = {
  setDefaultActor(actor: PinActor | undefined): void {
    if (actor !== undefined && actor !== 'owner' && actor !== 'agent') {
      throw new TypeError(`plur.setDefaultActor: actor must be "owner" or "agent", got ${String(actor)}`)
    }
    this._defaultActor = actor
  },

  pinPolicyFor(actor?: PinActor): PinDecision {
    return this._pinDecisionFor(actor)
  },

  _pinDecisionFor(actor: PinActor | undefined): PinDecision {
    return pinDecision(this.config, actor ?? this._defaultActor)
  },

  _remotePinRefusal(id: string, via: string): PinDeniedError {
    return new PinDeniedError(id, `${via}:remote`,
      `${id} is a team-store row, and this install reserves pinning for the owner (pinning.agents: `
      + `${resolvePinningConfig(this.config).agents}); a pin request cannot be recorded on a team-store row, so it was not pinned. `
      + 'Ask the owner to pin it with `plur pin <id>`.')
  },

  async pendingPinRequests(): Promise<PendingPinRequest[]> {
    const out: PendingPinRequest[] = []
    for (const e of await this._readCorpus()) {
      if (e.status !== 'active') continue
      const request = pinRequestOf(e)
      if (request) out.push({ id: e.id, statement: e.statement, scope: e.scope, request })
    }
    return out.sort((a, b) => a.request.requested_at < b.request.requested_at ? -1 : a.request.requested_at > b.request.requested_at ? 1 : 0)
  },

  async approvePinRequest(id: string, options?: { actor?: PinActor }): Promise<Engram | null> {
    this._remoteOnlyRefuseLocalStore('Approving a pin request (run it outside the remote-only folder)')
    const actor = this._pinReviewActor(id, 'approve', options?.actor)
    const row = (await this._loadTargeted([id])).find(e => e.id === id)
    if (!row) return null
    const request = pinRequestOf(row)
    if (!request) throw new Error(`${id} has no pending pin request.`)
    const pinned = await this.setPinned(id, true, { scope: 'primary', actor })
    if (!pinned || pinned.pinned !== true) return pinned
    if (request.tier === undefined && request.priority === undefined) return pinned
    return await this._updateEngramReturning({
      ...pinned,
      ...(request.tier ? { pinned_tier: request.tier } : {}),
      ...(request.priority !== undefined ? { pinned_priority: request.priority } : {}),
    } as Engram, { actor })
  },

  async rejectPinRequest(id: string, options?: { actor?: PinActor }): Promise<Engram | null> {
    this._remoteOnlyRefuseLocalStore('Rejecting a pin request (run it outside the remote-only folder)')
    const actor = this._pinReviewActor(id, 'reject', options?.actor)
    const row = (await this._loadTargeted([id])).find(e => e.id === id)
    if (!row) return null
    if (!pinRequestOf(row)) throw new Error(`${id} has no pending pin request.`)
    return await this._updateEngramReturning(
      withoutPinRequest(row as unknown as Record<string, unknown>) as unknown as Engram, { actor })
  },

  _pinReviewActor(id: string, verb: 'approve' | 'reject', given?: PinActor): PinActor | undefined {
    const actor = given ?? this._defaultActor
    if (this._pinDecisionFor(actor) !== 'allow') {
      throw new PinDeniedError(id, `${verb}:pin_request`,
        `Reviewing a pin request is an owner action on this install (pinning.agents: ${resolvePinningConfig(this.config).agents}), `
        + `so ${id}'s request was not ${verb === 'approve' ? 'approved' : 'rejected'}. The owner runs \`plur pins ${verb} ${id}\`.`)
    }
    return actor
  },

  async setPinPriority(id: string, priority: number, options?: { actor?: PinActor }): Promise<Engram | null> {
    if (typeof priority !== 'number' || !Number.isInteger(priority) || priority < 1 || priority > 100) {
      throw new TypeError(`plur.setPinPriority: priority must be an integer from 1 to 100, got ${String(priority)}`)
    }
    const row = await this.getById(id)
    if (!row) return null
    if (row.pinned !== true) throw new Error(`${id} is not pinned; pin it first (plur pin ${id}).`)
    return await this._updateEngramReturning({ ...row, pinned_priority: priority } as Engram, { actor: options?.actor })
  },

  async pinFitReport(options?: { budget?: number }): Promise<PinFitReport> {
    this.reloadConfigIfChanged()
    return computePinFitReport(await this.listPinned(), {
      budget: options?.budget ?? this.config.injection_budget ?? 2000,
      pinnedRatio: this.config.injection?.pinned_ratio ?? 0.5,
      hardRatio: this.config.injection?.pinned_hard_ratio ?? DEFAULT_PINNED_HARD_RATIO,
    })
  },

  async auditPins(llm: LlmFunction, options?: { model?: string; batchSize?: number; onProgress?: (done: number, total: number) => void }): Promise<PinAuditProposal> {
    // It sends the personal store's pins to a model (a pin audit acts on locally owned pins only).
    this._remoteOnlyRefuseLocalStore('A pin audit (run it outside the remote-only folder)')
    const local = (await this.listPinned()).filter(e => !parseNamespacedId(e.id)
      && (e as { _pack?: unknown })._pack === undefined && (e as { _storeScope?: unknown })._storeScope === undefined)
    return await auditPinsImpl(local, llm, options)
  },

  async applyPinAudit(proposal: PinAuditProposal, options?: { limit?: number; actor?: PinActor }): Promise<{ change: ChangeRecord | null; outcomes: PinApplyOutcome[] }> {
    let outcomes: Array<PinApplyOutcome & { row?: Engram }> = []
    const record = await this.beginChange('pins.apply', {
      actor: options?.actor ?? this._defaultActor ?? null,
      proposal_created_at: proposal.created_at,
      ...(options?.limit !== undefined ? { limit: options.limit } : {}),
    }).apply(tx => {
      // The proposal file is editable: a short form is scanned like any
      // write before it replaces a statement (S8).
      outcomes = planPinApply(proposal, id => tx.get(id), {
        limit: options?.limit,
        sensitive: (text, scope) => detectSecrets(text).length > 0 || this._offendingHitsForScope(text, scope).length > 0,
      })
      for (const o of outcomes) if (o.row) tx.put(o.row)
    })
    return {
      change: record.rows.length > 0 ? record : null,
      outcomes: outcomes.map(({ row: _row, ...o }) => o),
    }
  },
}
