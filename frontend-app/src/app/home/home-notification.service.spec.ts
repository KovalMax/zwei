import {BehaviorSubject, Subject} from 'rxjs';
import {CallFacade, CallState} from './call-facade.service';
import {DataProviderService, MessageSocketEvent, WEBSOCKET_PROTOCOL_VERSION} from './data-provider.service';
import {HomeNotificationService} from './home-notification.service';
import {BrowserNotificationPermission, BrowserNotificationService} from '../notifications/notification.service';

describe('HomeNotificationService', () => {
    let events: Subject<MessageSocketEvent>;
    let callState: BehaviorSubject<CallState>;
    let notifications: jasmine.SpyObj<BrowserNotificationService>;
    let documentStub: Document & {background: boolean};
    let permissionChanges: Subject<BrowserNotificationPermission>;
    let service: HomeNotificationService;

    beforeEach(() => {
        events = new Subject<MessageSocketEvent>();
        callState = new BehaviorSubject<CallState>({phase: 'idle', muted: false, screenShareQuality: '720p', screenShareAudioEnabled: false, screenShareAudioActive: false, screenShareTransition: false, statusLabel: 'No active call.'});
        permissionChanges = new Subject<BrowserNotificationPermission>();
        notifications = jasmine.createSpyObj<BrowserNotificationService>('notifications', [
            'playMessageSound', 'showMessageNotification', 'startCallRingtone', 'showCallNotification', 'stopCallRingtone',
        ], {notificationsSupported: true, notificationPermission: 'granted', areSoundsEnabled: true, permissionChanges: permissionChanges.asObservable()});
        documentStub = {background: false, visibilityState: 'visible', hasFocus: () => !documentStub.background} as unknown as Document & {background: boolean};
        service = new HomeNotificationService(
            {getObservable: () => events.asObservable()} as unknown as DataProviderService,
            {state$: callState.asObservable(), get state(): CallState { return callState.value; }} as unknown as CallFacade,
            notifications,
            documentStub,
        );
        notifications.stopCallRingtone.calls.reset();
        service.setUserID('user-me');
        service.setSelectedConversationID('conversation-selected');
    });

    afterEach(() => service.ngOnDestroy());

    it('suppresses foreground selected and own messages but alerts for other/background messages', () => {
        events.next(message('conversation-selected', 'user-peer'));
        expect(notifications.playMessageSound).not.toHaveBeenCalled();

        events.next(message('conversation-other', 'user-peer'));
        expect(notifications.playMessageSound).toHaveBeenCalledOnceWith();
        expect(notifications.showMessageNotification).not.toHaveBeenCalled();

        documentStub.background = true;
        events.next(message('conversation-selected', 'user-peer'));
        events.next(message('conversation-selected', 'user-me'));

        expect(notifications.playMessageSound).toHaveBeenCalledTimes(2);
        expect(notifications.showMessageNotification).toHaveBeenCalledOnceWith('conversation-selected');
    });

    it('starts an incoming-call ringtone and stops it on terminal state', () => {
        documentStub.background = true;
        callState.next({...callState.value, phase: 'incoming', callID: 'call-1', statusLabel: 'Incoming audio call.'});
        notifications.startCallRingtone.calls.reset();
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'call.incoming', payload: callPayload('call-1')} as MessageSocketEvent);

        expect(notifications.startCallRingtone).not.toHaveBeenCalled();
        expect(notifications.showCallNotification).toHaveBeenCalledOnceWith('call-1');

        callState.next({...callState.value, phase: 'ended', statusLabel: 'Call ended.'});
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'call.ended', payload: callPayload('call-1')} as MessageSocketEvent);

        expect(notifications.stopCallRingtone).toHaveBeenCalledOnceWith();
    });

    it('does not notify for an incoming call that cannot enter the incoming state', () => {
        documentStub.background = true;
        callState.next({...callState.value, phase: 'active', callID: 'call-active', statusLabel: 'Audio call connected.'});

        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'call.incoming', payload: callPayload('call-2')} as MessageSocketEvent);

        expect(notifications.showCallNotification).not.toHaveBeenCalled();
    });

    it('restarts an incoming ringtone after sounds are unlocked by a user gesture', () => {
        callState.next({...callState.value, phase: 'incoming', callID: 'call-1', statusLabel: 'Incoming audio call.'});
        notifications.startCallRingtone.calls.reset();

        permissionChanges.next('granted');

        expect(notifications.startCallRingtone).toHaveBeenCalledOnceWith();
    });

    it('stops sounds and ignores events after teardown', () => {
        service.ngOnDestroy();
        notifications.startCallRingtone.calls.reset();
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'call.incoming', payload: callPayload('call-1')} as MessageSocketEvent);

        expect(notifications.startCallRingtone).not.toHaveBeenCalled();
        expect(notifications.stopCallRingtone).toHaveBeenCalledOnceWith();
    });
});

function message(conversationID: string, senderID: string): MessageSocketEvent {
    return {
        version: WEBSOCKET_PROTOCOL_VERSION,
        type: 'message.created',
        payload: {id: `${conversationID}-${senderID}`, conversation_id: conversationID, sender_id: senderID, client_message_id: 'client-1', sequence: 1, body: 'Message', created_at: '2026-01-01T00:00:00Z'},
    };
}

function callPayload(callID: string) {
    return {call_id: callID, conversation_id: 'conversation-selected', caller_id: 'user-peer', recipient_id: 'user-me', caller_device_id: 'device-1', status: 'ringing' as const, expires_at: '2026-01-01T00:00:30Z'};
}
