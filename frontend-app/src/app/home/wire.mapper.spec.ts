import {messageSenderDisplayName, toConversation, toGroup, toGroupPeerReadCursor, toMessage, toMessageHistory} from './wire.mapper';

describe('wire mapper', () => {
    it('falls back to conversation creation time when last activity is omitted', () => {
        const conversation = toConversation({id: 'conversation-1', other_user_id: 'user-2', other_display_name: 'Peer', other_email: 'peer@example.test', created_at: '2026-01-01T00:00:00Z'});

        expect(conversation.lastMessageAt).toBe('2026-01-01T00:00:00Z');
    });

    it('maps a valid server-provided unread count and rejects malformed values', () => {
        const base = {id: 'conversation-1', other_user_id: 'user-2', other_display_name: 'Peer', other_email: 'peer@example.test', created_at: '2026-01-01T00:00:00Z'};

        expect(toConversation({...base, unread_count: 3}).unreadCount).toBe(3);
        expect(toConversation({...base, unread_count: -1}).unreadCount).toBe(0);
        expect(toConversation({...base, unread_count: 1.5}).unreadCount).toBe(0);
    });

    it('rejects malformed messages and retains valid history messages', () => {
        expect(toMessage({id: '', conversation_id: 'conversation-1', sender_id: 'user-1', client_message_id: 'client-1', sequence: 1, body: 'Hello', created_at: '2026-01-01T00:00:00Z'})).toBeNull();
        const history = toMessageHistory({messages: [
            {id: 'message-1', conversation_id: 'conversation-1', sender_id: 'user-1', client_message_id: 'client-1', sequence: 1, body: 'Hello', created_at: '2026-01-01T00:00:00Z'},
            {id: 'message-2', conversation_id: 'conversation-1', sender_id: 'user-1', client_message_id: 'client-2', sequence: 0, body: 'Invalid', created_at: '2026-01-01T00:00:00Z'},
        ]});

        expect(history.messages.map(message => message.id)).toEqual(['message-1']);
    });

    it('maps a typed group projection and rejects a missing owner', () => {
        const group = {id: 'group-1', name: 'Launch', avatar_seed: 'seed', owner_id: 'owner', membership_revision: 2, created_at: '2026-01-01T00:00:00Z', last_message_at: '2026-01-02T00:00:00Z', members: [{user_id: 'owner', display_name: 'Owner', email: 'owner@example.test', role: 'owner' as const, visible_from_sequence: 1, joined_at: '2026-01-01T00:00:00Z'}]};
        expect(toGroup(group)?.kind).toBe('group');
        expect(toGroup({...group, owner_id: 'missing'})).toBeNull();
    });

    it('resolves group senders from the authorized group projection', () => {
        const group = toGroup({id: 'group-1', name: 'Launch', avatar_seed: 'seed', owner_id: 'owner', membership_revision: 2, created_at: '2026-01-01T00:00:00Z', last_message_at: '2026-01-02T00:00:00Z', members: [
            {user_id: 'owner', display_name: 'Owner', email: 'owner@example.test', role: 'owner', visible_from_sequence: 1, joined_at: '2026-01-01T00:00:00Z'},
            {user_id: 'member', display_name: 'Member', email: 'member@example.test', role: 'member', visible_from_sequence: 1, joined_at: '2026-01-01T00:00:00Z'},
        ]});
        const message = toMessage({id: 'message-1', conversation_id: 'group-1', sender_id: 'member', client_message_id: 'client-1', sequence: 1, body: 'Hello', created_at: '2026-01-01T00:00:00Z'});

        expect(group).not.toBeNull();
        expect(message).not.toBeNull();
        if (!group || !message) {
            fail('expected typed group and message');
            return;
        }
        expect(messageSenderDisplayName(message, group, 'owner', 'Owner')).toBe('Member');
        expect(messageSenderDisplayName({...message, senderId: 'owner'}, group, 'owner', 'Owner')).toBe('Owner');
    });

    it('retains the typed system message kind', () => {
        const base = {id: 'message-1', conversation_id: 'group-1', sender_id: 'owner', client_message_id: 'client-1', sequence: 1, body: 'Owner added Member to the group.', created_at: '2026-01-01T00:00:00Z'};

        expect(toMessage({...base, kind: 'system'})?.kind).toBe('system');
    });

    it('maps group peer cursors and rejects malformed identifiers or sequences', () => {
        expect(toGroupPeerReadCursor({user_id: 'member-1', sequence: 0, visible_from_sequence: 1})).toEqual({userId: 'member-1', sequence: 0, visibleFromSequence: 1});
        expect(toGroupPeerReadCursor({user_id: ' ', sequence: 1, visible_from_sequence: 1})).toBeNull();
        expect(toGroupPeerReadCursor({user_id: 'member-1', sequence: 1.5, visible_from_sequence: 1})).toBeNull();
        expect(toGroupPeerReadCursor({user_id: 'member-1', sequence: 1, visible_from_sequence: 0})).toBeNull();
    });
});
