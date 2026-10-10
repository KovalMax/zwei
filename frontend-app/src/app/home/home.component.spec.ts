import {ComponentFixture, TestBed} from '@angular/core/testing';
import {fakeAsync, tick} from '../../testing/vitest-timers';
import { ChangeDetectorRef } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { By } from '@angular/platform-browser';
import { BehaviorSubject, EMPTY, NEVER, Observable, of, Subject, throwError, map } from 'rxjs';

import { HomeComponent } from './home.component';
import { AppModule } from '../app.module';
import { HomeModule } from './home.module';
import { AuthService } from '../auth/auth.service';
import { ConversationService, GroupProjectionFailureError, InvalidConversationProjectionError, InvalidGroupProjectionError } from './conversation.service';
import { Conversation, GroupConversation, GroupMember } from './conversation.model';
import { Message, MessageHistory } from './message.model';
import { WEBSOCKET_PROTOCOL_VERSION } from './data-provider.service';
import { DataProviderService } from './data-provider.service';
import { CallFacade, CallState } from './call-facade.service';
import { GroupCallFacade, GroupCallPeer, GroupCallState } from './group-call-facade.service';
import { Profile } from '../auth/profile.model';
import { UserSearchResult } from './user.model';
import { HomeGroupAccessFacade } from './home-group-access-facade.service';
import { HomeNotificationService } from './home-notification.service';
import { GroupProjectionNotFoundError } from './conversation.service';

