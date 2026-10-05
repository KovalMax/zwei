import {Injectable, OnDestroy} from '@angular/core';
import {Observable, Subject, Subscription, finalize, timeout} from 'rxjs';
import {Conversation, GroupConversation} from './conversation.model';
import {ConversationService, GroupProjectionFailureError, GroupProjectionFailureReason, GroupProjectionNotFoundError} from './conversation.service';

export interface HomeGroupAccessContext {
    readonly selected: boolean;
    readonly navigationIntentVersion: number;
    readonly projectionRevision: number;
}

export type HomeGroupAccessOutcome =
    | {readonly type: 'quarantined'; readonly groupID: string; readonly selected: boolean}
    | {readonly type: 'authorized'; readonly group: GroupConversation; readonly restoreSelected: boolean; readonly navigationIntentVersion?: number}
    | {readonly type: 'removed'; readonly groupID: string; readonly revision: number}
    | {readonly type: 'retryable'; readonly groupID: string; readonly reason: GroupProjectionFailureReason; readonly quarantined: boolean}
    | {readonly type: 'departure-pending'; readonly groupID: string}
    | {readonly type: 'departure-finished'; readonly groupID: string; readonly failed?: boolean};

interface GroupAccessState {
    revision: number;
    removedRevision?: number;
    quarantined: boolean;
    failed: boolean;
    context?: HomeGroupAccessContext;
    requestRevision: number;
    requestedRevision: number;
    inFlight: boolean;
    departureGeneration: number;
    departureFence?: {generation: number; revision: number};
    departureReconciliationRequired: boolean;
    departure?: {revision: number; context: HomeGroupAccessContext; subscription: Subscription; removalObserved: boolean};
}

/** Owns only Home's group authorization projection fences and their reconciliation lifecycle. */
@Injectable()
export class HomeGroupAccessFacade implements OnDestroy {
    private readonly states = new Map<string, GroupAccessState>();
    private readonly subscriptions = new Subscription();
    private readonly requests = new Map<string, Subscription>();
    private readonly departureOperations = new Map<string, Subscription>();
    private readonly outcomesSubject = new Subject<HomeGroupAccessOutcome>();
    public readonly outcomes$ = this.outcomesSubject.asObservable();
    public projectionGeneration = 0;

    constructor(private readonly conversationsAPI: ConversationService) {}

    public get hasQuarantinedGroups(): boolean {
        return [...this.states.values()].some(state => state.quarantined);
    }

    public get hasFailedQuarantines(): boolean {
        return [...this.states.values()].some(state => state.quarantined && state.failed);
    }

    public markProjectionChanged(): void { this.projectionGeneration++; }

    public isQuarantined(groupID: string): boolean { return this.stateFor(groupID).quarantined; }

    public markAuthorized(groupID: string, revision: number): void {
        const state = this.stateFor(groupID);
        if (revision > state.revision) {
            state.revision = revision;
            this.projectionGeneration++;
        }
    }

    public definitiveRemoval(groupID: string, revision: number): void {
        const state = this.stateFor(groupID);
        if (state.removedRevision !== undefined && state.removedRevision >= Math.max(revision, state.revision) && !state.quarantined) return;
        this.requests.get(groupID)?.unsubscribe();
        this.requests.delete(groupID);
        state.inFlight = false;
        this.markRemoved(groupID, revision);
        this.outcomesSubject.next({type: 'removed', groupID, revision: this.stateFor(groupID).revision});
    }

    public revisionFor(groupID: string, projectionRevision = 0): number {
        return Math.max(projectionRevision, this.stateFor(groupID).revision);
    }

    public acceptProjection(groupID: string, revision: number): boolean {
        const state = this.stateFor(groupID);
        if (revision < state.revision || (state.removedRevision !== undefined && revision <= state.removedRevision)) return false;
        const projectionWasCurrent = revision === state.revision;
        if (revision > state.revision) {
            state.revision = revision;
            if (state.inFlight) {
                state.requestedRevision = Math.max(state.requestedRevision, revision);
                state.requestRevision++;
            }
            this.projectionGeneration++;
        }
        if (state.removedRevision !== undefined && revision > state.removedRevision) {
            state.removedRevision = undefined;
            this.projectionGeneration++;
        }
        return !state.quarantined && (projectionWasCurrent || revision === state.revision);
    }

