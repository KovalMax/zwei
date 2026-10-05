import { Subject, of, throwError } from 'rxjs';
import { GroupConversation } from './conversation.model';
import { ConversationService, GroupProjectionFailureError, GroupProjectionNotFoundError } from './conversation.service';
import { HomeGroupAccessFacade } from './home-group-access-facade.service';

describe('HomeGroupAccessFacade', () => {
    const context = { selected: true, navigationIntentVersion: 4, projectionRevision: 1 };

    it('deduplicates per-group requests and fences stale revisions before applying the latest projection', () => {
        const oldLookup = new Subject<GroupConversation>();
        const latestLookup = new Subject<GroupConversation>();
        const getGroup = vi.fn().mockName('getGroup').mockReturnValueOnce(oldLookup).mockReturnValueOnce(latestLookup);
        const facade = new HomeGroupAccessFacade({ getGroup } as unknown as ConversationService);
        const outcomes: string[] = [];
        facade.outcomes$.subscribe(outcome => { if (outcome.type === 'authorized')
            outcomes.push(outcome.group.name); });

        facade.membershipChanged('group-1', 2, false, context);
        facade.conversationCreated('group-1', context);
        expect(getGroup).toHaveBeenCalledTimes(1);
        facade.membershipChanged('group-1', 3, false, context);
        oldLookup.next(group('group-1', 2, 'stale'));
        oldLookup.complete();
        expect(getGroup).toHaveBeenCalledTimes(2);
        latestLookup.next(group('group-1', 3, 'latest'));
        latestLookup.complete();

        expect(outcomes).toEqual(['latest']);
        expect(facade.isQuarantined('group-1')).toBe(false);
        facade.ngOnDestroy();
    });

    it('keeps 403 retryable while 404 definitively removes access', () => {
        const forbidden = new Subject<GroupConversation>();
        const getGroup = vi.fn().mockName('getGroup').mockReturnValueOnce(forbidden).mockReturnValueOnce(throwError(() => new GroupProjectionNotFoundError()));
        const facade = new HomeGroupAccessFacade({ getGroup } as unknown as ConversationService);
        const outcomes: string[] = [];
        facade.outcomes$.subscribe(outcome => outcomes.push(outcome.type));

        facade.membershipChanged('group-403', 2, false, context);
        forbidden.error(new Error('forbidden'));
        expect(facade.isQuarantined('group-403')).toBe(true);
        expect(facade.hasFailedQuarantines).toBe(true);
        facade.retryQuarantined();
        expect(facade.isQuarantined('group-403')).toBe(false);
        expect(facade.revisionFor('group-403')).toBe(2);

        expect(outcomes).toContain('retryable');
        expect(outcomes).toContain('removed');
        facade.ngOnDestroy();
    });

    it.each(['sessionExpired', 'unavailable'] as const)('emits the semantic %s failure without a transport error', reason => {
        const getGroup = vi.fn().mockReturnValue(throwError(() => new GroupProjectionFailureError(reason)));
        const facade = new HomeGroupAccessFacade({getGroup} as unknown as ConversationService);
        const outcomes: unknown[] = [];
        facade.outcomes$.subscribe(outcome => outcomes.push(outcome));

        facade.membershipChanged('group-semantic', 2, false, context);

        expect(outcomes).toContainEqual({type: 'retryable', groupID: 'group-semantic', reason, quarantined: true});
        expect(JSON.stringify(outcomes)).not.toContain('HttpErrorResponse');
        facade.ngOnDestroy();
    });

    it('reports stale and wrong-id successful lookups as finite retryable failures', () => {
        for (const response of [group('another-group', 2, 'wrong'), group('group-stale', 1, 'stale')]) {
            const lookup = new Subject<GroupConversation>();
            const getGroup = vi.fn().mockName('getGroup').mockReturnValue(lookup);
            const facade = new HomeGroupAccessFacade({ getGroup } as unknown as ConversationService);
            const outcomes: string[] = [];
            facade.outcomes$.subscribe(outcome => outcomes.push(outcome.type));
            facade.membershipChanged(response.id === 'another-group' ? 'expected-group' : response.id, 2, false, context);
            lookup.next(response);
            lookup.complete();
            expect(getGroup).toHaveBeenCalledTimes(1);
            expect(outcomes).toContain('retryable');
            expect(facade.hasFailedQuarantines).toBe(true);
            facade.ngOnDestroy();
        }
    });

    it('emits removal when an authorized list omits a projected group', () => {
        const facade = new HomeGroupAccessFacade({ getGroup: () => of(group('omitted', 4, 'omitted')) } as unknown as ConversationService);
        const removals: string[] = [];
        facade.outcomes$.subscribe(outcome => { if (outcome.type === 'removed')
            removals.push(outcome.groupID); });
        facade.projectConversationList([], [group('omitted', 4, 'omitted')]);
        expect(removals).toEqual(['omitted']);
        facade.ngOnDestroy();
    });

    it('quarantines after ambiguous departure failure and reconciles without trusting the error status', () => {
        const lookup = new Subject<GroupConversation>();
        const getGroup = vi.fn().mockName('getGroup').mockReturnValue(lookup);
        const facade = new HomeGroupAccessFacade({ getGroup } as unknown as ConversationService);
        const departure = new Subject<void>();
        const outcomes: string[] = [];
        facade.outcomes$.subscribe(outcome => outcomes.push(outcome.type));

        facade.depart('group-1', departure, 1, context);
        departure.error(new Error('forbidden'));
        expect(facade.isQuarantined('group-1')).toBe(true);
        expect(outcomes[0]).toBe('departure-pending');
        expect(outcomes[1]).toBe('quarantined');
        expect(getGroup).toHaveBeenCalledTimes(1);
        expect(getGroup).toHaveBeenCalledWith('group-1');
        lookup.next(group('group-1', 2, 'authorized'));
        lookup.complete();
        expect(outcomes).toContain('authorized');
        expect(facade.isQuarantined('group-1')).toBe(false);
        facade.ngOnDestroy();
    });

    it('keeps an in-flight departure quarantined when a newer authorized lookup resolves before leave completes', () => {
        const inFlightLookup = new Subject<GroupConversation>();
        const postDepartureLookup = new Subject<GroupConversation>();
        const getGroup = vi.fn().mockName('getGroup').mockReturnValueOnce(inFlightLookup).mockReturnValueOnce(postDepartureLookup);
        const facade = new HomeGroupAccessFacade({ getGroup } as unknown as ConversationService);
        const departure = new Subject<void>();
        const authorized: number[] = [];
        facade.outcomes$.subscribe(outcome => {
            if (outcome.type === 'authorized')
                authorized.push(outcome.group.membershipRevision);
        });

        facade.depart('group-departure', departure, 1, context);
        facade.membershipChanged('group-departure', 2, false, context);
        inFlightLookup.next(group('group-departure', 2, 'current before leave completes'));
        inFlightLookup.complete();

        expect(facade.isQuarantined('group-departure')).toBe(true);
        expect(authorized).toEqual([]);
        expect(getGroup).toHaveBeenCalledTimes(1);

        departure.next();
        departure.complete();
        expect(getGroup).toHaveBeenCalledTimes(2);
        expect(facade.isQuarantined('group-departure')).toBe(true);
        expect(authorized).toEqual([]);

        postDepartureLookup.next(group('group-departure', 2, 'verified after leave'));
        postDepartureLookup.complete();
        expect(facade.isQuarantined('group-departure')).toBe(false);
        expect(authorized).toEqual([2]);
        facade.ngOnDestroy();
    });

    it('quarantines a newer projection discovered by lookup before the membership event arrives during departure', () => {
        const lookup = new Subject<GroupConversation>();
        const postDepartureLookup = new Subject<GroupConversation>();
        const getGroup = vi.fn().mockName('getGroup').mockReturnValueOnce(lookup).mockReturnValueOnce(postDepartureLookup);
        const facade = new HomeGroupAccessFacade({ getGroup } as unknown as ConversationService);
        const departure = new Subject<void>();
        const authorized: number[] = [];
        facade.outcomes$.subscribe(outcome => {
            if (outcome.type === 'authorized')
                authorized.push(outcome.group.membershipRevision);
        });

        facade.depart('group-departure-before-event', departure, 1, context);
        // A newer revision can be fetched before its membership event reaches Home.
        facade.conversationCreated('group-departure-before-event', context);
        lookup.next(group('group-departure-before-event', 2, 'new projection before event'));
        lookup.complete();

        expect(facade.isQuarantined('group-departure-before-event')).toBe(true);
        expect(authorized).toEqual([]);
        expect(getGroup).toHaveBeenCalledTimes(1);

        departure.next();
        departure.complete();
        expect(getGroup).toHaveBeenCalledTimes(2);
        postDepartureLookup.next(group('group-departure-before-event', 2, 'verified after departure'));
        postDepartureLookup.complete();

        expect(facade.isQuarantined('group-departure-before-event')).toBe(false);
        expect(authorized).toEqual([2]);
        facade.ngOnDestroy();
    });

    it('does not project a newer conversation-list revision while departure is pending', () => {
        const preDepartureLookup = new Subject<GroupConversation>();
        const postDepartureLookup = new Subject<GroupConversation>();
        const getGroup = vi.fn().mockName('getGroup').mockReturnValueOnce(preDepartureLookup).mockReturnValueOnce(postDepartureLookup);
        const facade = new HomeGroupAccessFacade({ getGroup } as unknown as ConversationService);
        const departure = new Subject<void>();
        const outcomes: string[] = [];
        facade.outcomes$.subscribe(outcome => outcomes.push(outcome.type));

        facade.conversationCreated('group-list-race', context);
        facade.depart('group-list-race', departure, 1, context);
        preDepartureLookup.next(group('group-list-race', 1, 'older projection'));
        preDepartureLookup.complete();
        const projection = facade.projectConversationList([group('group-list-race', 2, 'new list projection')], [group('group-list-race', 1, 'cached projection')]);

        expect(projection).toEqual([]);
        expect(facade.isQuarantined('group-list-race')).toBe(true);
        expect(outcomes).toContain('quarantined');

        departure.next();
        departure.complete();
        expect(getGroup).toHaveBeenCalledTimes(2);
        postDepartureLookup.next(group('group-list-race', 2, 'post-departure authorization'));
        postDepartureLookup.complete();
        expect(facade.isQuarantined('group-list-race')).toBe(false);
        expect(outcomes).toContain('authorized');
        facade.ngOnDestroy();
    });

    it('does not authorize a superseded projection after membership advances during departure', () => {
        const inFlightLookup = new Subject<GroupConversation>();
        const postDepartureLookup = new Subject<GroupConversation>();
        const getGroup = vi.fn().mockName('getGroup').mockReturnValueOnce(inFlightLookup).mockReturnValueOnce(postDepartureLookup);
        const facade = new HomeGroupAccessFacade({ getGroup } as unknown as ConversationService);
        const departure = new Subject<void>();
        const authorized: number[] = [];
        facade.outcomes$.subscribe(outcome => {
            if (outcome.type === 'authorized')
                authorized.push(outcome.group.membershipRevision);
        });

        facade.depart('group-departure-race', departure, 1, context);
        facade.membershipChanged('group-departure-race', 2, false, context);
        facade.membershipChanged('group-departure-race', 3, false, context);

        // A request superseded by revision 3 must not restore the group while
        // leave is still pending, even when the response itself is revision 3.
        inFlightLookup.next(group('group-departure-race', 3, 'superseded pre-departure response'));
        inFlightLookup.complete();
        expect(facade.isQuarantined('group-departure-race')).toBe(true);
        expect(authorized).toEqual([]);
        expect(getGroup).toHaveBeenCalledTimes(1);

        departure.next();
        departure.complete();
        expect(getGroup).toHaveBeenCalledTimes(2);
        expect(facade.isQuarantined('group-departure-race')).toBe(true);
        expect(authorized).toEqual([]);

        postDepartureLookup.next(group('group-departure-race', 3, 'post-departure response'));
        postDepartureLookup.complete();
        expect(facade.isQuarantined('group-departure-race')).toBe(false);
        expect(authorized).toEqual([3]);
        facade.ngOnDestroy();
    });

    it('cancels a pending lookup on destroy and keeps independent group quarantine state', () => {
        const first = new Subject<GroupConversation>();
        const second = new Subject<GroupConversation>();
        const getGroup = vi.fn().mockName('getGroup').mockReturnValueOnce(first).mockReturnValueOnce(second);
        const facade = new HomeGroupAccessFacade({ getGroup } as unknown as ConversationService);
        facade.membershipChanged('group-1', 2, false, context);
        facade.membershipChanged('group-2', 5, false, context);
        expect(getGroup).toHaveBeenCalledTimes(2);
        expect(first.observed).toBe(true);
        expect(second.observed).toBe(true);
        facade.ngOnDestroy();
        expect(first.observed).toBe(false);
        expect(second.observed).toBe(false);
    });
});

function group(id: string, membershipRevision: number, name: string): GroupConversation {
    return { kind: 'group', id, name, avatarSeed: id, ownerId: 'owner', members: [], membershipRevision, lastMessageAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z', unreadCount: 0, otherUserId: '', otherDisplayName: '', otherEmail: '' };
}
