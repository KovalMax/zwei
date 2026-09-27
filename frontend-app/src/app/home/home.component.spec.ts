import {fakeAsync, tick, waitForAsync, ComponentFixture, TestBed} from '@angular/core/testing';
import {ChangeDetectorRef} from '@angular/core';
import {HttpErrorResponse} from '@angular/common/http';
import {By} from '@angular/platform-browser';
import {BehaviorSubject, EMPTY, NEVER, of, Subject, throwError} from 'rxjs';

import {HomeComponent} from './home.component';
import {AppModule} from '../app.module';
import {HomeModule} from './home.module';
import {AuthService} from '../auth/auth.service';
import {ConversationService} from './conversation.service';
import {Conversation, GroupConversation, GroupMember} from './conversation.model';
import {Message, MessageHistory} from './message.model';
import {WEBSOCKET_PROTOCOL_VERSION} from './data-provider.service';
import {DataProviderService} from './data-provider.service';
import {CallFacade} from './call-facade.service';
import {GroupCallFacade, GroupCallPeer} from './group-call-facade.service';
import {Profile} from '../auth/profile.model';
import {UserSearchResult} from './user.model';

describe('HomeComponent', () => {
    let component: HomeComponent;
    let fixture: ComponentFixture<HomeComponent>;

    beforeEach(waitForAsync(() => {
        TestBed.configureTestingModule({
            imports: [AppModule, HomeModule]
        })
            .compileComponents();
    }));

    beforeEach(() => {
        fixture = TestBed.createComponent(HomeComponent);
        component = fixture.componentInstance;
    });

    it('should create', () => {
        expect(component).toBeTruthy();
    });

    it('tracks refreshed Home list views by stable domain identity', () => {
        const member: GroupMember = {userId: 'user-1', displayName: 'Member', email: 'member@example.test', role: 'member', visibleFromSequence: 1, joinedAt: '2026-01-01T00:00:00Z'};
        const peer: GroupCallPeer = {userID: 'user-1', deviceID: 'device-1'};
        const user: UserSearchResult = {id: 'user-1', display_name: 'Member', email: 'member@example.test'};
        const message: Message = {id: 'message-1', conversationId: 'conversation-1', senderId: 'user-1', clientMessageId: 'client-1', sequence: 1, body: 'Hello', createdAt: '2026-01-01T00:00:00Z'};

        expect(component.trackConversation(0, conversation('conversation-1'))).toBe('conversation-1');
        expect(component.trackUserResult(0, user)).toBe('user-1');
        expect(component.trackGroupMember(0, member)).toBe('user-1');
        expect(component.trackGroupPeer(0, peer)).toBe('user-1:device-1');
        expect(component.trackMessage(0, message)).toBe('user-1:client-1');
        const optimisticMessage = {...message, id: 'pending:client-1', pending: true};
        expect(component.trackMessage(0, optimisticMessage)).toBe(component.trackMessage(0, message));
    });

    it('projects member actions by actor and target role, hiding owner and self actions', () => {
        const owner = {...groupMember('owner', 1), displayName: 'Owner', role: 'owner' as const};
        const admin = {...groupMember('admin', 1), displayName: 'Admin', role: 'admin' as const};
        const anotherAdmin = {...groupMember('another-admin', 1), displayName: 'Another admin', role: 'admin' as const};
        const member = {...groupMember('member', 1), displayName: 'Member', role: 'member' as const};
        const group = {...groupConversation('permissions'), ownerId: owner.userId, members: [owner, admin, anotherAdmin, member]};
        component.selectedConversation = group;

        component.profile = {id: owner.userId} as Profile;
        expect(component.groupMemberActions(owner)).toEqual([]);
        expect(component.groupMemberActions(admin).map(action => action.id)).toEqual(['make-member', 'transfer-owner', 'remove-member']);
        expect(component.groupMemberActions(member).map(action => action.id)).toEqual(['make-admin', 'transfer-owner', 'remove-member']);
        expect(component.groupMemberActions(admin)[0].ariaLabel).toBe('Make Admin a member');
        expect(component.groupMemberActions(member)[0].ariaLabel).toBe('Make Member an admin');
        expect(component.groupMemberActions(member)[1].label).toBe('Transfer owner');
        expect(component.groupMemberActions(member)[2].label).toBe('Remove');

        component.profile = {id: admin.userId} as Profile;
        expect(component.groupMemberActions(owner)).toEqual([]);
        expect(component.groupMemberActions(admin)).toEqual([]);
        expect(component.groupMemberActions(anotherAdmin).map(action => action.id)).toEqual(['make-member', 'remove-member']);
        expect(component.groupMemberActions(member).map(action => action.id)).toEqual(['make-admin', 'remove-member']);

        component.profile = {id: member.userId} as Profile;
        expect(component.groupMemberActions(owner)).toEqual([]);
        expect(component.groupMemberActions(admin)).toEqual([]);
        expect(component.groupMemberActions(member)).toEqual([]);

        const ownerOnly = {...groupConversation('owner-only'), ownerId: owner.userId, members: [owner]};
        component.selectedConversation = ownerOnly;
        component.profile = {id: owner.userId} as Profile;
        expect(component.groupMemberActions(ownerOnly.members[0])).toEqual([]);
    });

    it('dispatches only currently permitted group member actions to existing handlers', () => {
        const owner = {...groupMember('owner', 1), displayName: 'Owner', role: 'owner' as const};
        const admin = {...groupMember('admin', 1), displayName: 'Admin', role: 'admin' as const};
        const member = {...groupMember('member', 1), displayName: 'Member', role: 'member' as const};
        component.selectedConversation = {...groupConversation('actions'), ownerId: owner.userId, members: [owner, admin, member]};
        component.profile = {id: owner.userId} as Profile;
        const changeRole = spyOn(component, 'changeMemberRole');
        const transfer = spyOn(component, 'transferOwnership');
        const remove = spyOn(component, 'removeGroupMember');

        component.performGroupMemberAction(member, 'make-admin');
        component.performGroupMemberAction(admin, 'make-member');
        component.performGroupMemberAction(member, 'transfer-owner');
        component.performGroupMemberAction(member, 'remove-member');
        expect(changeRole.calls.allArgs()).toEqual([[member.userId, 'admin'], [admin.userId, 'member']]);
        expect(transfer).toHaveBeenCalledOnceWith(member.userId);
        expect(remove).toHaveBeenCalledOnceWith(member.userId);

        component.profile = {id: admin.userId} as Profile;
        component.performGroupMemberAction(member, 'transfer-owner');
        component.performGroupMemberAction(owner, 'remove-member');
        expect(transfer).toHaveBeenCalledTimes(1);
        expect(remove).toHaveBeenCalledTimes(1);
    });

    it('blocks all group mutation entry points while a role mutation is pending and releases the lock on completion', () => {
        const pendingMutation = new Subject<GroupConversation>();
        const completedMutation = new Subject<GroupConversation>();
        const owner = {...groupMember('owner', 1), displayName: 'Owner', role: 'owner' as const};
        const member = {...groupMember('member', 1), displayName: 'Member', role: 'member' as const};
        const group = {...groupConversation('pending-role-change'), ownerId: owner.userId, members: [owner, member]};
        const changeGroupRole = jasmine.createSpy('changeGroupRole').and.returnValues(pendingMutation.asObservable(), completedMutation.asObservable());
        const renameGroup = jasmine.createSpy('renameGroup');
        const addGroupMember = jasmine.createSpy('addGroupMember');
        const removeGroupMember = jasmine.createSpy('removeGroupMember');
        const transferGroupOwnership = jasmine.createSpy('transferGroupOwnership');
        const leaveGroup = jasmine.createSpy('leaveGroup');
        const deleteGroup = jasmine.createSpy('deleteGroup');
        const createGroup = jasmine.createSpy('createGroup');
        const history = jasmine.createSpy('history').and.returnValue(EMPTY);
        const confirm = spyOn(window, 'confirm').and.returnValue(true);
        const historyComponent = new HomeComponent(
            {changeGroupRole, renameGroup, addGroupMember, removeGroupMember, transferGroupOwnership, leaveGroup, deleteGroup, createGroup, history} as unknown as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {close: () => undefined, send: jasmine.createSpy('send')} as unknown as DataProviderService,
            {close: () => undefined} as CallFacade,
        );
        historyComponent.selectedConversation = group;
        historyComponent.profile = {id: owner.userId} as Profile;
        historyComponent.groupName = 'Pending rename';
        historyComponent.isCreatingGroup = true;
        historyComponent.selectedGroupMember = {id: 'another-member', display_name: 'Another member', email: 'another@example.test'};

        historyComponent.performGroupMemberAction(member, 'make-admin');
        expect(changeGroupRole).toHaveBeenCalledOnceWith(group.id, member.userId, 'admin');
        expect(historyComponent.groupLoading).toBeTrue();

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
        expect(historyComponent.groupLoading).toBeTrue();
        expect(historyComponent.selectedConversation?.id).toBe(group.id);
        expect(historyComponent.isCreatingGroup).toBeTrue();
        expect(historyComponent.groupName).toBe('Pending rename');

        pendingMutation.error(new Error('deterministic completion'));
        expect(historyComponent.groupLoading).toBeFalse();
        expect(historyComponent.groupError).toBe('Group changes could not be saved.');

        historyComponent.changeMemberRole(member.userId, 'admin');
        expect(changeGroupRole).toHaveBeenCalledTimes(2);
        expect(historyComponent.groupLoading).toBeTrue();
        completedMutation.next({...group, members: [owner, {...member, role: 'admin'}]});
        completedMutation.complete();
        expect(historyComponent.groupLoading).toBeFalse();
        expect(historyComponent.groupError).toBe('');
        historyComponent.ngOnDestroy();
    });

    it('disables group member, add, rename, leave, and delete controls while a mutation is busy', () => {
        const owner = {...groupMember('owner', 1), displayName: 'Owner', role: 'owner' as const};
        const member = {...groupMember('member', 1), displayName: 'Member', role: 'member' as const};
        const group = {...groupConversation('busy-controls'), ownerId: owner.userId, members: [owner, member]};
        spyOn(TestBed.inject(AuthService), 'profile').and.returnValue(of({id: owner.userId, display_name: 'Owner'} as Profile));
        spyOn(TestBed.inject(ConversationService), 'list').and.returnValue(of([group]));
        spyOn(fixture.debugElement.injector.get(DataProviderService), 'getObservable').and.returnValue(NEVER);
        component.selectedConversation = group;
        component.profile = {id: owner.userId} as Profile;
        component.showGroupManager = true;
        component.groupLoading = true;
        component.groupName = 'Busy group';
        component.selectedGroupMember = {id: 'another-member', display_name: 'Another member', email: 'another@example.test'};

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
        const historyComponent = new HomeComponent(
            {history: () => of({messages: []}), createGroup: jasmine.createSpy('createGroup').and.returnValue(of(created))} as unknown as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {} as DataProviderService,
            {close: () => undefined} as CallFacade,
        );
        historyComponent.selectConversation(conversation('selected'));

        historyComponent.openGroupCreation();

        expect(historyComponent.selectedConversation).toBeUndefined();
        expect(historyComponent.isCreatingGroup).toBeTrue();

        historyComponent.groupName = 'Created group';
        historyComponent.createGroup();

        expect(historyComponent.selectedConversation?.id).toBe(created.id);
        expect(historyComponent.isCreatingGroup).toBeFalse();
    });

    it('keeps group creation open when creation fails and clears it on cancel', () => {
        const historyComponent = new HomeComponent(
            {createGroup: () => throwError(() => new Error('unavailable'))} as unknown as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {} as DataProviderService,
            {close: () => undefined} as CallFacade,
        );
        historyComponent.openGroupCreation();
        historyComponent.groupName = 'Team';

        historyComponent.createGroup();

        expect(historyComponent.isCreatingGroup).toBeTrue();
        expect(historyComponent.groupError).toBe('Could not create the group.');

        historyComponent.cancelGroupCreation();

        expect(historyComponent.isCreatingGroup).toBeFalse();
        expect(historyComponent.groupName).toBe('');
    });

    it('uses the compact group-call quality selection and exposes an explicit connection retry', () => {
        const retryNow = jasmine.createSpy('retryNow');
        const historyComponent = new HomeComponent(
            {} as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {retryNow} as unknown as DataProviderService,
            {close: () => undefined} as CallFacade,
        );

        historyComponent.onGroupScreenQualityChange('2k');
        historyComponent.onGroupScreenQualityChange('unsupported');
        historyComponent.retryConnection();

        expect(historyComponent.groupScreenQuality).toBe('2k');
        expect(retryNow).toHaveBeenCalledTimes(1);
    });

    it('delegates group speaker selection to the call facade without choosing a peer audio element', () => {
        const selectOutputDevice = jasmine.createSpy('selectOutputDevice').and.returnValue(Promise.resolve());
        const historyComponent = new HomeComponent(
            {} as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {} as DataProviderService,
            {close: () => undefined} as CallFacade,
            undefined,
            {selectOutputDevice} as unknown as GroupCallFacade,
        );

        historyComponent.onGroupOutputDeviceChange('speaker-2');

        expect(selectOutputDevice).toHaveBeenCalledOnceWith('speaker-2');
    });

    it('removes only the matching ongoing group-call facade and clears group management selection', () => {
        const directEnd = jasmine.createSpy('directEnd');
        const groupAbort = jasmine.createSpy('groupAbort').and.returnValue(true);
        const removed = groupConversation('removed');
        const retained = groupConversation('retained');
        const groupCall = {isOngoing: true, state: {room: {conversation_id: removed.id}}, abort: groupAbort} as unknown as GroupCallFacade;
        const historyComponent = new HomeComponent(
            {} as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {} as DataProviderService,
            {end: directEnd, close: () => undefined} as unknown as CallFacade,
            undefined,
            groupCall,
        );
        historyComponent.selectedConversation = removed;
        historyComponent.conversations.next([removed, retained]);
        historyComponent.showGroupManager = true;
        historyComponent.groupCallMinimized = true;

        historyComponent.handleSocketEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: {conversation_id: removed.id, membership_revision: 2, deleted: true}});

        expect(groupAbort).toHaveBeenCalledOnceWith(removed.id);
        expect(directEnd).not.toHaveBeenCalled();
        expect(historyComponent.conversations.getValue().map(item => item.id)).toEqual([retained.id]);
        expect(historyComponent.selectedConversation).toBeUndefined();
        expect(historyComponent.showGroupManager).toBeFalse();
        expect(historyComponent.groupCallMinimized).toBeFalse();
    });

    it('keeps an unrelated group call running when another group is removed', () => {
        const groupAbort = jasmine.createSpy('groupAbort').and.returnValue(false);
        const active = groupConversation('active');
        const removed = groupConversation('removed');
        const groupCall = {isOngoing: true, state: {room: {conversation_id: active.id}}, abort: groupAbort} as unknown as GroupCallFacade;
        const historyComponent = new HomeComponent(
            {} as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {} as DataProviderService,
            {close: () => undefined} as CallFacade,
            undefined,
            groupCall,
        );
        historyComponent.conversations.next([active, removed]);

        historyComponent.handleSocketEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: {conversation_id: removed.id, membership_revision: 2, deleted: true}});

        expect(groupAbort).toHaveBeenCalledOnceWith(removed.id);
        expect(historyComponent.conversations.getValue().map(item => item.id)).toEqual([active.id]);
    });

    it('fences delayed membership and conversation-created lookups, then permits a newer membership revision', () => {
        const initial = {...groupConversation('projection-fence-get'), members: [groupMember('user-1', 1)]};
        const membershipLookup = new Subject<GroupConversation>();
        const createdLookup = new Subject<GroupConversation>();
        const rejoinLookup = new Subject<GroupConversation>();
        const getGroup = jasmine.createSpy('getGroup').and.returnValues(membershipLookup.asObservable(), createdLookup.asObservable(), rejoinLookup.asObservable());
        const historyComponent = new HomeComponent(
            {getGroup, list: () => EMPTY, history: () => of({messages: []})} as unknown as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {send: jasmine.createSpy('send').and.returnValue(true), close: () => undefined} as unknown as DataProviderService,
            {close: () => undefined} as CallFacade,
        );
        historyComponent.profile = {id: 'user-1'} as Profile;
        historyComponent.selectedConversation = initial;
        historyComponent.conversations.next([initial]);
        historyComponent.showGroupManager = true;

        historyComponent.handleSocketEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: {conversation_id: initial.id, membership_revision: 2, deleted: false}});
        historyComponent.handleSocketEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'conversation.created', payload: {conversation_id: initial.id}});
        historyComponent.handleSocketEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: {conversation_id: initial.id, membership_revision: 3, deleted: true}});

        membershipLookup.next({...initial, membershipRevision: 2, name: 'Old membership lookup'});
        membershipLookup.complete();
        createdLookup.next({...initial, membershipRevision: 2, name: 'Old conversation-created lookup'});
        createdLookup.complete();
        expect(historyComponent.conversations.getValue()).toEqual([]);
        expect(historyComponent.selectedConversation).toBeUndefined();
        expect(historyComponent.showGroupManager).toBeFalse();
        expect(historyComponent.groupSelected).toBeUndefined();
        expect(historyComponent.canManageGroup()).toBeFalse();

        historyComponent.handleSocketEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: {conversation_id: initial.id, membership_revision: 3, deleted: false}});
        expect(getGroup).toHaveBeenCalledTimes(2);
        historyComponent.handleSocketEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: {conversation_id: initial.id, membership_revision: 4, deleted: false}});
        rejoinLookup.next({...initial, name: 'Rejoined at a newer revision', membershipRevision: 4});
        rejoinLookup.complete();

        expect(historyComponent.conversations.getValue().map(item => item.id)).toEqual([initial.id]);
        const rejoined = historyComponent.conversations.getValue()[0];
        expect(rejoined.kind === 'group' && rejoined.membershipRevision).toBe(4);
        historyComponent.selectConversation(rejoined);
        historyComponent.toggleGroupManager();
        expect(historyComponent.canManageGroup()).toBeTrue();
        historyComponent.ngOnDestroy();
    });

    it('rejects stale mutation and conversation-list projections after a newer removal', () => {
        const owner = groupMember('user-1', 1);
        const selected = {...groupConversation('projection-fence-mutation-list'), members: [owner]};
        const mutation = new Subject<GroupConversation>();
        const staleList = new Subject<Conversation[]>();
        const remaining = conversation('still-authorized');
        const list = jasmine.createSpy('list').and.returnValues(staleList.asObservable(), of([selected, remaining]));
        const historyComponent = new HomeComponent(
            {renameGroup: () => mutation.asObservable(), list} as unknown as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {send: jasmine.createSpy('send').and.returnValue(true), close: () => undefined} as unknown as DataProviderService,
            {close: () => undefined} as CallFacade,
        );
        historyComponent.profile = {id: owner.userId} as Profile;
        historyComponent.selectedConversation = selected;
        historyComponent.conversations.next([selected]);
        historyComponent.showGroupManager = true;
        historyComponent.groupName = 'Pending rename';

        historyComponent.renameGroup();
        historyComponent.refreshChats();
        expect(historyComponent.groupLoading).toBeTrue();
        historyComponent.handleSocketEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: {conversation_id: selected.id, membership_revision: 2, deleted: true}});

        mutation.next({...selected, name: 'Late mutation response', membershipRevision: 1});
        mutation.complete();
        staleList.next([selected, remaining]);
        staleList.complete();

        expect(list).toHaveBeenCalledTimes(2);
        expect(historyComponent.conversations.getValue().map(item => item.id)).toEqual([remaining.id]);
        expect(historyComponent.selectedConversation).toBeUndefined();
        expect(historyComponent.groupSelected).toBeUndefined();
        expect(historyComponent.showGroupManager).toBeFalse();
        expect(historyComponent.canManageGroup()).toBeFalse();
        expect(historyComponent.groupLoading).toBeFalse();
        historyComponent.ngOnDestroy();
    });

    it('ignores history from a conversation that is no longer selected', () => {
        const firstHistory = new Subject<MessageHistory>();
        const secondHistory = new Subject<MessageHistory>();
        const history = jasmine.createSpy('history').and.returnValues(firstHistory.asObservable(), secondHistory.asObservable());
        const historyComponent = new HomeComponent(
            {history} as unknown as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {} as DataProviderService,
            {close: () => undefined} as CallFacade,
        );
        const firstConversation = conversation('first');
        const secondConversation = conversation('second');

        historyComponent.selectConversation(firstConversation);
        historyComponent.selectConversation(secondConversation);
        firstHistory.next({messages: [{id: 'stale', conversationId: 'first', senderId: 'user-1', clientMessageId: 'stale', sequence: 1, body: 'stale message', createdAt: '2026-01-01T00:00:00Z'}]});
        firstHistory.complete();
        secondHistory.next({messages: [{id: 'current', conversationId: 'second', senderId: 'user-2', clientMessageId: 'current', sequence: 1, body: 'current message', createdAt: '2026-01-01T00:00:00Z'}]});
        secondHistory.complete();

        expect(historyComponent.selectedConversation?.id).toBe('second');
        expect(historyComponent.messages.map(message => message.id)).toEqual(['current']);
        expect(historyComponent.isHistoryLoading).toBeFalse();
    });

    it('retains a realtime message received while selected history is loading', () => {
        const history = new Subject<MessageHistory>();
        const historyComponent = new HomeComponent(
            {history: () => history.asObservable()} as unknown as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {send: jasmine.createSpy('send').and.returnValue(true), close: () => undefined} as unknown as DataProviderService,
            {close: () => undefined} as CallFacade,
        );
        const selected = conversation('selected');

        historyComponent.selectConversation(selected);
        historyComponent.handleSocketEvent({
            version: WEBSOCKET_PROTOCOL_VERSION,
            type: 'message.created',
            payload: {id: 'live', conversation_id: selected.id, sender_id: 'user-2', client_message_id: 'live', sequence: 2, body: 'Live message', created_at: '2026-01-02T00:00:00Z'},
        });
        history.next({messages: [{id: 'history', conversationId: selected.id, senderId: 'user-1', clientMessageId: 'history', sequence: 1, body: 'Historic message', createdAt: '2026-01-01T00:00:00Z'}]});
        history.complete();

        expect(historyComponent.messages.map(message => message.id)).toEqual(['history', 'live']);
        historyComponent.ngOnDestroy();
    });

    it('reorders a background conversation and increments its unread count', () => {
        const historyComponent = new HomeComponent(
            {history: () => of({messages: [{id: 'background-message', conversationId: 'background', senderId: 'user-background', clientMessageId: 'background-message', sequence: 1, body: 'New message', createdAt: '2026-01-02T00:00:00Z'}]})} as unknown as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {send: jasmine.createSpy('send').and.returnValue(true), close: () => undefined} as unknown as DataProviderService,
            {close: () => undefined} as CallFacade,
        );
        const selected = conversation('selected');
        const background = conversation('background');
        historyComponent.selectedConversation = selected;
        historyComponent.conversations.next([selected, background]);
        historyComponent.socketReady = true;

        historyComponent.handleSocketEvent({
            version: WEBSOCKET_PROTOCOL_VERSION,
            type: 'message.created',
            payload: {id: 'message-1', conversation_id: 'background', sender_id: 'user-2', client_message_id: 'message-1', sequence: 1, body: 'New message', created_at: '2026-01-02T00:00:00Z'},
        });

        expect(historyComponent.conversations.getValue().map(item => item.id)).toEqual(['background', 'selected']);
        expect(historyComponent.conversations.getValue()[0].unreadCount).toBe(1);
        expect(historyComponent.conversations.getValue()[0].lastMessageAt).toBe('2026-01-02T00:00:00Z');

        historyComponent.selectConversation(historyComponent.conversations.getValue()[0]);

        expect(historyComponent.conversations.getValue()[0].unreadCount).toBe(0);
    });

    it('restores a saved conversation after the conversation list loads', () => {
        const savedConversation = conversation('saved');
        const historyComponent = new HomeComponent(
            {history: () => of({messages: []})} as unknown as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {} as DataProviderService,
            {close: () => undefined} as CallFacade,
        );
        window.localStorage.setItem('zwei_selected_conversation', savedConversation.id);

        (historyComponent as unknown as { restoreSelectedConversation(conversations: Conversation[]): void }).restoreSelectedConversation([savedConversation]);

        expect(historyComponent.selectedConversation?.id).toBe(savedConversation.id);
        expect(window.localStorage.getItem('zwei_selected_conversation')).toBe(savedConversation.id);
    });

    it('removes a saved conversation that is no longer available', () => {
        const historyComponent = new HomeComponent(
            {} as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {} as DataProviderService,
            {close: () => undefined} as CallFacade,
        );
        window.localStorage.setItem('zwei_selected_conversation', 'missing');

        (historyComponent as unknown as { restoreSelectedConversation(conversations: Conversation[]): void }).restoreSelectedConversation([]);

        expect(window.localStorage.getItem('zwei_selected_conversation')).toBeNull();
    });

    it('uses presence events to show the selected peer online or offline', () => {
        const historyComponent = new HomeComponent(
            {} as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {} as DataProviderService,
            {close: () => undefined} as CallFacade,
        );
        historyComponent.selectedConversation = conversation('peer');
        historyComponent.socketReady = true;

        expect(historyComponent.peerPresenceLabel()).toBe('Checking presence…');
        historyComponent.handleSocketEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'presence.snapshot', payload: {user_ids: ['user-peer']}});
        expect(historyComponent.peerPresenceLabel()).toBe('Online');
        historyComponent.handleSocketEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'presence.changed', payload: {user_id: 'user-peer', online: false}});
        expect(historyComponent.peerPresenceLabel()).toBe('Offline');
    });

    it('refreshes presence when selecting a group but preserves direct selection behavior', () => {
        const send = jasmine.createSpy('send').and.returnValue(true);
        const historyComponent = new HomeComponent(
            {history: () => of({messages: []})} as unknown as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {send, close: () => undefined} as unknown as DataProviderService,
            {close: () => undefined} as CallFacade,
        );
        historyComponent.socketReady = true;

        historyComponent.selectConversation(conversation('direct'));
        expect(send).not.toHaveBeenCalled();

        historyComponent.selectConversation(groupConversation('group'));

        expect(send).toHaveBeenCalledOnceWith({type: 'presence.refresh'});
        historyComponent.ngOnDestroy();
    });

    it('coalesces rapid group selections into one trailing presence refresh', fakeAsync(() => {
        const send = jasmine.createSpy('send').and.returnValue(true);
        const historyComponent = new HomeComponent(
            {history: () => of({messages: []})} as unknown as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {send, close: () => undefined} as unknown as DataProviderService,
            {close: () => undefined} as CallFacade,
        );
        const group = groupConversation('group');
        historyComponent.socketReady = true;

        historyComponent.selectConversation(group);
        historyComponent.selectConversation(group);
        expect(send).toHaveBeenCalledTimes(1);

        tick(1_000);
        expect(send).toHaveBeenCalledTimes(2);
        historyComponent.ngOnDestroy();
    }));

    it('refreshes selected group presence when the membership projection changes', () => {
        const existing = groupConversation('group');
        const updated = {...existing, membershipRevision: existing.membershipRevision + 1};
        const send = jasmine.createSpy('send').and.returnValue(true);
        const historyComponent = new HomeComponent(
            {history: () => of({messages: []}), getGroup: () => of(updated)} as unknown as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {send, close: () => undefined} as unknown as DataProviderService,
            {close: () => undefined} as CallFacade,
        );
        historyComponent.socketReady = true;
        historyComponent.selectedConversation = existing;
        historyComponent.conversations.next([existing]);

        historyComponent.handleSocketEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: {conversation_id: existing.id, membership_revision: updated.membershipRevision, deleted: false}});

        expect(historyComponent.selectedConversation?.kind === 'group' && historyComponent.selectedConversation.membershipRevision).toBe(updated.membershipRevision);
        expect(send).toHaveBeenCalledOnceWith({type: 'presence.refresh'});
        historyComponent.ngOnDestroy();
    });

    it('keeps a selected group and its call after a transient membership projection error', () => {
        const selected = groupConversation('selected-group');
        const abort = jasmine.createSpy('abort').and.returnValue(true);
        const groupCall = {isOngoing: true, state: {room: {conversation_id: selected.id}}, abort} as unknown as GroupCallFacade;
        const historyComponent = new HomeComponent(
            {getGroup: () => throwError(() => new HttpErrorResponse({status: 503}))} as unknown as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {} as DataProviderService,
            {close: () => undefined} as CallFacade,
            undefined,
            groupCall,
        );
        historyComponent.selectedConversation = selected;
        historyComponent.conversations.next([selected]);

        historyComponent.handleSocketEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: {conversation_id: selected.id, membership_revision: 2, deleted: false}});

        expect(historyComponent.selectedConversation?.id).toBe(selected.id);
        expect(historyComponent.conversations.getValue().map(item => item.id)).toEqual([selected.id]);
        expect(abort).not.toHaveBeenCalled();
        expect(historyComponent.groupMembershipRefreshError).toContain('remains selected');
        expect(historyComponent.groupMembershipRefreshErrorConversationID).toBe(selected.id);
    });

    it('preserves the selected group and call after an authentication failure', () => {
        const selected = groupConversation('auth-failure-group');
        const abort = jasmine.createSpy('abort').and.returnValue(true);
        const groupCall = {isOngoing: true, state: {room: {conversation_id: selected.id}}, abort} as unknown as GroupCallFacade;
        const historyComponent = new HomeComponent(
            {getGroup: () => throwError(() => new HttpErrorResponse({status: 401}))} as unknown as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {} as DataProviderService,
            {close: () => undefined} as CallFacade,
            undefined,
            groupCall,
        );
        historyComponent.selectedConversation = selected;
        historyComponent.conversations.next([selected]);

        historyComponent.handleSocketEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: {conversation_id: selected.id, membership_revision: 2, deleted: false}});

        expect(historyComponent.selectedConversation?.id).toBe(selected.id);
        expect(historyComponent.conversations.getValue().map(item => item.id)).toEqual([selected.id]);
        expect(abort).not.toHaveBeenCalled();
        expect(historyComponent.groupMembershipRefreshError).toContain('session may have expired');
    });

    it('removes a group projection only for explicit forbidden or not-found HTTP errors', () => {
        for (const status of [403, 404]) {
            const selected = groupConversation(`confirmed-removal-${status}`);
            const historyComponent = new HomeComponent(
                {getGroup: () => throwError(() => new HttpErrorResponse({status}))} as unknown as ConversationService,
                {} as AuthService,
                {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
                {} as DataProviderService,
                {close: () => undefined} as CallFacade,
            );
            historyComponent.selectedConversation = selected;
            historyComponent.conversations.next([selected]);

            historyComponent.handleSocketEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: {conversation_id: selected.id, membership_revision: 2, deleted: false}});

            expect(historyComponent.selectedConversation).toBeUndefined();
            expect(historyComponent.conversations.getValue()).toEqual([]);
        }
    });

    it('refreshes a failed selected group projection and revision from Refresh chats', () => {
        const selected = groupConversation('refresh-selected-group');
        const refreshed = {...selected, name: 'Refreshed group', membershipRevision: selected.membershipRevision + 1};
        const list = jasmine.createSpy('list').and.returnValue(of([refreshed]));
        const historyComponent = new HomeComponent(
            {getGroup: () => throwError(() => new HttpErrorResponse({status: 503})), list} as unknown as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {} as DataProviderService,
            {close: () => undefined} as CallFacade,
        );
        historyComponent.selectedConversation = selected;
        historyComponent.conversations.next([selected]);

        historyComponent.handleSocketEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: {conversation_id: selected.id, membership_revision: refreshed.membershipRevision, deleted: false}});
        expect(historyComponent.groupMembershipRefreshErrorConversationID).toBe(selected.id);

        historyComponent.refreshChats();

        expect(list).toHaveBeenCalledTimes(1);
        expect(historyComponent.selectedConversation).toEqual(refreshed);
        expect(historyComponent.groupMembershipRefreshError).toBe('');
        expect(historyComponent.groupMembershipRefreshErrorConversationID).toBeUndefined();
    });

    it('recovers a transient HTTP 500 group projection lookup through Refresh chats', () => {
        const selected = groupConversation('refresh-after-server-error');
        const refreshed = {...selected, name: 'Recovered group', membershipRevision: selected.membershipRevision + 1};
        const list = jasmine.createSpy('list').and.returnValue(of([refreshed]));
        const abort = jasmine.createSpy('abort').and.returnValue(true);
        const groupCall = {isOngoing: true, state: {room: {conversation_id: selected.id}}, abort} as unknown as GroupCallFacade;
        const historyComponent = new HomeComponent(
            {getGroup: () => throwError(() => new HttpErrorResponse({status: 500})), list} as unknown as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {} as DataProviderService,
            {close: () => undefined} as CallFacade,
            undefined,
            groupCall,
        );
        historyComponent.selectedConversation = selected;
        historyComponent.conversations.next([selected]);

        historyComponent.handleSocketEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: {conversation_id: selected.id, membership_revision: refreshed.membershipRevision, deleted: false}});

        expect(historyComponent.selectedConversation?.id).toBe(selected.id);
        expect(historyComponent.conversations.getValue().map(item => item.id)).toEqual([selected.id]);
        expect(abort).not.toHaveBeenCalled();
        expect(historyComponent.groupMembershipRefreshError).toContain('remains selected');
        expect(historyComponent.groupMembershipRefreshErrorConversationID).toBe(selected.id);

        historyComponent.refreshChats();

        expect(list).toHaveBeenCalledTimes(1);
        expect(historyComponent.selectedConversation).toEqual(refreshed);
        expect(historyComponent.conversations.getValue()).toEqual([refreshed]);
        expect(abort).not.toHaveBeenCalled();
        expect(historyComponent.groupMembershipRefreshError).toBe('');
        expect(historyComponent.groupMembershipRefreshErrorConversationID).toBeUndefined();
    });

    it('clears a selected group and its call state when a successful chat refresh confirms it is absent', () => {
        const selected = {...groupConversation('removed-group'), unreadCount: 4};
        const remaining = conversation('remaining-conversation');
        const list = jasmine.createSpy('list').and.returnValue(of([remaining]));
        const abort = jasmine.createSpy('abort').and.returnValue(true);
        const groupCall = {isOngoing: true, state: {room: {conversation_id: selected.id}}, abort} as unknown as GroupCallFacade;
        const historyComponent = new HomeComponent(
            {list} as unknown as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {finishRecovery: jasmine.createSpy('finishRecovery')} as unknown as DataProviderService,
            {close: () => undefined} as CallFacade,
            undefined,
            groupCall,
        );
        historyComponent.selectedConversation = selected;
        historyComponent.conversations.next([selected, remaining]);
        historyComponent.messages = [{id: 'old-message', conversationId: selected.id, senderId: 'peer', clientMessageId: 'old-client', sequence: 3, body: 'Private history', createdAt: '2026-01-01T00:00:00Z'}];
        historyComponent.historyCursor = '2';
        historyComponent.groupCallMinimized = true;
        historyComponent.groupMembershipRefreshError = 'Stale membership';
        historyComponent.groupMembershipRefreshErrorConversationID = selected.id;

        historyComponent.refreshChats();

        expect(list).toHaveBeenCalledTimes(1);
        expect(historyComponent.selectedConversation).toBeUndefined();
        expect(historyComponent.messages).toEqual([]);
        expect(historyComponent.historyCursor).toBeUndefined();
        expect(historyComponent.isHistoryLoading).toBeFalse();
        expect(historyComponent.conversations.getValue()).toEqual([remaining]);
        expect(historyComponent.groupCallMinimized).toBeFalse();
        expect(abort).toHaveBeenCalledOnceWith(selected.id);
        expect(historyComponent.groupMembershipRefreshError).toBe('');
        expect(historyComponent.groupMembershipRefreshErrorConversationID).toBeUndefined();
    });

    it('clears an absent direct conversation and its chat state without ending an active call', () => {
        const selected = {...conversation('removed-direct'), unreadCount: 3};
        const remaining = conversation('remaining-direct');
        const list = jasmine.createSpy('list').and.returnValue(of([remaining]));
        const callState = {phase: 'active'};
        const closeCall = jasmine.createSpy('close');
        const historyComponent = new HomeComponent(
            {list} as unknown as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {finishRecovery: jasmine.createSpy('finishRecovery')} as unknown as DataProviderService,
            {state: callState, close: closeCall} as unknown as CallFacade,
        );
        historyComponent.selectedConversation = selected;
        historyComponent.conversations.next([selected, remaining]);
        historyComponent.messages = [{id: 'direct-message', conversationId: selected.id, senderId: 'peer', clientMessageId: 'direct-client', sequence: 4, body: 'Private history', createdAt: '2026-01-01T00:00:00Z'}];
        historyComponent.historyCursor = '3';
        historyComponent['ownReadSequences'].set(selected.id, 4);
        historyComponent['peerReadSequences'].set(selected.id, 2);
        historyComponent['typingConversationID'] = selected.id;

        historyComponent.refreshChats();

        expect(list).toHaveBeenCalledTimes(1);
        expect(historyComponent.selectedConversation).toBeUndefined();
        expect(historyComponent.messages).toEqual([]);
        expect(historyComponent.historyCursor).toBeUndefined();
        expect(historyComponent.isHistoryLoading).toBeFalse();
        expect(historyComponent.conversations.getValue()).toEqual([remaining]);
        expect(historyComponent['ownReadSequences'].has(selected.id)).toBeFalse();
        expect(historyComponent['peerReadSequences'].has(selected.id)).toBeFalse();
        expect(historyComponent['typingConversationID']).toBeUndefined();
        expect(historyComponent.isOngoingCall()).toBeTrue();
        expect(closeCall).not.toHaveBeenCalled();
    });

    it('preserves a selected direct conversation when chat refresh fails transiently', fakeAsync(() => {
        const selected = conversation('temporarily-unavailable-direct');
        const list = jasmine.createSpy('list').and.returnValue(throwError(() => new HttpErrorResponse({status: 503})));
        const history: Message[] = [{id: 'retained-direct-message', conversationId: selected.id, senderId: 'peer', clientMessageId: 'retained-direct-client', sequence: 1, body: 'Still authorized until confirmed', createdAt: '2026-01-01T00:00:00Z'}];
        const historyComponent = new HomeComponent(
            {list} as unknown as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {} as DataProviderService,
            {state: {phase: 'active'}, close: jasmine.createSpy('close')} as unknown as CallFacade,
        );
        historyComponent.selectedConversation = selected;
        historyComponent.conversations.next([selected]);
        historyComponent.messages = history;
        historyComponent.historyCursor = '1';
        historyComponent['ownReadSequences'].set(selected.id, 1);

        historyComponent.refreshChats();
        tick(500);

        expect(list).toHaveBeenCalledTimes(3);
        expect(historyComponent.selectedConversation).toEqual(selected);
        expect(historyComponent.messages).toEqual(history);
        expect(historyComponent.historyCursor).toBe('1');
        expect(historyComponent.conversations.getValue()).toEqual([selected]);
        expect(historyComponent['ownReadSequences'].get(selected.id)).toBe(1);
    }));

    it('preserves selected group, history, and call state when Refresh chats fails', fakeAsync(() => {
        const selected = groupConversation('temporarily-unavailable-group');
        const abort = jasmine.createSpy('abort').and.returnValue(true);
        const groupCall = {isOngoing: true, state: {room: {conversation_id: selected.id}}, abort} as unknown as GroupCallFacade;
        const historyComponent = new HomeComponent(
            {list: () => throwError(() => new HttpErrorResponse({status: 503}))} as unknown as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {} as DataProviderService,
            {close: () => undefined} as CallFacade,
            undefined,
            groupCall,
        );
        const history: Message[] = [{id: 'retained-message', conversationId: selected.id, senderId: 'peer', clientMessageId: 'retained-client', sequence: 1, body: 'Still authorized until confirmed', createdAt: '2026-01-01T00:00:00Z'}];
        historyComponent.selectedConversation = selected;
        historyComponent.conversations.next([selected]);
        historyComponent.messages = history;
        historyComponent.historyCursor = '1';
        historyComponent.groupCallMinimized = true;

        historyComponent.refreshChats();
        tick(500);

        expect(historyComponent.selectedConversation?.id).toBe(selected.id);
        expect(historyComponent.messages).toEqual(history);
        expect(historyComponent.historyCursor).toBe('1');
        expect(historyComponent.conversations.getValue()).toEqual([selected]);
        expect(historyComponent.groupCallMinimized).toBeTrue();
        expect(abort).not.toHaveBeenCalled();
    }));

    it('preserves a selected group when conversation-created projection lookup fails transiently', () => {
        const selected = groupConversation('created-group');
        const list = jasmine.createSpy('list').and.returnValue(of([selected]));
        const send = jasmine.createSpy('send').and.returnValue(true);
        const historyComponent = new HomeComponent(
            {getGroup: () => throwError(() => new HttpErrorResponse({status: 503})), list} as unknown as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {send, close: () => undefined} as unknown as DataProviderService,
            {close: () => undefined} as CallFacade,
        );
        historyComponent.selectedConversation = selected;
        historyComponent.conversations.next([selected]);

        historyComponent.handleSocketEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'conversation.created', payload: {conversation_id: selected.id}});

        expect(historyComponent.selectedConversation?.id).toBe(selected.id);
        expect(historyComponent.conversations.getValue().map(item => item.id)).toContain(selected.id);
        expect(historyComponent.groupMembershipRefreshErrorConversationID).toBe(selected.id);
    });

    it('clears a group typing indicator immediately on a peer stop and preserves direct stop behavior', fakeAsync(() => {
        const historyComponent = new HomeComponent(
            {} as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {close: () => undefined} as unknown as DataProviderService,
            {close: () => undefined} as CallFacade,
        );
        historyComponent.profile = {id: 'self'} as Profile;
        const group = {...groupConversation('group'), members: [groupMember('peer', 1)]};
        historyComponent.selectedConversation = group;
        historyComponent.handleSocketEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'typing.started', payload: {conversation_id: group.id, user_id: 'peer'}});
        expect(historyComponent.isSelectedUserTyping()).toBeTrue();

        historyComponent.handleSocketEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'typing.stopped', payload: {conversation_id: group.id, user_id: 'peer'}});
        expect(historyComponent.isSelectedUserTyping()).toBeFalse();

        const direct = conversation('direct');
        historyComponent.selectedConversation = direct;
        historyComponent.handleSocketEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'typing.started', payload: {conversation_id: direct.id, user_id: direct.otherUserId}});
        expect(historyComponent.isSelectedUserTyping()).toBeTrue();
        historyComponent.handleSocketEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'typing.stopped', payload: {conversation_id: direct.id, user_id: direct.otherUserId}});
        expect(historyComponent.isSelectedUserTyping()).toBeFalse();
        tick(5_001);
        historyComponent.ngOnDestroy();
    }));

    it('refreshes peer presence when a new conversation is delivered', () => {
        const send = jasmine.createSpy('send').and.returnValue(true);
        const list = jasmine.createSpy('list').and.returnValue(of([conversation('new')]));
        const historyComponent = new HomeComponent(
            {list} as unknown as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {send} as unknown as DataProviderService,
            {close: () => undefined} as CallFacade,
        );
        historyComponent.selectedConversation = conversation('new');
        historyComponent.socketReady = true;
        historyComponent.presenceReady = true;

        historyComponent.handleSocketEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'conversation.created', payload: {conversation_id: 'new'}});
        historyComponent.handleSocketEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'presence.snapshot', payload: {user_ids: ['user-new']}});

        expect(send).toHaveBeenCalledWith({type: 'presence.refresh'});
        expect(historyComponent.peerPresenceLabel()).toBe('Online');
    });

    it('retries a failed conversation refresh after a conversation-created event', fakeAsync(() => {
        const list = jasmine.createSpy('list').and.returnValues(
            throwError(() => new Error('temporary failure')),
            of([conversation('new')]),
        );
        const historyComponent = new HomeComponent(
            {list} as unknown as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {send: jasmine.createSpy('send').and.returnValue(true), close: () => undefined} as unknown as DataProviderService,
            {close: () => undefined} as CallFacade,
        );

        historyComponent.handleSocketEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'conversation.created', payload: {conversation_id: 'new'}});
        tick(250);

        expect(list).toHaveBeenCalledTimes(2);
        expect(historyComponent.conversations.getValue().map(item => item.id)).toEqual(['new']);
        historyComponent.ngOnDestroy();
    }));

    it('uses the initial conversation list to complete first realtime recovery', () => {
        const connectionStateChanges = new BehaviorSubject<'offline' | 'connecting' | 'recovering' | 'ready' | 'failed'>('offline');
        const list = jasmine.createSpy('list').and.returnValue(of([conversation('recovered')]));
        const finishRecovery = jasmine.createSpy('finishRecovery');
        const historyComponent = new HomeComponent(
            {list} as unknown as ConversationService,
            {profile: () => of({id: 'user-1'} as Profile)} as unknown as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {getObservable: () => EMPTY, connectionStateChanges, finishRecovery, close: () => undefined} as unknown as DataProviderService,
            {state$: of({phase: 'idle'}), close: () => undefined} as unknown as CallFacade,
        );

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
        const send = jasmine.createSpy('send').and.returnValue(true);
        const historyComponent = new HomeComponent(
            {list: () => of([]), history: () => of({messages: []})} as unknown as ConversationService,
            {profile: () => of({id: 'user-1'} as Profile)} as unknown as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {getObservable: () => EMPTY, connectionStateChanges, send, close: () => undefined} as unknown as DataProviderService,
            {state$: of({phase: 'idle'}), close: () => undefined} as unknown as CallFacade,
        );
        historyComponent.ngOnInit();
        historyComponent.selectConversation(groupConversation('selected-group'));

        expect(send).not.toHaveBeenCalled();

        connectionStateChanges.next('ready');

        expect(send).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledWith({type: 'presence.refresh'});
        historyComponent.ngOnDestroy();
    });

    it('retries an empty initial conversation projection before rendering the rail', fakeAsync(() => {
        const connectionStateChanges = new BehaviorSubject<'offline' | 'connecting' | 'recovering' | 'ready' | 'failed'>('offline');
        const list = jasmine.createSpy('list').and.returnValues(of([]), of([conversation('bob')]));
        const historyComponent = new HomeComponent(
            {list} as unknown as ConversationService,
            {profile: () => of({id: 'user-1'} as Profile)} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {getObservable: () => EMPTY, connectionStateChanges, close: () => undefined} as unknown as DataProviderService,
            {state$: of({phase: 'idle'}), close: () => undefined} as unknown as CallFacade,
        );

        historyComponent.ngOnInit();
        tick(250);

        expect(list).toHaveBeenCalledTimes(2);
        expect(historyComponent.conversations.getValue().map(item => item.id)).toEqual(['bob']);
        historyComponent.ngOnDestroy();
    }));

    it('keeps the recovery conversation list when presence completes recovery first', () => {
        const connectionStateChanges = new BehaviorSubject<'offline' | 'connecting' | 'recovering' | 'ready' | 'failed'>('offline');
        const recoveryList = new Subject<Conversation[]>();
        const list = jasmine.createSpy('list').and.returnValues(of([]), recoveryList.asObservable());
        const historyComponent = new HomeComponent(
            {list} as unknown as ConversationService,
            {profile: () => of({id: 'user-1'} as Profile)} as unknown as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {getObservable: () => EMPTY, connectionStateChanges, finishRecovery: jasmine.createSpy('finishRecovery'), close: () => undefined} as unknown as DataProviderService,
            {state$: of({phase: 'idle'}), close: () => undefined} as unknown as CallFacade,
        );

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
        const list = jasmine.createSpy('list').and.returnValues(of([]), recoveryList.asObservable());
        const historyComponent = new HomeComponent(
            {list, history: () => of({messages: []})} as unknown as ConversationService,
            {profile: () => of({id: 'user-1'} as Profile)} as unknown as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {getObservable: () => EMPTY, connectionStateChanges, recover: jasmine.createSpy('recover').and.returnValue(true), close: () => undefined} as unknown as DataProviderService,
            {state$: of({phase: 'idle'}), close: () => undefined} as unknown as CallFacade,
        );

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
        const history = jasmine.createSpy('history').and.returnValue(of({messages: []}));
        const connectionStateChanges = new BehaviorSubject<'offline' | 'connecting' | 'recovering' | 'ready' | 'failed'>('offline');
        let reconciliationRequestID = '';
        const historyComponent = new HomeComponent(
            {list: jasmine.createSpy('list').and.returnValues(of([]), of([selected])), history} as unknown as ConversationService,
            {profile: () => of({id: 'user-1'} as Profile)} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {getObservable: () => EMPTY, connectionStateChanges, recover: (_conversationID: string, _afterSequence: number, requestID: string) => { reconciliationRequestID = requestID; return true; }, close: () => undefined} as unknown as DataProviderService,
            {state$: of({phase: 'idle'}), close: () => undefined} as unknown as CallFacade,
        );
        historyComponent.ngOnInit();
        historyComponent.selectConversation(selected);
        connectionStateChanges.next('ready');
        connectionStateChanges.next('recovering');
        const historyLoadsBeforeRejection = history.calls.count();

        historyComponent.handleSocketEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'message.rejected', request_id: reconciliationRequestID, payload: {error: 'conversation not found'}});

        expect(history.calls.count()).toBe(historyLoadsBeforeRejection + 1);
        historyComponent.ngOnDestroy();
    });

    it('uses the incoming call conversation when no chat is selected', () => {
        const incoming = conversation('incoming');
        const historyComponent = new HomeComponent(
            {} as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {} as DataProviderService,
            {state: {phase: 'incoming', conversationID: incoming.id}, close: () => undefined} as unknown as CallFacade,
        );
        historyComponent.conversations.next([incoming]);

        expect(historyComponent.callDisplayName()).toBe('incoming');
        expect(historyComponent.callInitials()).toBe('IN');
        expect(historyComponent.headerDisplayName()).toBe('incoming');
        expect(historyComponent.headerInitials()).toBe('IN');
    });

    it('renders the selected chat header while an active call is minimized', () => {
        const callConversation = conversation('call-peer');
        const selectedConversation = conversation('other-peer');
        const historyComponent = new HomeComponent(
            {} as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {} as DataProviderService,
            {state: {phase: 'active', conversationID: callConversation.id}, close: () => undefined} as unknown as CallFacade,
        );
        historyComponent.conversations.next([callConversation, selectedConversation]);
        historyComponent.selectedConversation = selectedConversation;

        expect(historyComponent.callDisplayName()).toBe('call-peer');
        expect(historyComponent.headerDisplayName()).toBe('other-peer');
        expect(historyComponent.headerInitials()).toBe('OT');
    });

    it('minimizes an active call when another conversation is selected and preserves it when restored', () => {
        const callConversation = conversation('call-peer');
        const selectedConversation = conversation('other-peer');
        const historyComponent = new HomeComponent(
            {history: () => of({messages: []})} as unknown as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {} as DataProviderService,
            {state: {phase: 'active', conversationID: callConversation.id}, close: () => undefined} as unknown as CallFacade,
        );
        historyComponent.conversations.next([callConversation, selectedConversation]);
        historyComponent.selectedConversation = callConversation;

        historyComponent.selectConversation(selectedConversation);

        expect(historyComponent.isCallMinimized()).toBeTrue();
        expect(historyComponent.selectedConversation?.id).toBe(selectedConversation.id);

        historyComponent.restoreCall();

        expect(historyComponent.isCallSurfaceVisible()).toBeTrue();
        expect(historyComponent.selectedConversation?.id).toBe(callConversation.id);
    });

    it('selects the caller conversation when an incoming call arrives', () => {
        const incoming = conversation('incoming');
        const historyComponent = new HomeComponent(
            {history: () => of({messages: []})} as unknown as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {} as DataProviderService,
            {close: () => undefined} as CallFacade,
        );
        historyComponent.conversations.next([incoming]);

        historyComponent.handleSocketEvent({
            version: WEBSOCKET_PROTOCOL_VERSION,
            type: 'call.incoming',
            payload: {call_id: 'call-1', conversation_id: incoming.id, caller_id: incoming.otherUserId, recipient_id: 'user-me', caller_device_id: 'device-1', status: 'ringing', expires_at: '2026-01-01T00:00:30Z'},
        });

        expect(historyComponent.selectedConversation?.id).toBe(incoming.id);
    });

    it('clears the same conversation unread count for every user device', () => {
        const historyComponent = new HomeComponent(
            {} as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {} as DataProviderService,
            {close: () => undefined} as CallFacade,
        );
        historyComponent.profile = {id: 'user-me'} as Profile;
        historyComponent.conversations.next([{...conversation('background'), unreadCount: 3}]);

        historyComponent.handleSocketEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'conversation.read', payload: {conversation_id: 'background', user_id: 'user-me', sequence: 4}});

        expect(historyComponent.conversations.getValue()[0].unreadCount).toBe(0);
    });

    it('excludes group members who joined after an outgoing message', () => {
        const group = groupConversation('group-read') as GroupConversation;
        group.members = [groupMember('user-me', 1), groupMember('later-member', 5)];
        const historyComponent = new HomeComponent({} as ConversationService, {} as AuthService, {markForCheck: () => undefined} as ChangeDetectorRef, {} as DataProviderService, {close: () => undefined} as CallFacade);
        historyComponent.profile = {id: 'user-me'} as Profile;
        historyComponent.selectedConversation = group;
        historyComponent.conversations.next([group]);
        historyComponent.messages = [ownMessage(group.id, 4)];
        historyComponent.handleSocketEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'conversation.read', payload: {conversation_id: group.id, user_id: 'later-member', sequence: 9, visible_from_sequence: 1}});

        expect(historyComponent.isLatestReadMessage(historyComponent.messages[0])).toBeFalse();
        expect(historyComponent.readReceiptLabel(historyComponent.messages[0])).toBe('Read by at least one member');
    });

    it('ignores inactive group members and marks only the latest qualifying outgoing message as cursors advance', () => {
        const group = groupConversation('group-read') as GroupConversation;
        group.members = [groupMember('user-me', 1), groupMember('member-a', 1), groupMember('member-b', 1)];
        const historyComponent = new HomeComponent({} as ConversationService, {} as AuthService, {markForCheck: () => undefined} as ChangeDetectorRef, {} as DataProviderService, {close: () => undefined} as CallFacade);
        historyComponent.profile = {id: 'user-me'} as Profile;
        historyComponent.selectedConversation = group;
        historyComponent.conversations.next([group]);
        historyComponent.messages = [ownMessage(group.id, 2), ownMessage(group.id, 4), ownMessage(group.id, 6)];
        historyComponent.handleSocketEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'conversation.read', payload: {conversation_id: group.id, user_id: 'member-a', sequence: 4, visible_from_sequence: 1}});
        expect(historyComponent.isLatestReadMessage(historyComponent.messages[1])).toBeTrue();
        expect(historyComponent.isLatestReadMessage(historyComponent.messages[0])).toBeFalse();

        historyComponent.handleSocketEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'conversation.read', payload: {conversation_id: group.id, user_id: 'member-a', sequence: 6, visible_from_sequence: 1}});
        expect(historyComponent.isLatestReadMessage(historyComponent.messages[2])).toBeTrue();
        expect(historyComponent.isLatestReadMessage(historyComponent.messages[1])).toBeFalse();

        group.members = group.members.filter(member => member.userId !== 'member-a');
        expect(historyComponent.isLatestReadMessage(historyComponent.messages[2])).toBeFalse();
        historyComponent.handleSocketEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'conversation.read', payload: {conversation_id: group.id, user_id: 'member-b', sequence: 6, visible_from_sequence: 1}});
        expect(historyComponent.isLatestReadMessage(historyComponent.messages[2])).toBeTrue();
    });

    it('shows no group receipt without peer cursors while preserving direct peer receipts', () => {
        const group = groupConversation('group-read') as GroupConversation;
        group.members = [groupMember('user-me', 1), groupMember('member-a', 1)];
        const direct = conversation('direct-read');
        const historyComponent = new HomeComponent({} as ConversationService, {} as AuthService, {markForCheck: () => undefined} as ChangeDetectorRef, {} as DataProviderService, {close: () => undefined} as CallFacade);
        historyComponent.profile = {id: 'user-me'} as Profile;
        historyComponent.selectedConversation = group;
        historyComponent.conversations.next([group, direct]);
        const groupMessage = ownMessage(group.id, 3);
        const directMessage = ownMessage(direct.id, 3);
        historyComponent.messages = [groupMessage, directMessage];
        historyComponent.handleSocketEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'conversation.read', payload: {conversation_id: group.id, user_id: 'member-a', sequence: 3}});
        expect(historyComponent.isLatestReadMessage(groupMessage)).toBeFalse();
        historyComponent.handleSocketEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'conversation.read', payload: {conversation_id: direct.id, user_id: direct.otherUserId, sequence: 3}});
        expect(historyComponent.isLatestReadMessage(directMessage)).toBeTrue();
        expect(historyComponent.readReceiptLabel(directMessage)).toBe('Read by peer');
    });

    it('applies reconciliation account cursors monotonically without using the group scalar', () => {
        const group = groupConversation('group-read') as GroupConversation;
        group.members = [groupMember('user-me', 1), groupMember('member-a', 1), groupMember('member-b', 1)];
        const historyComponent = new HomeComponent({} as ConversationService, {} as AuthService, {markForCheck: () => undefined} as ChangeDetectorRef, {} as DataProviderService, {close: () => undefined} as CallFacade);
        historyComponent.profile = {id: 'user-me'} as Profile;
        historyComponent.selectedConversation = group;
        historyComponent.conversations.next([group]);
        historyComponent.messages = [ownMessage(group.id, 3)];
        (historyComponent as unknown as {recoveryGeneration: number; reconciliationRequest: unknown}).recoveryGeneration = 2;
        (historyComponent as unknown as {reconciliationRequest: unknown}).reconciliationRequest = {generation: 2, requestID: 'reconcile-group', conversationID: group.id};
        const payload = {...reconciliationPayload(group.id, 3), messages: [], has_more: false, peer_read_sequence: 0, peer_read_cursors: [
            {user_id: 'member-a', sequence: 3, visible_from_sequence: 1},
            {user_id: 'member-b', sequence: 2, visible_from_sequence: 1},
        ]};

        historyComponent.handleSocketEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'conversation.reconciled', request_id: 'reconcile-group', payload});

        expect(historyComponent.isLatestReadMessage(historyComponent.messages[0])).toBeTrue();
        historyComponent.handleSocketEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'conversation.read', payload: {conversation_id: group.id, user_id: 'member-a', sequence: 1, visible_from_sequence: 1}});
        expect(historyComponent.isLatestReadMessage(historyComponent.messages[0])).toBeTrue();
    });

    it('shows an unread badge for an incoming message while the call surface is open', () => {
        const send = jasmine.createSpy('send').and.returnValue(true);
        const selected = conversation('selected');
        const historyComponent = new HomeComponent(
            {} as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {send} as unknown as DataProviderService,
            {state: {phase: 'active', conversationID: selected.id}, close: () => undefined} as unknown as CallFacade,
        );
        historyComponent.profile = {id: 'user-me'} as Profile;
        historyComponent.selectedConversation = selected;
        historyComponent.conversations.next([selected]);
        historyComponent.socketReady = true;

        historyComponent.handleSocketEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'message.created', payload: {id: 'call-message', conversation_id: selected.id, sender_id: selected.otherUserId, client_message_id: 'call-message', sequence: 2, body: 'While calling', created_at: '2026-01-01T00:00:02Z'}});

        expect(historyComponent.conversations.getValue()[0].unreadCount).toBe(1);
        expect(send).not.toHaveBeenCalledWith({type: 'conversation.read', payload: {conversation_id: selected.id, sequence: 2}});
    });

    it('marks call-time messages read when the call is minimized', () => {
        const send = jasmine.createSpy('send').and.returnValue(true);
        const selected = conversation('selected');
        const historyComponent = new HomeComponent(
            {} as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {send} as unknown as DataProviderService,
            {state: {phase: 'active', conversationID: selected.id}, close: () => undefined} as unknown as CallFacade,
        );
        historyComponent.profile = {id: 'user-me'} as Profile;
        historyComponent.selectedConversation = selected;
        historyComponent.conversations.next([{...selected, unreadCount: 1}]);
        historyComponent.messages = [{id: 'call-message', conversationId: selected.id, senderId: selected.otherUserId, clientMessageId: 'call-message', sequence: 2, body: 'While calling', createdAt: '2026-01-01T00:00:02Z'}];
        historyComponent.socketReady = true;

        historyComponent.minimizeCall();

        expect(send).toHaveBeenCalledWith({type: 'conversation.read', payload: {conversation_id: selected.id, sequence: 2}});
        expect(historyComponent.conversations.getValue()[0].unreadCount).toBe(0);
    });

    it('refreshes typing while composing so the peer indicator does not expire', fakeAsync(() => {
        const send = jasmine.createSpy('send').and.returnValue(true);
        const historyComponent = new HomeComponent(
            {} as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {send, close: () => undefined} as unknown as DataProviderService,
            {close: () => undefined} as CallFacade,
        );
        historyComponent.selectedConversation = conversation('peer');
        historyComponent.socketReady = true;
        historyComponent.draft = 'First';

        historyComponent.onDraftChange();
        tick(1_200);
        historyComponent.draft = 'First continued';
        historyComponent.onDraftChange();

        expect(send).toHaveBeenCalledTimes(2);
        expect(send.calls.allArgs()).toEqual([
            [{type: 'typing.start', payload: {conversation_id: 'peer'}}],
            [{type: 'typing.start', payload: {conversation_id: 'peer'}}],
        ]);
        historyComponent.ngOnDestroy();
    }));

    it('stops typing in the old group before switching and cancels its delayed stop', fakeAsync(() => {
        const send = jasmine.createSpy('send').and.returnValue(true);
        const historyComponent = new HomeComponent(
            {history: () => of({messages: []})} as unknown as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {send, close: () => undefined} as unknown as DataProviderService,
            {close: () => undefined} as CallFacade,
        );
        const oldGroup = groupConversation('old-group');
        const newGroup = groupConversation('new-group');
        historyComponent.selectedConversation = oldGroup;
        historyComponent.socketReady = true;
        historyComponent.draft = 'typing';
        historyComponent.onDraftChange();

        historyComponent.selectConversation(newGroup);
        tick(2_001);

        expect(send.calls.allArgs().filter(([event]) => event.type === 'typing.start' || event.type === 'typing.stop')).toEqual([
            [{type: 'typing.start', payload: {conversation_id: oldGroup.id}}],
            [{type: 'typing.stop', payload: {conversation_id: oldGroup.id}}],
        ]);
        expect(historyComponent.selectedConversation?.id).toBe(newGroup.id);
        historyComponent.ngOnDestroy();
    }));

    it('sends typing.stop to the original conversation exactly once before closing realtime on destroy', () => {
        const send = jasmine.createSpy('send').and.returnValue(true);
        const close = jasmine.createSpy('close');
        const historyComponent = new HomeComponent(
            {} as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {send, close} as unknown as DataProviderService,
            {close: () => undefined} as CallFacade,
        );
        historyComponent.selectedConversation = groupConversation('typing-conversation');
        historyComponent.socketReady = true;
        historyComponent.draft = 'typing';
        historyComponent.onDraftChange();

        historyComponent.selectedConversation = groupConversation('different-conversation');
        historyComponent.ngOnDestroy();

        expect(send.calls.allArgs().filter(([event]) => event.type === 'typing.stop')).toEqual([
            [{type: 'typing.stop', payload: {conversation_id: 'typing-conversation'}}],
        ]);
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('keeps multiple sent messages pending until their matching acknowledgements arrive', () => {
        const historyComponent = new HomeComponent(
            {} as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {} as DataProviderService,
            {close: () => undefined} as CallFacade,
        );
        const send = jasmine.createSpy('send').and.returnValue(true);
        (historyComponent as unknown as { dataProvider: { send: typeof send; close(): void } }).dataProvider = {send, close: () => undefined};
        historyComponent.selectedConversation = conversation('selected');
        historyComponent.profile = {id: 'user-1'} as any;
        historyComponent.socketReady = true;

        historyComponent.draft = 'First';
        historyComponent.sendMessage();
        historyComponent.draft = 'Second';
        historyComponent.sendMessage();
        expect(send).toHaveBeenCalledTimes(2);
        expect(historyComponent.messages.filter(message => message.pending)).toHaveSize(2);

        const firstRequest = send.calls.argsFor(0)[0] as {request_id: string; payload: {client_message_id: string}};
        const secondRequest = send.calls.argsFor(1)[0] as {request_id: string; payload: {client_message_id: string}};
        historyComponent.handleSocketEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'message.accepted', request_id: secondRequest.request_id, payload: socketMessage('message-2', secondRequest.payload.client_message_id, 'Second')});
        expect(historyComponent.messages.find(message => message.clientMessageId === secondRequest.payload.client_message_id)?.pending).toBeUndefined();
        expect(historyComponent.messages.find(message => message.clientMessageId === firstRequest.payload.client_message_id)?.pending).toBeTrue();

        historyComponent.handleSocketEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'message.accepted', request_id: firstRequest.request_id, payload: socketMessage('message-1', firstRequest.payload.client_message_id, 'First')});
        expect(historyComponent.messages.some(message => message.pending)).toBeFalse();
        historyComponent.ngOnDestroy();
    });

    it('retains the draft and avoids optimistic UI when message enqueue fails', () => {
        const historyComponent = new HomeComponent(
            {} as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {} as DataProviderService,
            {close: () => undefined} as CallFacade,
        );
        const send = jasmine.createSpy('send').and.returnValue(false);
        (historyComponent as unknown as {dataProvider: {send: typeof send; close(): void}}).dataProvider = {send, close: () => undefined};
        historyComponent.selectedConversation = conversation('selected');
        historyComponent.profile = {id: 'user-1'} as Profile;
        historyComponent.socketReady = true;
        historyComponent.draft = 'Retry this message';

        historyComponent.sendMessage();

        expect(historyComponent.draft).toBe('Retry this message');
        expect(historyComponent.messages).toEqual([]);
        expect(historyComponent.sendStatus).toBe('Secure connection was lost. Refresh to reconnect.');
        historyComponent.ngOnDestroy();
    });

    it('retains a timed-out send as uncertain until reconciliation returns its durable own message', fakeAsync(() => {
        const send = jasmine.createSpy('send').and.returnValue(true);
        const historyComponent = new HomeComponent(
            {} as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {send, close: () => undefined} as unknown as DataProviderService,
            {close: () => undefined} as CallFacade,
        );
        historyComponent.selectedConversation = conversation('selected');
        historyComponent.profile = {id: 'user-1'} as Profile;
        historyComponent.socketReady = true;
        historyComponent.draft = 'Delayed';
        historyComponent.sendMessage();
        const request = send.calls.mostRecent().args[0] as {request_id: string; payload: {client_message_id: string}};

        tick(10_000);
        expect(historyComponent.messages[0]).toEqual(jasmine.objectContaining({clientMessageId: request.payload.client_message_id, pending: false, uncertain: true}));

        (historyComponent as unknown as {recoveryGeneration: number; reconciliationRequest: unknown}).recoveryGeneration = 1;
        (historyComponent as unknown as {reconciliationRequest: unknown}).reconciliationRequest = {generation: 1, requestID: 'reconcile', conversationID: 'selected'};
        historyComponent.handleSocketEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'conversation.reconciled', request_id: 'reconcile', payload: {
            ...reconciliationPayload('selected', 1),
            messages: [socketMessage('durable', request.payload.client_message_id, 'Delayed')],
        }});

        expect(historyComponent.messages.map(message => message.id)).toEqual(['durable']);
        expect(historyComponent.messages[0].pending).toBeUndefined();
        expect(historyComponent.messages[0].uncertain).toBeUndefined();
        historyComponent.ngOnDestroy();
    }));

    it('replays uncertain sends with fresh request IDs and resolves them independently out of order', fakeAsync(() => {
        const connectionStateChanges = new BehaviorSubject<'offline' | 'connecting' | 'recovering' | 'ready' | 'failed'>('offline');
        const send = jasmine.createSpy('send').and.returnValue(true);
        const historyComponent = new HomeComponent(
            {list: () => of([])} as unknown as ConversationService,
            {profile: () => of({id: 'user-1'} as Profile)} as unknown as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {getObservable: () => EMPTY, connectionStateChanges, send, close: () => undefined} as unknown as DataProviderService,
            {state$: of({phase: 'idle'}), close: () => undefined} as unknown as CallFacade,
        );
        historyComponent.ngOnInit();
        historyComponent.selectedConversation = conversation('selected');
        historyComponent.profile = {id: 'user-1'} as Profile;
        historyComponent.socketReady = true;
        historyComponent.draft = 'First';
        historyComponent.sendMessage();
        historyComponent.draft = 'Second';
        historyComponent.sendMessage();
        const firstSend = send.calls.argsFor(0)[0] as {request_id: string; payload: {client_message_id: string; body: string}};
        const secondSend = send.calls.argsFor(1)[0] as {request_id: string; payload: {client_message_id: string; body: string}};

        tick(10_000);
        connectionStateChanges.next('ready');
        const firstReplay = send.calls.argsFor(2)[0] as {request_id: string; payload: {client_message_id: string; body: string}};
        const secondReplay = send.calls.argsFor(3)[0] as {request_id: string; payload: {client_message_id: string; body: string}};
        expect(firstReplay.request_id).not.toBe(firstSend.request_id);
        expect(secondReplay.request_id).not.toBe(secondSend.request_id);
        expect(firstReplay.payload).toEqual(jasmine.objectContaining({client_message_id: firstSend.payload.client_message_id, body: 'First'}));
        expect(secondReplay.payload).toEqual(jasmine.objectContaining({client_message_id: secondSend.payload.client_message_id, body: 'Second'}));

        historyComponent.handleSocketEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'message.accepted', request_id: secondReplay.request_id, payload: socketMessage('second-durable', secondReplay.payload.client_message_id, 'Second')});
        historyComponent.handleSocketEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'message.accepted', request_id: firstReplay.request_id, payload: socketMessage('first-durable', firstReplay.payload.client_message_id, 'First')});
        expect(historyComponent.messages.map(message => message.id)).toEqual(['first-durable', 'second-durable']);
        expect(historyComponent.messages.some(message => message.pending || message.uncertain)).toBeFalse();
        historyComponent.ngOnDestroy();
    }));

    it('applies only the current selected conversation reconciliation response', () => {
        const selected = conversation('selected');
        const historyComponent = new HomeComponent(
            {} as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {} as DataProviderService,
            {close: () => undefined} as CallFacade,
        );
        historyComponent.selectedConversation = selected;
        historyComponent.messages = [{id: 'existing', conversationId: selected.id, senderId: 'user-1', clientMessageId: 'existing', sequence: 2, body: 'Existing', createdAt: '2026-01-01T00:00:00Z'}];
        (historyComponent as unknown as {recoveryGeneration: number; reconciliationRequest: unknown}).recoveryGeneration = 3;
        (historyComponent as unknown as {reconciliationRequest: unknown}).reconciliationRequest = {generation: 3, requestID: 'current', conversationID: selected.id};

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
});