    public projectConversationList(items: readonly Conversation[], currentGroups: readonly GroupConversation[], authoritativeAbsence = true): Conversation[] {
        const current = new Map(currentGroups.map(group => [group.id, group]));
        const incoming = new Set<string>();
        const projected: Conversation[] = [];
        for (const item of items) {
            if (item.kind !== 'group') {
                projected.push(item);
                continue;
            }
            incoming.add(item.id);
            const state = this.stateFor(item.id);
            if (state.departure && item.membershipRevision > state.departure.revision) {
                // List reconciliation can race the membership event that would normally
                // quarantine the selected projection. A newer revision while departure
                // is pending is uncertain access, not permission to restore cached UI.
                state.revision = Math.max(state.revision, item.membershipRevision);
                this.quarantine(item.id, state.context ?? state.departure.context);
                continue;
            }
            if (state.quarantined && !this.departureProjectionIsFenced(state) && item.membershipRevision >= state.revision &&
                (state.removedRevision === undefined || item.membershipRevision > state.removedRevision)) {
                // The authorized list supersedes any pending point lookup. Fence its
                // callbacks before cancelling it so a late older response cannot
                // overwrite this projection or re-quarantine the group.
                state.requestedRevision = Math.max(state.requestedRevision, item.membershipRevision);
                state.requestRevision++;
                this.requests.get(item.id)?.unsubscribe();
                this.requests.delete(item.id);
                state.inFlight = false;
                state.revision = item.membershipRevision;
                state.removedRevision = undefined;
                state.quarantined = false;
                state.failed = false;
                state.departureReconciliationRequired = false;
                const context = state.context;
                state.context = undefined;
                this.projectionGeneration++;
                this.outcomesSubject.next({type: 'authorized', group: item, restoreSelected: Boolean(context?.selected), navigationIntentVersion: context?.navigationIntentVersion});
                projected.push(item);
                continue;
            }
            if (state.quarantined) continue;
            if (this.acceptProjection(item.id, item.membershipRevision)) {
                projected.push(item);
                continue;
            }
            const existing = current.get(item.id);
            if (existing && !this.stateFor(item.id).removedRevision) projected.push(existing);
        }
        if (!authoritativeAbsence) return projected;
        for (const group of currentGroups) {
            const state = this.stateFor(group.id);
            if (!incoming.has(group.id) && !state.quarantined && state.removedRevision === undefined && this.states.has(group.id)) {
                this.markRemoved(group.id, group.membershipRevision);
                this.outcomesSubject.next({type: 'removed', groupID: group.id, revision: state.revision});
            }
        }
        return projected;
    }

    public membershipChanged(groupID: string, revision: number, deleted: boolean, context: HomeGroupAccessContext): void {
        const state = this.stateFor(groupID);
        const effectiveCurrentRevision = Math.max(state.revision, context.projectionRevision);
        if (revision <= effectiveCurrentRevision) return;
        const previousRevision = effectiveCurrentRevision;
        state.revision = revision;
        if (state.inFlight) {
            state.requestedRevision = Math.max(state.requestedRevision, revision);
            state.requestRevision++;
        }
        this.projectionGeneration++;
        if (deleted) {
            if (state.departure && previousRevision === state.departure.revision) state.departure.removalObserved = true;
        this.requests.get(groupID)?.unsubscribe();
        this.requests.delete(groupID);
        state.inFlight = false;
            this.markRemoved(groupID, revision);
            this.outcomesSubject.next({type: 'removed', groupID, revision: state.revision});
            return;
        }
        // A rejoin only clears a removal fence at a strictly newer revision.
        if (state.removedRevision !== undefined && revision > state.removedRevision) state.removedRevision = undefined;
        this.quarantine(groupID, context);
        this.requestGroup(groupID, revision);
    }

