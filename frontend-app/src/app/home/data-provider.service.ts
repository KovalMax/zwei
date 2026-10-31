import {HttpClient} from '@angular/common/http';
import {Inject, Injectable, InjectionToken} from '@angular/core';
import {webSocket, WebSocketSubject, WebSocketSubjectConfig} from 'rxjs/webSocket';
import {backends} from '../../environments/environment';
import {BehaviorSubject, Observable, Subject} from 'rxjs';
import {isValidMessageMentionWire} from './wire.mapper';
import type {PeerReadCursorWire} from './wire.mapper';
import {GroupIceCandidate, iceCandidateIdentity} from './group-ice-generation';

// V3 retains per-account group cursors; the scalar remains the direct-chat contract.
export const WEBSOCKET_PROTOCOL_VERSION = 3 as const;
export type ConnectionState = 'offline' | 'connecting' | 'recovering' | 'ready' | 'failed';
export type WebSocketFactory = <T>(config: WebSocketSubjectConfig<T>) => WebSocketSubject<T>;
const defaultWebSocketFactory: WebSocketFactory = <T>(config: WebSocketSubjectConfig<T>) => webSocket(config);
export const WEBSOCKET_FACTORY = new InjectionToken<WebSocketFactory>('ZWEI_WEBSOCKET_FACTORY', {
    providedIn: 'root',
    factory: () => defaultWebSocketFactory,
});
export const RECONNECT_RANDOM = new InjectionToken<() => number>('ZWEI_RECONNECT_RANDOM', {
    providedIn: 'root',
    factory: () => Math.random,
});

export interface MessageSendEvent {
    type: 'message.send';
    request_id: string;
    payload: { conversation_id: string; client_message_id: string; body: string; content_type: 'text'; mentions?: {user_id: string; start: number; end: number}[] };
}

export interface TypingClientEvent {
    type: 'typing.start' | 'typing.stop';
    payload: { conversation_id: string };
}

export interface PresenceRefreshEvent {
    type: 'presence.refresh';
}

export interface ConversationReadEvent {
    type: 'conversation.read';
    payload: { conversation_id: string; sequence: number };
}

export interface ConversationReconcileEvent {
    type: 'conversation.reconcile';
    request_id: string;
    payload: { conversation_id: string; after_sequence: number };
}

export interface CallStartEvent {
    type: 'call.start';
    request_id: string;
    payload: { conversation_id: string };
}

export interface CallControlEvent {
    type: 'call.accept' | 'call.decline' | 'call.cancel' | 'call.end';
    request_id: string;
    payload: { call_id: string };
}

export interface CallSignalEvent {
    type: 'call.signal';
    request_id: string;
    payload: { call_id: string; signal: CallSignal };
}

export interface CallRecoverEvent { type: 'call.recover'; request_id: string; payload: {call_id: string}; }

export interface GroupCallDiscoverEvent { type: 'group.call.discover'; request_id: string; payload: {conversation_id: string}; }
export interface GroupCallPrepareStartEvent { type: 'group.call.prepare_start'; request_id: string; payload: {conversation_id: string}; }
export interface GroupCallCancelStartEvent { type: 'group.call.cancel_start'; request_id: string; payload: {conversation_id: string; attempt_id: string}; }
export interface GroupCallStartEvent { type: 'group.call.start'; request_id: string; payload: {conversation_id: string; attempt_id: string}; }
export interface GroupCallJoinEvent { type: 'group.call.join'; request_id: string; payload: {conversation_id: string; room_id: string; generation: number}; }
export interface GroupCallSyncEvent { type: 'group.call.sync'; request_id: string; payload: {conversation_id: string; room_id: string; generation: number; ownership_status: true}; }
export interface GroupCallCredentialsEvent { type: 'group.call.credentials'; request_id: string; payload: {conversation_id: string; room_id: string; generation: number}; }
export type GroupCallControlEvent = {
    [Type in 'group.call.leave' | 'group.call.end' | 'group.call.presenter.start' | 'group.call.presenter.stop']:
        { type: Type; request_id: string; payload: {conversation_id: string; room_id: string; generation: number} }
}['group.call.leave' | 'group.call.end' | 'group.call.presenter.start' | 'group.call.presenter.stop'];
export interface GroupCallSignalEvent { type: 'group.call.signal'; request_id: string; payload: {conversation_id: string; room_id: string; generation: number; target_user_id: string; target_device_id: string; signal: GroupCallSignal}; }

export type CallSignal =
    | { type: 'offer' | 'answer'; sdp: string }
    | { type: 'candidate'; candidate: object }
    | { type: 'screen-share-started' | 'screen-share-stopped' };
export type GroupCallSignal = Exclude<CallSignal, {type: 'offer' | 'answer' | 'candidate'}> | {type: 'candidate'; candidate: GroupIceCandidate} | {type: 'offer' | 'answer'; sdp: string; negotiation_id: string};

