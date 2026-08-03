import {toConversation, toMessage, toMessageHistory} from './wire.mapper';

describe('wire mapper', () => {
    it('falls back to conversation creation time when last activity is omitted', () => {
        const conversation = toConversation({id: 'conversation-1', other_user_id: 'user-2', other_display_name: 'Peer', other_email: 'peer@example.test', created_at: '2026-01-01T00:00:00Z'});

        expect(conversation.lastMessageAt).toBe('2026-01-01T00:00:00Z');
    });

    it('rejects malformed messages and retains valid history messages', () => {
        expect(toMessage({id: '', conversation_id: 'conversation-1', sender_id: 'user-1', client_message_id: 'client-1', sequence: 1, body: 'Hello', created_at: '2026-01-01T00:00:00Z'})).toBeNull();
        const history = toMessageHistory({messages: [
            {id: 'message-1', conversation_id: 'conversation-1', sender_id: 'user-1', client_message_id: 'client-1', sequence: 1, body: 'Hello', created_at: '2026-01-01T00:00:00Z'},
            {id: 'message-2', conversation_id: 'conversation-1', sender_id: 'user-1', client_message_id: 'client-2', sequence: 0, body: 'Invalid', created_at: '2026-01-01T00:00:00Z'},
        ]});

        expect(history.messages.map(message => message.id)).toEqual(['message-1']);
    });
});