    public conversationCreated(groupID: string, context: HomeGroupAccessContext): void {
        this.requestGroup(groupID, this.revisionFor(groupID), context);
    }

    public verifyQuarantined(groupID: string, context: HomeGroupAccessContext): void {
        const state = this.stateFor(groupID);
        if (!state.quarantined) this.quarantine(groupID, context);
        else if (!state.context && context.selected) state.context = context;
        if (!state.inFlight) this.requestGroup(groupID, state.revision, context);
    }

    public quarantineForVerification(groupID: string, context: HomeGroupAccessContext): void {
        const state = this.stateFor(groupID);
        if (!state.quarantined) this.quarantine(groupID, context);
        else if (!state.context && context.selected) state.context = context;
    }

    public retryQuarantined(): void {
        for (const [groupID, state] of this.states) {
            if ((state.quarantined || state.departure?.removalObserved) && !state.inFlight) this.requestGroup(groupID, state.revision);
        }
    }

    public depart(groupID: string, request: Observable<void>, projectionRevision: number, context: HomeGroupAccessContext): void {
        const state = this.stateFor(groupID);
        if (state.departure) return;
        state.revision = Math.max(state.revision, projectionRevision);
        const departure = {revision: this.revisionFor(groupID, projectionRevision), context, subscription: new Subscription(), removalObserved: false};
        state.departure = departure;
        state.context = undefined;
        this.outcomesSubject.next({type: 'departure-pending', groupID});
        const staleLookup = this.requests.get(groupID);
        staleLookup?.unsubscribe();
        this.requests.delete(groupID);
        state.inFlight = false;
        state.revision = Math.max(state.revision, departure.revision);
        departure.subscription = request.subscribe({
            next: () => {
                if (state.departure !== departure) return;
                if (departure.removalObserved && state.removedRevision !== undefined) {
                    this.finishDeparture(groupID, state, departure);
                    return;
                }
                let reconcileAfterDeparture = false;
                if (state.revision > departure.revision && (!state.departure.removalObserved || state.removedRevision === undefined)) {
                    state.quarantined = true;
                    state.failed = false;
                    state.context = context;
                    state.departureGeneration++;
                    state.departureFence = {generation: state.departureGeneration, revision: departure.revision};
                    state.departureReconciliationRequired = true;
                    this.requests.get(groupID)?.unsubscribe();
                    this.requests.delete(groupID);
                    state.inFlight = false;
                    state.requestRevision++;
                    reconcileAfterDeparture = true;
                }
                if (state.revision === departure.revision) {
                    this.markRemoved(groupID, departure.revision);
                    this.outcomesSubject.next({type: 'removed', groupID, revision: departure.revision});
                }
                this.finishDeparture(groupID, state, departure);
                if (reconcileAfterDeparture) this.fetchLatest(groupID, state);
            },
            error: error => {
                if (state.departure !== departure) return;
                if (!departure.removalObserved) {
                    // The leave/delete response is ambiguous. Hide the cached private
                    // projection immediately instead of waiting for reconciliation.
                    this.quarantine(groupID, context);
                    this.requests.get(groupID)?.unsubscribe();
                    this.requests.delete(groupID);
                    state.inFlight = false;
                    state.requestRevision++;
                    this.fetchLatest(groupID, state);
                }
                this.outcomesSubject.next({type: 'departure-finished', groupID, failed: true});
                state.departure = undefined;
            },
        });
        this.departureOperations.set(groupID, departure.subscription);
        departure.subscription.add(() => {
            if (this.departureOperations.get(groupID) === departure.subscription) this.departureOperations.delete(groupID);
        });
        this.subscriptions.add(departure.subscription);
    }

    public ngOnDestroy(): void {
        this.subscriptions.unsubscribe();
        this.requests.clear();
        this.departureOperations.clear();
        this.outcomesSubject.complete();
        this.states.clear();
    }