export type ClientSocketEvent = MessageSendEvent | TypingClientEvent | PresenceRefreshEvent | ConversationReadEvent | ConversationReconcileEvent | CallStartEvent | CallControlEvent | CallSignalEvent | CallRecoverEvent | GroupCallDiscoverEvent | GroupCallPrepareStartEvent | GroupCallCancelStartEvent | GroupCallStartEvent | GroupCallJoinEvent | GroupCallSyncEvent | GroupCallCredentialsEvent | GroupCallControlEvent | GroupCallSignalEvent;

export interface MessagePayload {
    id: string;
    conversation_id: string;
    sender_id: string;
    client_message_id: string;
    sequence: number;
    body: string;
    content_type?: 'text' | 'sticker';
    mentions?: {user_id: string; start: number; end: number}[];
    created_at: string;
    kind?: 'user' | 'system';
}

export interface MessageAcceptedEvent {
    version: typeof WEBSOCKET_PROTOCOL_VERSION;
    type: 'message.accepted';
    request_id: string;
    payload: MessagePayload;
}

export interface MessageCreatedEvent {
    version: typeof WEBSOCKET_PROTOCOL_VERSION;
    type: 'message.created';
    payload: MessagePayload;
}

export interface MessageRejectedEvent {
    version: typeof WEBSOCKET_PROTOCOL_VERSION;
    type: 'message.rejected';
    request_id?: string;
    payload: { error: string };
}

export interface PresenceSnapshotEvent {
    version: typeof WEBSOCKET_PROTOCOL_VERSION;
    type: 'presence.snapshot';
    payload: { user_ids: string[] };
}

export interface PresenceChangedEvent {
    version: typeof WEBSOCKET_PROTOCOL_VERSION;
    type: 'presence.changed';
    payload: { user_id: string; online: boolean };
}

export interface TypingSocketEvent {
    version: typeof WEBSOCKET_PROTOCOL_VERSION;
    type: 'typing.started' | 'typing.stopped';
    payload: { conversation_id: string; user_id: string };
}

export interface ConversationCreatedEvent {
    version: typeof WEBSOCKET_PROTOCOL_VERSION;
    type: 'conversation.created';
    payload: { conversation_id: string };
}

export interface ConversationReadSocketEvent {
    version: typeof WEBSOCKET_PROTOCOL_VERSION;
    type: 'conversation.read';
    payload: { conversation_id: string; user_id: string; sequence: number; visible_from_sequence?: number };
}

export interface GroupMembershipChangedSocketEvent {
    version: typeof WEBSOCKET_PROTOCOL_VERSION;
    type: 'group.membership.changed';
    payload: { conversation_id: string; membership_revision: number; deleted: boolean };
}

export interface ConversationReconciledSocketEvent {
    version: typeof WEBSOCKET_PROTOCOL_VERSION;
    type: 'conversation.reconciled';
    request_id: string;
    payload: {
        conversation_id: string;
        messages: MessagePayload[];
        next_after_sequence: number;
        high_watermark: number;
        has_more: boolean;
        own_read_sequence: number;
        peer_read_sequence: number;
        peer_read_cursors?: PeerReadCursorWire[];
    };
}

export interface CallPayload {
    call_id: string;
    conversation_id: string;
    caller_id: string;
    recipient_id: string;
    caller_device_id: string;
    accepted_device_id?: string;
    status: 'ringing' | 'active' | 'ended';
    expires_at: string;
    support_ref?: string;
}

export interface ICEServer {
    urls: string[];
    username: string;
    credential: string;
}

export interface CallStateSocketEvent {
    version: typeof WEBSOCKET_PROTOCOL_VERSION;
    type: 'call.incoming' | 'call.ringing' | 'call.declined' | 'call.ended';
    payload: CallPayload;
}

export interface CallAcceptedSocketEvent {
    version: typeof WEBSOCKET_PROTOCOL_VERSION;
    type: 'call.accepted';
    payload: CallPayload & { ice_servers: ICEServer[] };
}

export interface CallSignalSocketEvent {
    version: typeof WEBSOCKET_PROTOCOL_VERSION;
    type: 'call.signal';
    payload: { call_id: string; signal: CallSignal };
}

export interface CallRejectedSocketEvent {
    version: typeof WEBSOCKET_PROTOCOL_VERSION;
    type: 'call.rejected';
    request_id?: string;
    payload: { error: string; support_ref?: string };
}

export interface CallRecoveredSocketEvent {
    version: typeof WEBSOCKET_PROTOCOL_VERSION;
    type: 'call.recovered';
    request_id: string;
    payload: {status: 'ringing'; call: {call_id: string; conversation_id: string; caller_id: string; status: 'ringing'; expires_at: string}} | {status: 'missed'};
}

