import {HttpClient} from '@angular/common/http';
import {Inject, Injectable, InjectionToken} from '@angular/core';
import {webSocket, WebSocketSubject, WebSocketSubjectConfig} from 'rxjs/webSocket';
import {backends} from '../../environments/environment';
import {BehaviorSubject, Observable, Subject} from 'rxjs';
import type {PeerReadCursorWire} from './wire.mapper';

// V2 carries per-account group cursors; the older scalar remains the direct-chat contract.
export const WEBSOCKET_PROTOCOL_VERSION = 2 as const;
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
    payload: { conversation_id: string; client_message_id: string; body: string };
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

export interface GroupCallStartEvent { type: 'group.call.start'; request_id: string; payload: {conversation_id: string}; }
export interface GroupCallJoinEvent { type: 'group.call.join'; request_id: string; payload: {conversation_id: string; room_id: string; generation: number}; }
export interface GroupCallSyncEvent { type: 'group.call.sync'; request_id: string; payload: {conversation_id: string; room_id: string; generation: number}; }
export type GroupCallControlEvent = {
    [Type in 'group.call.leave' | 'group.call.end' | 'group.call.presenter.start' | 'group.call.presenter.stop']:
        { type: Type; request_id: string; payload: {conversation_id: string; room_id: string; generation: number} }
}['group.call.leave' | 'group.call.end' | 'group.call.presenter.start' | 'group.call.presenter.stop'];
export interface GroupCallSignalEvent { type: 'group.call.signal'; request_id: string; payload: {conversation_id: string; room_id: string; generation: number; target_user_id: string; target_device_id: string; signal: CallSignal}; }

export type CallSignal =
    | { type: 'offer' | 'answer'; sdp: string }
    | { type: 'candidate'; candidate: object }
    | { type: 'screen-share-started' | 'screen-share-stopped' };

export type ClientSocketEvent = MessageSendEvent | TypingClientEvent | PresenceRefreshEvent | ConversationReadEvent | ConversationReconcileEvent | CallStartEvent | CallControlEvent | CallSignalEvent | GroupCallStartEvent | GroupCallJoinEvent | GroupCallSyncEvent | GroupCallControlEvent | GroupCallSignalEvent;

export interface MessagePayload {
    id: string;
    conversation_id: string;
    sender_id: string;
    client_message_id: string;
    sequence: number;
    body: string;
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
    payload: { error: string };
}

export interface GroupCallParticipant { user_id: string; device_id: string; }
export interface GroupCallRoomPayload { room_id: string; conversation_id: string; membership_revision: number; generation: number; status: 'ringing' | 'active' | 'ended'; expires_at: string; participants: GroupCallParticipant[]; presenter?: GroupCallParticipant; ice_servers?: ICEServer[]; }
export type GroupCallRoomEventPayload = GroupCallRoomPayload & {state_revision: number};
export interface GroupCallMembershipProjectionEndedPayload { room_id: string; generation: number; status: 'ended'; state_revision: number; }
export type GroupCallRoomSocketEvent =
    | { version: typeof WEBSOCKET_PROTOCOL_VERSION; type: 'group.call.started' | 'group.call.participant.joined' | 'group.call.participant.left' | 'group.call.presenter.start' | 'group.call.presenter.stop'; payload: GroupCallRoomEventPayload }
    | { version: typeof WEBSOCKET_PROTOCOL_VERSION; type: 'group.call.ended'; payload: GroupCallRoomEventPayload | GroupCallMembershipProjectionEndedPayload };
export interface GroupCallActiveSyncPayload extends Omit<GroupCallRoomPayload, 'status' | 'ice_servers'> { status: 'ringing' | 'active'; state_revision: number; }
export interface GroupCallEndedSyncPayload { room_id: string; generation: number; status: 'ended'; }
export type GroupCallSyncedPayload = GroupCallActiveSyncPayload | GroupCallEndedSyncPayload;
export interface GroupCallSyncedSocketEvent { version: typeof WEBSOCKET_PROTOCOL_VERSION; type: 'group.call.synced'; request_id: string; payload: GroupCallSyncedPayload; }
export interface GroupCallSignalSocketEvent { version: typeof WEBSOCKET_PROTOCOL_VERSION; type: 'group.call.signal'; payload: {room_id: string; generation: number; from_user_id: string; from_device_id: string; signal: CallSignal}; }

export type CallSocketEvent = CallStateSocketEvent | CallAcceptedSocketEvent | CallSignalSocketEvent | CallRejectedSocketEvent;
export type MessageSocketEvent = MessageAcceptedEvent | MessageCreatedEvent | MessageRejectedEvent | PresenceSnapshotEvent | PresenceChangedEvent | TypingSocketEvent | ConversationCreatedEvent | ConversationReadSocketEvent | GroupMembershipChangedSocketEvent | ConversationReconciledSocketEvent | CallSocketEvent | GroupCallRoomSocketEvent | GroupCallSyncedSocketEvent | GroupCallSignalSocketEvent;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCallPayload(value: unknown): value is CallPayload {
    if (!isRecord(value)) return false;
    const required = ['call_id', 'conversation_id', 'caller_id', 'recipient_id', 'caller_device_id', 'status', 'expires_at'];
    return required.every(key => typeof value[key] === 'string') &&
        (value.status === 'ringing' || value.status === 'active' || value.status === 'ended') &&
        (value.accepted_device_id === undefined || typeof value.accepted_device_id === 'string');
}

function isICEServers(value: unknown): value is ICEServer[] {
    return Array.isArray(value) && value.length > 0 && value.every(server => isRecord(server) && Array.isArray(server.urls) && server.urls.every(url => typeof url === 'string') && typeof server.username === 'string' && typeof server.credential === 'string');
}

