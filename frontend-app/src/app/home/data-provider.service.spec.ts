import {WEBSOCKET_PROTOCOL_VERSION, isValidCallSocketEvent, isValidConversationReadEvent} from './data-provider.service';

describe('call socket event validation', () => {
    it('accepts a complete incoming call event', () => {
        expect(isValidCallSocketEvent({
            version: WEBSOCKET_PROTOCOL_VERSION,
            type: 'call.incoming',
            payload: {
                call_id: 'call-1', conversation_id: 'conversation-1', caller_id: 'caller-1', recipient_id: 'recipient-1',
                caller_device_id: 'caller-device', status: 'ringing', expires_at: '2026-08-05T12:00:00Z',
            },
        })).toBeTrue();
    });

    it('requires TURN configuration before accepting a call', () => {
        const payload = {
            call_id: 'call-1', conversation_id: 'conversation-1', caller_id: 'caller-1', recipient_id: 'recipient-1',
            caller_device_id: 'caller-device', status: 'active', expires_at: '2026-08-05T12:00:00Z',
        };
        expect(isValidCallSocketEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'call.accepted', payload})).toBeFalse();
        expect(isValidCallSocketEvent({
            version: WEBSOCKET_PROTOCOL_VERSION,
            type: 'call.accepted',
            payload: {...payload, ice_servers: [{urls: ['turn:turn.example.test:3478?transport=udp'], username: 'credential-user', credential: 'credential'}]},
        })).toBeTrue();
    });

    it('rejects malformed call events before UI state can consume them', () => {
        expect(isValidCallSocketEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'call.incoming', payload: {call_id: 'call-1'}})).toBeFalse();
        expect(isValidCallSocketEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'call.signal', payload: {call_id: 'call-1', signal: 'offer'}})).toBeFalse();
    });
});

describe('conversation read event validation', () => {
    it('requires the global reader identity', () => {
        expect(isValidConversationReadEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'conversation.read', payload: {conversation_id: 'conversation-1', sequence: 4}})).toBeFalse();
        expect(isValidConversationReadEvent({version: WEBSOCKET_PROTOCOL_VERSION, type: 'conversation.read', payload: {conversation_id: 'conversation-1', user_id: 'user-1', sequence: 4}})).toBeTrue();
    });
});
