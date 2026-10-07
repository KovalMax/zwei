interface ConversationBase {
    id: string;
    createdAt: string;
    lastMessageAt: string;
    unreadCount: number;
}

export interface DirectConversation extends ConversationBase {
    kind?: 'direct';
    otherUserId: string;
    otherDisplayName: string;
    otherEmail: string;
}

export type GroupRole = 'owner' | 'admin' | 'member';

export interface GroupMember {
    userId: string;
    displayName: string;
    role: GroupRole;
    visibleFromSequence: number;
    joinedAt: string;
}

export interface GroupPeerReadCursor {
    userId: string;
    sequence: number;
    visibleFromSequence: number;
}

export interface GroupConversation extends ConversationBase {
    kind: 'group';
    name: string;
    avatarSeed: string;
    ownerId: string;
    membershipRevision: number;
    members: GroupMember[];
    // Empty direct fields preserve the existing shared rail/call presentation boundary.
    otherUserId: string;
    otherDisplayName: string;
    otherEmail: string;
    accessNeedsVerification?: true;
}

export type Conversation = DirectConversation | GroupConversation;