describe('HomeComponent', () => {
    let component: HomeComponent;
    let fixture: ComponentFixture<HomeComponent>;

    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [AppModule, HomeModule],
            providers: [{provide: AuthService, useValue: {profile: () => of({id: 'test-user'})}}]
        }).compileComponents();
    });

    beforeEach(() => {
        fixture = TestBed.createComponent(HomeComponent);
        component = fixture.componentInstance;
    });

    it('should create', () => {
        expect(component).toBeTruthy();
    });

    it('renders singular result wording in the Home people-search template', () => {
        component.searchState = 'results';
        component.searchResults = [{ id: 'one', display_name: 'One Person', email: 'one@example.test' }];
        fixture.detectChanges();

        expect(fixture.nativeElement.querySelector('.conversation-rail .group-search-status[role="status"]')?.textContent?.trim()).toBe('1 person found.');
    });

    it('keeps exhausted group pagination announcement accessible without visible completion copy', () => {
        component.conversations.next([groupConversation('exhausted-group')]);
        component.groupPageLoaded = true;
        component.groupNextCursor = null;
        fixture.detectChanges();

        const surface = fixture.nativeElement as HTMLElement;
        const announcement = surface.querySelector<HTMLElement>('.people-list [role="status"]');
        expect(component.groupsExhausted).toBe(true);
        expect(component.canLoadMoreGroups()).toBe(false);
        expect(announcement?.textContent?.trim()).toBe('All groups loaded.');
        if (!announcement) throw new Error('Accessible group completion announcement is missing');
        expect(getComputedStyle(announcement).position).toBe('absolute');
        expect(getComputedStyle(announcement).clip).toBe('rect(0px, 0px, 0px, 0px)');
        expect(surface.querySelector('.groups-exhausted')).toBeNull();
    });

    it('routes group-call end through the same typed surface-intent dispatcher', () => {
        const end = vi.fn().mockName('end');
        const groupCall = { end, close: () => undefined } as unknown as GroupCallFacade;
        const home = createHomeComponent({} as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { close: () => undefined } as DataProviderService, { close: () => undefined } as CallFacade, undefined, groupCall);

        home.onGroupCallSurfaceIntent({ type: 'end' });

        expect(end).toHaveBeenCalledTimes(1);

        expect(end).toHaveBeenCalledWith();
        home.ngOnDestroy();
    });

    it('shows terminal group-call notices only in their originating conversation', () => {
        const origin = groupConversation('origin-group');
        const home = createHomeComponent({} as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { close: () => undefined } as DataProviderService, { close: () => undefined } as CallFacade);
        home.selectedConversation = origin;
        (home as unknown as {
            groupCallNoticeConversationID?: string;
        }).groupCallNoticeConversationID = origin.id;
        const leftState: GroupCallState = {
            phase: 'left', peers: [], muted: false, sharing: false, screenShareAudioEnabled: false,
            screenShareAudioActive: false, shareTransitioning: false, inputDevices: [], outputDevices: [],
            audioPlaybackBlocked: false, statusLabel: 'You left the group call.',
        };
        const endedState: GroupCallState = { ...leftState, phase: 'ended', statusLabel: 'Group call ended.' };

        expect(home.showGroupCallTerminalNotice(leftState)).toBe(true);
        expect(home.showGroupCallTerminalNotice(endedState)).toBe(true);
        home.selectedConversation = conversation('another-conversation');
        expect(home.showGroupCallTerminalNotice(leftState)).toBe(false);
        expect(home.showGroupCallTerminalNotice(endedState)).toBe(false);
        home.selectedConversation = undefined;
        expect(home.showGroupCallTerminalNotice(endedState)).toBe(true);
        home.ngOnDestroy();
    });

    it('renders the recipient-offline explanation from authoritative absence in presence', () => {
        const call = { state: { phase: 'error', statusLabel: 'Call unavailable: call unavailable', errorLabel: 'Call unavailable: call unavailable' }, close: () => undefined } as unknown as CallFacade;
        const home = createHomeComponent({} as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { close: () => undefined } as DataProviderService, call);
        const selected: Conversation = { ...conversation('offline-peer'), kind: 'direct' };
        home.selectedConversation = selected;
        home.presenceReady = true;
        home.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'presence.snapshot', payload: { user_ids: [] } });

        expect(home.directCallProfile().status).toBe('Call unavailable: recipient is offline');
        home.presenceReady = false;
        expect(home.directCallProfile().status).toBe('Call unavailable: call unavailable');
        home.ngOnDestroy();
    });

    it('tracks refreshed Home list views by stable domain identity', () => {
        const member: GroupMember = { userId: 'user-1', displayName: 'Member', role: 'member', visibleFromSequence: 1, joinedAt: '2026-01-01T00:00:00Z' };
        const peer: GroupCallPeer = { userID: 'user-1', deviceID: 'device-1' };
        const user: UserSearchResult = { id: 'user-1', display_name: 'Member', email: 'member@example.test' };
        const message: Message = { id: 'message-1', conversationId: 'conversation-1', senderId: 'user-1', clientMessageId: 'client-1', sequence: 1, body: 'Hello', createdAt: '2026-01-01T00:00:00Z' };

        expect(component.trackConversation(0, conversation('conversation-1'))).toBe('conversation-1');
        expect(component.trackUserResult(0, user)).toBe('user-1');
        expect(component.trackGroupMember(0, member)).toBe('user-1');
        expect(component.trackGroupPeer(0, peer)).toBe('user-1:device-1');
        expect(component.trackMessage(0, message)).toBe('user-1:client-1');
        const optimisticMessage = { ...message, id: 'pending:client-1', pending: true };
        expect(component.trackMessage(0, optimisticMessage)).toBe(component.trackMessage(0, message));
    });

    it('projects member actions by actor and target role, hiding owner and self actions', () => {
        const owner = { ...groupMember('owner', 1), displayName: 'Owner', role: 'owner' as const };
        const admin = { ...groupMember('admin', 1), displayName: 'Admin', role: 'admin' as const };
        const anotherAdmin = { ...groupMember('another-admin', 1), displayName: 'Another admin', role: 'admin' as const };
        const member = { ...groupMember('member', 1), displayName: 'Member', role: 'member' as const };
        const group = { ...groupConversation('permissions'), ownerId: owner.userId, members: [owner, admin, anotherAdmin, member] };
        component.selectedConversation = group;

        component.profile = { id: owner.userId } as Profile;
        expect(component.groupMemberActions(owner)).toEqual([]);
        expect(component.groupMemberActions(admin).map(action => action.id)).toEqual(['make-member', 'transfer-owner', 'remove-member']);
        expect(component.groupMemberActions(member).map(action => action.id)).toEqual(['make-admin', 'transfer-owner', 'remove-member']);
        expect(component.groupMemberActions(admin)[0].ariaLabel).toBe('Make Admin a member');
        expect(component.groupMemberActions(member)[0].ariaLabel).toBe('Make Member an admin');
        expect(component.groupMemberActions(member)[1].label).toBe('Transfer owner');
        expect(component.groupMemberActions(member)[2].label).toBe('Remove');

        component.profile = { id: admin.userId } as Profile;
        expect(component.groupMemberActions(owner)).toEqual([]);
        expect(component.groupMemberActions(admin)).toEqual([]);
        expect(component.groupMemberActions(anotherAdmin).map(action => action.id)).toEqual(['make-member', 'remove-member']);
        expect(component.groupMemberActions(member).map(action => action.id)).toEqual(['make-admin', 'remove-member']);

        component.profile = { id: member.userId } as Profile;
        expect(component.groupMemberActions(owner)).toEqual([]);
        expect(component.groupMemberActions(admin)).toEqual([]);
        expect(component.groupMemberActions(member)).toEqual([]);

        const ownerOnly = { ...groupConversation('owner-only'), ownerId: owner.userId, members: [owner] };
        component.selectedConversation = ownerOnly;
        component.profile = { id: owner.userId } as Profile;
        expect(component.groupMemberActions(ownerOnly.members[0])).toEqual([]);
    });

    it('dispatches only currently permitted group member actions to existing handlers', () => {
        const owner = { ...groupMember('owner', 1), displayName: 'Owner', role: 'owner' as const };
        const admin = { ...groupMember('admin', 1), displayName: 'Admin', role: 'admin' as const };
        const member = { ...groupMember('member', 1), displayName: 'Member', role: 'member' as const };
        component.selectedConversation = { ...groupConversation('actions'), ownerId: owner.userId, members: [owner, admin, member] };
        component.profile = { id: owner.userId } as Profile;
        const changeRole = vi.spyOn(component, 'changeMemberRole').mockReturnValue(undefined);
        const transfer = vi.spyOn(component, 'transferOwnership').mockReturnValue(undefined);
        const remove = vi.spyOn(component, 'removeGroupMember').mockReturnValue(undefined);

        component.performGroupMemberAction(member, 'make-admin');
        component.performGroupMemberAction(admin, 'make-member');
        component.performGroupMemberAction(member, 'transfer-owner');
        component.performGroupMemberAction(member, 'remove-member');
        expect(vi.mocked(changeRole).mock.calls).toEqual([[member.userId, 'admin'], [admin.userId, 'member']]);
        expect(transfer).toHaveBeenCalledTimes(1);
        expect(transfer).toHaveBeenCalledWith(member.userId);
        expect(remove).toHaveBeenCalledTimes(1);
        expect(remove).toHaveBeenCalledWith(member.userId);

        component.profile = { id: admin.userId } as Profile;
        component.performGroupMemberAction(member, 'transfer-owner');
        component.performGroupMemberAction(owner, 'remove-member');
        expect(transfer).toHaveBeenCalledTimes(1);
        expect(remove).toHaveBeenCalledTimes(1);
    });

    it('blocks all group mutation entry points while a role mutation is pending and releases the lock on completion', () => {
        const pendingMutation = new Subject<GroupConversation>();
        const completedMutation = new Subject<GroupConversation>();
        const owner = { ...groupMember('owner', 1), displayName: 'Owner', role: 'owner' as const };
        const member = { ...groupMember('member', 1), displayName: 'Member', role: 'member' as const };
        const group = { ...groupConversation('pending-role-change'), ownerId: owner.userId, members: [owner, member] };
        const changeGroupRole = vi.fn().mockName('changeGroupRole').mockReturnValueOnce(pendingMutation.asObservable()).mockReturnValueOnce(completedMutation.asObservable());
        const renameGroup = vi.fn().mockName('renameGroup');
        const addGroupMember = vi.fn().mockName('addGroupMember');
        const removeGroupMember = vi.fn().mockName('removeGroupMember');
        const transferGroupOwnership = vi.fn().mockName('transferGroupOwnership');
        const leaveGroup = vi.fn().mockName('leaveGroup');
        const deleteGroup = vi.fn().mockName('deleteGroup');
        const createGroup = vi.fn().mockName('createGroup');
        const history = vi.fn().mockName('history').mockReturnValue(EMPTY);
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
        const historyComponent = createHomeComponent({ changeGroupRole, renameGroup, addGroupMember, removeGroupMember, transferGroupOwnership, leaveGroup, deleteGroup, createGroup, history } as unknown as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { close: () => undefined, send: vi.fn().mockName('send') } as unknown as DataProviderService, { close: () => undefined } as CallFacade);
        historyComponent.selectedConversation = group;
        historyComponent.profile = { id: owner.userId } as Profile;
        historyComponent.groupName = 'Pending rename';
        historyComponent.isCreatingGroup = true;
        historyComponent.selectedGroupMember = { id: 'another-member', display_name: 'Another member', email: 'another@example.test' };

        historyComponent.performGroupMemberAction(member, 'make-admin');
        expect(changeGroupRole).toHaveBeenCalledTimes(1);
        expect(changeGroupRole).toHaveBeenCalledWith(group.id, member.userId, 'admin');
        expect(historyComponent.groupLoading).toBe(true);

        historyComponent.performGroupMemberAction(member, 'make-admin');
        historyComponent.changeMemberRole(member.userId, 'member');
        historyComponent.renameGroup();
        historyComponent.addGroupMember();
        historyComponent.removeGroupMember(member.userId);
        historyComponent.transferOwnership(member.userId);
        historyComponent.leaveGroup();
        historyComponent.deleteGroup();
        historyComponent.createGroup();
        historyComponent.openGroupCreation();
        historyComponent.cancelGroupCreation();

        expect(changeGroupRole).toHaveBeenCalledTimes(1);
        expect(renameGroup).not.toHaveBeenCalled();
        expect(addGroupMember).not.toHaveBeenCalled();
        expect(removeGroupMember).not.toHaveBeenCalled();
        expect(transferGroupOwnership).not.toHaveBeenCalled();
        expect(leaveGroup).not.toHaveBeenCalled();
        expect(deleteGroup).not.toHaveBeenCalled();
        expect(createGroup).not.toHaveBeenCalled();
        expect(confirm).not.toHaveBeenCalled();
        expect(historyComponent.groupLoading).toBe(true);
        expect(historyComponent.selectedConversation?.id).toBe(group.id);
        expect(historyComponent.isCreatingGroup).toBe(true);
        expect(historyComponent.groupName).toBe('Pending rename');

        pendingMutation.error(new Error('deterministic completion'));
        expect(historyComponent.groupLoading).toBe(false);
        expect(historyComponent.groupError).toBe('Group changes could not be saved.');

        historyComponent.changeMemberRole(member.userId, 'admin');
        expect(changeGroupRole).toHaveBeenCalledTimes(2);
        expect(historyComponent.groupLoading).toBe(true);
        completedMutation.next({ ...group, members: [owner, { ...member, role: 'admin' }] });
        completedMutation.complete();
        expect(historyComponent.groupLoading).toBe(false);
        expect(historyComponent.groupError).toBe('');
        historyComponent.ngOnDestroy();
    });

    it('disables group member, add, rename, leave, and delete controls while a mutation is busy', () => {
        const owner = { ...groupMember('owner', 1), displayName: 'Owner', role: 'owner' as const };
        const member = { ...groupMember('member', 1), displayName: 'Member', role: 'member' as const };
        const group = { ...groupConversation('busy-controls'), ownerId: owner.userId, members: [owner, member] };
        vi.spyOn(TestBed.inject(AuthService), 'profile').mockReturnValue(of({ id: owner.userId, display_name: 'Owner' } as Profile));
        vi.spyOn(TestBed.inject(ConversationService), 'listHomeSnapshot').mockReturnValue(of({direct: [], groups: {items: [group], nextCursor: null}}));
        vi.spyOn(fixture.debugElement.injector.get(DataProviderService), 'getObservable').mockReturnValue(NEVER);
        component.selectedConversation = group;
        component.profile = { id: owner.userId } as Profile;
        component.showGroupManager = true;
        component.groupLoading = true;
        component.groupName = 'Busy group';
        component.selectedGroupMember = { id: 'another-member', display_name: 'Another member', email: 'another@example.test' };

        fixture.detectChanges();

        expect(fixture.debugElement.query(By.css('.group-settings-panel')).attributes['aria-busy']).toBe('true');
        const mutationButtons = fixture.debugElement.queryAll(By.css('.group-manager button:not([aria-label="Close group settings"])'))
            .map(button => button.nativeElement as HTMLButtonElement)
            .filter(button => ['Make Member an admin', 'Transfer ownership to Member', 'Remove Member', 'Add member', 'Save name', 'Leave group', 'Delete group'].includes(button.getAttribute('aria-label') || button.textContent?.trim() || ''));
        expect(mutationButtons.length).toBeGreaterThanOrEqual(7);
        expect(mutationButtons.every(button => button.disabled)).toBe(true);
    });

    it('replaces a selected conversation with group creation and selects the created group', () => {
        const created = groupConversation('created-group');
        const historyComponent = createHomeComponent({ history: () => of({ messages: [] }), createGroup: vi.fn().mockName('createGroup').mockReturnValue(of(created)) } as unknown as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, {} as DataProviderService, { close: () => undefined } as CallFacade);
        historyComponent.selectConversation(conversation('selected'));

        historyComponent.openGroupCreation();

        expect(historyComponent.selectedConversation).toBeUndefined();
        expect(historyComponent.isCreatingGroup).toBe(true);

        historyComponent.groupName = 'Created group';
        historyComponent.createGroup();

        expect(historyComponent.selectedConversation?.id).toBe(created.id);
        expect(historyComponent.isCreatingGroup).toBe(false);
    });

    it('keeps group creation open when creation fails and clears it on cancel', () => {
        const historyComponent = createHomeComponent({ createGroup: () => throwError(() => new Error('unavailable')) } as unknown as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, {} as DataProviderService, { close: () => undefined } as CallFacade);
        historyComponent.openGroupCreation();
        historyComponent.groupName = 'Team';

        historyComponent.createGroup();

        expect(historyComponent.isCreatingGroup).toBe(true);
        expect(historyComponent.groupError).toBe('Could not create the group.');

        historyComponent.cancelGroupCreation();

        expect(historyComponent.isCreatingGroup).toBe(false);
        expect(historyComponent.groupName).toBe('');
    });

    it('hides quarantined private group data and never restores selection or draft after a newer navigation intent', () => {
        const selected = groupConversation('private-group');
        const other = conversation('other-conversation');
        const lookup = new Subject<GroupConversation>();
        const service = { getGroup: () => lookup.asObservable(), history: () => of({ messages: [] }) } as unknown as ConversationService;
        const facade = new HomeGroupAccessFacade(service);
        const home = createHomeComponent(service, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { send: vi.fn().mockName('send'), close: vi.fn().mockName('close') } as unknown as DataProviderService, { close: vi.fn().mockName('close') } as unknown as CallFacade, undefined, undefined, facade);
        home.selectedConversation = selected;
        home.conversations.next([selected]);
        home.messages = [{ id: 'private', conversationId: selected.id, senderId: 'user-1', clientMessageId: 'client', sequence: 1, body: 'private', createdAt: '2026-01-01T00:00:00Z' }];
        home.draft = 'private draft';

        home.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: { conversation_id: selected.id, membership_revision: 2, deleted: false } });
        expect(home.selectedConversation).toBeUndefined();
        expect(home.conversations.getValue()).toEqual([]);
        expect(home.messages).toEqual([]);
        expect(home.draft).toBe('');

        home.selectConversation(other);
        home.draft = 'new conversation draft';
        lookup.next({ ...selected, membershipRevision: 2 });
        lookup.complete();

        expect(home.selectedConversation?.id).toBe(other.id);
        expect(home.draft).toBe('new conversation draft');
        expect(home.conversations.getValue().map(item => item.id)).toContain(selected.id);
        home.ngOnDestroy();
    });

    it('uses the compact group-call quality selection and exposes an explicit connection retry', () => {
        const retryNow = vi.fn().mockName('retryNow');
        const historyComponent = createHomeComponent({} as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { retryNow } as unknown as DataProviderService, { close: () => undefined } as CallFacade);

        historyComponent.onGroupScreenQualityChange('2k');
        historyComponent.onGroupScreenQualityChange('unsupported');
        historyComponent.retryConnection();

        expect(historyComponent.groupScreenQuality).toBe('2k');
        expect(retryNow).toHaveBeenCalledTimes(1);
    });

    it('delegates group speaker selection to the call facade without choosing a peer audio element', () => {
        const selectOutputDevice = vi.fn().mockName('selectOutputDevice').mockResolvedValue(undefined);
        const historyComponent = createHomeComponent({} as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, {} as DataProviderService, { close: () => undefined } as CallFacade, undefined, { selectOutputDevice } as unknown as GroupCallFacade);

        historyComponent.onGroupOutputDeviceChange('speaker-2');

        expect(selectOutputDevice).toHaveBeenCalledTimes(1);

        expect(selectOutputDevice).toHaveBeenCalledWith('speaker-2');
    });

    it('removes only the matching ongoing group-call facade and clears group management selection', () => {
        const directEnd = vi.fn().mockName('directEnd');
        const groupAbort = vi.fn().mockName('groupAbort').mockReturnValue(true);
        const removed = groupConversation('removed');
        const retained = groupConversation('retained');
        const groupCall = { isOngoing: true, state: { room: { conversation_id: removed.id } }, abort: groupAbort } as unknown as GroupCallFacade;
        const historyComponent = createHomeComponent({} as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, {} as DataProviderService, { end: directEnd, close: () => undefined } as unknown as CallFacade, undefined, groupCall);
        historyComponent.selectedConversation = removed;
        historyComponent.conversations.next([removed, retained]);
        historyComponent.showGroupManager = true;
        historyComponent.groupCallMinimized = true;

        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: { conversation_id: removed.id, membership_revision: 2, deleted: true } });

        expect(groupAbort).toHaveBeenCalledTimes(1);

        expect(groupAbort).toHaveBeenCalledWith(removed.id);
        expect(directEnd).not.toHaveBeenCalled();
        expect(historyComponent.conversations.getValue().map(item => item.id)).toEqual([retained.id]);
        expect(historyComponent.selectedConversation).toBeUndefined();
        expect(historyComponent.showGroupManager).toBe(false);
        expect(historyComponent.groupCallMinimized).toBe(false);
    });

    it('does not ask an unrelated group call to abort when another group is removed', () => {
        const groupAbort = vi.fn().mockName('groupAbort').mockReturnValue(false);
        const active = groupConversation('active');
        const removed = groupConversation('removed');
        const groupCall = { isOngoing: true, state: { room: { conversation_id: active.id } }, abort: groupAbort } as unknown as GroupCallFacade;
        const historyComponent = createHomeComponent({} as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, {} as DataProviderService, { close: () => undefined } as CallFacade, undefined, groupCall);
        historyComponent.conversations.next([active, removed]);

        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: { conversation_id: removed.id, membership_revision: 2, deleted: true } });

        expect(groupAbort).not.toHaveBeenCalled();
        expect(historyComponent.conversations.getValue().map(item => item.id)).toEqual([active.id]);
    });

    for (const action of ['leave', 'delete'] as const) {
        it(`reconciles a non-deleted revision advance before ${action} success with an authorized 404`, () => {
            const initial = groupConversation(`advanced-${action}`);
            const response = new Subject<void>();
            const lookup = new Subject<GroupConversation>();
            const getGroup = vi.fn().mockName('getGroup').mockReturnValueOnce(NEVER).mockReturnValueOnce(lookup.asObservable());
            const historyComponent = createHomeComponent({ leaveGroup: () => response.asObservable(), deleteGroup: () => response.asObservable(), getGroup } as unknown as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { close: () => undefined } as DataProviderService, { close: () => undefined } as CallFacade);
            const groupAccess = (historyComponent as unknown as {
                groupAccess: HomeGroupAccessFacade;
            }).groupAccess;
            vi.spyOn(window, 'confirm').mockReturnValue(true);
            historyComponent.selectedConversation = initial;
            historyComponent.conversations.next([initial]);

            if (action === 'leave')
                historyComponent.leaveGroup();
            else
                historyComponent.deleteGroup();
            historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: { conversation_id: initial.id, membership_revision: 2, deleted: false } });
            response.next();
            response.complete();
            expect(historyComponent.conversations.getValue()).toEqual([]);
            expect(getGroup).toHaveBeenCalledTimes(2);
            lookup.error(new GroupProjectionNotFoundError());
            expect(historyComponent.conversations.getValue()).toEqual([]);
            expect(historyComponent.selectedConversation).toBeUndefined();
            historyComponent.ngOnDestroy();
        });

        it(`retains an equal-revision rejoin tombstone after ${action} completion`, () => {
            const initial = groupConversation(`equal-${action}`);
            const rejoined = { ...initial, membershipRevision: 3 };
            const response = new Subject<void>();
            const historyComponent = createHomeComponent({ leaveGroup: () => response.asObservable(), deleteGroup: () => response.asObservable(), getGroup: () => of(rejoined), history: () => of({ messages: [] }) } as unknown as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { send: () => true, close: () => undefined } as unknown as DataProviderService, { close: () => undefined } as CallFacade);
            const groupAccess = (historyComponent as unknown as {
                groupAccess: HomeGroupAccessFacade;
            }).groupAccess;
            vi.spyOn(window, 'confirm').mockReturnValue(true);
            historyComponent.selectedConversation = initial;
            historyComponent.conversations.next([initial]);
            if (action === 'leave')
                historyComponent.leaveGroup();
            else
                historyComponent.deleteGroup();
            historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: { conversation_id: initial.id, membership_revision: 2, deleted: true } });
            historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: { conversation_id: initial.id, membership_revision: 3, deleted: false } });
            response.next();
            response.complete();
            historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: { conversation_id: initial.id, membership_revision: 3, deleted: true } });
            expect(historyComponent.conversations.getValue()).toEqual([rejoined]);
            historyComponent.ngOnDestroy();
        });

        it(`does not apply a delayed ${action} reconciliation over a newer rejoin`, () => {
            const initial = groupConversation(`lookup-${action}`);
            const rejoined = { ...initial, membershipRevision: 3, name: 'Rejoined' };
            const response = new Subject<void>();
            const lookup = new Subject<GroupConversation>();
            const getGroup = vi.fn().mockName('getGroup').mockReturnValueOnce(NEVER).mockReturnValueOnce(lookup.asObservable()).mockReturnValueOnce(of(rejoined));
            const historyComponent = createHomeComponent({ leaveGroup: () => response.asObservable(), deleteGroup: () => response.asObservable(), getGroup, history: () => of({ messages: [] }) } as unknown as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { send: () => true, close: () => undefined } as unknown as DataProviderService, { close: () => undefined } as CallFacade);
            vi.spyOn(window, 'confirm').mockReturnValue(true);
            historyComponent.selectedConversation = initial;
            historyComponent.conversations.next([initial]);
            if (action === 'leave')
                historyComponent.leaveGroup();
            else
                historyComponent.deleteGroup();
            historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: { conversation_id: initial.id, membership_revision: 2, deleted: false } });
            response.next();
            response.complete();
            historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: { conversation_id: initial.id, membership_revision: 3, deleted: false } });
            lookup.error(new Error('forbidden'));
            expect(historyComponent.conversations.getValue()).toEqual([rejoined]);
            expect(historyComponent.groupMembershipRefreshError).toBe('');
            historyComponent.ngOnDestroy();
        });

        it(`does not overwrite a newer rejoin with a delayed ${action} reconciliation 200`, () => {
            const initial = groupConversation(`lookup-200-${action}`);
            const stale = { ...initial, membershipRevision: 2, name: 'Stale' };
            const rejoined = { ...initial, membershipRevision: 3, name: 'Rejoined' };
            const response = new Subject<void>();
            const lookup = new Subject<GroupConversation>();
            const getGroup = vi.fn().mockName('getGroup').mockReturnValueOnce(NEVER).mockReturnValueOnce(lookup.asObservable()).mockReturnValueOnce(of(rejoined));
            const historyComponent = createHomeComponent({ leaveGroup: () => response.asObservable(), deleteGroup: () => response.asObservable(), getGroup, history: () => of({ messages: [] }) } as unknown as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { send: () => true, close: () => undefined } as unknown as DataProviderService, { close: () => undefined } as CallFacade);
            vi.spyOn(window, 'confirm').mockReturnValue(true);
            historyComponent.selectedConversation = initial;
            historyComponent.conversations.next([initial]);
            if (action === 'leave')
                historyComponent.leaveGroup();
            else
                historyComponent.deleteGroup();
            historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: { conversation_id: initial.id, membership_revision: 2, deleted: false } });
            response.next();
            response.complete();
            historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: { conversation_id: initial.id, membership_revision: 3, deleted: false } });
            lookup.next(stale);
            lookup.complete();
            expect(historyComponent.conversations.getValue()).toEqual([rejoined]);
            historyComponent.ngOnDestroy();
        });

        it(`upserts a current authorized projection after ${action} success, without removing it on refresh failure`, () => {
            const initial = groupConversation(`refresh-${action}`);
            const refreshed = { ...initial, membershipRevision: 2, name: 'Current membership' };
            const response = new Subject<void>();
            const lookup = new Subject<GroupConversation>();
            const getGroup = vi.fn().mockName('getGroup').mockReturnValueOnce(NEVER).mockReturnValueOnce(lookup.asObservable());
            const historyComponent = createHomeComponent({ leaveGroup: () => response.asObservable(), deleteGroup: () => response.asObservable(), getGroup, history: () => of({ messages: [] }) } as unknown as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { send: () => true, close: () => undefined } as unknown as DataProviderService, { close: () => undefined } as CallFacade);
            vi.spyOn(window, 'confirm').mockReturnValue(true);
            historyComponent.selectedConversation = initial;
            historyComponent.conversations.next([initial]);
            if (action === 'leave')
                historyComponent.leaveGroup();
            else
                historyComponent.deleteGroup();
            historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: { conversation_id: initial.id, membership_revision: 2, deleted: false } });
            response.next();
            response.complete();
            lookup.next(refreshed);
            lookup.complete();
            expect(historyComponent.conversations.getValue()).toEqual([refreshed]);
            expect(historyComponent.selectedConversation).toEqual(refreshed);
            historyComponent.ngOnDestroy();
        });

        it(`quarantines selected private content and actions through pending and failed ${action} reconciliation, then restores an authorized equal-revision 200`, async () => {
            const initial = groupConversation(`error-${action}`);
            const response = new Subject<void>();
            const preDepartureLookup = new Subject<GroupConversation>();
            const lookup = new Subject<GroupConversation>();
            const retry = new Subject<GroupConversation>();
            const service = TestBed.inject(ConversationService);
            vi.spyOn(TestBed.inject(AuthService), 'profile').mockReturnValue(of({ id: 'user-1', display_name: 'Member' } as Profile));
            vi.spyOn(service, 'listHomeSnapshot').mockReturnValue(of({direct: [], groups: {items: [initial], nextCursor: null}}));
            vi.spyOn(service, 'history').mockReturnValue(of({ messages: [] }));
            vi.spyOn(service, 'getGroup').mockReturnValueOnce(preDepartureLookup.asObservable()).mockReturnValueOnce(lookup.asObservable()).mockReturnValueOnce(retry.asObservable());
            vi.spyOn(service, 'leaveGroup').mockReturnValue(response.asObservable());
            vi.spyOn(service, 'deleteGroup').mockReturnValue(response.asObservable());
            vi.spyOn(fixture.debugElement.injector.get(DataProviderService), 'getObservable').mockReturnValue(NEVER);
            fixture.detectChanges();
            const historyComponent = component;
            vi.spyOn(window, 'confirm').mockReturnValue(true);
            historyComponent.selectConversation(initial);
            historyComponent.socketReady = true;
            historyComponent.draft = 'Private draft';
            historyComponent.messages = [{ id: 'private-message', conversationId: initial.id, senderId: 'user-1', clientMessageId: 'private-client', sequence: 1, body: 'Private content', createdAt: '2026-01-01T00:00:00Z' }];
            historyComponent.showGroupManager = true;
            if (action === 'leave')
                historyComponent.leaveGroup();
            else
                historyComponent.deleteGroup();
            historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: { conversation_id: initial.id, membership_revision: 2, deleted: false } });
            response.next();
            response.complete();
            await Promise.resolve();
            await new Promise<void>(resolve => setTimeout(resolve, 0));
            fixture.detectChanges();
            fixture.detectChanges();
            expect(historyComponent.conversations.getValue()).toEqual([]);
            expect(historyComponent.selectedConversation).toBeUndefined();
            expect(historyComponent.messages).toEqual([]);
            expect(historyComponent.draft).toBe('');
            expect(historyComponent.showGroupManager).toBe(false);
            expect(fixture.debugElement.query(By.css('.person-option'))).toBeNull();
            expect(fixture.debugElement.query(By.css('.message-history'))).toBeNull();
            expect(fixture.debugElement.query(By.css('.group-manager'))).toBeNull();
            expect((fixture.debugElement.query(By.css('.composer textarea')).nativeElement as HTMLTextAreaElement).disabled).toBe(true);
            preDepartureLookup.next({ ...initial, membershipRevision: 2 });
            preDepartureLookup.complete();
            fixture.detectChanges();
            expect(historyComponent.conversations.getValue()).toEqual([]);
            lookup.error(new Error('unavailable'));
            fixture.detectChanges();
            fixture.detectChanges();
            expect(historyComponent.conversations.getValue()).toEqual([]);
            expect(historyComponent.selectedConversation).toBeUndefined();
            expect(historyComponent.departedGroupRefreshFailed).toBe(true);
            const alert = fixture.debugElement.query(By.css('.group-settings-error[role="alert"]'));
            expect(alert.nativeElement.textContent).toContain('hidden until access is verified');
            expect(fixture.debugElement.query(By.css('.workspace.conversation-open'))).not.toBeNull();
            expect((fixture.debugElement.query(By.css('.composer textarea')).nativeElement as HTMLTextAreaElement).disabled).toBe(true);
            (alert.query(By.css('button')).nativeElement as HTMLButtonElement).click();
            retry.next({ ...initial, membershipRevision: 2, name: 'Authorized again' });
            retry.complete();
            historyComponent.socketReady = true;
            await new Promise<void>(resolve => setTimeout(resolve, 0));
            fixture.detectChanges();
            fixture.detectChanges();
            expect(historyComponent.conversations.getValue().map(item => item.id)).toEqual([initial.id]);
            expect(historyComponent.selectedConversation?.id).toBe(initial.id);
            expect(historyComponent.departedGroupRefreshFailed).toBe(false);
            expect(fixture.debugElement.query(By.css('.workspace.conversation-open'))).not.toBeNull();
            expect((fixture.debugElement.query(By.css('.composer textarea')).nativeElement as HTMLTextAreaElement).disabled).toBe(false);
        });

        it(`cancels an in-flight ${action} reconciliation on destroy`, () => {
            const initial = groupConversation(`cancel-${action}`);
            const response = new Subject<void>();
            const lookup = new Subject<GroupConversation>();
            const getGroup = vi.fn().mockName('getGroup').mockReturnValueOnce(NEVER).mockReturnValueOnce(lookup.asObservable());
            const historyComponent = createHomeComponent({ leaveGroup: () => response.asObservable(), deleteGroup: () => response.asObservable(), getGroup } as unknown as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { close: () => undefined } as DataProviderService, { close: () => undefined } as CallFacade);
            const groupAccess = (historyComponent as unknown as {
                groupAccess: HomeGroupAccessFacade;
            }).groupAccess;
            vi.spyOn(window, 'confirm').mockReturnValue(true);
            historyComponent.selectedConversation = initial;
            historyComponent.conversations.next([initial]);
            if (action === 'leave')
                historyComponent.leaveGroup();
            else
                historyComponent.deleteGroup();
            historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: { conversation_id: initial.id, membership_revision: 2, deleted: false } });
            response.next();
            response.complete();
            expect(lookup.observed).toBe(true);
            historyComponent.ngOnDestroy();
            groupAccess.ngOnDestroy();
            expect(lookup.observed).toBe(false);
        });

        it(`keeps a revision-3 rejoin after delayed ${action} success`, () => {
            const initial = groupConversation(`delayed-${action}`);
            const rejoined = { ...initial, membershipRevision: 3, name: 'Rejoined' };
            const response = new Subject<void>();
            const request = vi.fn().mockName(action).mockReturnValue(response.asObservable());
            const historyComponent = createHomeComponent({ leaveGroup: request, deleteGroup: request, getGroup: () => of(rejoined), history: () => of({ messages: [] }) } as unknown as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { send: vi.fn().mockName('send').mockReturnValue(true), close: () => undefined } as unknown as DataProviderService, { close: () => undefined } as CallFacade);
            vi.spyOn(window, 'confirm').mockReturnValue(true);
            historyComponent.selectedConversation = initial;
            historyComponent.conversations.next([initial]);
            historyComponent.showGroupManager = true;

            if (action === 'leave')
                historyComponent.leaveGroup();
            else
                historyComponent.deleteGroup();
            expect(request).toHaveBeenCalledTimes(1);
            expect(request).toHaveBeenCalledWith(initial.id);
            expect(historyComponent.groupLoading).toBe(true);

            historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: { conversation_id: initial.id, membership_revision: 2, deleted: true } });
            historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: { conversation_id: initial.id, membership_revision: 3, deleted: false } });
            historyComponent.selectConversation(rejoined);
            historyComponent.showGroupManager = true;
            response.next();
            response.complete();

            expect(historyComponent.conversations.getValue()).toEqual([rejoined]);
            expect(historyComponent.selectedConversation).toEqual(rejoined);
            expect(historyComponent.showGroupManager).toBe(true);
            expect(historyComponent.groupLoading).toBe(false);
            historyComponent.ngOnDestroy();
        });

        it(`removes the group on ordinary ${action} success without a newer membership`, () => {
            const group = groupConversation(`ordinary-${action}`);
            const rejoined = { ...group, membershipRevision: 3 };
            const response = new Subject<void>();
            const request = vi.fn().mockName(action).mockReturnValue(response.asObservable());
            const historyComponent = createHomeComponent({ leaveGroup: request, deleteGroup: request, getGroup: () => of(rejoined) } as unknown as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { close: () => undefined } as DataProviderService, { close: () => undefined } as CallFacade);
            vi.spyOn(window, 'confirm').mockReturnValue(true);
            historyComponent.selectedConversation = group;
            historyComponent.conversations.next([group]);
            historyComponent.showGroupManager = true;

            if (action === 'leave')
                historyComponent.leaveGroup();
            else
                historyComponent.deleteGroup();
            expect(historyComponent.conversations.getValue()).toEqual([group]);
            response.next();
            response.complete();

            expect(historyComponent.conversations.getValue()).toEqual([]);
            expect(historyComponent.selectedConversation).toBeUndefined();
            expect(historyComponent.showGroupManager).toBe(false);
            expect(historyComponent.groupLoading).toBe(false);

            // The server's removal event may arrive after HTTP success; neither may mask a later rejoin.
            historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: { conversation_id: group.id, membership_revision: 2, deleted: true } });
            expect(historyComponent.conversations.getValue()).toEqual([]);
            historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: { conversation_id: group.id, membership_revision: 3, deleted: false } });
            expect(historyComponent.conversations.getValue()).toEqual([rejoined]);
            historyComponent.ngOnDestroy();
        });

        it(`does not close another group's settings when delayed ${action} succeeds`, () => {
            const departing = groupConversation(`departing-${action}`);
            const other = groupConversation(`other-${action}`);
            const response = new Subject<void>();
            const request = vi.fn().mockName(action).mockReturnValue(response.asObservable());
            const historyComponent = createHomeComponent({ leaveGroup: request, deleteGroup: request } as unknown as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { close: () => undefined } as DataProviderService, { close: () => undefined } as CallFacade);
            vi.spyOn(window, 'confirm').mockReturnValue(true);
            historyComponent.selectedConversation = departing;
            historyComponent.conversations.next([departing, other]);
            if (action === 'leave')
                historyComponent.leaveGroup();
            else
                historyComponent.deleteGroup();

            historyComponent.selectedConversation = other;
            historyComponent.showGroupManager = true;
            historyComponent.groupError = 'Other group error';
            response.next();
            response.complete();

            expect(request).toHaveBeenCalledTimes(1);

            expect(request).toHaveBeenCalledWith(departing.id);
            expect(historyComponent.conversations.getValue()).toEqual([other]);
            expect(historyComponent.selectedConversation).toBe(other);
            expect(historyComponent.showGroupManager).toBe(true);
            expect(historyComponent.groupError).toBe('Other group error');
            historyComponent.ngOnDestroy();
        });

        it(`does not show ${action}'s delayed failure in another group's settings`, () => {
            const departing = groupConversation(`failed-departure-${action}`);
            const other = groupConversation(`unrelated-${action}`);
            const response = new Subject<void>();
            const historyComponent = createHomeComponent({ leaveGroup: () => response.asObservable(), deleteGroup: () => response.asObservable() } as unknown as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { close: () => undefined } as DataProviderService, { close: () => undefined } as CallFacade);
            vi.spyOn(window, 'confirm').mockReturnValue(true);
            historyComponent.selectedConversation = departing;
            historyComponent.conversations.next([departing, other]);
            if (action === 'leave')
                historyComponent.leaveGroup();
            else
                historyComponent.deleteGroup();
            historyComponent.selectedConversation = other;
            historyComponent.showGroupManager = true;
            historyComponent.groupError = 'Other group error';
            response.error(new Error('Departure failed'));
            expect(historyComponent.selectedConversation).toBe(other);
            expect(historyComponent.showGroupManager).toBe(true);
            expect(historyComponent.groupError).toBe('Other group error');
            expect(historyComponent.groupLoading).toBe(false);
            historyComponent.ngOnDestroy();
        });
    }

    it('keeps retry visible until every failed departure has been reconciled', () => {
        const first = groupConversation('first-departure');
        const second = groupConversation('second-departure');
        const firstLeave = new Subject<void>();
        const secondLeave = new Subject<void>();
        const firstLookup = new Subject<GroupConversation>();
        const secondLookup = new Subject<GroupConversation>();
        const firstRetry = new Subject<GroupConversation>();
        const secondRetry = new Subject<GroupConversation>();
        const lookupCalls = new Map<string, number>();
        const historyComponent = createHomeComponent({
            leaveGroup: (id: string) => id === first.id ? firstLeave.asObservable() : secondLeave.asObservable(),
            getGroup: (id: string) => {
                const count = lookupCalls.get(id) || 0;
                lookupCalls.set(id, count + 1);
                if (count === 0)
                    return NEVER;
                return (id === first.id ? [firstLookup, firstRetry] : [secondLookup, secondRetry])[count - 1].asObservable();
            },
            list: () => EMPTY,
        } as unknown as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { close: () => undefined } as DataProviderService, { close: () => undefined } as CallFacade);
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        historyComponent.selectedConversation = first;
        historyComponent.conversations.next([first, second]);
        historyComponent.leaveGroup();
        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: { conversation_id: first.id, membership_revision: 2, deleted: false } });
        firstLeave.next();
        firstLeave.complete();
        firstLookup.error(new HttpErrorResponse({ status: 500 }));
        expect(historyComponent.groupMembershipRefreshErrorConversationID).toBe(first.id);
        expect(historyComponent.groupRefreshStatusVisible()).toBe(true);

        historyComponent.selectedConversation = second;
        historyComponent.leaveGroup();
        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: { conversation_id: second.id, membership_revision: 2, deleted: false } });
        secondLeave.next();
        secondLeave.complete();
        secondLookup.error(new HttpErrorResponse({ status: 500 }));
        expect(historyComponent.departedGroupRefreshFailed).toBe(true);

        historyComponent.refreshChats();
        secondRetry.error(new GroupProjectionNotFoundError());
        expect(historyComponent.departedGroupRefreshFailed).toBe(true);
        expect(historyComponent.groupRefreshStatusVisible()).toBe(true);
        firstRetry.error(new GroupProjectionNotFoundError());
        expect(historyComponent.departedGroupRefreshFailed).toBe(false);
        expect(historyComponent.groupRefreshStatusVisible()).toBe(false);
        expect(historyComponent.conversations.getValue()).toEqual([]);
        historyComponent.ngOnDestroy();
    });

    it('keeps a retry visible when a newer membership event returns a stale projection during departure reconciliation', () => {
        const group = groupConversation('stale-departure-reconciliation');
        const departure = new Subject<void>();
        const earlierEventLookup = new Subject<GroupConversation>();
        const departureLookup = new Subject<GroupConversation>();
        const newerEventLookup = new Subject<GroupConversation>();
        const getGroup = vi.fn().mockName('getGroup').mockReturnValueOnce(earlierEventLookup).mockReturnValueOnce(departureLookup).mockReturnValueOnce(newerEventLookup);
        const historyComponent = createHomeComponent({ leaveGroup: () => departure.asObservable(), getGroup } as unknown as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { close: () => undefined } as DataProviderService, { close: () => undefined } as CallFacade);
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        historyComponent.selectedConversation = group;
        historyComponent.conversations.next([group]);
        historyComponent.leaveGroup();
        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: { conversation_id: group.id, membership_revision: 2, deleted: false } });
        departure.next();
        departure.complete();
        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: { conversation_id: group.id, membership_revision: 3, deleted: false } });
        departureLookup.next({ ...group, membershipRevision: 2 });
        departureLookup.complete();
        newerEventLookup.next({ ...group, membershipRevision: 2 });
        newerEventLookup.complete();
        earlierEventLookup.next({ ...group, membershipRevision: 2 });
        earlierEventLookup.complete();

        expect(historyComponent.conversations.getValue()).toEqual([]);
        expect(historyComponent.selectedConversation).toBeUndefined();
        expect(historyComponent.departedGroupRefreshFailed).toBe(true);
        expect(historyComponent.groupRefreshStatusVisible()).toBe(true);
        historyComponent.ngOnDestroy();
    });

    it('cancels an in-flight membership-event projection lookup on Home destruction', () => {
        const group = groupConversation('event-lookup-teardown');
        const lookup = new Subject<GroupConversation>();
        const historyComponent = createHomeComponent({ getGroup: () => lookup.asObservable() } as unknown as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { close: () => undefined } as DataProviderService, { close: () => undefined } as CallFacade);
        const groupAccess = (historyComponent as unknown as {
            groupAccess: HomeGroupAccessFacade;
        }).groupAccess;
        historyComponent.selectedConversation = group;
        historyComponent.conversations.next([group]);
        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: { conversation_id: group.id, membership_revision: 2, deleted: false } });
        expect(lookup.observed).toBe(true);
        historyComponent.ngOnDestroy();
        groupAccess.ngOnDestroy();
        expect(lookup.observed).toBe(false);
        lookup.next({ ...group, membershipRevision: 2 });
        expect(historyComponent.conversations.getValue()).toEqual([]);
    });

    it('times out an unresolved departure lookup while keeping private content hidden and retry visible', fakeAsync(async () => {
        const group = groupConversation('pending-departure');
        const departure = new Subject<void>();
        const historyComponent = createHomeComponent({ leaveGroup: () => departure.asObservable(), getGroup: () => NEVER } as unknown as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { close: () => undefined } as DataProviderService, { close: () => undefined } as CallFacade);
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        historyComponent.selectedConversation = group;
        historyComponent.conversations.next([group]);
        historyComponent.leaveGroup();
        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: { conversation_id: group.id, membership_revision: 2, deleted: false } });
        departure.next();
        departure.complete();
        expect(historyComponent.departedGroupRefreshPending).toBe(true);
        expect(historyComponent.groupRefreshStatusVisible()).toBe(true);
        expect(historyComponent.selectedConversation).toBeUndefined();
        expect(historyComponent.conversations.getValue()).toEqual([]);
        await tick(10001);
        expect(historyComponent.departedGroupRefreshPending).toBe(false);
        expect(historyComponent.departedGroupRefreshFailed).toBe(true);
        expect(historyComponent.groupRefreshStatusVisible()).toBe(true);
        historyComponent.ngOnDestroy();
    }));

    for (const invalidProjection of ['wrong-id', 'stale-revision'] as const) {
        it(`quarantines a selected group when a membership event returns a ${invalidProjection} 200`, () => {
            const group = groupConversation(`invalid-${invalidProjection}`);
            const lookup = new Subject<GroupConversation>();
            const historyComponent = createHomeComponent({ getGroup: () => lookup.asObservable() } as unknown as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { close: () => undefined } as DataProviderService, { close: () => undefined } as CallFacade);
            historyComponent.selectedConversation = group;
            historyComponent.conversations.next([group]);
            historyComponent.showGroupManager = true;
            historyComponent.messages = [{ id: 'private', conversationId: group.id, senderId: 'sender', clientMessageId: 'private', sequence: 1, body: 'Private', createdAt: '2026-01-01T00:00:00Z' }];
            historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: { conversation_id: group.id, membership_revision: 2, deleted: false } });
            lookup.next(invalidProjection === 'wrong-id' ? { ...group, id: 'other-group', membershipRevision: 2 } : group);
            lookup.complete();
            expect(historyComponent.conversations.getValue()).toEqual([]);
            expect(historyComponent.selectedConversation).toBeUndefined();
            expect(historyComponent.messages).toEqual([]);
            expect(historyComponent.showGroupManager).toBe(false);
            expect(historyComponent.departedGroupRefreshFailed).toBe(true);
            historyComponent.ngOnDestroy();
        });
    }

    it('quarantines a selected group when an authorized 200 contains a malformed projection', () => {
        const group = groupConversation('malformed-group-projection');
        const lookup = new Subject<GroupConversation>();
        const historyComponent = createHomeComponent({ getGroup: () => lookup.asObservable() } as unknown as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { close: () => undefined } as DataProviderService, { close: () => undefined } as CallFacade);
        historyComponent.selectedConversation = group;
        historyComponent.conversations.next([group]);
        historyComponent.messages = [{ id: 'private', conversationId: group.id, senderId: 'sender', clientMessageId: 'private', sequence: 1, body: 'Private', createdAt: '2026-01-01T00:00:00Z' }];
        historyComponent.showGroupManager = true;
        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: { conversation_id: group.id, membership_revision: 2, deleted: false } });
        lookup.error(new InvalidGroupProjectionError());
        expect(historyComponent.selectedConversation).toBeUndefined();
        expect(historyComponent.conversations.getValue()).toEqual([]);
        expect(historyComponent.messages).toEqual([]);
        expect(historyComponent.showGroupManager).toBe(false);
        expect(historyComponent.departedGroupRefreshFailed).toBe(true);
        expect(historyComponent.groupRefreshStatusVisible()).toBe(true);
        historyComponent.ngOnDestroy();
    });

    it('preserves a known authorized group and its selection when Refresh chats receives a malformed group list', () => {
        const group = groupConversation('malformed-list-refresh');
        const list = vi.fn().mockName('list').mockReturnValue(throwError(() => new InvalidGroupProjectionError()));
        const home = createHomeComponent({ list } as unknown as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { close: () => undefined } as DataProviderService, { close: () => undefined } as CallFacade);
        home.conversations.next([group]);
        home.selectedConversation = group;
        home.messages = [{ id: 'private-message', conversationId: group.id, senderId: 'user-1', clientMessageId: 'private-client', sequence: 1, body: 'Still authorized', createdAt: '2026-01-01T00:00:00Z' }];

        home.refreshChats();

        expect(list).toHaveBeenCalledTimes(1);
        expect(home.conversations.getValue()).toEqual([group]);
        expect(home.selectedConversation).toBe(group);
        expect(home.messages.map(message => message.body)).toEqual(['Still authorized']);
        home.ngOnDestroy();
    });

    it('fences delayed membership and conversation-created lookups, then permits a newer membership revision', () => {
        const initial = { ...groupConversation('projection-fence-get'), members: [groupMember('user-1', 1)] };
        const membershipLookup = new Subject<GroupConversation>();
        const createdLookup = new Subject<GroupConversation>();
        const rejoinLookup = new Subject<GroupConversation>();
        const getGroup = vi.fn().mockName('getGroup').mockReturnValueOnce(membershipLookup.asObservable()).mockReturnValueOnce(createdLookup.asObservable()).mockReturnValueOnce(rejoinLookup.asObservable());
        const historyComponent = createHomeComponent({ getGroup, list: () => EMPTY, history: () => of({ messages: [] }) } as unknown as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { send: vi.fn().mockName('send').mockReturnValue(true), close: () => undefined } as unknown as DataProviderService, { close: () => undefined } as CallFacade);
        historyComponent.profile = { id: 'user-1' } as Profile;
        historyComponent.selectedConversation = initial;
        historyComponent.conversations.next([initial]);
        historyComponent.showGroupManager = true;

        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: { conversation_id: initial.id, membership_revision: 2, deleted: false } });
        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'conversation.created', payload: { conversation_id: initial.id } });
        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: { conversation_id: initial.id, membership_revision: 3, deleted: true } });

        membershipLookup.next({ ...initial, membershipRevision: 2, name: 'Old membership lookup' });
        membershipLookup.complete();
        createdLookup.next({ ...initial, membershipRevision: 2, name: 'Old conversation-created lookup' });
        createdLookup.complete();
        expect(historyComponent.conversations.getValue()).toEqual([]);
        expect(historyComponent.selectedConversation).toBeUndefined();
        expect(historyComponent.showGroupManager).toBe(false);
        expect(historyComponent.groupSelected).toBeUndefined();
        expect(historyComponent.canManageGroup()).toBe(false);

        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: { conversation_id: initial.id, membership_revision: 4, deleted: false } });
        expect(getGroup).toHaveBeenCalledTimes(2);
        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: { conversation_id: initial.id, membership_revision: 5, deleted: false } });
        rejoinLookup.next({ ...initial, name: 'Rejoined at a newer revision', membershipRevision: 5 });
        rejoinLookup.complete();

        expect(historyComponent.conversations.getValue().map(item => item.id)).toEqual([initial.id]);
        const rejoined = historyComponent.conversations.getValue()[0];
        expect(rejoined.kind === 'group' && rejoined.membershipRevision).toBe(5);
        historyComponent.selectConversation(rejoined);
        historyComponent.toggleGroupManager();
        expect(historyComponent.canManageGroup()).toBe(true);
        historyComponent.ngOnDestroy();
    });

    it('rejects stale mutation and conversation-list projections after a newer removal', () => {
        const owner = groupMember('user-1', 1);
        const selected = { ...groupConversation('projection-fence-mutation-list'), members: [owner] };
        const mutation = new Subject<GroupConversation>();
        const staleList = new Subject<Conversation[]>();
        const remaining = conversation('still-authorized');
        const list = vi.fn().mockName('list').mockReturnValueOnce(staleList.asObservable()).mockReturnValueOnce(of([selected, remaining]));
        const historyComponent = createHomeComponent({ renameGroup: () => mutation.asObservable(), list } as unknown as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { send: vi.fn().mockName('send').mockReturnValue(true), close: () => undefined } as unknown as DataProviderService, { close: () => undefined } as CallFacade);
        historyComponent.profile = { id: owner.userId } as Profile;
        historyComponent.selectedConversation = selected;
        historyComponent.conversations.next([selected]);
        historyComponent.showGroupManager = true;
        historyComponent.groupName = 'Pending rename';

        historyComponent.renameGroup();
        historyComponent.refreshChats();
        expect(historyComponent.groupLoading).toBe(true);
        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: { conversation_id: selected.id, membership_revision: 2, deleted: true } });

        mutation.next({ ...selected, name: 'Late mutation response', membershipRevision: 1 });
        mutation.complete();
        staleList.next([selected, remaining]);
        staleList.complete();

        expect(list).toHaveBeenCalledTimes(2);
        expect(historyComponent.conversations.getValue().map(item => item.id)).toEqual([remaining.id]);
        expect(historyComponent.selectedConversation).toBeUndefined();
        expect(historyComponent.groupSelected).toBeUndefined();
        expect(historyComponent.showGroupManager).toBe(false);
        expect(historyComponent.canManageGroup()).toBe(false);
        expect(historyComponent.groupLoading).toBe(false);
        historyComponent.ngOnDestroy();
    });

    it('ignores history from a conversation that is no longer selected', () => {
        const firstHistory = new Subject<MessageHistory>();
        const secondHistory = new Subject<MessageHistory>();
        const history = vi.fn().mockName('history').mockReturnValueOnce(firstHistory.asObservable()).mockReturnValueOnce(secondHistory.asObservable());
        const historyComponent = createHomeComponent({ history } as unknown as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, {} as DataProviderService, { close: () => undefined } as CallFacade);
        const firstConversation = conversation('first');
        const secondConversation = conversation('second');

        historyComponent.selectConversation(firstConversation);
        historyComponent.selectConversation(secondConversation);
        firstHistory.next({ messages: [{ id: 'stale', conversationId: 'first', senderId: 'user-1', clientMessageId: 'stale', sequence: 1, body: 'stale message', createdAt: '2026-01-01T00:00:00Z' }] });
        firstHistory.complete();
        secondHistory.next({ messages: [{ id: 'current', conversationId: 'second', senderId: 'user-2', clientMessageId: 'current', sequence: 1, body: 'current message', createdAt: '2026-01-01T00:00:00Z' }] });
        secondHistory.complete();

        expect(historyComponent.selectedConversation?.id).toBe('second');
        expect(historyComponent.messages.map(message => message.id)).toEqual(['current']);
        expect(historyComponent.isHistoryLoading).toBe(false);
    });

    it('retains a realtime message received while selected history is loading', () => {
        const history = new Subject<MessageHistory>();
        const historyComponent = createHomeComponent({ history: () => history.asObservable() } as unknown as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { send: vi.fn().mockName('send').mockReturnValue(true), close: () => undefined } as unknown as DataProviderService, { close: () => undefined } as CallFacade);
        const selected = conversation('selected');

        historyComponent.selectConversation(selected);
        historyComponent.handleSocketEvent({
            version: WEBSOCKET_PROTOCOL_VERSION,
            type: 'message.created',
            payload: { id: 'live', conversation_id: selected.id, sender_id: 'user-2', client_message_id: 'live', sequence: 2, body: 'Live message', created_at: '2026-01-02T00:00:00Z' },
        });
        history.next({ messages: [{ id: 'history', conversationId: selected.id, senderId: 'user-1', clientMessageId: 'history', sequence: 1, body: 'Historic message', createdAt: '2026-01-01T00:00:00Z' }] });
        history.complete();

        expect(historyComponent.messages.map(message => message.id)).toEqual(['history', 'live']);
        historyComponent.ngOnDestroy();
    });

    it('reorders a background conversation and increments its unread count', () => {
        const historyComponent = createHomeComponent({ history: () => of({ messages: [{ id: 'background-message', conversationId: 'background', senderId: 'user-background', clientMessageId: 'background-message', sequence: 1, body: 'New message', createdAt: '2026-01-02T00:00:00Z' }] }) } as unknown as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { send: vi.fn().mockName('send').mockReturnValue(true), close: () => undefined } as unknown as DataProviderService, { close: () => undefined } as CallFacade);
        const selected = conversation('selected');
        const background = conversation('background');
        historyComponent.selectedConversation = selected;
        historyComponent.conversations.next([selected, background]);
        historyComponent.socketReady = true;

        historyComponent.handleSocketEvent({
            version: WEBSOCKET_PROTOCOL_VERSION,
            type: 'message.created',
            payload: { id: 'message-1', conversation_id: 'background', sender_id: 'user-2', client_message_id: 'message-1', sequence: 1, body: 'New message', created_at: '2026-01-02T00:00:00Z' },
        });

        expect(historyComponent.conversations.getValue().map(item => item.id)).toEqual(['background', 'selected']);
        expect(historyComponent.conversations.getValue()[0].unreadCount).toBe(1);
        expect(historyComponent.conversations.getValue()[0].lastMessageAt).toBe('2026-01-02T00:00:00Z');

        historyComponent.selectConversation(historyComponent.conversations.getValue()[0]);

        expect(historyComponent.conversations.getValue()[0].unreadCount).toBe(0);
    });

    it('restores a saved conversation after the conversation list loads', () => {
        const savedConversation = conversation('saved');
        const historyComponent = createHomeComponent({ history: () => of({ messages: [] }) } as unknown as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, {} as DataProviderService, { close: () => undefined } as CallFacade);
        window.localStorage.setItem('zwei_selected_conversation', savedConversation.id);

        (historyComponent as unknown as {
            restoreSelectedConversation(conversations: Conversation[]): void;
        }).restoreSelectedConversation([savedConversation]);

        expect(historyComponent.selectedConversation?.id).toBe(savedConversation.id);
        expect(window.localStorage.getItem('zwei_selected_conversation')).toBe(savedConversation.id);
    });

    it('restores a saved conversation without minimizing a call that became active while the initial list was pending', () => {
        const savedConversation = conversation('saved-during-call');
        const pendingConversations = new Subject<Conversation[]>();
        const callStates = new BehaviorSubject<CallState>({phase: 'idle'} as CallState);
        const call = {
            get state() { return callStates.value; },
            state$: callStates.asObservable(),
            close: () => undefined,
        } as unknown as CallFacade;
        const home = createHomeComponent(
            {list: () => pendingConversations.asObservable(), history: () => of({messages: []})} as unknown as ConversationService,
            {profile: () => of({id: 'user-me'} as Profile)} as AuthService,
            {markForCheck: vi.fn().mockName('markForCheck')} as unknown as ChangeDetectorRef,
            {getObservable: () => NEVER, connectionStateChanges: new BehaviorSubject<'offline' | 'connecting' | 'recovering' | 'ready' | 'failed'>('offline'), close: () => undefined} as unknown as DataProviderService,
            call,
        );
        window.localStorage.setItem('zwei_selected_conversation', savedConversation.id);
        home.ngOnInit();

        callStates.next({...callStates.value, phase: 'active', conversationID: savedConversation.id});
        pendingConversations.next([savedConversation]);

        expect(home.selectedConversation?.id).toBe(savedConversation.id);
        expect(home.isCallSurfaceVisible()).toBe(true);
        expect(home.isCallMinimized()).toBe(false);
        window.localStorage.removeItem('zwei_selected_conversation');
        home.ngOnDestroy();
    });

    it('removes a saved conversation that is no longer available', () => {
        const historyComponent = createHomeComponent({} as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, {} as DataProviderService, { close: () => undefined } as CallFacade);
        window.localStorage.setItem('zwei_selected_conversation', 'missing');

        (historyComponent as unknown as {
            restoreSelectedConversation(conversations: Conversation[]): void;
        }).restoreSelectedConversation([]);

        expect(window.localStorage.getItem('zwei_selected_conversation')).toBeNull();
    });

    it('uses presence events to show the selected peer online or offline', () => {
        const historyComponent = createHomeComponent({} as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, {} as DataProviderService, { close: () => undefined } as CallFacade);
        historyComponent.selectedConversation = conversation('peer');
        historyComponent.socketReady = true;

        expect(historyComponent.peerPresenceLabel()).toBe('Checking presence…');
        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'presence.snapshot', payload: { user_ids: ['user-peer'] } });
        expect(historyComponent.peerPresenceLabel()).toBe('Online');
        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'presence.changed', payload: { user_id: 'user-peer', online: false } });
        expect(historyComponent.peerPresenceLabel()).toBe('Offline');
    });

    it('refreshes presence when selecting a group but preserves direct selection behavior', () => {
        const send = vi.fn().mockName('send').mockReturnValue(true);
        const historyComponent = createHomeComponent({ history: () => of({ messages: [] }) } as unknown as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { send, close: () => undefined } as unknown as DataProviderService, { close: () => undefined } as CallFacade);
        historyComponent.socketReady = true;

        historyComponent.selectConversation(conversation('direct'));
        expect(send).not.toHaveBeenCalled();

        historyComponent.selectConversation(groupConversation('group'));

        expect(send).toHaveBeenCalledTimes(1);

        expect(send).toHaveBeenCalledWith({ type: 'presence.refresh' });
        historyComponent.ngOnDestroy();
    });

    it('coalesces rapid group selections into one trailing presence refresh', fakeAsync(async () => {
        const send = vi.fn().mockName('send').mockReturnValue(true);
        const historyComponent = createHomeComponent({ history: () => of({ messages: [] }) } as unknown as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { send, close: () => undefined } as unknown as DataProviderService, { close: () => undefined } as CallFacade);
        const group = groupConversation('group');
        historyComponent.socketReady = true;

        historyComponent.selectConversation(group);
        historyComponent.selectConversation(group);
        expect(send).toHaveBeenCalledTimes(1);

        await tick(1000);
        expect(send).toHaveBeenCalledTimes(2);
        historyComponent.ngOnDestroy();
    }));

    it('refreshes selected group presence when the membership projection changes', () => {
        const existing = groupConversation('group');
        const updated = { ...existing, membershipRevision: existing.membershipRevision + 1 };
        const send = vi.fn().mockName('send').mockReturnValue(true);
        const historyComponent = createHomeComponent({ history: () => of({ messages: [] }), getGroup: () => of(updated) } as unknown as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { send, close: () => undefined } as unknown as DataProviderService, { close: () => undefined } as CallFacade);
        historyComponent.socketReady = true;
        historyComponent.selectedConversation = existing;
        historyComponent.conversations.next([existing]);

        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: { conversation_id: existing.id, membership_revision: updated.membershipRevision, deleted: false } });

        expect(historyComponent.selectedConversation?.kind === 'group' && historyComponent.selectedConversation.membershipRevision).toBe(updated.membershipRevision);
        expect(send).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledWith({ type: 'presence.refresh' });
        historyComponent.ngOnDestroy();
    });

    it('quarantines a selected group and its call after a transient membership projection error', () => {
        const selected = groupConversation('selected-group');
        const abort = vi.fn().mockName('abort').mockReturnValue(true);
        const groupCall = { isOngoing: true, state: { room: { conversation_id: selected.id } }, abort } as unknown as GroupCallFacade;
        const historyComponent = createHomeComponent({ getGroup: () => throwError(() => new GroupProjectionFailureError('unavailable')) } as unknown as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, {} as DataProviderService, { close: () => undefined } as CallFacade, undefined, groupCall);
        historyComponent.selectedConversation = selected;
        historyComponent.conversations.next([selected]);

        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: { conversation_id: selected.id, membership_revision: 2, deleted: false } });

        expect(historyComponent.selectedConversation).toBeUndefined();
        expect(historyComponent.conversations.getValue()).toEqual([]);
        expect(abort).not.toHaveBeenCalled();
        expect(historyComponent.departedGroupRefreshFailed).toBe(true);
        expect(historyComponent.groupMembershipRefreshError).toBe('Could not refresh group membership. Try refreshing chats.');
    });

    it('quarantines the selected group and call after an authentication failure', () => {
        const selected = groupConversation('auth-failure-group');
        const abort = vi.fn().mockName('abort').mockReturnValue(true);
        const groupCall = { isOngoing: true, state: { room: { conversation_id: selected.id } }, abort } as unknown as GroupCallFacade;
        const historyComponent = createHomeComponent({ getGroup: () => throwError(() => new GroupProjectionFailureError('sessionExpired')) } as unknown as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, {} as DataProviderService, { close: () => undefined } as CallFacade, undefined, groupCall);
        historyComponent.selectedConversation = selected;
        historyComponent.conversations.next([selected]);

        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: { conversation_id: selected.id, membership_revision: 2, deleted: false } });
        expect(historyComponent.selectedConversation).toBeUndefined();
        expect(historyComponent.conversations.getValue()).toEqual([]);
        expect(abort).not.toHaveBeenCalled();
        expect(historyComponent.departedGroupRefreshFailed).toBe(true);
        expect(historyComponent.groupMembershipRefreshError).toBe('Your session may have expired. Reconnect or sign in again to refresh group membership.');
    });

    it('quarantines forbidden projections for retry and removes only explicit not-found projections', () => {
        for (const status of [403, 404]) {
            const selected = groupConversation(`confirmed-removal-${status}`);
            const historyComponent = createHomeComponent({ getGroup: () => throwError(() => status === 404 ? new GroupProjectionNotFoundError() : new HttpErrorResponse({ status })) } as unknown as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, {} as DataProviderService, { close: () => undefined } as CallFacade);
            historyComponent.selectedConversation = selected;
            historyComponent.conversations.next([selected]);

            historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: { conversation_id: selected.id, membership_revision: 2, deleted: false } });

            expect(historyComponent.selectedConversation).toBeUndefined();
            expect(historyComponent.conversations.getValue()).toEqual([]);
            if (status === 403) {
                expect(historyComponent['groupAccess'].isQuarantined(selected.id)).toBe(true);
                expect(historyComponent.departedGroupRefreshFailed).toBe(true);
            }
            else {
                expect(historyComponent['groupAccess'].isQuarantined(selected.id)).toBe(false);
                expect(historyComponent.departedGroupRefreshFailed).toBe(false);
            }
        }
    });

    it('refreshes a failed selected group projection and revision from Refresh chats', () => {
        const selected = groupConversation('refresh-selected-group');
        const refreshed = { ...selected, name: 'Refreshed group', membershipRevision: selected.membershipRevision + 1 };
        const list = vi.fn().mockName('list').mockReturnValue(of([refreshed]));
        const historyComponent = createHomeComponent({ getGroup: () => throwError(() => new Error('unavailable')), list, history: () => of({ messages: [] }) } as unknown as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, {} as DataProviderService, { close: () => undefined } as CallFacade);
        historyComponent.selectedConversation = selected;
        historyComponent.conversations.next([selected]);

        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: { conversation_id: selected.id, membership_revision: refreshed.membershipRevision, deleted: false } });
        expect(historyComponent.groupMembershipRefreshErrorConversationID).toBe(selected.id);

        historyComponent.refreshChats();

        expect(list).toHaveBeenCalledTimes(1);
        expect(historyComponent.selectedConversation).toEqual(refreshed);
        expect(historyComponent.groupMembershipRefreshError).toBe('');
        expect(historyComponent.groupMembershipRefreshErrorConversationID).toBeUndefined();
    });

    it('recovers a transient HTTP 500 group projection lookup through Refresh chats', () => {
        const selected = groupConversation('refresh-after-server-error');
        const refreshed = { ...selected, name: 'Recovered group', membershipRevision: selected.membershipRevision + 1 };
        const list = vi.fn().mockName('list').mockReturnValue(of([refreshed]));
        const abort = vi.fn().mockName('abort').mockReturnValue(true);
        const groupCall = { isOngoing: true, state: { room: { conversation_id: selected.id } }, abort } as unknown as GroupCallFacade;
        const historyComponent = createHomeComponent({ getGroup: () => throwError(() => new Error('unavailable')), list } as unknown as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, {} as DataProviderService, { close: () => undefined } as CallFacade, undefined, groupCall);
        historyComponent.selectedConversation = selected;
        historyComponent.conversations.next([selected]);

        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: { conversation_id: selected.id, membership_revision: refreshed.membershipRevision, deleted: false } });

        expect(historyComponent.selectedConversation).toBeUndefined();
        expect(historyComponent.conversations.getValue()).toEqual([]);
        expect(abort).not.toHaveBeenCalled();
        expect(historyComponent.departedGroupRefreshFailed).toBe(true);

        historyComponent.refreshChats();

        expect(list).toHaveBeenCalledTimes(1);
        expect(historyComponent.selectedConversation?.id).toBe(selected.id);
        expect(historyComponent.conversations.getValue()).toEqual([refreshed]);
        expect(abort).not.toHaveBeenCalled();
        expect(historyComponent.groupMembershipRefreshError).toBe('');
        expect(historyComponent.groupMembershipRefreshErrorConversationID).toBeUndefined();
    });

    it('quarantines a selected group without aborting its call when a successful chat refresh omits it', () => {
        const selected = { ...groupConversation('removed-group'), unreadCount: 4 };
        const remaining = conversation('remaining-conversation');
        const list = vi.fn().mockName('list').mockReturnValue(of([remaining]));
        const abort = vi.fn().mockName('abort').mockReturnValue(true);
        const groupCall = { isOngoing: true, state: { room: { conversation_id: selected.id } }, abort } as unknown as GroupCallFacade;
        const historyComponent = createHomeComponent({ list } as unknown as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { finishRecovery: vi.fn().mockName('finishRecovery') } as unknown as DataProviderService, { close: () => undefined } as CallFacade, undefined, groupCall);
        historyComponent.selectedConversation = selected;
        historyComponent.conversations.next([selected, remaining]);
        historyComponent.messages = [{ id: 'old-message', conversationId: selected.id, senderId: 'peer', clientMessageId: 'old-client', sequence: 3, body: 'Private history', createdAt: '2026-01-01T00:00:00Z' }];
        historyComponent.historyCursor = '2';
        historyComponent.groupCallMinimized = true;
        historyComponent.groupMembershipRefreshError = 'Stale membership';
        historyComponent.groupMembershipRefreshErrorConversationID = selected.id;

        historyComponent.refreshChats();

        expect(list).toHaveBeenCalledTimes(1);
        expect(historyComponent.selectedConversation).toBeUndefined();
        expect(historyComponent.messages).toEqual([]);
        expect(historyComponent.historyCursor).toBeUndefined();
        expect(historyComponent.isHistoryLoading).toBe(false);
        expect(historyComponent.conversations.getValue().map(item => item.id).sort()).toEqual([remaining.id, selected.id].sort());
        expect(historyComponent.conversations.getValue().find(item => item.id === selected.id)).toEqual(expect.objectContaining({name: 'Group access needs verification', accessNeedsVerification: true, members: [], unreadCount: 0}));
        expect(historyComponent.groupCallMinimized).toBe(true);
        expect(abort).not.toHaveBeenCalled();
        expect(historyComponent.groupMembershipRefreshError).toBe('Could not refresh group membership. Try refreshing chats.');
        expect(historyComponent.groupMembershipRefreshErrorConversationID).toBe(selected.id);
    });

    it('clears an absent direct conversation and its chat state without ending an active call', () => {
        const selected = { ...conversation('removed-direct'), unreadCount: 3 };
        const remaining = conversation('remaining-direct');
        const list = vi.fn().mockName('list').mockReturnValue(of([remaining]));
        const callState = { phase: 'active' };
        const closeCall = vi.fn().mockName('close');
        const historyComponent = createHomeComponent({ list } as unknown as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { finishRecovery: vi.fn().mockName('finishRecovery') } as unknown as DataProviderService, { state: callState, close: closeCall } as unknown as CallFacade);
        historyComponent.selectedConversation = selected;
        historyComponent.conversations.next([selected, remaining]);
        historyComponent.messages = [{ id: 'direct-message', conversationId: selected.id, senderId: 'peer', clientMessageId: 'direct-client', sequence: 4, body: 'Private history', createdAt: '2026-01-01T00:00:00Z' }];
        historyComponent.historyCursor = '3';
        historyComponent['ownReadSequences'].set(selected.id, 4);
        historyComponent['peerReadSequences'].set(selected.id, 2);
        historyComponent['typingConversationID'] = selected.id;

        historyComponent.refreshChats();

        expect(list).toHaveBeenCalledTimes(1);
        expect(historyComponent.selectedConversation).toBeUndefined();
        expect(historyComponent.messages).toEqual([]);
        expect(historyComponent.historyCursor).toBeUndefined();
        expect(historyComponent.isHistoryLoading).toBe(false);
        expect(historyComponent.conversations.getValue()).toEqual([remaining]);
        expect(historyComponent['ownReadSequences'].has(selected.id)).toBe(false);
        expect(historyComponent['peerReadSequences'].has(selected.id)).toBe(false);
        expect(historyComponent['typingConversationID']).toBeUndefined();
        expect(historyComponent.isOngoingCall()).toBe(true);
        expect(closeCall).not.toHaveBeenCalled();
    });

    it('preserves a selected direct conversation when chat refresh fails transiently', fakeAsync(async () => {
        const selected = conversation('temporarily-unavailable-direct');
        const list = vi.fn().mockName('list').mockReturnValue(throwError(() => new HttpErrorResponse({ status: 503 })));
        const history: Message[] = [{ id: 'retained-direct-message', conversationId: selected.id, senderId: 'peer', clientMessageId: 'retained-direct-client', sequence: 1, body: 'Still authorized until confirmed', createdAt: '2026-01-01T00:00:00Z' }];
        const historyComponent = createHomeComponent({ list } as unknown as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, {} as DataProviderService, { state: { phase: 'active' }, close: vi.fn().mockName('close') } as unknown as CallFacade);
        historyComponent.selectedConversation = selected;
        historyComponent.conversations.next([selected]);
        historyComponent.messages = history;
        historyComponent.historyCursor = '1';
        historyComponent['ownReadSequences'].set(selected.id, 1);

        historyComponent.refreshChats();
        await tick(500);

        expect(list).toHaveBeenCalledTimes(3);
        expect(historyComponent.selectedConversation).toEqual(selected);
        expect(historyComponent.messages).toEqual(history);
        expect(historyComponent.historyCursor).toBe('1');
        expect(historyComponent.conversations.getValue()).toEqual([selected]);
        expect(historyComponent['ownReadSequences'].get(selected.id)).toBe(1);
    }));

    it('preserves the prior direct and group list when a Home snapshot is rejected', fakeAsync(async () => {
        const direct = conversation('retained-direct');
        const group = groupConversation('retained-group');
        const snapshotFailure = new InvalidConversationProjectionError();
        const listHomeSnapshot = vi.fn().mockName('listHomeSnapshot').mockReturnValue(throwError(() => snapshotFailure));
        const historyComponent = createHomeComponent({listHomeSnapshot} as unknown as ConversationService, {} as AuthService, {markForCheck: vi.fn().mockName('markForCheck')} as unknown as ChangeDetectorRef, {} as DataProviderService, {close: vi.fn().mockName('close')} as unknown as CallFacade);
        historyComponent.selectedConversation = direct;
        historyComponent.conversations.next([direct, group]);

        historyComponent.refreshChats();
        await tick(500);

        expect(listHomeSnapshot).toHaveBeenCalledTimes(3);
        expect(historyComponent.conversations.getValue()).toEqual([direct, group]);
        expect(historyComponent.selectedConversation).toEqual(direct);
    }));

    it('preserves selected group, history, and call state when Refresh chats fails', fakeAsync(async () => {
        const selected = groupConversation('temporarily-unavailable-group');
        const abort = vi.fn().mockName('abort').mockReturnValue(true);
        const groupCall = { isOngoing: true, state: { room: { conversation_id: selected.id } }, abort } as unknown as GroupCallFacade;
        const historyComponent = createHomeComponent({ list: () => throwError(() => new HttpErrorResponse({ status: 503 })) } as unknown as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, {} as DataProviderService, { close: () => undefined } as CallFacade, undefined, groupCall);
        const history: Message[] = [{ id: 'retained-message', conversationId: selected.id, senderId: 'peer', clientMessageId: 'retained-client', sequence: 1, body: 'Still authorized until confirmed', createdAt: '2026-01-01T00:00:00Z' }];
        historyComponent.selectedConversation = selected;
        historyComponent.conversations.next([selected]);
        historyComponent.messages = history;
        historyComponent.historyCursor = '1';
        historyComponent.groupCallMinimized = true;

        historyComponent.refreshChats();
        await tick(500);

        expect(historyComponent.selectedConversation?.id).toBe(selected.id);
        expect(historyComponent.messages).toEqual(history);
        expect(historyComponent.historyCursor).toBe('1');
        expect(historyComponent.conversations.getValue()).toEqual([selected]);
        expect(historyComponent.groupCallMinimized).toBe(true);
        expect(abort).not.toHaveBeenCalled();
    }));

    it('preserves a selected group when conversation-created projection lookup fails transiently', () => {
        const selected = groupConversation('created-group');
        const list = vi.fn().mockName('list').mockReturnValue(of([selected]));
        const send = vi.fn().mockName('send').mockReturnValue(true);
        const historyComponent = createHomeComponent({ getGroup: () => throwError(() => new HttpErrorResponse({ status: 503 })), list } as unknown as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { send, close: () => undefined } as unknown as DataProviderService, { close: () => undefined } as CallFacade);
        historyComponent.selectedConversation = selected;
        historyComponent.conversations.next([selected]);

        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'conversation.created', payload: { conversation_id: selected.id } });

        expect(historyComponent.selectedConversation?.id).toBe(selected.id);
        expect(historyComponent.conversations.getValue().map(item => item.id)).toContain(selected.id);
        expect(historyComponent.groupMembershipRefreshErrorConversationID).toBe(selected.id);
    });

    it('clears a group typing indicator immediately on a peer stop and preserves direct stop behavior', fakeAsync(async () => {
        const historyComponent = createHomeComponent({} as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { close: () => undefined } as unknown as DataProviderService, { close: () => undefined } as CallFacade);
        historyComponent.profile = { id: 'self' } as Profile;
        const group = { ...groupConversation('group'), members: [groupMember('peer', 1)] };
        historyComponent.selectedConversation = group;
        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'typing.started', payload: { conversation_id: group.id, user_id: 'peer' } });
        expect(historyComponent.isSelectedUserTyping()).toBe(true);

        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'typing.stopped', payload: { conversation_id: group.id, user_id: 'peer' } });
        expect(historyComponent.isSelectedUserTyping()).toBe(false);

        const direct = conversation('direct');
        historyComponent.selectedConversation = direct;
        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'typing.started', payload: { conversation_id: direct.id, user_id: direct.otherUserId } });
        expect(historyComponent.isSelectedUserTyping()).toBe(true);
        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'typing.stopped', payload: { conversation_id: direct.id, user_id: direct.otherUserId } });
        expect(historyComponent.isSelectedUserTyping()).toBe(false);
        await tick(5001);
        historyComponent.ngOnDestroy();
    }));

    it('names authorized group typers independently and clears their state on stop, expiry, or conversation switch', fakeAsync(async () => {
        const firstGroup = { ...groupConversation('group-one'), members: [
                { ...groupMember('alice', 1), displayName: 'Alice' },
                { ...groupMember('bob', 1), displayName: 'Bob' },
                { ...groupMember('carol', 1), displayName: 'Carol' },
            ] };
        const historyComponent = createHomeComponent({ history: () => of({ messages: [] }) } as unknown as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { send: vi.fn().mockName('send').mockReturnValue(true), close: () => undefined } as unknown as DataProviderService, { close: () => undefined } as CallFacade);
        historyComponent.profile = { id: 'self' } as Profile;
        historyComponent.selectedConversation = firstGroup;
        historyComponent.conversations.next([firstGroup]);

        const typing = (type: 'typing.started' | 'typing.stopped', conversationID: string, userID: string): void => {
            historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type, payload: { conversation_id: conversationID, user_id: userID } });
        };
        typing('typing.started', firstGroup.id, 'self');
        typing('typing.started', firstGroup.id, 'unknown');
        typing('typing.started', 'unselected-conversation', 'alice');
        expect(historyComponent.typingIndicatorText()).toBeUndefined();

        typing('typing.started', firstGroup.id, 'alice');
        expect(historyComponent.typingIndicatorText()).toBe('Alice is typing…');
        typing('typing.started', firstGroup.id, 'bob');
        expect(historyComponent.typingIndicatorText()).toBe('Alice and Bob are typing…');
        typing('typing.started', firstGroup.id, 'carol');
        expect(historyComponent.typingIndicatorText()).toBe('Alice, Bob, and Carol are typing…');
        typing('typing.stopped', firstGroup.id, 'alice');
        expect(historyComponent.typingIndicatorText()).toBe('Bob and Carol are typing…');

        historyComponent.selectConversation({ ...groupConversation('group-two'), members: [
                { ...groupMember('alice', 1), displayName: 'Alice' },
                { ...groupMember('bob', 1), displayName: 'Bob' },
            ] });
        expect(historyComponent.isSelectedUserTyping()).toBe(false);
        expect(historyComponent.typingIndicatorText()).toBeUndefined();

        historyComponent.selectConversation(firstGroup);
        typing('typing.started', firstGroup.id, 'alice');
        await tick(2500);
        typing('typing.started', firstGroup.id, 'bob');
        await tick(2500);
        expect(historyComponent.typingIndicatorText()).toBe('Bob is typing…');
        await tick(2500);
        expect(historyComponent.isSelectedUserTyping()).toBe(false);

        historyComponent.selectConversation(firstGroup);
        typing('typing.started', firstGroup.id, 'alice');
        typing('typing.started', firstGroup.id, 'carol');
        expect(historyComponent.typingIndicatorText()).toBe('Alice and Carol are typing…');
        historyComponent.selectedConversation = {
            ...firstGroup,
            membershipRevision: 2,
            members: firstGroup.members.filter(member => member.userId !== 'carol'),
        };
        expect(historyComponent.typingIndicatorText()).toBe('Alice is typing…');
        historyComponent.ngOnDestroy();
    }));

    it('clears group typing timers on realtime recovery and component destruction', fakeAsync(async () => {
        const connectionStateChanges = new BehaviorSubject<'ready' | 'recovering'>('ready');
        const group = { ...groupConversation('recovering-group'), members: [
                { ...groupMember('alice', 1), displayName: 'Alice' },
                { ...groupMember('bob', 1), displayName: 'Bob' },
            ] };
        const historyComponent = createHomeComponent({ list: () => NEVER } as unknown as ConversationService, { profile: () => of({ id: 'self' } as Profile) } as unknown as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { getObservable: () => NEVER, connectionStateChanges, send: () => true, close: () => undefined } as unknown as DataProviderService, { state$: NEVER, close: () => undefined } as unknown as CallFacade);
        historyComponent.ngOnInit();
        historyComponent.profile = { id: 'self' } as Profile;
        historyComponent.selectedConversation = group;

        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'typing.started', payload: { conversation_id: group.id, user_id: 'alice' } });
        expect(historyComponent.typingIndicatorText()).toBe('Alice is typing…');
        expect((historyComponent as unknown as {
            groupTypingTimeouts: Map<string, number>;
        }).groupTypingTimeouts.size).toBe(1);

        connectionStateChanges.next('recovering');
        expect(historyComponent.typingIndicatorText()).toBeUndefined();
        expect((historyComponent as unknown as {
            groupTypingTimeouts: Map<string, number>;
        }).groupTypingTimeouts.size).toBe(0);

        connectionStateChanges.next('ready');
        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'typing.started', payload: { conversation_id: group.id, user_id: 'bob' } });
        expect(historyComponent.typingIndicatorText()).toBe('Bob is typing…');
        historyComponent.ngOnDestroy();
        expect((historyComponent as unknown as {
            groupTypingTimeouts: Map<string, number>;
        }).groupTypingTimeouts.size).toBe(0);
        await tick(5001);
        connectionStateChanges.complete();
    }));

    it('refreshes peer presence when a new conversation is delivered', () => {
        const send = vi.fn().mockName('send').mockReturnValue(true);
        const list = vi.fn().mockName('list').mockReturnValue(of([conversation('new')]));
        const historyComponent = createHomeComponent({ list } as unknown as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { send } as unknown as DataProviderService, { close: () => undefined } as CallFacade);
        historyComponent.selectedConversation = conversation('new');
        historyComponent.socketReady = true;
        historyComponent.presenceReady = true;

        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'conversation.created', payload: { conversation_id: 'new' } });
        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'presence.snapshot', payload: { user_ids: ['user-new'] } });

        expect(send).toHaveBeenCalledWith({ type: 'presence.refresh' });
        expect(historyComponent.peerPresenceLabel()).toBe('Online');
    });

    it('retries a failed conversation refresh after a conversation-created event', fakeAsync(async () => {
        const list = vi.fn().mockName('list').mockReturnValueOnce(throwError(() => new Error('temporary failure'))).mockReturnValueOnce(of([conversation('new')]));
        const historyComponent = createHomeComponent({ list } as unknown as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { send: vi.fn().mockName('send').mockReturnValue(true), close: () => undefined } as unknown as DataProviderService, { close: () => undefined } as CallFacade);

        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'conversation.created', payload: { conversation_id: 'new' } });
        await tick(250);

        expect(list).toHaveBeenCalledTimes(2);
        expect(historyComponent.conversations.getValue().map(item => item.id)).toEqual(['new']);
        historyComponent.ngOnDestroy();
    }));

    it('uses the initial conversation list to complete first realtime recovery', () => {
        const connectionStateChanges = new BehaviorSubject<'offline' | 'connecting' | 'recovering' | 'ready' | 'failed'>('offline');
        const list = vi.fn().mockName('list').mockReturnValue(of([conversation('recovered')]));
        const finishRecovery = vi.fn().mockName('finishRecovery');
        const historyComponent = createHomeComponent({ list } as unknown as ConversationService, { profile: () => of({ id: 'user-1' } as Profile) } as unknown as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { getObservable: () => EMPTY, connectionStateChanges, finishRecovery, close: () => undefined } as unknown as DataProviderService, { state$: of({ phase: 'idle' }), close: () => undefined } as unknown as CallFacade);

        historyComponent.ngOnInit();
        connectionStateChanges.next('recovering');
        connectionStateChanges.next('ready');

        expect(list).toHaveBeenCalledTimes(1);
        expect(historyComponent.conversations.getValue().map(item => item.id)).toEqual(['recovered']);
        expect(finishRecovery).toHaveBeenCalledTimes(1);
        historyComponent.ngOnDestroy();
    });

    it('refreshes authorized presence when a group selected before readiness reaches ready', () => {
        const connectionStateChanges = new BehaviorSubject<'offline' | 'connecting' | 'recovering' | 'ready' | 'failed'>('offline');
        const send = vi.fn().mockName('send').mockReturnValue(true);
        const historyComponent = createHomeComponent({ list: () => of([]), history: () => of({ messages: [] }) } as unknown as ConversationService, { profile: () => of({ id: 'user-1' } as Profile) } as unknown as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { getObservable: () => EMPTY, connectionStateChanges, send, close: () => undefined } as unknown as DataProviderService, { state$: of({ phase: 'idle' }), close: () => undefined } as unknown as CallFacade);
        historyComponent.ngOnInit();
        historyComponent.selectConversation(groupConversation('selected-group'));

        expect(send).not.toHaveBeenCalled();

        connectionStateChanges.next('ready');

        expect(send).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledWith({ type: 'presence.refresh' });
        historyComponent.ngOnDestroy();
    });

    it('retries an empty initial conversation projection before rendering the rail', fakeAsync(async () => {
        const connectionStateChanges = new BehaviorSubject<'offline' | 'connecting' | 'recovering' | 'ready' | 'failed'>('offline');
        const list = vi.fn().mockName('list').mockReturnValueOnce(of([])).mockReturnValueOnce(of([conversation('bob')]));
        const historyComponent = createHomeComponent({ list } as unknown as ConversationService, { profile: () => of({ id: 'user-1' } as Profile) } as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { getObservable: () => EMPTY, connectionStateChanges, close: () => undefined } as unknown as DataProviderService, { state$: of({ phase: 'idle' }), close: () => undefined } as unknown as CallFacade);

        historyComponent.ngOnInit();
        await tick(250);

        expect(list).toHaveBeenCalledTimes(2);
        expect(historyComponent.conversations.getValue().map(item => item.id)).toEqual(['bob']);
        historyComponent.ngOnDestroy();
    }));

    it('keeps the recovery conversation list when presence completes recovery first', () => {
        const connectionStateChanges = new BehaviorSubject<'offline' | 'connecting' | 'recovering' | 'ready' | 'failed'>('offline');
        const recoveryList = new Subject<Conversation[]>();
        const list = vi.fn().mockName('list').mockReturnValueOnce(of([])).mockReturnValueOnce(recoveryList.asObservable());
        const historyComponent = createHomeComponent({ list } as unknown as ConversationService, { profile: () => of({ id: 'user-1' } as Profile) } as unknown as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { getObservable: () => EMPTY, connectionStateChanges, finishRecovery: vi.fn().mockName('finishRecovery'), close: () => undefined } as unknown as DataProviderService, { state$: of({ phase: 'idle' }), close: () => undefined } as unknown as CallFacade);

        historyComponent.ngOnInit();
        connectionStateChanges.next('ready');
        connectionStateChanges.next('recovering');
        connectionStateChanges.next('ready');
        recoveryList.next([conversation('bob')]);
        recoveryList.complete();

        expect(historyComponent.conversations.getValue().map(item => item.id)).toEqual(['bob']);
        historyComponent.ngOnDestroy();
    });

    it('keeps the recovery conversation list when a conversation is selected during recovery', () => {
        const connectionStateChanges = new BehaviorSubject<'offline' | 'connecting' | 'recovering' | 'ready' | 'failed'>('offline');
        const recoveryList = new Subject<Conversation[]>();
        const selected = conversation('alice');
        const list = vi.fn().mockName('list').mockReturnValueOnce(of([])).mockReturnValueOnce(recoveryList.asObservable());
        const historyComponent = createHomeComponent({ list, history: () => of({ messages: [] }) } as unknown as ConversationService, { profile: () => of({ id: 'user-1' } as Profile) } as unknown as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { getObservable: () => EMPTY, connectionStateChanges, recover: vi.fn().mockName('recover').mockReturnValue(true), close: () => undefined } as unknown as DataProviderService, { state$: of({ phase: 'idle' }), close: () => undefined } as unknown as CallFacade);

        historyComponent.ngOnInit();
        connectionStateChanges.next('ready');
        connectionStateChanges.next('recovering');
        historyComponent.selectConversation(selected);
        recoveryList.next([selected]);
        recoveryList.complete();

        expect(historyComponent.selectedConversation?.id).toBe(selected.id);
        expect(historyComponent.conversations.getValue().map(item => item.id)).toEqual([selected.id]);
        historyComponent.ngOnDestroy();
    });

    it('falls back to HTTP history when the active reconciliation is rejected', () => {
        const selected = conversation('alice');
        const history = vi.fn().mockName('history').mockReturnValue(of({ messages: [] }));
        const connectionStateChanges = new BehaviorSubject<'offline' | 'connecting' | 'recovering' | 'ready' | 'failed'>('offline');
        let reconciliationRequestID = '';
        const historyComponent = createHomeComponent({ list: vi.fn().mockName('list').mockReturnValueOnce(of([])).mockReturnValueOnce(of([selected])), history } as unknown as ConversationService, { profile: () => of({ id: 'user-1' } as Profile) } as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { getObservable: () => EMPTY, connectionStateChanges, recover: (_conversationID: string, _afterSequence: number, requestID: string) => { reconciliationRequestID = requestID; return true; }, close: () => undefined } as unknown as DataProviderService, { state$: of({ phase: 'idle' }), close: () => undefined } as unknown as CallFacade);
        historyComponent.ngOnInit();
        historyComponent.selectConversation(selected);
        connectionStateChanges.next('ready');
        connectionStateChanges.next('recovering');
        const historyLoadsBeforeRejection = vi.mocked(history).mock.calls.length;

        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'message.rejected', request_id: reconciliationRequestID, payload: { error: 'conversation not found' } });

        expect(vi.mocked(history).mock.calls.length).toBe(historyLoadsBeforeRejection + 1);
        historyComponent.ngOnDestroy();
    });

    it('uses the incoming call conversation when no chat is selected', () => {
        const incoming = conversation('incoming');
        const historyComponent = createHomeComponent({} as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, {} as DataProviderService, { state: { phase: 'incoming', conversationID: incoming.id }, close: () => undefined } as unknown as CallFacade);
        historyComponent.conversations.next([incoming]);

        expect(historyComponent.callDisplayName()).toBe('incoming');
        expect(historyComponent.callInitials()).toBe('IN');
        expect(historyComponent.headerDisplayName()).toBe('incoming');
        expect(historyComponent.headerInitials()).toBe('IN');
    });

    it('renders the selected chat header while an active call is minimized', () => {
        const callConversation = conversation('call-peer');
        const selectedConversation = conversation('other-peer');
        const historyComponent = createHomeComponent({} as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, {} as DataProviderService, { state: { phase: 'active', conversationID: callConversation.id }, close: () => undefined } as unknown as CallFacade);
        historyComponent.conversations.next([callConversation, selectedConversation]);
        historyComponent.selectedConversation = selectedConversation;

        expect(historyComponent.callDisplayName()).toBe('call-peer');
        expect(historyComponent.headerDisplayName()).toBe('other-peer');
        expect(historyComponent.headerInitials()).toBe('OT');
    });

    it('minimizes an active call when another conversation is selected and preserves it when restored', () => {
        const callConversation = conversation('call-peer');
        const selectedConversation = conversation('other-peer');
        const historyComponent = createHomeComponent({ history: () => of({ messages: [] }) } as unknown as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, {} as DataProviderService, { state: { phase: 'active', conversationID: callConversation.id }, close: () => undefined } as unknown as CallFacade);
        historyComponent.conversations.next([callConversation, selectedConversation]);
        historyComponent.selectedConversation = callConversation;

        historyComponent.selectConversation(selectedConversation);

        expect(historyComponent.isCallMinimized()).toBe(true);
        expect(historyComponent.selectedConversation?.id).toBe(selectedConversation.id);

        historyComponent.restoreCall();

        expect(historyComponent.isCallSurfaceVisible()).toBe(true);
        expect(historyComponent.selectedConversation?.id).toBe(callConversation.id);
    });

    it('selects the caller conversation when an incoming call arrives', () => {
        const incoming = conversation('incoming');
        const historyComponent = createHomeComponent({ history: () => of({ messages: [] }) } as unknown as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, {} as DataProviderService, { close: () => undefined } as CallFacade);
        historyComponent.conversations.next([incoming]);

        historyComponent.handleSocketEvent({
            version: WEBSOCKET_PROTOCOL_VERSION,
            type: 'call.incoming',
            payload: { call_id: 'call-1', conversation_id: incoming.id, caller_id: incoming.otherUserId, recipient_id: 'user-me', caller_device_id: 'device-1', status: 'ringing', expires_at: '2026-01-01T00:00:30Z' },
        });

        expect(historyComponent.selectedConversation?.id).toBe(incoming.id);
    });

    it('keeps the active call surface visible when its incoming conversation arrives after the call becomes active', () => {
        const incoming = conversation('delayed-incoming');
        const pendingConversations = new Subject<Conversation[]>();
        const callStates = new BehaviorSubject<CallState>({phase: 'idle'} as CallState);
        const call = {
            get state() { return callStates.value; },
            state$: callStates.asObservable(),
            close: () => undefined,
        } as unknown as CallFacade;
        const home = createHomeComponent(
            {list: () => pendingConversations.asObservable(), history: () => of({messages: []})} as unknown as ConversationService,
            {profile: () => of({id: 'user-me'} as Profile)} as AuthService,
            {markForCheck: vi.fn().mockName('markForCheck')} as unknown as ChangeDetectorRef,
            {getObservable: () => NEVER, connectionStateChanges: new BehaviorSubject<'offline' | 'connecting' | 'recovering' | 'ready' | 'failed'>('offline'), close: () => undefined} as unknown as DataProviderService,
            call,
        );
        home.ngOnInit();

        home.handleSocketEvent({
            version: WEBSOCKET_PROTOCOL_VERSION,
            type: 'call.incoming',
            payload: {call_id: 'call-delayed', conversation_id: incoming.id, caller_id: incoming.otherUserId, recipient_id: 'user-me', caller_device_id: 'device-1', status: 'ringing', expires_at: '2026-01-01T00:00:30Z'},
        });
        callStates.next({...callStates.value, phase: 'active', conversationID: incoming.id});

        pendingConversations.next([incoming]);

        expect(home.selectedConversation?.id).toBe(incoming.id);
        expect(home.isCallSurfaceVisible()).toBe(true);
        expect(home.isCallMinimized()).toBe(false);
        home.ngOnDestroy();
    });

    it('does not override explicit navigation made while the incoming conversation list is pending', () => {
        const incoming = conversation('delayed-incoming');
        const other = conversation('explicitly-selected');
        const pendingConversations = new Subject<Conversation[]>();
        const callStates = new BehaviorSubject<CallState>({phase: 'idle'} as CallState);
        const call = {
            get state() { return callStates.value; },
            state$: callStates.asObservable(),
            close: () => undefined,
        } as unknown as CallFacade;
        const home = createHomeComponent(
            {list: () => pendingConversations.asObservable(), history: () => of({messages: []})} as unknown as ConversationService,
            {profile: () => of({id: 'user-me'} as Profile)} as AuthService,
            {markForCheck: vi.fn().mockName('markForCheck')} as unknown as ChangeDetectorRef,
            {getObservable: () => NEVER, connectionStateChanges: new BehaviorSubject<'offline' | 'connecting' | 'recovering' | 'ready' | 'failed'>('offline'), close: () => undefined} as unknown as DataProviderService,
            call,
        );
        home.ngOnInit();

        home.handleSocketEvent({
            version: WEBSOCKET_PROTOCOL_VERSION,
            type: 'call.incoming',
            payload: {call_id: 'call-delayed', conversation_id: incoming.id, caller_id: incoming.otherUserId, recipient_id: 'user-me', caller_device_id: 'device-1', status: 'ringing', expires_at: '2026-01-01T00:00:30Z'},
        });
        callStates.next({...callStates.value, phase: 'active', conversationID: incoming.id});
        home.selectConversation(other);

        pendingConversations.next([incoming, other]);

        expect(home.selectedConversation?.id).toBe(other.id);
        expect(home.isCallMinimized()).toBe(true);
        expect(home.isCallSurfaceVisible()).toBe(false);
        expect(home.isOngoingCall()).toBe(true);
        home.ngOnDestroy();
    });

    it('retires pending incoming selection when the call becomes terminal', () => {
        const incoming = conversation('terminal-incoming');
        const home = createHomeComponent(
            {history: () => of({messages: []})} as unknown as ConversationService,
            {} as AuthService,
            {markForCheck: vi.fn().mockName('markForCheck')} as unknown as ChangeDetectorRef,
            {} as DataProviderService,
            {state: {phase: 'incoming'}, close: () => undefined} as unknown as CallFacade,
        );
        home.handleSocketEvent({
            version: WEBSOCKET_PROTOCOL_VERSION,
            type: 'call.incoming',
            payload: {call_id: 'call-terminal', conversation_id: incoming.id, caller_id: incoming.otherUserId, recipient_id: 'user-me', caller_device_id: 'device-1', status: 'ringing', expires_at: '2026-01-01T00:00:30Z'},
        });
        (home as unknown as {handleCallState(state: CallState): void}).handleCallState({phase: 'ended'} as CallState);
        home.conversations.next([incoming]);

        const selectPending = (home as unknown as {selectPendingIncomingCallConversation(conversationListResolved?: boolean): void}).selectPendingIncomingCallConversation;
        selectPending.call(home, true);

        expect(home.selectedConversation).toBeUndefined();
    });

    it('clears the same conversation unread count for every user device', () => {
        const historyComponent = createHomeComponent({} as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, {} as DataProviderService, { close: () => undefined } as CallFacade);
        historyComponent.profile = { id: 'user-me' } as Profile;
        historyComponent.conversations.next([{ ...conversation('background'), unreadCount: 3 }]);

        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'conversation.read', payload: { conversation_id: 'background', user_id: 'user-me', sequence: 4 } });

        expect(historyComponent.conversations.getValue()[0].unreadCount).toBe(0);
    });

    it('excludes group members who joined after an outgoing message', () => {
        const group = groupConversation('group-read') as GroupConversation;
        group.members = [groupMember('user-me', 1), groupMember('later-member', 5)];
        const historyComponent = createHomeComponent({} as ConversationService, {} as AuthService, { markForCheck: () => undefined } as ChangeDetectorRef, {} as DataProviderService, { close: () => undefined } as CallFacade);
        historyComponent.profile = { id: 'user-me' } as Profile;
        historyComponent.selectedConversation = group;
        historyComponent.conversations.next([group]);
        historyComponent.messages = [ownMessage(group.id, 4)];
        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'conversation.read', payload: { conversation_id: group.id, user_id: 'later-member', sequence: 9, visible_from_sequence: 1 } });

        expect(historyComponent.isLatestReadMessage(historyComponent.messages[0])).toBe(false);
        expect(historyComponent.readReceiptLabel(historyComponent.messages[0])).toBe('Read by at least one member');
    });

    it('ignores inactive group members and marks only the latest qualifying outgoing message as cursors advance', () => {
        const group = groupConversation('group-read') as GroupConversation;
        group.members = [groupMember('user-me', 1), groupMember('member-a', 1), groupMember('member-b', 1)];
        const historyComponent = createHomeComponent({} as ConversationService, {} as AuthService, { markForCheck: () => undefined } as ChangeDetectorRef, {} as DataProviderService, { close: () => undefined } as CallFacade);
        historyComponent.profile = { id: 'user-me' } as Profile;
        historyComponent.selectedConversation = group;
        historyComponent.conversations.next([group]);
        historyComponent.messages = [ownMessage(group.id, 2), ownMessage(group.id, 4), ownMessage(group.id, 6)];
        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'conversation.read', payload: { conversation_id: group.id, user_id: 'member-a', sequence: 4, visible_from_sequence: 1 } });
        expect(historyComponent.isLatestReadMessage(historyComponent.messages[1])).toBe(true);
        expect(historyComponent.isLatestReadMessage(historyComponent.messages[0])).toBe(false);

        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'conversation.read', payload: { conversation_id: group.id, user_id: 'member-a', sequence: 6, visible_from_sequence: 1 } });
        expect(historyComponent.isLatestReadMessage(historyComponent.messages[2])).toBe(true);
        expect(historyComponent.isLatestReadMessage(historyComponent.messages[1])).toBe(false);

        group.members = group.members.filter(member => member.userId !== 'member-a');
        expect(historyComponent.isLatestReadMessage(historyComponent.messages[2])).toBe(false);
        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'conversation.read', payload: { conversation_id: group.id, user_id: 'member-b', sequence: 6, visible_from_sequence: 1 } });
        expect(historyComponent.isLatestReadMessage(historyComponent.messages[2])).toBe(true);
    });

    it('shows no group receipt without peer cursors while preserving direct peer receipts', () => {
        const group = groupConversation('group-read') as GroupConversation;
        group.members = [groupMember('user-me', 1), groupMember('member-a', 1)];
        const direct = conversation('direct-read');
        const historyComponent = createHomeComponent({} as ConversationService, {} as AuthService, { markForCheck: () => undefined } as ChangeDetectorRef, {} as DataProviderService, { close: () => undefined } as CallFacade);
        historyComponent.profile = { id: 'user-me' } as Profile;
        historyComponent.selectedConversation = group;
        historyComponent.conversations.next([group, direct]);
        const groupMessage = ownMessage(group.id, 3);
        const directMessage = ownMessage(direct.id, 3);
        historyComponent.messages = [groupMessage, directMessage];
        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'conversation.read', payload: { conversation_id: group.id, user_id: 'member-a', sequence: 3 } });
        expect(historyComponent.isLatestReadMessage(groupMessage)).toBe(false);
        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'conversation.read', payload: { conversation_id: direct.id, user_id: direct.otherUserId, sequence: 3 } });
        expect(historyComponent.isLatestReadMessage(directMessage)).toBe(true);
        expect(historyComponent.readReceiptLabel(directMessage)).toBe('Read by peer');
    });

    it('applies reconciliation account cursors monotonically without using the group scalar', () => {
        const group = groupConversation('group-read') as GroupConversation;
        group.members = [groupMember('user-me', 1), groupMember('member-a', 1), groupMember('member-b', 1)];
        const historyComponent = createHomeComponent({} as ConversationService, {} as AuthService, { markForCheck: () => undefined } as ChangeDetectorRef, {} as DataProviderService, { close: () => undefined } as CallFacade);
        historyComponent.profile = { id: 'user-me' } as Profile;
        historyComponent.selectedConversation = group;
        historyComponent.conversations.next([group]);
        historyComponent.messages = [ownMessage(group.id, 3)];
        (historyComponent as unknown as {
            recoveryGeneration: number;
            reconciliationRequest: unknown;
        }).recoveryGeneration = 2;
        (historyComponent as unknown as {
            reconciliationRequest: unknown;
        }).reconciliationRequest = { generation: 2, requestID: 'reconcile-group', conversationID: group.id };
        const payload = { ...reconciliationPayload(group.id, 3), messages: [], has_more: false, peer_read_sequence: 0, peer_read_cursors: [
                { user_id: 'member-a', sequence: 3, visible_from_sequence: 1 },
                { user_id: 'member-b', sequence: 2, visible_from_sequence: 1 },
            ] };

        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'conversation.reconciled', request_id: 'reconcile-group', payload });

        expect(historyComponent.isLatestReadMessage(historyComponent.messages[0])).toBe(true);
        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'conversation.read', payload: { conversation_id: group.id, user_id: 'member-a', sequence: 1, visible_from_sequence: 1 } });
        expect(historyComponent.isLatestReadMessage(historyComponent.messages[0])).toBe(true);
    });

    it('shows an unread badge for an incoming message while the call surface is open', () => {
        const send = vi.fn().mockName('send').mockReturnValue(true);
        const selected = conversation('selected');
        const historyComponent = createHomeComponent({} as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { send } as unknown as DataProviderService, { state: { phase: 'active', conversationID: selected.id }, close: () => undefined } as unknown as CallFacade);
        historyComponent.profile = { id: 'user-me' } as Profile;
        historyComponent.selectedConversation = selected;
        historyComponent.conversations.next([selected]);
        historyComponent.socketReady = true;

        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'message.created', payload: { id: 'call-message', conversation_id: selected.id, sender_id: selected.otherUserId, client_message_id: 'call-message', sequence: 2, body: 'While calling', created_at: '2026-01-01T00:00:02Z' } });

        expect(historyComponent.conversations.getValue()[0].unreadCount).toBe(1);
        expect(send).not.toHaveBeenCalledWith({ type: 'conversation.read', payload: { conversation_id: selected.id, sequence: 2 } });
    });

    it('marks call-time messages read when the call is minimized', () => {
        const send = vi.fn().mockName('send').mockReturnValue(true);
        const selected = conversation('selected');
        const historyComponent = createHomeComponent({} as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { send } as unknown as DataProviderService, { state: { phase: 'active', conversationID: selected.id }, close: () => undefined } as unknown as CallFacade);
        historyComponent.profile = { id: 'user-me' } as Profile;
        historyComponent.selectedConversation = selected;
        historyComponent.conversations.next([{ ...selected, unreadCount: 1 }]);
        historyComponent.messages = [{ id: 'call-message', conversationId: selected.id, senderId: selected.otherUserId, clientMessageId: 'call-message', sequence: 2, body: 'While calling', createdAt: '2026-01-01T00:00:02Z' }];
        historyComponent.socketReady = true;

        historyComponent.minimizeCall();

        expect(send).toHaveBeenCalledWith({ type: 'conversation.read', payload: { conversation_id: selected.id, sequence: 2 } });
        expect(historyComponent.conversations.getValue()[0].unreadCount).toBe(0);
    });

    it('refreshes typing while composing so the peer indicator does not expire', fakeAsync(async () => {
        const send = vi.fn().mockName('send').mockReturnValue(true);
        const historyComponent = createHomeComponent({} as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { send, close: () => undefined } as unknown as DataProviderService, { close: () => undefined } as CallFacade);
        historyComponent.selectedConversation = conversation('peer');
        historyComponent.socketReady = true;
        historyComponent.draft = 'First';

        historyComponent.onDraftChange();
        await tick(1200);
        historyComponent.draft = 'First continued';
        historyComponent.onDraftChange();

        expect(send).toHaveBeenCalledTimes(2);
        expect(vi.mocked(send).mock.calls).toEqual([
            [{ type: 'typing.start', payload: { conversation_id: 'peer' } }],
            [{ type: 'typing.start', payload: { conversation_id: 'peer' } }],
        ]);
        historyComponent.ngOnDestroy();
    }));

    it('stops typing in the old group before switching and cancels its delayed stop', fakeAsync(async () => {
        const send = vi.fn().mockName('send').mockReturnValue(true);
        const historyComponent = createHomeComponent({ history: () => of({ messages: [] }) } as unknown as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { send, close: () => undefined } as unknown as DataProviderService, { close: () => undefined } as CallFacade);
        const oldGroup = groupConversation('old-group');
        const newGroup = groupConversation('new-group');
        historyComponent.selectedConversation = oldGroup;
        historyComponent.socketReady = true;
        historyComponent.draft = 'typing';
        historyComponent.onDraftChange();

        historyComponent.selectConversation(newGroup);
        await tick(2001);

        expect(vi.mocked(send).mock.calls.filter(([event]) => event.type === 'typing.start' || event.type === 'typing.stop')).toEqual([
            [{ type: 'typing.start', payload: { conversation_id: oldGroup.id } }],
            [{ type: 'typing.stop', payload: { conversation_id: oldGroup.id } }],
        ]);
        expect(historyComponent.selectedConversation?.id).toBe(newGroup.id);
        historyComponent.ngOnDestroy();
    }));

    it('sends typing.stop to the original conversation exactly once before closing realtime on destroy', () => {
        const send = vi.fn().mockName('send').mockReturnValue(true);
        const close = vi.fn().mockName('close');
        const historyComponent = createHomeComponent({} as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { send, close } as unknown as DataProviderService, { close: () => undefined } as CallFacade);
        historyComponent.selectedConversation = groupConversation('typing-conversation');
        historyComponent.socketReady = true;
        historyComponent.draft = 'typing';
        historyComponent.onDraftChange();

        historyComponent.selectedConversation = groupConversation('different-conversation');
        historyComponent.ngOnDestroy();

        expect(vi.mocked(send).mock.calls.filter(([event]) => event.type === 'typing.stop')).toEqual([
            [{ type: 'typing.stop', payload: { conversation_id: 'typing-conversation' } }],
        ]);
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('keeps multiple sent messages pending until their matching acknowledgements arrive', () => {
        const historyComponent = createHomeComponent({} as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, {} as DataProviderService, { close: () => undefined } as CallFacade);
        const send = vi.fn().mockName('send').mockReturnValue(true);
        (historyComponent as unknown as {
            dataProvider: {
                send: typeof send;
                close(): void;
            };
        }).dataProvider = { send, close: () => undefined };
        historyComponent.selectedConversation = conversation('selected');
        historyComponent.profile = { id: 'user-1' } as any;
        historyComponent.socketReady = true;

        historyComponent.draft = 'First';
        historyComponent.sendMessage();
        historyComponent.draft = 'Second';
        historyComponent.sendMessage();
        expect(send).toHaveBeenCalledTimes(2);
        expect(historyComponent.messages.filter(message => message.pending)).toHaveLength(2);

        const firstRequest = vi.mocked(send).mock.calls[0][0] as {
            request_id: string;
            payload: {
                client_message_id: string;
            };
        };
        const secondRequest = vi.mocked(send).mock.calls[1][0] as {
            request_id: string;
            payload: {
                client_message_id: string;
            };
        };
        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'message.accepted', request_id: secondRequest.request_id, payload: socketMessage('message-2', secondRequest.payload.client_message_id, 'Second') });
        expect(historyComponent.messages.find(message => message.clientMessageId === secondRequest.payload.client_message_id)?.pending).toBeUndefined();
        expect(historyComponent.messages.find(message => message.clientMessageId === firstRequest.payload.client_message_id)?.pending).toBe(true);

        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'message.accepted', request_id: firstRequest.request_id, payload: socketMessage('message-1', firstRequest.payload.client_message_id, 'First') });
        expect(historyComponent.messages.some(message => message.pending)).toBe(false);
        historyComponent.ngOnDestroy();
    });

    it('retains the draft and avoids optimistic UI when message enqueue fails', () => {
        const historyComponent = createHomeComponent({} as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, {} as DataProviderService, { close: () => undefined } as CallFacade);
        const send = vi.fn().mockName('send').mockReturnValue(false);
        (historyComponent as unknown as {
            dataProvider: {
                send: typeof send;
                close(): void;
            };
        }).dataProvider = { send, close: () => undefined };
        historyComponent.selectedConversation = conversation('selected');
        historyComponent.profile = { id: 'user-1' } as Profile;
        historyComponent.socketReady = true;
        historyComponent.draft = 'Retry this message';

        historyComponent.sendMessage();

        expect(historyComponent.draft).toBe('Retry this message');
        expect(historyComponent.messages).toEqual([]);
        expect(historyComponent.sendStatus).toBe('Secure connection was lost. Refresh to reconnect.');
        historyComponent.ngOnDestroy();
    });

    it('retains a timed-out send as uncertain until reconciliation returns its durable own message', fakeAsync(async () => {
        const send = vi.fn().mockName('send').mockReturnValue(true);
        const historyComponent = createHomeComponent({} as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { send, close: () => undefined } as unknown as DataProviderService, { close: () => undefined } as CallFacade);
        historyComponent.selectedConversation = conversation('selected');
        historyComponent.profile = { id: 'user-1' } as Profile;
        historyComponent.socketReady = true;
        historyComponent.draft = 'Delayed';
        historyComponent.sendMessage();
        const lastSend = vi.mocked(send).mock.lastCall;
        if (!lastSend) throw new Error('Expected a send request.');
        const request = lastSend[0] as {
            request_id: string;
            payload: {
                client_message_id: string;
            };
        };

        await tick(10000);
        expect(historyComponent.messages[0]).toEqual(expect.objectContaining({ clientMessageId: request.payload.client_message_id, pending: false, uncertain: true }));

        (historyComponent as unknown as {
            recoveryGeneration: number;
            reconciliationRequest: unknown;
        }).recoveryGeneration = 1;
        (historyComponent as unknown as {
            reconciliationRequest: unknown;
        }).reconciliationRequest = { generation: 1, requestID: 'reconcile', conversationID: 'selected' };
        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'conversation.reconciled', request_id: 'reconcile', payload: {
                ...reconciliationPayload('selected', 1),
                messages: [socketMessage('durable', request.payload.client_message_id, 'Delayed')],
            } });

        expect(historyComponent.messages.map(message => message.id)).toEqual(['durable']);
        expect(historyComponent.messages[0].pending).toBeUndefined();
        expect(historyComponent.messages[0].uncertain).toBeUndefined();
        historyComponent.ngOnDestroy();
    }));

    it('replays uncertain sends with fresh request IDs and resolves them independently out of order', fakeAsync(async () => {
        const connectionStateChanges = new BehaviorSubject<'offline' | 'connecting' | 'recovering' | 'ready' | 'failed'>('offline');
        const send = vi.fn().mockName('send').mockReturnValue(true);
        const historyComponent = createHomeComponent({ list: () => of([]) } as unknown as ConversationService, { profile: () => of({ id: 'user-1' } as Profile) } as unknown as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, { getObservable: () => EMPTY, connectionStateChanges, send, close: () => undefined } as unknown as DataProviderService, { state$: of({ phase: 'idle' }), close: () => undefined } as unknown as CallFacade);
        historyComponent.ngOnInit();
        historyComponent.selectedConversation = conversation('selected');
        historyComponent.profile = { id: 'user-1' } as Profile;
        historyComponent.socketReady = true;
        historyComponent.draft = 'First';
        historyComponent.sendMessage();
        historyComponent.draft = 'Second';
        historyComponent.sendMessage();
        const firstSend = vi.mocked(send).mock.calls[0][0] as {
            request_id: string;
            payload: {
                client_message_id: string;
                body: string;
            };
        };
        const secondSend = vi.mocked(send).mock.calls[1][0] as {
            request_id: string;
            payload: {
                client_message_id: string;
                body: string;
            };
        };

        await tick(10000);
        connectionStateChanges.next('ready');
        const firstReplay = vi.mocked(send).mock.calls[2][0] as {
            request_id: string;
            payload: {
                client_message_id: string;
                body: string;
            };
        };
        const secondReplay = vi.mocked(send).mock.calls[3][0] as {
            request_id: string;
            payload: {
                client_message_id: string;
                body: string;
            };
        };
        expect(firstReplay.request_id).not.toBe(firstSend.request_id);
        expect(secondReplay.request_id).not.toBe(secondSend.request_id);
        expect(firstReplay.payload).toEqual(expect.objectContaining({ client_message_id: firstSend.payload.client_message_id, body: 'First' }));
        expect(secondReplay.payload).toEqual(expect.objectContaining({ client_message_id: secondSend.payload.client_message_id, body: 'Second' }));

        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'message.accepted', request_id: secondReplay.request_id, payload: socketMessage('second-durable', secondReplay.payload.client_message_id, 'Second') });
        historyComponent.handleSocketEvent({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'message.accepted', request_id: firstReplay.request_id, payload: socketMessage('first-durable', firstReplay.payload.client_message_id, 'First') });
        expect(historyComponent.messages.map(message => message.id)).toEqual(['first-durable', 'second-durable']);
        expect(historyComponent.messages.some(message => message.pending || message.uncertain)).toBe(false);
        historyComponent.ngOnDestroy();
    }));

    it('applies only the current selected conversation reconciliation response', () => {
        const selected = conversation('selected');
        const historyComponent = createHomeComponent({} as ConversationService, {} as AuthService, { markForCheck: vi.fn().mockName('markForCheck') } as unknown as ChangeDetectorRef, {} as DataProviderService, { close: () => undefined } as CallFacade);
        historyComponent.selectedConversation = selected;
        historyComponent.messages = [{ id: 'existing', conversationId: selected.id, senderId: 'user-1', clientMessageId: 'existing', sequence: 2, body: 'Existing', createdAt: '2026-01-01T00:00:00Z' }];
        (historyComponent as unknown as {
            recoveryGeneration: number;
            reconciliationRequest: unknown;
        }).recoveryGeneration = 3;
        (historyComponent as unknown as {
            reconciliationRequest: unknown;
        }).reconciliationRequest = { generation: 3, requestID: 'current', conversationID: selected.id };

        historyComponent.handleSocketEvent({
            version: WEBSOCKET_PROTOCOL_VERSION,
            type: 'conversation.reconciled',
            request_id: 'stale',
            payload: reconciliationPayload(selected.id, 3),
        });
        expect(historyComponent.messages.map(message => message.id)).toEqual(['existing']);

        historyComponent.handleSocketEvent({
            version: WEBSOCKET_PROTOCOL_VERSION,
            type: 'conversation.reconciled',
            request_id: 'current',
            payload: reconciliationPayload(selected.id, 3),
        });
        expect(historyComponent.messages.map(message => message.id)).toEqual(['existing', 'reconciled']);
        expect(historyComponent.historyCursor).toBe('3');
    });

    it('loads later group pages once, merges by ID, and retries the same cursor after failure', () => {
        const request = new Subject<{items: GroupConversation[]; nextCursor: string | null}>();
        const retry = new Subject<{items: GroupConversation[]; nextCursor: string | null}>();
        const listGroupPage = vi.fn().mockName('listGroupPage').mockReturnValueOnce(request.asObservable()).mockReturnValueOnce(retry.asObservable());
        const home = createHomeComponent({listGroupPage} as unknown as ConversationService, {} as AuthService, {markForCheck: vi.fn()} as unknown as ChangeDetectorRef, {close: () => undefined} as DataProviderService, {close: () => undefined} as CallFacade);
        const first = groupConversation('page-first');
        const duplicate = {...first, name: 'Updated projection'};
        const second = groupConversation('page-second');
        home.conversations.next([first]);
        home.groupNextCursor = 'opaque-cursor';
        home.groupPageLoaded = true;

        home.loadMoreGroups();
        home.loadMoreGroups();
        expect(listGroupPage).toHaveBeenCalledTimes(1);
        expect(listGroupPage).toHaveBeenCalledWith('opaque-cursor');
        expect(home.groupPageLoading).toBe(true);
        request.error(new Error('temporary failure'));
        expect(home.groupPageError).toBe(true);
        expect(home.conversations.getValue()).toEqual([first]);

        home.loadMoreGroups();
        expect(listGroupPage).toHaveBeenCalledTimes(2);
        retry.next({items: [duplicate, second], nextCursor: null});
        retry.complete();
        expect(home.conversations.getValue().filter(item => item.kind === 'group').map(item => item.id).sort()).toEqual(['page-first', 'page-second']);
        const mergedFirst = home.conversations.getValue().find(item => item.id === first.id);
        expect(mergedFirst?.kind === 'group' ? mergedFirst.name : undefined).toBe('Updated projection');
        expect(home.canLoadMoreGroups()).toBe(false);
        expect(home.groupsExhausted).toBe(true);
        home.ngOnDestroy();
    });

    it('sorts activity instants across offsets and fractional precision before descending ID ties on refresh and page load', () => {
        const olderID = {...conversation('conversation-a'), lastMessageAt: '2026-01-02T00:00:00.100000000Z'};
        const newerID = {...conversation('conversation-z'), lastMessageAt: '2026-01-01T19:00:00.100-05:00'};
        const genuinelyNewer = {...conversation('conversation-m'), lastMessageAt: '2026-01-02T00:00:00.100000001Z'};
        const refreshing = createHomeComponent({listHomeSnapshot: () => of({direct: [olderID, newerID, genuinelyNewer], groups: {items: [], nextCursor: null}})} as unknown as ConversationService, {} as AuthService, {markForCheck: vi.fn()} as unknown as ChangeDetectorRef, {close: () => undefined} as DataProviderService, {close: () => undefined} as CallFacade);

        refreshing.refreshChats();

        expect(refreshing.conversations.getValue().map(item => item.id)).toEqual(['conversation-m', 'conversation-z', 'conversation-a']);
        refreshing.ngOnDestroy();

        const loadedGroupA = {...groupConversation('group-a'), lastMessageAt: '2026-01-02T00:00:00Z'};
        const loadedGroupZ = {...groupConversation('group-z'), lastMessageAt: '2026-01-01T19:00:00.000-05:00'};
        const newerGroup = {...groupConversation('group-m'), lastMessageAt: '2026-01-02T00:00:00.000000001Z'};
        const loading = createHomeComponent({listGroupPage: () => of({items: [loadedGroupA, loadedGroupZ, newerGroup], nextCursor: null})} as unknown as ConversationService, {} as AuthService, {markForCheck: vi.fn()} as unknown as ChangeDetectorRef, {close: () => undefined} as DataProviderService, {close: () => undefined} as CallFacade);
        loading.groupNextCursor = 'opaque-next-page';
        loading.loadMoreGroups();

        expect(loading.conversations.getValue().map(item => item.id)).toEqual(['group-m', 'group-z', 'group-a']);
        loading.ngOnDestroy();
    });

    it('hides all omitted group details while authorized revalidation is pending or fails', () => {
        const loaded = {...groupConversation('stale-on-refresh'), name: 'Secret group', unreadCount: 8, members: [groupMember('member', 1)]};
        const lookup = new Subject<GroupConversation>();
        const getGroup = vi.fn().mockName('getGroup').mockReturnValue(lookup.asObservable());
        const home = createHomeComponent({listHomeSnapshot: () => of({direct: [], groups: {items: [], nextCursor: null}}), getGroup} as unknown as ConversationService, {} as AuthService, {markForCheck: vi.fn()} as unknown as ChangeDetectorRef, {send: () => true, close: () => undefined} as unknown as DataProviderService, {close: () => undefined} as CallFacade);
        home.conversations.next([loaded]);
        home.selectedConversation = loaded;
        home.messages = [{id: 'cached', conversationId: loaded.id, senderId: 'member', clientMessageId: 'cached', sequence: 1, body: 'Secret preview', createdAt: loaded.lastMessageAt}];

        home.refreshChats();

        expect(home.conversations.getValue()).toEqual([expect.objectContaining({id: loaded.id, name: 'Group access needs verification', accessNeedsVerification: true, members: [], unreadCount: 0})]);
        expect(home.selectedConversation).toBeUndefined();
        expect(home.messages).toEqual([]);
        expect(home.canManageGroup()).toBe(false);
        expect(getGroup).toHaveBeenCalledWith(loaded.id);
        lookup.error(new Error('temporary detail failure'));
        expect(home.conversations.getValue()).toEqual([expect.objectContaining({id: loaded.id, name: 'Group access needs verification', accessNeedsVerification: true, members: [], unreadCount: 0})]);
        expect(home.departedGroupRefreshFailed).toBe(true);
        home.ngOnDestroy();
    });

    it('restores selected history after an omitted later-page group is authorized, without disturbing call or navigation state', () => {
        const loaded = {...groupConversation('later-page-selected'), name: 'Private group'};
        const restored = {...loaded, name: 'Authorized group', membershipRevision: loaded.membershipRevision + 1};
        const failedLookup = new Subject<GroupConversation>();
        const authorizedLookup = new Subject<GroupConversation>();
        const laterPage = new Subject<{items: GroupConversation[]; nextCursor: string | null}>();
        const getGroup = vi.fn().mockName('getGroup').mockReturnValueOnce(failedLookup.asObservable()).mockReturnValueOnce(authorizedLookup.asObservable());
        const history = vi.fn().mockName('history').mockReturnValue(of({messages: [{id: 'restored-history', conversationId: loaded.id, senderId: 'peer', clientMessageId: 'history-client', sequence: 4, body: 'Authorized history', createdAt: loaded.lastMessageAt}]}));
        const callState: CallState = {phase: 'active', conversationID: 'ongoing-call'} as CallState;
        const closeCall = vi.fn().mockName('closeCall');
        const home = createHomeComponent(
            {listHomeSnapshot: () => of({direct: [], groups: {items: [], nextCursor: 'next-page'}}), listGroupPage: () => laterPage.asObservable(), getGroup, history} as unknown as ConversationService,
            {} as AuthService,
            {markForCheck: vi.fn()} as unknown as ChangeDetectorRef,
            {send: () => true, close: () => undefined} as unknown as DataProviderService,
            {state: callState, close: closeCall} as unknown as CallFacade,
        );
        home.groupNextCursor = 'next-page';
        home.loadMoreGroups();
        laterPage.next({items: [loaded], nextCursor: null});
        laterPage.complete();
        expect(home.conversations.getValue()).toContain(loaded);
        home.selectedConversation = loaded;
        home.messages = [{id: 'private-cache', conversationId: loaded.id, senderId: 'peer', clientMessageId: 'private-cache', sequence: 3, body: 'Must be hidden', createdAt: loaded.lastMessageAt}];
        home.minimizeCall();
        const navigationVersion = (home as unknown as {navigationIntentVersion: number}).navigationIntentVersion;

        home.refreshChats();

        expect(home.conversations.getValue()).toEqual([expect.objectContaining({id: loaded.id, name: 'Group access needs verification', accessNeedsVerification: true, members: [], unreadCount: 0})]);
        expect(home.selectedConversation).toBeUndefined();
        expect(home.messages).toEqual([]);
        expect(history).not.toHaveBeenCalled();
        expect(getGroup).toHaveBeenCalledTimes(1);

        failedLookup.error(new Error('temporary lookup failure'));
        expect(home.conversations.getValue()).toEqual([expect.objectContaining({id: loaded.id, name: 'Group access needs verification', accessNeedsVerification: true, members: [], unreadCount: 0})]);
        expect(home.selectedConversation).toBeUndefined();
        expect(home.messages).toEqual([]);
        expect(home.departedGroupRefreshFailed).toBe(true);

        home['groupAccess'].retryQuarantined();
        expect(getGroup).toHaveBeenCalledTimes(2);
        expect(home.selectedConversation).toBeUndefined();
        authorizedLookup.next(restored);
        authorizedLookup.complete();

        expect(home.selectedConversation).toEqual(restored);
        expect(home.conversations.getValue().find(item => item.id === loaded.id)).toEqual(restored);
        expect(home.messages.map(message => message.id)).toEqual(['restored-history']);
        expect(history).toHaveBeenCalledTimes(1);
        expect(history).toHaveBeenCalledWith(loaded.id, undefined);
        expect(home.isCallMinimized()).toBe(true);
        expect(home.call.state).toBe(callState);
        expect(closeCall).not.toHaveBeenCalled();
        expect((home as unknown as {navigationIntentVersion: number}).navigationIntentVersion).toBe(navigationVersion);
        home.ngOnDestroy();
    });

    it('refreshes from page one, upserts returned groups, and replaces omitted groups with data-free verification rows', () => {
        const previous = groupConversation('previously-loaded');
        const omitted = {...groupConversation('omitted-loaded'), name: 'Hidden name', unreadCount: 5};
        const fresh = {...previous, name: 'Fresh name', membershipRevision: 2};
        const service = {listHomeSnapshot: () => of({direct: [], groups: {items: [fresh], nextCursor: 'page-two'}})};
        const home = createHomeComponent(service as unknown as ConversationService, {} as AuthService, {markForCheck: vi.fn()} as unknown as ChangeDetectorRef, {close: () => undefined} as DataProviderService, {close: () => undefined} as CallFacade);
        home.conversations.next([previous, omitted]);
        home.groupNextCursor = 'old-cursor';

        home.refreshChats();

        expect(home.groupNextCursor).toBe('page-two');
        expect(home.conversations.getValue().map(item => item.id).sort()).toEqual([previous.id, omitted.id].sort());
        expect(home.conversations.getValue().find(item => item.id === previous.id)).toMatchObject({name: 'Fresh name', membershipRevision: 2});
        expect(home.conversations.getValue().find(item => item.id === omitted.id)).toEqual(expect.objectContaining({
            id: omitted.id,
            kind: 'group',
            name: 'Group access needs verification',
            accessNeedsVerification: true,
            members: [],
            unreadCount: 0,
        }));
        home.ngOnDestroy();
    });

    it('keeps a data-free placeholder for an omitted group until a later authorized page restores it', () => {
        const group = groupConversation('restored-by-page');
        const page = new Subject<{items: GroupConversation[]; nextCursor: string | null}>();
        const service = {
            listHomeSnapshot: () => of({direct: [], groups: {items: [], nextCursor: 'cursor-one'}}),
            listGroupPage: () => page.asObservable(),
        };
        const home = createHomeComponent(service as unknown as ConversationService, {} as AuthService, {markForCheck: vi.fn()} as unknown as ChangeDetectorRef, {close: () => undefined} as DataProviderService, {close: () => undefined} as CallFacade);
        home.conversations.next([group]);

        home.refreshChats();
        expect(home.conversations.getValue()).toEqual([expect.objectContaining({id: group.id, name: 'Group access needs verification', accessNeedsVerification: true, members: [], unreadCount: 0})]);
        home.loadMoreGroups();
        page.next({items: [group], nextCursor: null});
        page.complete();

        expect(home.conversations.getValue()).toEqual([group]);
        home.ngOnDestroy();
    });

    it('quarantines an omitted page-two group without aborting its rejoinable call and restores the same call after authorized GET', () => {
        const group = {...groupConversation('page-two-active'), name: 'Private group', members: [groupMember('secret-member', 1)]};
        const lookup = new Subject<GroupConversation>();
        const callState = {phase: 'active', room: {conversation_id: group.id}, localStream: {getTracks: () => []}};
        const abort = vi.fn().mockReturnValue(true);
        const canRejoin = vi.fn().mockReturnValue(true);
        const groupCall = {state: callState, abort, canRejoin, get isOngoing() { return true; }} as unknown as GroupCallFacade;
        const history = vi.fn().mockReturnValue(of({messages: []}));
        const home = createHomeComponent(
            {listHomeSnapshot: () => of({direct: [], groups: {items: [], nextCursor: 'page-two'}}), getGroup: () => lookup.asObservable(), history} as unknown as ConversationService,
            {} as AuthService,
            {markForCheck: vi.fn()} as unknown as ChangeDetectorRef,
            {send: () => true, close: () => undefined} as unknown as DataProviderService,
            {close: () => undefined} as CallFacade,
            undefined,
            groupCall,
        );
        home.conversations.next([group]);
        home.selectedConversation = group;
        home.messages = [{id: 'private-message', conversationId: group.id, senderId: 'secret-member', clientMessageId: 'private', sequence: 1, body: 'Secret text', createdAt: group.lastMessageAt}];
        home.showGroupManager = true;

        home.refreshChats();

        expect(home.conversations.getValue()).toEqual([expect.objectContaining({id: group.id, name: 'Group access needs verification', accessNeedsVerification: true, members: [], unreadCount: 0})]);
        expect(home.selectedConversation).toBeUndefined();
        expect(home.messages).toEqual([]);
        expect(home.showGroupManager).toBe(false);
        expect(home.conversations.getValue()).toEqual([expect.objectContaining({id: group.id, name: 'Group access needs verification', accessNeedsVerification: true, members: [], unreadCount: 0})]);
        expect(abort).not.toHaveBeenCalled();
        expect(callState.room.conversation_id).toBe(group.id);

        lookup.next(group);
        lookup.complete();

        expect(home.selectedConversation).toEqual(group);
        expect(home.conversations.getValue()).toContainEqual(expect.objectContaining({id: group.id, name: group.name}));
        expect(history).toHaveBeenCalledWith(group.id, undefined);
        expect(abort).not.toHaveBeenCalled();
        home.ngOnDestroy();
    });

    it('aborts a rejoinable group call on recognized group-detail 404', () => {
        const group = groupConversation('missing-group');
        const lookup = new Subject<GroupConversation>();
        const abort = vi.fn().mockReturnValue(true);
        const groupCall = {state: {room: null}, canRejoin: (id: string) => id === group.id, abort} as unknown as GroupCallFacade;
        const home = createHomeComponent(
            {listHomeSnapshot: () => of({direct: [], groups: {items: [], nextCursor: null}}), getGroup: () => lookup.asObservable()} as unknown as ConversationService,
            {} as AuthService,
            {markForCheck: vi.fn()} as unknown as ChangeDetectorRef,
            {send: () => true, close: () => undefined} as unknown as DataProviderService,
            {close: () => undefined} as CallFacade,
            undefined,
            groupCall,
        );
        home.conversations.next([group]);
        home.selectedConversation = group;

        home.refreshChats();
        lookup.error(new GroupProjectionNotFoundError());

        expect(abort).toHaveBeenCalledOnce();
        expect(abort).toHaveBeenCalledWith(group.id);
        expect(home.conversations.getValue()).toEqual([]);
        home.ngOnDestroy();
    });

    it('fences group member search responses and exposes loading, empty, and error states distinctly', () => {
        const first = new Subject<UserSearchResult[]>();
        const second = new Subject<UserSearchResult[]>();
        const searchUsers = vi.fn().mockReturnValueOnce(first.asObservable()).mockReturnValueOnce(second.asObservable());
        const home = createHomeComponent({searchUsers} as unknown as ConversationService, {} as AuthService, {markForCheck: vi.fn()} as unknown as ChangeDetectorRef, {close: () => undefined} as unknown as DataProviderService, {close: () => undefined} as CallFacade);
        home.groupMemberQuery = 'al';
        home.searchGroupMembers();
        expect(home.groupMemberSearchState).toBe('loading');
        home.groupMemberQuery = 'alex';
        home.searchGroupMembers();
        const newerResult = {id: 'alex', display_name: 'Alex', email: 'alex@example.test'};
        second.next([newerResult]);
        expect(home.groupMemberResults).toEqual([newerResult]);
        expect(home.groupMemberSearchState).toBe('results');
        first.error(new Error('obsolete failure'));
        expect(home.groupMemberResults).toEqual([newerResult]);
        expect(home.groupMemberSearchState).toBe('results');

        const empty = new Subject<UserSearchResult[]>();
        searchUsers.mockReturnValueOnce(empty.asObservable());
        home.groupMemberQuery = 'nobody';
        home.searchGroupMembers();
        empty.next([]);
        expect(home.groupMemberSearchState).toBe('empty');
        expect(home.groupMemberResults).toEqual([]);

        const failed = new Subject<UserSearchResult[]>();
        searchUsers.mockReturnValueOnce(failed.asObservable());
        home.groupMemberQuery = 'failure';
        home.searchGroupMembers();
        failed.error(new Error('search failed'));
        expect(home.groupMemberSearchState).toBe('error');
        home.ngOnDestroy();
    });

    it('cancels superseded people searches and exposes visible main-search states', () => {
        const first = new Subject<UserSearchResult[]>();
        const second = new Subject<UserSearchResult[]>();
        const searchUsers = vi.fn().mockReturnValueOnce(first.asObservable()).mockReturnValueOnce(second.asObservable());
        const home = createHomeComponent({searchUsers} as unknown as ConversationService, {} as AuthService, {markForCheck: vi.fn()} as unknown as ChangeDetectorRef, {close: () => undefined} as unknown as DataProviderService, {close: () => undefined} as CallFacade);
        home.searchQuery = 'al';
        home.searchUsers();
        expect(home.searchState).toBe('loading');
        home.searchQuery = 'alex';
        home.searchUsers();
        expect(home.searchResults).toEqual([]);
        const result = {id: 'alex', display_name: 'Alex', email: 'alex@example.test'};
        second.next([result]);
        expect(home.searchResults).toEqual([result]);
        expect(home.searchState).toBe('results');
        first.next([{id: 'stale', display_name: 'Stale', email: 'stale@example.test'}]);
        expect(home.searchResults).toEqual([result]);

        const empty = new Subject<UserSearchResult[]>();
        searchUsers.mockReturnValueOnce(empty.asObservable());
        home.searchQuery = 'nobody';
        home.searchUsers();
        expect(home.searchResults).toEqual([]);
        empty.next([]);
        expect(home.searchState).toBe('empty');

        const failed = new Subject<UserSearchResult[]>();
        searchUsers.mockReturnValueOnce(failed.asObservable());
        home.searchQuery = 'failure';
        home.searchUsers();
        failed.error(new Error('invalid response'));
        expect(home.searchState).toBe('error');
        home.searchQuery = 'x';
        home.searchUsers();
        expect(home.searchState).toBe('idle');
        expect(home.searchResults).toEqual([]);
        home.ngOnDestroy();
    });

    it('does not let automatic pagination minimize a direct call or overwrite explicit navigation', () => {
        const page = new Subject<{items: GroupConversation[]; nextCursor: string | null}>();
        const direct = conversation('explicit-navigation');
        const minimizeCall = vi.fn().mockName('minimizeCall');
        const service = {listGroupPage: () => page.asObservable()};
        const home = createHomeComponent(service as unknown as ConversationService, {} as AuthService, {markForCheck: vi.fn()} as unknown as ChangeDetectorRef, {close: () => undefined} as DataProviderService, {state: {phase: 'active'}, close: () => undefined} as unknown as CallFacade);
        vi.spyOn(home, 'minimizeCall').mockImplementation(minimizeCall);
        home.conversations.next([direct]);
        home.groupNextCursor = 'next';
        home.loadMoreGroups();
        home.selectConversation(direct);
        page.next({items: [groupConversation('automatically-loaded')], nextCursor: null});
        expect(home.selectedConversation?.id).toBe(direct.id);
        expect(minimizeCall).toHaveBeenCalledTimes(1);
        expect(home.conversations.getValue().map(item => item.id).sort()).toEqual([direct.id, 'automatically-loaded'].sort());
        home.ngOnDestroy();
    });

    it('keeps the row and selection when archive fails', () => {
        const archive = new Subject<void>();
        const item = conversation('keep-on-error');
        const home = createHomeComponent({archiveConversation: () => archive.asObservable()} as unknown as ConversationService, {} as AuthService, {markForCheck: vi.fn()} as unknown as ChangeDetectorRef, {close: () => undefined} as DataProviderService, {close: () => undefined} as CallFacade);
        home.conversations.next([item]);
        home.selectedConversation = item;

        home.toggleArchive(item);
        archive.error(new Error('network failure'));

        expect(home.conversations.getValue()).toEqual([item]);
        expect(home.selectedConversation?.id).toBe(item.id);
        expect(home.archiveActionError).toContain('still in your list');
        home.ngOnDestroy();
    });

    it('removes a successfully archived selection and ignores an older in-flight list response', () => {
        const staleList = new Subject<{direct: Conversation[]; groups: {items: GroupConversation[]; nextCursor: string | null}}>();
        const item = conversation('archive-success');
        const home = createHomeComponent({
            listHomeSnapshot: () => staleList.asObservable(),
            archiveConversation: () => of(undefined),
        } as unknown as ConversationService, {} as AuthService, {markForCheck: vi.fn()} as unknown as ChangeDetectorRef, {close: () => undefined} as DataProviderService, {close: () => undefined} as CallFacade);
        home.conversations.next([item]);
        home.selectedConversation = item;

        home.refreshChats();
        home.toggleArchive(item);
        staleList.next({direct: [item], groups: {items: [], nextCursor: null}});

        expect(home.conversations.getValue()).toEqual([]);
        expect(home.selectedConversation).toBeUndefined();
        home.ngOnDestroy();
    });

    it('reloads Archived after an archive completes while switching into the destination mode', () => {
        const item = conversation('archive-while-switching');
        const requests: Array<{archived: boolean; response: Subject<{direct: Conversation[]; groups: {items: GroupConversation[]; nextCursor: string | null}}>}> = [];
        const archive = new Subject<void>();
        const listHomeSnapshot = vi.fn((archived: boolean) => {
            const response = new Subject<{direct: Conversation[]; groups: {items: GroupConversation[]; nextCursor: string | null}}>();
            requests.push({archived, response});
            return response.asObservable();
        });
        const home = createHomeComponent({listHomeSnapshot, archiveConversation: () => archive.asObservable()} as unknown as ConversationService, {} as AuthService, {markForCheck: vi.fn()} as unknown as ChangeDetectorRef, {close: () => undefined} as DataProviderService, {close: () => undefined} as CallFacade);
        home.conversations.next([item]);
        home.toggleArchive(item);
        home.setArchiveMode('archived');
        archive.next();

        expect(requests.map(request => request.archived)).toEqual([true, true]);
        requests[0]?.response.next({direct: [], groups: {items: [], nextCursor: null}});
        requests[1]?.response.next({direct: [item], groups: {items: [], nextCursor: null}});

        expect(home.conversations.getValue().map(conversation => conversation.id)).toEqual([item.id]);
        expect(home.isLoading).toBe(false);
        expect(home.groupSnapshotLoading).toBe(false);
        home.ngOnDestroy();
    });

    it('reloads All chats after a restore completes while switching into the destination mode', () => {
        const item = conversation('restore-while-switching');
        const requests: Array<{archived: boolean; response: Subject<{direct: Conversation[]; groups: {items: GroupConversation[]; nextCursor: string | null}}>}> = [];
        const restore = new Subject<void>();
        const listHomeSnapshot = vi.fn((archived: boolean) => {
            const response = new Subject<{direct: Conversation[]; groups: {items: GroupConversation[]; nextCursor: string | null}}>();
            requests.push({archived, response});
            return response.asObservable();
        });
        const home = createHomeComponent({listHomeSnapshot, restoreConversation: () => restore.asObservable()} as unknown as ConversationService, {} as AuthService, {markForCheck: vi.fn()} as unknown as ChangeDetectorRef, {close: () => undefined} as DataProviderService, {close: () => undefined} as CallFacade);
        home.archiveMode = 'archived';
        home.conversations.next([item]);
        home.toggleArchive(item);
        home.setArchiveMode('active');
        restore.next();

        expect(requests.map(request => request.archived)).toEqual([false, false]);
        requests[0]?.response.next({direct: [], groups: {items: [], nextCursor: null}});
        requests[1]?.response.next({direct: [item], groups: {items: [], nextCursor: null}});

        expect(home.conversations.getValue().map(conversation => conversation.id)).toEqual([item.id]);
        expect(home.isLoading).toBe(false);
        expect(home.groupSnapshotLoading).toBe(false);
        home.ngOnDestroy();
    });

    it('returns to All chats and reloads the source projection when archive fails after switching modes', () => {
        const item = conversation('archive-failure-after-switch');
        const requests: Array<{archived: boolean; response: Subject<{direct: Conversation[]; groups: {items: GroupConversation[]; nextCursor: string | null}}>}> = [];
        const archive = new Subject<void>();
        const listHomeSnapshot = vi.fn((archived: boolean) => {
            const response = new Subject<{direct: Conversation[]; groups: {items: GroupConversation[]; nextCursor: string | null}}>();
            requests.push({archived, response});
            return response.asObservable();
        });
        const home = createHomeComponent({listHomeSnapshot, archiveConversation: () => archive.asObservable()} as unknown as ConversationService, {} as AuthService, {markForCheck: vi.fn()} as unknown as ChangeDetectorRef, {close: () => undefined} as DataProviderService, {close: () => undefined} as CallFacade);
        home.conversations.next([item]);
        home.toggleArchive(item);
        home.setArchiveMode('archived');
        archive.error(new Error('archive rejected'));

        expect(home.archiveMode).toBe('active');
        expect(home.archiveActionError).toContain('still in your list');
        expect(requests.map(request => request.archived)).toEqual([true, false]);
        requests[0]?.response.next({direct: [], groups: {items: [], nextCursor: null}});
        expect(home.conversations.getValue()).toEqual([]);
        expect(home.isLoading).toBe(true);
        requests[1]?.response.next({direct: [item], groups: {items: [], nextCursor: null}});

        expect(home.conversations.getValue().map(conversation => conversation.id)).toEqual([item.id]);
        expect(home.isLoading).toBe(false);
        expect(home.archiveActionError).toContain('still in your list');
        home.ngOnDestroy();
    });

    it('switches between active and archived lists with distinct accessible mode controls', () => {
        vi.spyOn(TestBed.inject(ConversationService), 'listHomeSnapshot').mockReturnValue(of({direct: [], groups: {items: [], nextCursor: null}}));
        fixture.detectChanges();
        component.conversations.next([conversation('archive-controls')]);
        fixture.detectChanges();
        const buttons = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('.archive-mode-tabs button'));
        expect(buttons.map(button => button.textContent?.trim())).toEqual(['All chats', 'Archived']);
        expect(buttons[0]?.getAttribute('aria-pressed')).toBe('true');

        component.setArchiveMode('archived');
        fixture.detectChanges();

        expect(component.archiveMode).toBe('archived');
        expect(buttons[1]?.getAttribute('aria-pressed')).toBe('true');
        const emptyState = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('.people-list .empty-rail');
        expect(emptyState?.textContent).toContain('No archived chats.');
        expect(emptyState?.textContent).toContain('Archive a conversation from All chats to find it here.');
    });
});