export interface GroupCallParticipant { user_id: string; device_id: string; }
export interface GroupCallRoomPayload { room_id: string; conversation_id: string; membership_revision: number; generation: number; status: 'ringing' | 'active' | 'ended'; expires_at: string; ring_expires_at?: string; participants: GroupCallParticipant[]; presenter?: GroupCallParticipant; ice_servers?: ICEServer[]; ice_expires_at?: string; support_ref?: string; }
export type GroupCallDiscoveredRoomPayload = Omit<GroupCallRoomPayload, 'ice_servers'> & {state_revision: number};
export type GroupCallRoomEventPayload = GroupCallRoomPayload & {state_revision: number};
export interface GroupCallMembershipProjectionEndedPayload { room_id: string; generation: number; status: 'ended'; state_revision: number; support_ref?: string; }
export type GroupCallRoomSocketEvent =
    | { version: typeof WEBSOCKET_PROTOCOL_VERSION; type: 'group.call.started' | 'group.call.participant.joined' | 'group.call.participant.left' | 'group.call.presenter.start' | 'group.call.presenter.stop'; payload: GroupCallRoomEventPayload }
    | { version: typeof WEBSOCKET_PROTOCOL_VERSION; type: 'group.call.ended'; payload: GroupCallRoomEventPayload | GroupCallMembershipProjectionEndedPayload };
export interface GroupCallActiveSyncPayload extends Omit<GroupCallRoomPayload, 'status' | 'ice_servers'> { status: 'ringing' | 'active'; state_revision: number; ownership_status: 'active'; }
export interface GroupCallEndedSyncPayload { room_id: string; generation: number; status: 'ended'; support_ref?: string; ownership_status: 'participant_absent' | 'owned_elsewhere' | 'room_unavailable'; }
export type GroupCallSyncedPayload = GroupCallActiveSyncPayload | GroupCallEndedSyncPayload;
export interface GroupCallSyncedSocketEvent { version: typeof WEBSOCKET_PROTOCOL_VERSION; type: 'group.call.synced'; request_id: string; payload: GroupCallSyncedPayload; }
export interface GroupCallDiscoveredSocketEvent { version: typeof WEBSOCKET_PROTOCOL_VERSION; type: 'group.call.discovered'; request_id: string; payload: {conversation_id: string; room: GroupCallDiscoveredRoomPayload | null}; }
export interface GroupCallStartPreparedSocketEvent { version: typeof WEBSOCKET_PROTOCOL_VERSION; type: 'group.call.start_prepared'; request_id: string; payload: {conversation_id: string; attempt_id: string; expires_at: string}; }
export interface GroupCallStartAcceptedSocketEvent { version: typeof WEBSOCKET_PROTOCOL_VERSION; type: 'group.call.start_accepted'; request_id: string; payload: {conversation_id: string; room_id: string; generation: number}; }
export interface GroupCallStartCancelledSocketEvent { version: typeof WEBSOCKET_PROTOCOL_VERSION; type: 'group.call.start_cancelled'; request_id: string; payload: {conversation_id: string; attempt_id: string; outcome: 'confirmed' | 'retired' | 'unknown'}; }
export interface GroupCallSignalSocketEvent { version: typeof WEBSOCKET_PROTOCOL_VERSION; type: 'group.call.signal'; payload: {room_id: string; generation: number; from_user_id: string; from_device_id: string; signal: GroupCallSignal}; }
/** Local transport diagnostic, containing no untrusted candidate data. */
export interface GroupCallInvalidCandidateEvent { version: typeof WEBSOCKET_PROTOCOL_VERSION; type: 'group.call.invalid_candidate'; payload: {room_id: string; generation: number; from_user_id: string; from_device_id: string}; }
export interface GroupCallCredentialsSocketEvent { version: typeof WEBSOCKET_PROTOCOL_VERSION; type: 'group.call.credentials'; request_id: string; payload: {conversation_id: string; room_id: string; generation: number; ice_servers: ICEServer[]; ice_expires_at: string}; }

export type CallSocketEvent = CallStateSocketEvent | CallAcceptedSocketEvent | CallSignalSocketEvent | CallRejectedSocketEvent | CallRecoveredSocketEvent;
export type MessageSocketEvent = MessageAcceptedEvent | MessageCreatedEvent | MessageRejectedEvent | PresenceSnapshotEvent | PresenceChangedEvent | TypingSocketEvent | ConversationCreatedEvent | ConversationReadSocketEvent | GroupMembershipChangedSocketEvent | ConversationReconciledSocketEvent | CallSocketEvent | GroupCallRoomSocketEvent | GroupCallSyncedSocketEvent | GroupCallDiscoveredSocketEvent | GroupCallStartPreparedSocketEvent | GroupCallStartAcceptedSocketEvent | GroupCallStartCancelledSocketEvent | GroupCallSignalSocketEvent | GroupCallInvalidCandidateEvent | GroupCallCredentialsSocketEvent;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCallPayload(value: unknown): value is CallPayload {
    if (!isRecord(value)) return false;
    const required = ['call_id', 'conversation_id', 'caller_id', 'recipient_id', 'caller_device_id', 'status', 'expires_at'];
    return required.every(key => typeof value[key] === 'string') &&
        (value.status === 'ringing' || value.status === 'active' || value.status === 'ended') &&
        (value.accepted_device_id === undefined || typeof value.accepted_device_id === 'string') &&
        (value.support_ref === undefined || isIdentifier(value.support_ref));
}