    private requestGroup(groupID: string, requestedRevision: number, context?: HomeGroupAccessContext): void {
        const state = this.stateFor(groupID);
        if (context && !state.context) state.context = context;
        const latestRevision = Math.max(state.requestedRevision, requestedRevision);
        if (!state.inFlight) state.requestRevision++;
        else if (latestRevision > state.requestedRevision) state.requestRevision++;
        state.requestedRevision = latestRevision;
        if (state.inFlight) return;
        this.fetchLatest(groupID, state);
    }

    private fetchLatest(groupID: string, state: GroupAccessState): void {
        const fetchRevision = state.requestRevision;
        const departureGeneration = state.departureGeneration;
        const targetRevision = state.requestedRevision;
        let retryAfterCompletion = false;
        state.inFlight = true;
        const getGroup = this.conversationsAPI.getGroup;
        if (typeof getGroup !== 'function') {
            state.inFlight = false;
            this.outcomesSubject.next({type: 'retryable', groupID, reason: 'unavailable', quarantined: state.quarantined});
            return;
        }
        const lookup = getGroup.call(this.conversationsAPI, groupID).pipe(timeout({first: 10_000}), finalize(() => {
            state.inFlight = false;
                if (retryAfterCompletion && !(state.removedRevision !== undefined && !state.quarantined)) this.fetchLatest(groupID, state);
        }));
        const subscription = lookup.subscribe({
            next: group => {
                if (state.departure && group.id === groupID && group.membershipRevision > state.departure.revision) {
                    // A lookup may discover the changed projection before its membership
                    // event arrives. Never treat that projection as authorization while
                    // departure is pending; reconcile again after the leave settles.
                    state.revision = Math.max(state.revision, group.membershipRevision);
                    this.quarantine(groupID, state.context ?? state.departure.context);
                    return;
                }
                if (state.departureFence && departureGeneration < state.departureFence.generation &&
                    group.id === groupID && group.membershipRevision > state.departureFence.revision) {
                    // A lookup begun before a successful leave cannot restore private UI,
                    // even if its callback races leave completion and a later projection.
                    state.revision = Math.max(state.revision, group.membershipRevision);
                    state.quarantined = true;
                    state.failed = false;
                    if (fetchRevision !== state.requestRevision) retryAfterCompletion = true;
                    return;
                }
                if (state.departure?.removalObserved && state.removedRevision !== undefined) {
                    this.finishDeparture(groupID, state, state.departure);
                    return;
                }
                if (state.departure?.removalObserved && !state.quarantined) {
                    this.markRemoved(groupID, Math.max(targetRevision, state.revision));
                    this.outcomesSubject.next({type: 'removed', groupID, revision: state.revision});
                    return;
                }
                if (group.id !== groupID || group.membershipRevision < Math.max(targetRevision, state.revision) ||
                    (state.removedRevision !== undefined && group.membershipRevision <= state.removedRevision) || fetchRevision !== state.requestRevision) {
                    const superseded = fetchRevision !== state.requestRevision;
                    if (group.id === groupID && group.membershipRevision > state.revision && superseded &&
                        (state.removedRevision === undefined || group.membershipRevision > state.removedRevision)) {
                        state.revision = group.membershipRevision;
                        if (this.departureProjectionIsFenced(state) ||
                            Boolean(state.departureFence && departureGeneration < state.departureFence.generation &&
                                group.membershipRevision > state.departureFence.revision)) {
                            // Supersession means a newer event exists, not that this
                            // response was fetched after the pending departure settled.
                            state.quarantined = true;
                            state.failed = false;
                        } else {
                            state.removedRevision = undefined;
                            state.quarantined = false;
                            state.failed = false;
                            this.projectionGeneration++;
                            this.outcomesSubject.next({type: 'authorized', group, restoreSelected: false});
                        }
                    }
                    if (superseded && !state.departure && !(state.removedRevision !== undefined && !state.quarantined)) retryAfterCompletion = true;
                    else {
                        if (!superseded) {
                            state.failed = state.quarantined;
                            this.outcomesSubject.next({type: 'retryable', groupID, reason: 'unavailable', quarantined: state.quarantined});
                        }
                    }
                    return;
                }
                if (state.departure && state.revision > state.departure.revision) {
                    // A projection requested before departure completed is not sufficient to
                    // restore private UI after a newer membership revision. Keep the group
                    // quarantined; departure completion starts a fresh, post-departure lookup.
                    state.revision = group.membershipRevision;
                    state.failed = false;
                    return;
                }
                state.revision = group.membershipRevision;
                state.removedRevision = undefined;
                state.quarantined = false;
                state.failed = false;
                if (state.departureFence && departureGeneration >= state.departureFence.generation) {
                    state.departureReconciliationRequired = false;
                }
                const context = state.context;
                state.context = undefined;
                this.projectionGeneration++;
                this.outcomesSubject.next({type: 'authorized', group, restoreSelected: Boolean(context?.selected), navigationIntentVersion: context?.navigationIntentVersion});
            },
            error: error => {
                if (fetchRevision !== state.requestRevision) {
                    retryAfterCompletion = true;
                    return;
                }
                if (state.departure && state.revision > state.departure.revision && !state.departure.removalObserved) {
                    this.quarantine(groupID, state.departure.context);
                    state.failed = true;
                    state.departure = undefined;
                    this.outcomesSubject.next({type: 'departure-finished', groupID, failed: true});
                }
                if (error instanceof GroupProjectionNotFoundError) {
                    this.markRemoved(groupID, Math.max(targetRevision, state.revision));
                    this.outcomesSubject.next({type: 'removed', groupID, revision: state.revision});
                    return;
                }
                if (state.departure?.removalObserved) {
                    state.failed = true;
                    this.outcomesSubject.next({type: 'retryable', groupID, reason: this.failureReason(error), quarantined: state.quarantined});
                    return;
                }
                state.failed = state.quarantined;
                this.outcomesSubject.next({type: 'retryable', groupID, reason: this.failureReason(error), quarantined: state.quarantined});
            },
        });
        this.requests.set(groupID, subscription);
        subscription.add(() => {
            if (this.requests.get(groupID) === subscription) this.requests.delete(groupID);
        });
        this.subscriptions.add(subscription);
    }