function isValidCallSignal(value: unknown): value is CallSignal {
    if (!isRecord(value) || typeof value.type !== 'string') return false;
    if (value.type === 'offer' || value.type === 'answer') return typeof value.sdp === 'string' && value.sdp.length > 0;
    if (value.type === 'candidate') return isRecord(value.candidate);
    return value.type === 'screen-share-started' || value.type === 'screen-share-stopped';
}

function isAcceptedCallPayload(value: unknown): value is CallPayload & {ice_servers: ICEServer[]} {
    return isRecord(value) && isCallPayload(value) && isICEServers(value['ice_servers']);
}

function isGroupRoomPayload(value: unknown): value is GroupCallRoomPayload {
    if (!isRecord(value) || !isIdentifier(value.room_id) || !isIdentifier(value.conversation_id) || !isSequence(value.membership_revision) || !isSequence(value.generation) || !['ringing', 'active', 'ended'].includes(String(value.status)) || typeof value.expires_at !== 'string' || !Array.isArray(value.participants)) return false;
    return value.participants.every(item => isRecord(item) && isIdentifier(item.user_id) && isIdentifier(item.device_id)) && (value.presenter === undefined || (isRecord(value.presenter) && isIdentifier(value.presenter.user_id) && isIdentifier(value.presenter.device_id))) && (value.ice_servers === undefined || isICEServers(value.ice_servers));
}

export function isGroupRoomEventPayload(value: unknown): value is GroupCallRoomEventPayload {
    return isGroupRoomPayload(value) && isRecord(value) && isSequence(value.state_revision);
}

function isGroupCallActiveSyncPayload(value: unknown): value is GroupCallActiveSyncPayload {
    return isRecord(value) && isGroupRoomPayload(value) && (value.status === 'ringing' || value.status === 'active') &&
        isSequence(value.state_revision) && value.ice_servers === undefined;
}

function isGroupCallEndedSyncPayload(value: unknown): value is GroupCallEndedSyncPayload {
    return isRecord(value) && isIdentifier(value.room_id) && isSequence(value.generation) && value.status === 'ended' &&
        Object.keys(value).every(key => key === 'room_id' || key === 'generation' || key === 'status');
}

function isGroupCallMembershipProjectionEndedPayload(value: unknown): value is GroupCallMembershipProjectionEndedPayload {
    return isRecord(value) && isIdentifier(value.room_id) && isSequence(value.generation) && value.status === 'ended' &&
        isSequence(value.state_revision) && Object.keys(value).every(key => key === 'room_id' || key === 'generation' || key === 'status' || key === 'state_revision');
}

function isGroupCallSyncedPayload(value: unknown): value is GroupCallSyncedSocketEvent['payload'] {
    return isGroupCallEndedSyncPayload(value) || isGroupCallActiveSyncPayload(value);
}

function isMessagePayload(value: unknown): value is MessagePayload {
    if (!isRecord(value)) return false;
    const required = ['id', 'conversation_id', 'sender_id', 'client_message_id', 'body', 'created_at'];
    return required.every(key => typeof value[key] === 'string') &&
        typeof value.sequence === 'number' && Number.isSafeInteger(value.sequence) && value.sequence > 0 &&
        (value.kind === undefined || value.kind === 'user' || value.kind === 'system');
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

/** Reject malformed group-call commands at the transport boundary, including JS callers bypassing TS. */
export function isValidGroupCallClientEvent(event: unknown): event is GroupCallStartEvent | GroupCallJoinEvent | GroupCallSyncEvent | GroupCallControlEvent | GroupCallSignalEvent {
    if (!isRecord(event) || typeof event.type !== 'string') return false;
    if (event.type === 'group.call.start') {
        return isIdentifier(event.request_id) && isRecord(event.payload) && isIdentifier(event.payload.conversation_id) && !('generation' in event.payload);
    }
    if (!['group.call.join', 'group.call.sync', 'group.call.leave', 'group.call.end', 'group.call.presenter.start', 'group.call.presenter.stop', 'group.call.signal'].includes(event.type)) return false;
    if (!isIdentifier(event.request_id) || !isRecord(event.payload) || !isIdentifier(event.payload.conversation_id) || !isIdentifier(event.payload.room_id) || !isSequence(event.payload.generation)) return false;
    if (event.type === 'group.call.signal') {
        return isIdentifier(event.payload.target_user_id) && isIdentifier(event.payload.target_device_id) && isValidCallSignal(event.payload.signal);
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
    if (event.type === 'call.rejected') return isRecord(event.payload) && typeof event.payload.error === 'string';
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
            return isValidCallSocketEvent(event);
        case 'group.call.started':
        case 'group.call.participant.joined':
        case 'group.call.participant.left':
        case 'group.call.presenter.start':
        case 'group.call.presenter.stop':
            return isGroupRoomEventPayload(event.payload);
        case 'group.call.ended':
            return isGroupRoomEventPayload(event.payload) || isGroupCallMembershipProjectionEndedPayload(event.payload);
        case 'group.call.synced':
            return isIdentifier(event.request_id) && isGroupCallSyncedPayload(event.payload);
        case 'group.call.signal':
            return isRecord(event.payload) && typeof event.payload.room_id === 'string' && isSequence(event.payload.generation) && typeof event.payload.from_user_id === 'string' && typeof event.payload.from_device_id === 'string' && isValidCallSignal(event.payload.signal);
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
                        if (!isValidSocketEvent(event)) return;
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