function isICEServers(value: unknown): value is ICEServer[] {
    return Array.isArray(value) && value.length > 0 && value.every(server => isRecord(server) && Array.isArray(server.urls) && server.urls.every(url => typeof url === 'string') && typeof server.username === 'string' && typeof server.credential === 'string');
}

function isValidCallSignal(value: unknown): value is CallSignal {
    if (!isRecord(value) || typeof value.type !== 'string') return false;
    const keys = Object.keys(value);
    if (value.type === 'offer' || value.type === 'answer') {
        return keys.length === 2 && keys.includes('type') && keys.includes('sdp') && typeof value.sdp === 'string' && value.sdp.length > 0;
    }
    if (value.type === 'candidate') {
        return keys.length === 2 && keys.includes('type') && keys.includes('candidate') && isRecord(value.candidate);
    }
    if (value.type === 'screen-share-started' || value.type === 'screen-share-stopped') {
        return keys.length === 1 && keys[0] === 'type';
    }
    return false;
}

function isValidGroupCallSignal(value: unknown): value is GroupCallSignal {
    if (!isRecord(value)) return false;
    if (value.type === 'candidate') return exactKeys(value, ['type', 'candidate']) && !!iceCandidateIdentity(value.candidate);
    if (value.type !== 'offer' && value.type !== 'answer') return isValidCallSignal(value);
    return exactKeys(value, ['type', 'sdp', 'negotiation_id']) && typeof value.sdp === 'string' && value.sdp.length > 0 &&
        typeof value.negotiation_id === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value.negotiation_id) && value.negotiation_id !== '00000000-0000-0000-0000-000000000000';
}