function conversation(id: string): Conversation {
    return {id, otherUserId: `user-${id}`, otherDisplayName: id, otherEmail: `${id}@example.test`, createdAt: '2026-01-01T00:00:00Z', lastMessageAt: '2026-01-01T00:00:00Z', unreadCount: 0};
}

function groupConversation(id: string): GroupConversation {
    return {id, kind: 'group', name: id, avatarSeed: id, ownerId: 'user-1', membershipRevision: 1, members: [], otherUserId: '', otherDisplayName: id, otherEmail: '', createdAt: '2026-01-01T00:00:00Z', lastMessageAt: '2026-01-01T00:00:00Z', unreadCount: 0};
}

function groupMember(userId: string, visibleFromSequence: number): GroupMember {
    return {userId, displayName: userId, email: `${userId}@example.test`, role: userId === 'user-1' ? 'owner' : 'member', visibleFromSequence, joinedAt: '2026-01-01T00:00:00Z'};
}

function ownMessage(conversationId: string, sequence: number): Message {
    return {id: `message-${sequence}`, conversationId, senderId: 'user-me', clientMessageId: `client-${sequence}`, sequence, body: `Message ${sequence}`, createdAt: '2026-01-01T00:00:00Z'};
}

function socketMessage(id: string, clientMessageID: string, body: string) {
    return {id, conversation_id: 'selected', sender_id: 'user-1', client_message_id: clientMessageID, sequence: 1, body, created_at: '2026-01-01T00:00:00Z'};
}

function reconciliationPayload(conversationID: string, nextAfterSequence: number) {
    return {
        conversation_id: conversationID,
        messages: [{id: 'reconciled', conversation_id: conversationID, sender_id: 'user-2', client_message_id: 'reconciled', sequence: 3, body: 'Recovered', created_at: '2026-01-01T00:00:03Z'}],
        next_after_sequence: nextAfterSequence,
        high_watermark: 3,
        has_more: true,
        own_read_sequence: 2,
        peer_read_sequence: 1,
    };
}
