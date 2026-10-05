import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { ConversationService, GroupProjectionFailureError, GroupProjectionNotFoundError, InvalidConversationProjectionError, InvalidGroupProjectionError, InvalidUserSearchResponseError } from './conversation.service';

describe('ConversationService group projection', () => {
    let service: ConversationService;
    let http: HttpTestingController;

    beforeEach(() => {
        TestBed.configureTestingModule({ imports: [HttpClientTestingModule] });
        service = TestBed.inject(ConversationService);
        http = TestBed.inject(HttpTestingController);
    });

    afterEach(() => http.verify());

    for (const [name, payload] of [
        ['missing fields', { id: 'group-1' }],
        ['null response', null],
        ['null member', { id: 'group-1', name: 'Launch', avatar_seed: 'seed', owner_id: 'owner', membership_revision: 2, created_at: '2026-01-01T00:00:00Z', last_message_at: '2026-01-02T00:00:00Z', members: [null] }],
        ['object name', { id: 'group-1', name: {}, avatar_seed: 'seed', owner_id: 'owner', membership_revision: 2, created_at: '2026-01-01T00:00:00Z', last_message_at: '2026-01-02T00:00:00Z', members: [{ user_id: 'owner', display_name: 'Owner', role: 'owner', visible_from_sequence: 1, joined_at: '2026-01-01T00:00:00Z' }] }],
    ] as const) {
        it(`rejects a ${name} with a typed mapping error`, () => {
            const received = vi.fn().mockName('received');
            const rejected = vi.fn().mockName('rejected');
            service.getGroup('group-1').subscribe({ next: received, error: rejected });

            const request = http.expectOne(item => item.url.endsWith('/api/chat/groups/group-1'));
            expect(request.request.method).toBe('GET');
            request.flush(payload);

            expect(received).not.toHaveBeenCalled();
            expect(rejected).toHaveBeenCalledTimes(1);
            expect(rejected).toHaveBeenCalledWith(expect.any(InvalidGroupProjectionError));
        });
    }

    it('maps only HTTP 404 to the explicit not-found outcome', () => {
        const rejected = vi.fn().mockName('rejected');
        service.getGroup('missing').subscribe({ error: rejected });
        http.expectOne(item => item.url.endsWith('/api/chat/groups/missing')).flush({ error: 'group or user not found' }, { status: 404, statusText: 'Not Found' });
        expect(rejected).toHaveBeenCalledTimes(1);
        expect(rejected).toHaveBeenCalledWith(expect.any(GroupProjectionNotFoundError));
    });

    it.each([[401, 'sessionExpired'], [503, 'unavailable']] as const)('maps HTTP %s to a semantic group lookup failure', (status, reason) => {
        const rejected = vi.fn().mockName('rejected');
        service.getGroup('group-1').subscribe({error: rejected});
        http.expectOne(item => item.url.endsWith('/api/chat/groups/group-1')).flush({error: 'request failed'}, {status, statusText: 'Request failed'});
        expect(rejected).toHaveBeenCalledWith(expect.any(GroupProjectionFailureError));
        expect(vi.mocked(rejected).mock.calls[0]?.[0].reason).toBe(reason);
    });

    it('does not treat an unclassified 404 as proof of group removal', () => {
        const rejected = vi.fn().mockName('rejected');
        service.getGroup('missing').subscribe({ error: rejected });
        http.expectOne(item => item.url.endsWith('/api/chat/groups/missing')).flush({ error: 'route not found' }, { status: 404, statusText: 'Not Found' });
        expect(rejected).toHaveBeenCalledTimes(1);
        const rejection = vi.mocked(rejected).mock.calls[0]?.[0];
        if (!rejection) throw new Error('Expected the group lookup to reject.');
        expect(rejection).toEqual(expect.anything());
        expect(rejection).not.toEqual(expect.any(GroupProjectionNotFoundError));
    });

    it('rejects the entire group page when any group entry is malformed', () => {
        const received = vi.fn().mockName('received');
        const rejected = vi.fn().mockName('rejected');
        service.listGroupPage().subscribe({ next: received, error: rejected });
        const validGroup = { id: 'group-1', name: 'Launch', avatar_seed: 'seed', owner_id: 'owner', membership_revision: 2, created_at: '2026-01-01T00:00:00Z', last_message_at: '2026-01-02T00:00:00Z', members: [{ user_id: 'owner', display_name: 'Owner', role: 'owner', visible_from_sequence: 1, joined_at: '2026-01-01T00:00:00Z' }] };
        http.expectOne(item => item.urlWithParams.endsWith('/api/chat/groups?limit=25')).flush({items: [validGroup, { id: 'group-2' }], next_cursor: null});
        expect(received).not.toHaveBeenCalled();
        expect(rejected).toHaveBeenCalledTimes(1);
        expect(rejected).toHaveBeenCalledWith(expect.any(InvalidGroupProjectionError));
    });

    it('accepts a valid legacy group array as a complete page', () => {
        const received = vi.fn().mockName('received');
        service.listGroupPage().subscribe(received);
        const group = { id: 'group-1', name: 'Launch', avatar_seed: 'seed', owner_id: 'owner', membership_revision: 2, created_at: '2026-01-01T00:00:00Z', last_message_at: '2026-01-02T00:00:00Z', members: [{ user_id: 'owner', display_name: 'Owner', role: 'owner', visible_from_sequence: 1, joined_at: '2026-01-01T00:00:00Z' }] };
        http.expectOne(item => item.urlWithParams.endsWith('/api/chat/groups?limit=25')).flush([group]);

        expect(received).toHaveBeenCalledWith({items: [expect.objectContaining({id: 'group-1', name: 'Launch'})], nextCursor: null});
    });

    it('accepts an empty legacy group array as an exhausted page', () => {
        const received = vi.fn().mockName('received');
        service.listGroupPage().subscribe(received);
        http.expectOne(item => item.urlWithParams.endsWith('/api/chat/groups?limit=25')).flush([]);

        expect(received).toHaveBeenCalledWith({items: [], nextCursor: null});
    });

    it('rejects a legacy group array atomically when an entry is malformed', () => {
        const received = vi.fn().mockName('received');
        const rejected = vi.fn().mockName('rejected');
        service.listGroupPage().subscribe({next: received, error: rejected});
        const group = { id: 'group-1', name: 'Launch', avatar_seed: 'seed', owner_id: 'owner', membership_revision: 2, created_at: '2026-01-01T00:00:00Z', last_message_at: '2026-01-02T00:00:00Z', members: [{ user_id: 'owner', display_name: 'Owner', role: 'owner', visible_from_sequence: 1, joined_at: '2026-01-01T00:00:00Z' }] };
        http.expectOne(item => item.urlWithParams.endsWith('/api/chat/groups?limit=25')).flush([group, {id: 'group-2'}]);

        expect(received).not.toHaveBeenCalled();
        expect(rejected).toHaveBeenCalledOnce();
        expect(rejected).toHaveBeenCalledWith(expect.any(InvalidGroupProjectionError));
    });

    it.each([
        ['more than 25 groups', {items: Array.from({length: 26}, (_, index) => ({id: `group-${index}`, name: 'Launch', avatar_seed: 'seed', owner_id: 'owner', membership_revision: 2, created_at: '2026-01-01T00:00:00Z', last_message_at: '2026-01-02T00:00:00Z', members: [{user_id: 'owner', display_name: 'Owner', role: 'owner', visible_from_sequence: 1, joined_at: '2026-01-01T00:00:00Z'}]})), next_cursor: null}],
        ['a cursor longer than 512 characters', {items: [], next_cursor: 'c'.repeat(513)}],
        ['a malformed base64url cursor', {items: [], next_cursor: 'abc'}],
    ])('rejects a group page with %s atomically', (_name, payload) => {
        const received = vi.fn().mockName('received');
        const rejected = vi.fn().mockName('rejected');
        service.listGroupPage().subscribe({next: received, error: rejected});
        http.expectOne(item => item.urlWithParams.endsWith('/api/chat/groups?limit=25')).flush(payload);

        expect(received).not.toHaveBeenCalled();
        expect(rejected).toHaveBeenCalledTimes(1);
        expect(rejected).toHaveBeenCalledWith(expect.any(InvalidGroupProjectionError));
    });

    it('rejects a group-page envelope whose items are not an array', () => {
        const received = vi.fn().mockName('received');
        const rejected = vi.fn().mockName('rejected');
        service.listGroupPage().subscribe({ next: received, error: rejected });
        http.expectOne(item => item.urlWithParams.endsWith('/api/chat/groups?limit=25')).flush({items: { id: 'group-1' }, next_cursor: null});

        expect(received).not.toHaveBeenCalled();
        expect(rejected).toHaveBeenCalledTimes(1);
        expect(rejected).toHaveBeenCalledWith(expect.any(InvalidGroupProjectionError));
    });

    it('rejects the home snapshot when any group entry is malformed', () => {
        const received = vi.fn().mockName('received');
        const rejected = vi.fn().mockName('rejected');
        service.listHomeSnapshot().subscribe({ next: received, error: rejected });
        http.expectOne(item => item.url.endsWith('/api/chat/conversations')).flush([
            { id: 'direct-1', other_user_id: 'peer', other_display_name: 'Peer', other_email: 'peer@example.test', created_at: '2026-01-01T00:00:00Z' },
        ]);
        http.expectOne(item => item.urlWithParams.endsWith('/api/chat/groups?limit=25')).flush({items: [{ id: 'group-2' }], next_cursor: null});
        expect(received).not.toHaveBeenCalled();
        expect(rejected).toHaveBeenCalledTimes(1);
        expect(rejected).toHaveBeenCalledWith(expect.any(InvalidGroupProjectionError));
    });

    it('rejects a direct list atomically when any entry is malformed', () => {
        const received = vi.fn().mockName('received');
        const rejected = vi.fn().mockName('rejected');
        service.listDirect().subscribe({ next: received, error: rejected });
        http.expectOne(item => item.url.endsWith('/api/chat/conversations')).flush([
            { id: 'direct-1', other_user_id: 'peer', other_display_name: 'Peer', other_email: 'peer@example.test', created_at: '2026-01-01T00:00:00Z' },
            { id: 5, other_user_id: 'invalid-peer', other_display_name: 'Invalid', other_email: 'invalid@example.test', created_at: '2026-01-01T00:00:00Z' },
        ]);
        expect(received).not.toHaveBeenCalled();
        expect(rejected).toHaveBeenCalledTimes(1);
        expect(rejected).toHaveBeenCalledWith(expect.any(InvalidConversationProjectionError));
    });

    it.each([
        ['an object envelope', {items: [{ id: 'direct-1', other_user_id: 'peer', other_display_name: 'Peer', other_email: 'peer@example.test', created_at: '2026-01-01T00:00:00Z' }]}],
        ['a null response', null],
    ])('rejects a direct list with %s', (_name, payload) => {
        const received = vi.fn().mockName('received');
        const rejected = vi.fn().mockName('rejected');
        service.listDirect().subscribe({next: received, error: rejected});
        http.expectOne(item => item.url.endsWith('/api/chat/conversations')).flush(payload);

        expect(received).not.toHaveBeenCalled();
        expect(rejected).toHaveBeenCalledTimes(1);
        expect(rejected).toHaveBeenCalledWith(expect.any(InvalidConversationProjectionError));
    });

    it('rejects a malformed direct conversation returned by create', () => {
        const received = vi.fn().mockName('received');
        const rejected = vi.fn().mockName('rejected');
        service.create('peer').subscribe({ next: received, error: rejected });
        http.expectOne(item => item.url.endsWith('/api/chat/conversations')).flush({ id: {}, other_user_id: 'peer' });
        expect(received).not.toHaveBeenCalled();
        expect(rejected).toHaveBeenCalledWith(expect.any(InvalidConversationProjectionError));
    });

    it('maps user search responses from unknown and rejects malformed arrays atomically', () => {
        const received = vi.fn().mockName('received');
        const rejected = vi.fn().mockName('rejected');
        service.searchUsers('alex').subscribe({next: received, error: rejected});
        const request = http.expectOne(item => item.urlWithParams.endsWith('/api/chat/users/search?q=alex'));
        expect(request.request.method).toBe('GET');
        request.flush([{id: 'user-1', display_name: 'Alex', email: 'alex@example.test'}]);
        expect(received).toHaveBeenCalledWith([{id: 'user-1', display_name: 'Alex', email: 'alex@example.test'}]);

        service.searchUsers('invalid').subscribe({next: received, error: rejected});
        http.expectOne(item => item.urlWithParams.endsWith('/api/chat/users/search?q=invalid')).flush([
            {id: 'user-2', display_name: 'Valid', email: 'valid@example.test'},
            {id: 'user-3', display_name: 42, email: 'invalid@example.test'},
        ]);
        expect(received).toHaveBeenCalledTimes(1);
        expect(rejected).toHaveBeenCalledOnce();
        expect(rejected).toHaveBeenCalledWith(expect.any(InvalidUserSearchResponseError));

        service.searchUsers('not-array').subscribe({next: received, error: rejected});
        http.expectOne(item => item.urlWithParams.endsWith('/api/chat/users/search?q=not-array')).flush({items: []});
        expect(received).toHaveBeenCalledTimes(1);
        expect(rejected).toHaveBeenCalledTimes(2);
    });

    it('requests the next group page with an encoded cursor and maps the envelope', () => {
        const received = vi.fn().mockName('received');
        service.listGroupPage('cursor+/=').subscribe(received);
        const request = http.expectOne(item => item.urlWithParams.includes('/api/chat/groups?limit=25&cursor='));
        expect(request.request.urlWithParams).toContain('cursor=cursor%2B%2F%3D');
        const group = { id: 'group-1', name: 'Launch', avatar_seed: 'seed', owner_id: 'owner', membership_revision: 2, created_at: '2026-01-01T00:00:00Z', last_message_at: '2026-01-02T00:00:00Z', members: [{ user_id: 'owner', display_name: 'Owner', role: 'owner', visible_from_sequence: 1, joined_at: '2026-01-01T00:00:00Z' }] };
        request.flush({items: [group], next_cursor: validGroupCursor()});
        expect(received).toHaveBeenCalledWith({
            items: [expect.objectContaining({id: 'group-1', name: 'Launch'})],
            nextCursor: validGroupCursor(),
        });
    });

    it.each([
        ['missing items', {next_cursor: null}],
        ['malformed cursor', {items: [], next_cursor: 'not a cursor'}],
        ['missing cursor field', {items: []}],
        ['non-array items', {items: {}, next_cursor: null}],
    ])('rejects the whole page for %s', (_name, payload) => {
        const received = vi.fn().mockName('received');
        const rejected = vi.fn().mockName('rejected');
        service.listGroupPage().subscribe({next: received, error: rejected});
        http.expectOne(item => item.urlWithParams.endsWith('/api/chat/groups?limit=25')).flush(payload);
        expect(received).not.toHaveBeenCalled();
        expect(rejected).toHaveBeenCalledWith(expect.any(InvalidGroupProjectionError));
    });
});

function validGroupCursor(): string {
    const cursor = {v: 1, upper: {sort_at: '2026-01-02T00:00:00Z', group_id: '00000000-0000-4000-8000-000000000001'}, after: {sort_at: '2026-01-01T00:00:00Z', group_id: '00000000-0000-4000-8000-000000000002'}};
    return btoa(JSON.stringify(cursor)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