function snapshotFrom(source: Observable<Conversation[]>): Observable<{direct: Conversation[]; groups: {items: GroupConversation[]; nextCursor: string | null}}> {
    return source.pipe(map(items => ({direct: items.filter(item => item.kind !== 'group'), groups: {items: items.filter((item): item is GroupConversation => item.kind === 'group'), nextCursor: null}})));
}

function createHomeComponent(conversationService: ConversationService, authService: AuthService, changeDetector: ChangeDetectorRef, dataProvider: DataProviderService, call: CallFacade, notifications?: HomeNotificationService, groupCall?: GroupCallFacade, groupAccess = new HomeGroupAccessFacade(conversationService)): HomeComponent {
    const legacyTestService = conversationService as ConversationService & {list?: () => Observable<Conversation[]>};
    const serviceWithHistory = Object.assign(conversationService, {
        history: conversationService.history ?? (() => of({ messages: [] })),
        listHomeSnapshot: conversationService.listHomeSnapshot ?? (() => snapshotFrom(legacyTestService.list?.() ?? of([]))),
    });
    return new HomeComponent(serviceWithHistory, authService, changeDetector, dataProvider, call, groupAccess, notifications, groupCall);
}

function conversation(id: string): Conversation {
    return { id, otherUserId: `user-${id}`, otherDisplayName: id, otherEmail: `${id}@example.test`, createdAt: '2026-01-01T00:00:00Z', lastMessageAt: '2026-01-01T00:00:00Z', unreadCount: 0 };
}

