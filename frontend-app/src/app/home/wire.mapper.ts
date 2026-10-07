import {Conversation, DirectConversation, GroupConversation, GroupMember, GroupPeerReadCursor, GroupRole} from './conversation.model';
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

export interface GroupMemberWire { user_id: string; display_name: string; role: GroupRole; visible_from_sequence: number; joined_at: string; }
export interface GroupWire { id: string; name: string; avatar_seed: string; owner_id: string; membership_revision: number; created_at: string; last_message_at: string; members: GroupMemberWire[]; unread_count?: number; }
export interface GroupPageWire { items: GroupWire[]; next_cursor: string | null; }
export interface GroupPage { items: GroupConversation[]; nextCursor: string | null; }

const MAX_GROUP_PAGE_ITEMS = 25;
const MAX_GROUP_PAGE_CURSOR_LENGTH = 512;
const RFC3339_TIMESTAMP = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const CANONICAL_UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

interface GroupSortKeyWire {
    sort_at: string;
    group_id: string;
}

export function toGroupPage(value: unknown): GroupPage | null {
    if (Array.isArray(value)) {
        const items = toGroupItems(value);
        return items ? {items, nextCursor: null} : null;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const envelope = value as Partial<GroupPageWire>;
    if (!Array.isArray(envelope.items) || envelope.items.length > MAX_GROUP_PAGE_ITEMS || !(envelope.next_cursor === null || isValidGroupPageCursor(envelope.next_cursor))) return null;
    const items = toGroupItems(envelope.items);
    return items ? {items, nextCursor: envelope.next_cursor} : null;
}

function toGroupItems(value: readonly unknown[]): GroupConversation[] | null {
    const items: GroupConversation[] = [];
    for (const item of value) {
        const group = toGroup(item);
        if (!group) return null;
        items.push(group);
    }
    return items;
}

function isValidGroupPageCursor(value: unknown): value is string {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_GROUP_PAGE_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
    try {
        const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
        if (btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '') !== value) return false;
        const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
        if (bytes.length === 0 || bytes.length > MAX_GROUP_PAGE_CURSOR_LENGTH) return false;
        const decoded = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
        const cursor: unknown = JSON.parse(decoded);
        if (JSON.stringify(cursor) !== decoded) return false;
        if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return false;
        const record = cursor as Record<string, unknown>;
        if (Object.keys(record).length !== 3 || !hasOwn(record, 'v') || !hasOwn(record, 'upper') || !hasOwn(record, 'after') || record['v'] !== 1) return false;
        return isValidGroupSortKey(record['upper']) && isValidGroupSortKey(record['after']);
    } catch {
        return false;
    }
}

function isValidGroupSortKey(value: unknown): value is GroupSortKeyWire {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const key = value as Record<string, unknown>;
    if (Object.keys(key).length !== 2 || !hasOwn(key, 'sort_at') || !hasOwn(key, 'group_id') || typeof key['sort_at'] !== 'string' || typeof key['group_id'] !== 'string') return false;
    const timestamp = key['sort_at'];
    const groupID = key['group_id'];
    if (!RFC3339_TIMESTAMP.test(timestamp) || !CANONICAL_UUID.test(groupID) || !Number.isFinite(Date.parse(timestamp))) return false;
    const [datePart] = timestamp.split('T');
    const [year, month, day] = datePart.split('-').map(Number);
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return day <= daysInMonth;
}

function hasOwn(value: object, key: PropertyKey): boolean {
    return Object.prototype.hasOwnProperty.call(value, key);
}

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

export function toConversation(item: unknown): DirectConversation | null {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const conversation = item as Partial<ConversationWire>;
    if (typeof conversation.id !== 'string' || !conversation.id.trim() || typeof conversation.other_user_id !== 'string' || !conversation.other_user_id.trim() || typeof conversation.other_display_name !== 'string' || !conversation.other_display_name.trim() || typeof conversation.other_email !== 'string' || !conversation.other_email.trim() || typeof conversation.created_at !== 'string' || !conversation.created_at.trim() || (conversation.last_message_at !== undefined && typeof conversation.last_message_at !== 'string')) return null;
    const unreadCount = conversation.unread_count;
    return {
        kind: 'direct',
        id: conversation.id,
        otherUserId: conversation.other_user_id,
        otherDisplayName: conversation.other_display_name,
        otherEmail: conversation.other_email,
        createdAt: conversation.created_at,
        lastMessageAt: conversation.last_message_at || conversation.created_at,
        unreadCount: typeof unreadCount === 'number' && Number.isSafeInteger(unreadCount) && unreadCount > 0 ? unreadCount : 0,
    };
}