    private retryLatest(groupID: string, state: GroupAccessState): void {
        if (state.inFlight || (state.removedRevision !== undefined && !state.quarantined)) return;
        this.fetchLatest(groupID, state);
    }

    private quarantine(groupID: string, context: HomeGroupAccessContext): void {
        const state = this.stateFor(groupID);
        if (!state.quarantined) {
            state.quarantined = true;
            state.failed = false;
            state.context = context;
            this.projectionGeneration++;
            this.outcomesSubject.next({type: 'quarantined', groupID, selected: context.selected});
        } else if (!state.context && context.selected) state.context = context;
    }

    private markRemoved(groupID: string, revision: number): void {
        const state = this.stateFor(groupID);
        const removalRevision = Math.max(revision, state.revision);
        state.revision = removalRevision;
        if (state.inFlight) state.requestRevision++;
        state.inFlight = false;
        state.removedRevision = Math.max(state.removedRevision ?? 0, removalRevision);
        state.quarantined = false;
        state.failed = false;
        state.departureReconciliationRequired = false;
        state.context = undefined;
        this.projectionGeneration++;
    }

    private finishDeparture(groupID: string, state: GroupAccessState, departure: NonNullable<GroupAccessState['departure']>): void {
        if (state.departure === departure) state.departure = undefined;
        this.outcomesSubject.next({type: 'departure-finished', groupID});
    }

    private departureProjectionIsFenced(state: GroupAccessState): boolean {
        return state.departureReconciliationRequired || Boolean(state.departure);
    }

    private stateFor(groupID: string): GroupAccessState {
        let state = this.states.get(groupID);
        if (!state) {
            state = {revision: 0, quarantined: false, failed: false, requestRevision: 0, requestedRevision: 0, inFlight: false, departureGeneration: 0, departureReconciliationRequired: false};
            this.states.set(groupID, state);
        }
        return state;
    }

    private failureReason(error: unknown): GroupProjectionFailureReason {
        return error instanceof GroupProjectionFailureError ? error.reason : 'unavailable';
    }
}