function invalidGroupCandidate(event: unknown): GroupCallInvalidCandidateEvent | undefined {
    if (!isRecord(event) || event.version !== WEBSOCKET_PROTOCOL_VERSION || event.type !== 'group.call.signal' || !isRecord(event.payload)) return undefined;
    const payload = event.payload;
    if (typeof payload.room_id !== 'string' || !isSequence(payload.generation) || typeof payload.from_user_id !== 'string' || typeof payload.from_device_id !== 'string' ||
        !isRecord(payload.signal) || payload.signal.type !== 'candidate' || !exactKeys(payload.signal, ['type', 'candidate']) || iceCandidateIdentity(payload.signal.candidate)) return undefined;
    return {version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.invalid_candidate', payload: {room_id: payload.room_id, generation: payload.generation, from_user_id: payload.from_user_id, from_device_id: payload.from_device_id}};
}

function isAcceptedCallPayload(value: unknown): value is CallPayload & {ice_servers: ICEServer[]} {
    return isRecord(value) && isCallPayload(value) && isICEServers(value['ice_servers']);
}

function isGroupRoomPayload(value: unknown): value is GroupCallRoomPayload {
    if (!isRecord(value) || !isIdentifier(value.room_id) || !isIdentifier(value.conversation_id) || !isSequence(value.membership_revision) || !isSequence(value.generation) || !['ringing', 'active', 'ended'].includes(String(value.status)) || typeof value.expires_at !== 'string' || !Array.isArray(value.participants)) return false;
    return (value.ring_expires_at === undefined || typeof value.ring_expires_at === 'string' && Number.isFinite(Date.parse(value.ring_expires_at))) && value.participants.every(item => isRecord(item) && isIdentifier(item.user_id) && isIdentifier(item.device_id)) && (value.presenter === undefined || (isRecord(value.presenter) && isIdentifier(value.presenter.user_id) && isIdentifier(value.presenter.device_id))) && (value.ice_servers === undefined ? value.ice_expires_at === undefined : isICEServers(value.ice_servers) && typeof value.ice_expires_at === 'string' && Number.isFinite(Date.parse(value.ice_expires_at))) && (value.support_ref === undefined || isIdentifier(value.support_ref));
}

export function isGroupRoomEventPayload(value: unknown): value is GroupCallRoomEventPayload {
    return isGroupRoomPayload(value) && isRecord(value) && isSequence(value.state_revision);
}

function isGroupCallActiveSyncPayload(value: unknown): value is GroupCallActiveSyncPayload {
    return isRecord(value) && isGroupRoomPayload(value) && (value.status === 'ringing' || value.status === 'active') &&
        isSequence(value.state_revision) && value.ice_servers === undefined && value.ownership_status === 'active';
}

function isGroupCallEndedSyncPayload(value: unknown): value is GroupCallEndedSyncPayload {
    return isRecord(value) && isIdentifier(value.room_id) && isSequence(value.generation) && value.status === 'ended' &&
        (value.support_ref === undefined || isIdentifier(value.support_ref)) &&
        (value.ownership_status === 'participant_absent' || value.ownership_status === 'owned_elsewhere' || value.ownership_status === 'room_unavailable') &&
        Object.keys(value).every(key => key === 'room_id' || key === 'generation' || key === 'status' || key === 'support_ref' || key === 'ownership_status');
}

function isGroupCallMembershipProjectionEndedPayload(value: unknown): value is GroupCallMembershipProjectionEndedPayload {
    return isRecord(value) && isIdentifier(value.room_id) && isSequence(value.generation) && value.status === 'ended' &&
        isSequence(value.state_revision) && (value.support_ref === undefined || isIdentifier(value.support_ref)) && Object.keys(value).every(key => key === 'room_id' || key === 'generation' || key === 'status' || key === 'state_revision' || key === 'support_ref');
}

function isGroupCallSyncedPayload(value: unknown): value is GroupCallSyncedSocketEvent['payload'] {
    return isGroupCallEndedSyncPayload(value) || isGroupCallActiveSyncPayload(value);
}

function isGroupCallDiscoveredPayload(value: unknown): value is GroupCallDiscoveredSocketEvent['payload'] {
    return isRecord(value) && isIdentifier(value.conversation_id) &&
        (value.room === null || isGroupCallDiscoveredRoomPayload(value.room) && value.room.conversation_id === value.conversation_id);
}

function isGroupCallDiscoveredRoomPayload(value: unknown): value is GroupCallDiscoveredRoomPayload {
    return isRecord(value) && isGroupRoomPayload(value) && isSequence(value['state_revision']) && !('ice_servers' in value) &&
        value['participants'].every(participant => isRecord(participant) && !('connection_id' in participant));
}

function isMessagePayload(value: unknown): value is MessagePayload {
    if (!isRecord(value)) return false;
    const required = ['id', 'conversation_id', 'sender_id', 'client_message_id', 'body', 'created_at'];
    return required.every(key => typeof value[key] === 'string') &&
        typeof value.body === 'string' &&
        typeof value.sequence === 'number' && Number.isSafeInteger(value.sequence) && value.sequence > 0 &&
        (value.kind === undefined || value.kind === 'user' || value.kind === 'system') &&
        (value.content_type === undefined || value.content_type === 'text' || value.content_type === 'sticker') &&
        (value.mentions === undefined || isValidMessageMentionWire(value.mentions, value.body));
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isSequence(value: unknown, allowZero = false): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && (allowZero ? value >= 0 : value > 0);
}

function isIdentifier(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value === value.trim();
}

function isUUID(value: unknown): value is string {
    return typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
}

function exactKeys(value: object, expected: readonly string[]): boolean {
    return Object.keys(value).length === expected.length && expected.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

/** Reject malformed group-call commands at the transport boundary, including JS callers bypassing TS. */
export function isValidGroupCallClientEvent(event: unknown): event is GroupCallDiscoverEvent | GroupCallPrepareStartEvent | GroupCallCancelStartEvent | GroupCallStartEvent | GroupCallJoinEvent | GroupCallSyncEvent | GroupCallCredentialsEvent | GroupCallControlEvent | GroupCallSignalEvent {
    if (!isRecord(event) || typeof event.type !== 'string') return false;
    if (event.type === 'group.call.cancel_start' || event.type === 'group.call.start') {
        return isIdentifier(event.request_id) && isRecord(event.payload) && isIdentifier(event.payload.conversation_id) && isUUID(event.payload.attempt_id) && !('generation' in event.payload);
    }
    if (event.type === 'group.call.discover' || event.type === 'group.call.prepare_start') {
        return isIdentifier(event.request_id) && isRecord(event.payload) && isIdentifier(event.payload.conversation_id) && !('generation' in event.payload);
    }
    if (!['group.call.join', 'group.call.sync', 'group.call.credentials', 'group.call.leave', 'group.call.end', 'group.call.presenter.start', 'group.call.presenter.stop', 'group.call.signal'].includes(event.type)) return false;
    if (!isIdentifier(event.request_id) || !isRecord(event.payload) || !isIdentifier(event.payload.conversation_id) || !isIdentifier(event.payload.room_id) || !isSequence(event.payload.generation)) return false;
    if (event.type === 'group.call.sync' && event.payload.ownership_status !== true) return false;
    if (event.type === 'group.call.signal') {
        return isIdentifier(event.payload.target_user_id) && isIdentifier(event.payload.target_device_id) && isValidGroupCallSignal(event.payload.signal);
    }
    return true;
}

function isPeerReadCursor(value: unknown): value is PeerReadCursorWire {
    return isRecord(value) && isIdentifier(value.user_id) && isSequence(value.sequence, true) && isSequence(value.visible_from_sequence);
}

export function isValidConversationReconciledEvent(event: unknown): event is ConversationReconciledSocketEvent {
    if (!isRecord(event) || event.version !== WEBSOCKET_PROTOCOL_VERSION || event.type !== 'conversation.reconciled' || typeof event.request_id !== 'string' || !isRecord(event.payload)) return false;
    const payload = event.payload;
    return isIdentifier(payload.conversation_id) && Array.isArray(payload.messages) && payload.messages.every(isMessagePayload) &&
        isSequence(payload.next_after_sequence, true) && isSequence(payload.high_watermark, true) &&
        isSequence(payload.own_read_sequence, true) && isSequence(payload.peer_read_sequence, true) && typeof payload.has_more === 'boolean' &&
        (payload.peer_read_cursors === undefined || (Array.isArray(payload.peer_read_cursors) && payload.peer_read_cursors.every(isPeerReadCursor)));
}

export function isValidCallSocketEvent(event: unknown): event is CallSocketEvent {
    if (!isRecord(event) || event.version !== WEBSOCKET_PROTOCOL_VERSION || typeof event.type !== 'string' || !('payload' in event)) return false;
    if (event.type === 'call.signal') return isRecord(event.payload) && typeof event.payload.call_id === 'string' && isValidCallSignal(event.payload.signal);
    if (event.type === 'call.rejected') return isRecord(event.payload) && typeof event.payload.error === 'string' && (event.payload.support_ref === undefined || isIdentifier(event.payload.support_ref));
    if (event.type === 'call.recovered') {
        if (!exactKeys(event, ['version', 'type', 'request_id', 'payload']) || !isUUID(event.request_id) || !isRecord(event.payload)) return false;
        if (event.payload.status === 'missed') return exactKeys(event.payload, ['status']);
        if (event.payload.status !== 'ringing' || !isRecord(event.payload.call) || !exactKeys(event.payload, ['status', 'call'])) return false;
        const call = event.payload.call;
        return call.status === 'ringing' && isUUID(call.call_id) && isUUID(call.conversation_id) && isUUID(call.caller_id) && typeof call.expires_at === 'string' && Number.isFinite(Date.parse(call.expires_at)) && exactKeys(call, ['call_id', 'conversation_id', 'caller_id', 'status', 'expires_at']);
    }
    if (event.type === 'call.accepted') return isAcceptedCallPayload(event.payload);
    return ['call.incoming', 'call.ringing', 'call.declined', 'call.ended'].includes(event.type) && isCallPayload(event.payload);
}

export function isValidConversationReadEvent(event: unknown): event is ConversationReadSocketEvent {
    if (!isRecord(event) || event.version !== WEBSOCKET_PROTOCOL_VERSION || event.type !== 'conversation.read' || !isRecord(event.payload)) return false;
    return isIdentifier(event.payload.conversation_id) && isIdentifier(event.payload.user_id) && isSequence(event.payload.sequence) &&
        (event.payload.visible_from_sequence === undefined || isSequence(event.payload.visible_from_sequence));
}

function isValidSocketEvent(event: unknown): event is MessageSocketEvent {
    if (!isRecord(event) || event.version !== WEBSOCKET_PROTOCOL_VERSION || typeof event.type !== 'string' || !('payload' in event)) return false;
    switch (event.type) {
        case 'message.accepted':
            return typeof event.request_id === 'string' && isMessagePayload(event.payload);
        case 'message.created':
            return isMessagePayload(event.payload);
        case 'message.rejected':
            return isRecord(event.payload) && typeof event.payload.error === 'string' && (event.request_id === undefined || typeof event.request_id === 'string');
        case 'presence.snapshot':
            return isRecord(event.payload) && isStringArray(event.payload.user_ids);
        case 'presence.changed':
            return isRecord(event.payload) && typeof event.payload.user_id === 'string' && typeof event.payload.online === 'boolean';
        case 'typing.started':
        case 'typing.stopped':
            return isRecord(event.payload) && typeof event.payload.conversation_id === 'string' && typeof event.payload.user_id === 'string';
        case 'conversation.created':
            return isRecord(event.payload) && typeof event.payload.conversation_id === 'string';
        case 'conversation.read':
            return isValidConversationReadEvent(event);
        case 'group.membership.changed':
            return isRecord(event.payload) && typeof event.payload.conversation_id === 'string' && isSequence(event.payload.membership_revision) && typeof event.payload.deleted === 'boolean';
        case 'conversation.reconciled':
            return isValidConversationReconciledEvent(event);
        case 'call.incoming':
        case 'call.ringing':
        case 'call.declined':
        case 'call.ended':
        case 'call.accepted':
        case 'call.signal':
        case 'call.rejected':
        case 'call.recovered':
            return isValidCallSocketEvent(event);
        case 'group.call.started':
            return isGroupRoomEventPayload(event.payload) && typeof event.payload.ring_expires_at === 'string';
        case 'group.call.participant.joined':
        case 'group.call.participant.left':
        case 'group.call.presenter.start':
        case 'group.call.presenter.stop':
            return isGroupRoomEventPayload(event.payload);
        case 'group.call.ended':
            return isGroupRoomEventPayload(event.payload) || isGroupCallMembershipProjectionEndedPayload(event.payload);
        case 'group.call.synced':
            return isIdentifier(event.request_id) && isGroupCallSyncedPayload(event.payload);
        case 'group.call.discovered':
            return isIdentifier(event.request_id) && isGroupCallDiscoveredPayload(event.payload);
        case 'group.call.start_prepared':
            return isIdentifier(event.request_id) && isRecord(event.payload) && isIdentifier(event.payload.conversation_id) && isUUID(event.payload.attempt_id) && typeof event.payload.expires_at === 'string' && Number.isFinite(Date.parse(event.payload.expires_at));
        case 'group.call.start_accepted':
            return isIdentifier(event.request_id) && isRecord(event.payload) && isIdentifier(event.payload.conversation_id) && isIdentifier(event.payload.room_id) && isSequence(event.payload.generation) && event.payload.generation > 0;
        case 'group.call.start_cancelled':
            return isIdentifier(event.request_id) && isRecord(event.payload) && isIdentifier(event.payload.conversation_id) && isUUID(event.payload.attempt_id) && typeof event.payload.outcome === 'string' && ['confirmed', 'retired', 'unknown'].includes(event.payload.outcome);
        case 'group.call.signal':
            return isRecord(event.payload) && typeof event.payload.room_id === 'string' && isSequence(event.payload.generation) && typeof event.payload.from_user_id === 'string' && typeof event.payload.from_device_id === 'string' && isValidGroupCallSignal(event.payload.signal);
        case 'group.call.credentials':
            return isIdentifier(event.request_id) && isRecord(event.payload) && isIdentifier(event.payload.conversation_id) && isIdentifier(event.payload.room_id) && isSequence(event.payload.generation) && isICEServers(event.payload.ice_servers) && typeof event.payload.ice_expires_at === 'string' && Number.isFinite(Date.parse(event.payload.ice_expires_at));
        default:
            return false;
    }
}

interface WebSocketTicketResponse { ticket: string; }

@Injectable()
export class DataProviderService {
    private socket?: WebSocketSubject<MessageSocketEvent | (ClientSocketEvent & {version: typeof WEBSOCKET_PROTOCOL_VERSION})>;
    private socketReady = false;
    private socketOpen = false;
    private started = false;
    private closed = false;
    private reconnectAttempt = 0;
    private reconnectTimer?: number;
    private connectionGeneration = 0;
    private readonly readySubject = new BehaviorSubject<boolean>(false);
    private readonly connectionStateSubject = new BehaviorSubject<ConnectionState>('offline');
    private readonly events = new Subject<MessageSocketEvent>();
    private recoveryRequestID?: string;
    private presenceSnapshotReceived = false;

    public constructor(private http: HttpClient, @Inject(WEBSOCKET_FACTORY) private readonly socketFactory: WebSocketFactory, @Inject(RECONNECT_RANDOM) private readonly reconnectRandom: () => number = Math.random) {}

    public getObservable(): Observable<MessageSocketEvent> {
        if (!this.started) {
            this.started = true;
            this.connect();
        }
        return this.events.asObservable();
    }

    public send(event: ClientSocketEvent): boolean {
        if (event.type === 'message.send' && (!isRecord(event.payload) || typeof event.payload.body !== 'string' || event.payload.content_type !== 'text' ||
            (event.payload.mentions !== undefined && !isValidMessageMentionWire(event.payload.mentions, event.payload.body)))) return false;
        if (event.type === 'call.signal' && (!isRecord(event.payload) || !isIdentifier(event.payload.call_id) || !isValidCallSignal(event.payload.signal))) return false;
        if (event.type === 'call.recover' && (!exactKeys(event, ['type', 'request_id', 'payload']) || !isUUID(event.request_id) || !isRecord(event.payload) || !exactKeys(event.payload, ['call_id']) || !isUUID(event.payload.call_id))) return false;
        if (isGroupCallClientType(event.type) && !isValidGroupCallClientEvent(event)) return false;
        const socket = this.socket;
        if (!socket || !this.socketReady) {
            return false;
        }
        try {
            socket.next({...event, version: WEBSOCKET_PROTOCOL_VERSION});
            return true;
        } catch {
            this.scheduleReconnect();
            return false;
        }
    }

    public get ready(): boolean { return this.socketReady; }
    public get readyChanges(): Observable<boolean> { return this.readySubject.asObservable(); }
    public get connectionState(): ConnectionState { return this.connectionStateSubject.value; }
    public get connectionStateChanges(): Observable<ConnectionState> { return this.connectionStateSubject.asObservable(); }

    public recover(conversationID: string, afterSequence: number, requestID: string): boolean {
        if (!this.socketOpen || this.closed || afterSequence < 0) return false;
        this.recoveryRequestID = requestID;
        return this.sendRecovery({type: 'conversation.reconcile', request_id: requestID, payload: {conversation_id: conversationID, after_sequence: afterSequence}});
    }

    public finishRecovery(): void {
        this.recoveryRequestID = undefined;
        this.completeRecoveryIfReady();
    }

    public failRecovery(): void {
        if (!this.closed) this.scheduleReconnect();
    }

    public retryNow(): void {
        if (this.closed) return;
        window.clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
        this.connectionGeneration += 1;
        this.socket?.complete();
        this.socket?.unsubscribe();
        this.socket = undefined;
        this.socketOpen = false;
        this.socketReady = false;
        this.readySubject.next(false);
        this.connectionStateSubject.next('connecting');
        this.connect();
    }

    public close(): void {
        if (this.closed) return;
        this.closed = true;
        this.connectionGeneration += 1;
        window.clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
        this.readySubject.next(false);
        this.connectionStateSubject.next('offline');
        this.socket?.complete();
        this.socket?.unsubscribe();
        this.events.complete();
    }

    private connect(): void {
        if (this.closed) return;
        if (this.connectionStateSubject.value !== 'failed') this.connectionStateSubject.next('connecting');
        const generation = ++this.connectionGeneration;
        this.http.post<WebSocketTicketResponse>(backends.websocketTicket, {}).subscribe({
            next: ({ticket}) => {
                if (this.closed || generation !== this.connectionGeneration) return;
                const url = `${backends.websocket}?ticket=${encodeURIComponent(ticket)}`;
                let socket: WebSocketSubject<MessageSocketEvent | (ClientSocketEvent & {version: typeof WEBSOCKET_PROTOCOL_VERSION})> | undefined;
                const createdSocket = this.socketFactory<MessageSocketEvent | (ClientSocketEvent & {version: typeof WEBSOCKET_PROTOCOL_VERSION})>({
                    url,
                    openObserver: {next: () => {
                        if (this.closed || generation !== this.connectionGeneration || this.socket !== socket) return;
                        this.reconnectAttempt = 0;
                        this.socketOpen = true;
                        this.presenceSnapshotReceived = false;
                        this.recoveryRequestID = undefined;
                        this.connectionStateSubject.next('recovering');
                    }},
                    closeObserver: {next: () => {
                        if (this.closed || generation !== this.connectionGeneration || this.socket !== socket) return;
                        this.socketReady = false;
                        this.socketOpen = false;
                        this.readySubject.next(false);
                    }},
                });
                socket = createdSocket;
                this.socket = createdSocket;
                createdSocket.subscribe({
                    next: event => {
                        if (this.closed || generation !== this.connectionGeneration || this.socket !== socket) return;
                        if (!isValidSocketEvent(event)) {
                            const invalid = invalidGroupCandidate(event);
                            if (invalid) this.events.next(invalid);
                            return;
                        }
                        this.events.next(event);
                        if (event.type === 'presence.snapshot') {
                            this.presenceSnapshotReceived = true;
                            this.completeRecoveryIfReady();
                        } else if (event.type === 'conversation.reconciled' && event.request_id === this.recoveryRequestID) {
                            if (event.payload.has_more) return;
                            this.recoveryRequestID = undefined;
                            this.completeRecoveryIfReady();
                        } else if (event.type === 'message.rejected' && event.request_id === this.recoveryRequestID) {
                            // A rejected reconciliation is an application-level recovery failure,
                            // not a failed WebSocket. Keeping the healthy socket avoids consuming
                            // tickets in a reconnect loop while Home falls back to HTTP history.
                            this.recoveryRequestID = undefined;
                            this.completeRecoveryIfReady();
                        }
                    },
                    error: () => { if (!this.closed && generation === this.connectionGeneration && this.socket === socket) this.scheduleReconnect(); },
                    complete: () => { if (!this.closed && generation === this.connectionGeneration && this.socket === socket) this.scheduleReconnect(); },
                });
            },
            error: () => { if (!this.closed && generation === this.connectionGeneration) this.scheduleReconnect(); },
        });
    }

    private scheduleReconnect(): void {
        if (this.closed || this.reconnectTimer !== undefined) return;
        this.connectionGeneration += 1;
        const failedSocket = this.socket;
        this.socket = undefined;
        this.socketOpen = false;
        this.socketReady = false;
        this.readySubject.next(false);
        this.connectionStateSubject.next('failed');
        failedSocket?.complete();
        failedSocket?.unsubscribe();
        const baseDelay = Math.min(1_000 * 2 ** Math.min(this.reconnectAttempt++, 5), 30_000);
        const delay = Math.round(baseDelay * (0.8 + Math.min(1, Math.max(0, this.reconnectRandom())) * 0.4));
        this.reconnectTimer = window.setTimeout(() => {
            this.reconnectTimer = undefined;
            this.connect();
        }, delay);
    }

    private sendRecovery(event: ConversationReconcileEvent): boolean {
        if (!this.socket || !this.socketOpen) return false;
        try {
            this.socket.next({...event, version: WEBSOCKET_PROTOCOL_VERSION});
            return true;
        } catch {
            this.scheduleReconnect();
            return false;
        }
    }

    private completeRecoveryIfReady(): void {
        if (this.closed || !this.socketOpen || this.recoveryRequestID || !this.presenceSnapshotReceived) return;
        this.socketReady = true;
        this.readySubject.next(true);
        this.connectionStateSubject.next('ready');
    }
}

function isGroupCallClientType(type: string): boolean {
    return type.startsWith('group.call.');
}