export function toConversationList(value: unknown): DirectConversation[] | null {
    if (!Array.isArray(value)) return null;
    const items: readonly unknown[] = value;
    const conversations: DirectConversation[] = [];
    for (const item of items) {
        const conversation = toConversation(item);
        if (!conversation) return null;
        conversations.push(conversation);
    }
    return conversations;
}

export function toGroupMember(item: unknown): GroupMember | null {
    if (!item || typeof item !== 'object') return null;
    const member = item as Partial<GroupMemberWire>;
    if (typeof member.user_id !== 'string' || !member.user_id.trim() || member.user_id !== member.user_id.trim() || typeof member.display_name !== 'string' || !member.display_name.trim() || (member.role !== 'owner' && member.role !== 'admin' && member.role !== 'member') || !Number.isSafeInteger(member.visible_from_sequence) || typeof member.visible_from_sequence !== 'number' || member.visible_from_sequence < 1 || typeof member.joined_at !== 'string' || !member.joined_at.trim() || !Number.isFinite(Date.parse(member.joined_at))) return null;
    return {userId: member.user_id, displayName: member.display_name, role: member.role, visibleFromSequence: member.visible_from_sequence, joinedAt: member.joined_at};
}

export function toGroup(value: unknown): GroupConversation | null {
    if (!value || typeof value !== 'object') return null;
    const item = value as Partial<GroupWire>;
    if (typeof item.id !== 'string' || !item.id.trim() || item.id !== item.id.trim() || typeof item.name !== 'string' || !item.name.trim() || typeof item.avatar_seed !== 'string' || !item.avatar_seed.trim() || typeof item.owner_id !== 'string' || !item.owner_id.trim() || item.owner_id !== item.owner_id.trim() || !Number.isSafeInteger(item.membership_revision) || typeof item.membership_revision !== 'number' || item.membership_revision < 1 || typeof item.created_at !== 'string' || !item.created_at.trim() || !Number.isFinite(Date.parse(item.created_at)) || typeof item.last_message_at !== 'string' || !item.last_message_at.trim() || !Number.isFinite(Date.parse(item.last_message_at)) || !Array.isArray(item.members) || item.members.length > 16 || (item.unread_count !== undefined && (!Number.isSafeInteger(item.unread_count) || item.unread_count < 0))) return null;
    const members: GroupMember[] = [];
    const memberIDs = new Set<string>();
    let containsOwner = false;
    for (const wireMember of item.members) {
        const member = toGroupMember(wireMember);
        if (!member || memberIDs.has(member.userId)) return null;
        memberIDs.add(member.userId);
        members.push(member);
        if (member.userId === item.owner_id && member.role === 'owner') containsOwner = true;
    }
    if (!containsOwner) return null;
    return {kind: 'group', id: item.id, name: item.name, avatarSeed: item.avatar_seed, ownerId: item.owner_id, membershipRevision: item.membership_revision, createdAt: item.created_at, lastMessageAt: item.last_message_at, unreadCount: typeof item.unread_count === 'number' && Number.isSafeInteger(item.unread_count) && item.unread_count > 0 ? item.unread_count : 0, members, otherUserId: '', otherDisplayName: '', otherEmail: ''};
}

export function toMessage(item: MessageWire): Message | null {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id.trim() || typeof item.conversation_id !== 'string' || !item.conversation_id.trim() || typeof item.sender_id !== 'string' || !item.sender_id.trim() || typeof item.client_message_id !== 'string' || !item.client_message_id.trim() || !Number.isSafeInteger(item.sequence) || item.sequence < 1 || typeof item.body !== 'string' || typeof item.created_at !== 'string' || !item.created_at.trim() || (item.kind !== undefined && item.kind !== 'user' && item.kind !== 'system')) return null;
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
