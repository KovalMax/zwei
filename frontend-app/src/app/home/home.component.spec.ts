import {waitForAsync, ComponentFixture, TestBed} from '@angular/core/testing';
import {ChangeDetectorRef} from '@angular/core';
import {of, Subject} from 'rxjs';

import {HomeComponent} from './home.component';
import {AppModule} from '../app.module';
import {AuthService} from '../auth/auth.service';
import {ConversationService} from './conversation.service';
import {Conversation} from './conversation.model';
import {MessageHistory} from './message.model';
import {WEBSOCKET_PROTOCOL_VERSION} from './data-provider.service';
import {DataProviderService} from './data-provider.service';

describe('HomeComponent', () => {
    let component: HomeComponent;
    let fixture: ComponentFixture<HomeComponent>;

    beforeEach(waitForAsync(() => {
        TestBed.configureTestingModule({
            imports: [AppModule]
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

    it('ignores history from a conversation that is no longer selected', () => {
        const firstHistory = new Subject<MessageHistory>();
        const secondHistory = new Subject<MessageHistory>();
        const history = jasmine.createSpy('history').and.returnValues(firstHistory.asObservable(), secondHistory.asObservable());
        const historyComponent = new HomeComponent(
            {history} as unknown as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {} as DataProviderService,
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

    it('reorders a background conversation and increments its unread count', () => {
        const historyComponent = new HomeComponent(
            {history: () => of({messages: []})} as unknown as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {} as DataProviderService,
        );
        const selected = conversation('selected');
        const background = conversation('background');
        historyComponent.selectedConversation = selected;
        historyComponent.conversations.next([selected, background]);

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
        );
        historyComponent.selectedConversation = conversation('peer');
        historyComponent.socketReady = true;

        expect(historyComponent.peerPresenceLabel()).toBe('Checking presence…');
        historyComponent.handleSocketEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'presence.snapshot', payload: {user_ids: ['user-peer']}});
        expect(historyComponent.peerPresenceLabel()).toBe('Online');
        historyComponent.handleSocketEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'presence.changed', payload: {user_id: 'user-peer', online: false}});
        expect(historyComponent.peerPresenceLabel()).toBe('Offline');
    });

    it('keeps multiple sent messages pending until their matching acknowledgements arrive', () => {
        const historyComponent = new HomeComponent(
            {} as ConversationService,
            {} as AuthService,
            {markForCheck: jasmine.createSpy('markForCheck')} as unknown as ChangeDetectorRef,
            {} as DataProviderService,
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
});

function conversation(id: string): Conversation {
    return {id, otherUserId: `user-${id}`, otherDisplayName: id, otherEmail: `${id}@example.test`, createdAt: '2026-01-01T00:00:00Z', lastMessageAt: '2026-01-01T00:00:00Z', unreadCount: 0};
}

function socketMessage(id: string, clientMessageID: string, body: string) {
    return {id, conversation_id: 'selected', sender_id: 'user-1', client_message_id: clientMessageID, sequence: 1, body, created_at: '2026-01-01T00:00:00Z'};
}