function groupConversation(id: string): GroupConversation {
    return { id, kind: 'group', name: id, avatarSeed: id, ownerId: 'user-1', membershipRevision: 1, members: [], otherUserId: '', otherDisplayName: id, otherEmail: '', createdAt: '2026-01-01T00:00:00Z', lastMessageAt: '2026-01-01T00:00:00Z', unreadCount: 0 };
}

function groupMember(userId: string, visibleFromSequence: number): GroupMember {
    return { userId, displayName: userId, role: userId === 'user-1' ? 'owner' : 'member', visibleFromSequence, joinedAt: '2026-01-01T00:00:00Z' };
}

function ownMessage(conversationId: string, sequence: number): Message {
    return { id: `message-${sequence}`, conversationId, senderId: 'user-me', clientMessageId: `client-${sequence}`, sequence, body: `Message ${sequence}`, createdAt: '2026-01-01T00:00:00Z' };
}

function socketMessage(id: string, clientMessageID: string, body: string) {
    return { id, conversation_id: 'selected', sender_id: 'user-1', client_message_id: clientMessageID, sequence: 1, body, created_at: '2026-01-01T00:00:00Z' };
}

function reconciliationPayload(conversationID: string, nextAfterSequence: number) {
    return {
        conversation_id: conversationID,
        messages: [{ id: 'reconciled', conversation_id: conversationID, sender_id: 'user-2', client_message_id: 'reconciled', sequence: 3, body: 'Recovered', created_at: '2026-01-01T00:00:03Z' }],
        next_after_sequence: nextAfterSequence,
        high_watermark: 3,
        has_more: true,
        own_read_sequence: 2,
        peer_read_sequence: 1,
    };
}
