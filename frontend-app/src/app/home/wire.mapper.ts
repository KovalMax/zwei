import {Conversation, GroupConversation, GroupMember, GroupPeerReadCursor, GroupRole} from './conversation.model';
import {Message, MessageHistory} from './message.model';

export interface ConversationWire {
    kind?: 'direct';
    id: string;
    other_user_id: string;
    other_display_name: string;
    other_email: string;
    created_at: string;
    last_message_at?: string;
    unread_count?: number;
}

export interface GroupMemberWire { user_id: string; display_name: string; email: string; role: GroupRole; visible_from_sequence: number; joined_at: string; }
export interface GroupWire { id: string; name: string; avatar_seed: string; owner_id: string; membership_revision: number; created_at: string; last_message_at: string; members: GroupMemberWire[]; unread_count?: number; }

export interface MessageWire {
    id: string;
    conversation_id: string;
    sender_id: string;
    client_message_id: string;
    sequence: number;
    body: string;
    created_at: string;
    kind?: 'user' | 'system';
}

export interface PeerReadCursorWire {
    user_id: string;
    sequence: number;
    visible_from_sequence: number;
}

export function toGroupPeerReadCursor(item: PeerReadCursorWire): GroupPeerReadCursor | null {
    if (typeof item.user_id !== 'string' || !item.user_id || item.user_id !== item.user_id.trim() || !Number.isSafeInteger(item.sequence) || item.sequence < 0 || !Number.isSafeInteger(item.visible_from_sequence) || item.visible_from_sequence < 1) return null;
    return {userId: item.user_id, sequence: item.sequence, visibleFromSequence: item.visible_from_sequence};
}

export interface MessageHistoryWire {
    messages: MessageWire[];
    next_cursor?: string;
}

export function toConversation(item: ConversationWire): Conversation {
    const unreadCount = item.unread_count;
    return {
        kind: 'direct',
        id: item.id,
        otherUserId: item.other_user_id,
        otherDisplayName: item.other_display_name,
        otherEmail: item.other_email,
        createdAt: item.created_at,
        lastMessageAt: item.last_message_at || item.created_at,
        unreadCount: typeof unreadCount === 'number' && Number.isSafeInteger(unreadCount) && unreadCount > 0 ? unreadCount : 0,
    };
}

export function toGroupMember(item: GroupMemberWire): GroupMember | null {
    if (!item.user_id || !item.display_name || !item.email || !['owner', 'admin', 'member'].includes(item.role) || !Number.isSafeInteger(item.visible_from_sequence) || item.visible_from_sequence < 1 || !item.joined_at) return null;
    return {userId: item.user_id, displayName: item.display_name, email: item.email, role: item.role, visibleFromSequence: item.visible_from_sequence, joinedAt: item.joined_at};
}

export function toGroup(item: GroupWire): GroupConversation | null {
    if (!item.id || !item.name || !item.avatar_seed || !item.owner_id || !Number.isSafeInteger(item.membership_revision) || item.membership_revision < 1 || !item.created_at || !item.last_message_at || !Array.isArray(item.members)) return null;
    const members = item.members.map(toGroupMember);
    if (members.some(member => member === null) || !members.some(member => member?.userId === item.owner_id && member.role === 'owner')) return null;
    return {kind: 'group', id: item.id, name: item.name, avatarSeed: item.avatar_seed, ownerId: item.owner_id, membershipRevision: item.membership_revision, createdAt: item.created_at, lastMessageAt: item.last_message_at, unreadCount: typeof item.unread_count === 'number' && Number.isSafeInteger(item.unread_count) && item.unread_count > 0 ? item.unread_count : 0, members: members as GroupMember[], otherUserId: '', otherDisplayName: '', otherEmail: ''};
}

export function toMessage(item: MessageWire): Message | null {
    if (!item.id || !item.conversation_id || !item.sender_id || !item.client_message_id || !Number.isFinite(item.sequence) || item.sequence < 1 || typeof item.body !== 'string' || !item.created_at || (item.kind !== undefined && item.kind !== 'user' && item.kind !== 'system')) return null;
    return {
        id: item.id,
        conversationId: item.conversation_id,
        senderId: item.sender_id,
        clientMessageId: item.client_message_id,
        sequence: item.sequence,
        body: item.body,
        createdAt: item.created_at,
        kind: item.kind === 'system' ? 'system' : 'user',
    };
}

export function messageSenderDisplayName(message: Message, conversation: Conversation | undefined, ownUserID: string | undefined, ownDisplayName: string | undefined): string {
    if (message.senderId === ownUserID) return ownDisplayName || 'You';
    if (conversation?.kind === 'direct') return conversation.otherDisplayName;
    return conversation?.kind === 'group' ? conversation.members.find(member => member.userId === message.senderId)?.displayName || 'Conversation member' : 'Conversation member';
}

export function toMessageHistory(response: MessageHistoryWire): MessageHistory {
    return {
        messages: response.messages.map(toMessage).filter((message): message is Message => message !== null),
        nextCursor: response.next_cursor,
    };
}
