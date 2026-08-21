import {HttpClient} from '@angular/common/http';
import {Injectable} from '@angular/core';
import {webSocket, WebSocketSubject} from 'rxjs/webSocket';
import {backends} from '../../environments/environment';
import {BehaviorSubject, Observable, Subject} from 'rxjs';

export const WEBSOCKET_PROTOCOL_VERSION = 1 as const;

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

export type CallSignal =
    | { type: 'offer' | 'answer'; sdp: string }
    | { type: 'candidate'; candidate: object }
    | { type: 'screen-share-started' | 'screen-share-stopped' };

export type ClientSocketEvent = MessageSendEvent | TypingClientEvent | PresenceRefreshEvent | ConversationReadEvent | CallStartEvent | CallControlEvent | CallSignalEvent;

export interface MessagePayload {
    id: string;
    conversation_id: string;
    sender_id: string;
    client_message_id: string;
    sequence: number;
    body: string;
    created_at: string;
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
    payload: { conversation_id: string; user_id: string; sequence: number };
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

export type CallSocketEvent = CallStateSocketEvent | CallAcceptedSocketEvent | CallSignalSocketEvent | CallRejectedSocketEvent;
export type MessageSocketEvent = MessageAcceptedEvent | MessageCreatedEvent | MessageRejectedEvent | PresenceSnapshotEvent | PresenceChangedEvent | TypingSocketEvent | ConversationCreatedEvent | ConversationReadSocketEvent | CallSocketEvent;

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

export function isValidCallSocketEvent(event: unknown): event is CallSocketEvent {
    if (!isRecord(event) || event.version !== WEBSOCKET_PROTOCOL_VERSION || typeof event.type !== 'string' || !('payload' in event)) return false;
    if (event.type === 'call.signal') return isRecord(event.payload) && typeof event.payload.call_id === 'string' && isValidCallSignal(event.payload.signal);
    if (event.type === 'call.rejected') return isRecord(event.payload) && typeof event.payload.error === 'string';
    if (event.type === 'call.accepted') return isAcceptedCallPayload(event.payload);
    return ['call.incoming', 'call.ringing', 'call.declined', 'call.ended'].includes(event.type) && isCallPayload(event.payload);
}

export function isValidConversationReadEvent(event: unknown): event is ConversationReadSocketEvent {
    if (!isRecord(event) || event.version !== WEBSOCKET_PROTOCOL_VERSION || event.type !== 'conversation.read' || !isRecord(event.payload)) return false;
    return typeof event.payload.conversation_id === 'string' && typeof event.payload.user_id === 'string' && typeof event.payload.sequence === 'number' && Number.isSafeInteger(event.payload.sequence) && event.payload.sequence > 0;
}

interface WebSocketTicketResponse { ticket: string; }

@Injectable()
export class DataProviderService {
    private socket?: WebSocketSubject<MessageSocketEvent | (ClientSocketEvent & {version: typeof WEBSOCKET_PROTOCOL_VERSION})>;
    private socketReady = false;
    private started = false;
    private closed = false;
    private reconnectAttempt = 0;
    private reconnectTimer?: number;
    private readonly readySubject = new BehaviorSubject<boolean>(false);
    private readonly events = new Subject<MessageSocketEvent>();

    public constructor(private http: HttpClient) {}

    public getObservable(): Observable<MessageSocketEvent> {
        if (!this.started) {
            this.started = true;
            this.connect();
        }
        return this.events.asObservable();
    }

    public send(event: ClientSocketEvent): boolean {
        if (!this.socket || !this.socketReady) {
            return false;
        }
        this.socket.next({...event, version: WEBSOCKET_PROTOCOL_VERSION});
        return true;
    }

    public get ready(): boolean { return this.socketReady; }
    public get readyChanges(): Observable<boolean> { return this.readySubject.asObservable(); }

    public close(): void {
        this.closed = true;
        window.clearTimeout(this.reconnectTimer);
        this.readySubject.next(false);
        this.socket?.complete();
        this.socket?.unsubscribe();
        this.events.complete();
    }

    private connect(): void {
        if (this.closed) return;
        this.http.post<WebSocketTicketResponse>(backends.websocketTicket, {}).subscribe({
            next: ({ticket}) => {
                const url = `${backends.websocket}?ticket=${encodeURIComponent(ticket)}`;
                this.socket = webSocket<MessageSocketEvent | (ClientSocketEvent & {version: typeof WEBSOCKET_PROTOCOL_VERSION})>({
                    url,
                    openObserver: {next: () => {
                        this.reconnectAttempt = 0;
                        this.socketReady = true;
                        this.readySubject.next(true);
                    }},
                    closeObserver: {next: () => {
                        this.socketReady = false;
                        this.readySubject.next(false);
                    }},
                });
                this.socket.subscribe({
                    next: event => {
                        if (event.version === WEBSOCKET_PROTOCOL_VERSION && (!event.type.startsWith('call.') || isValidCallSocketEvent(event)) && (event.type !== 'conversation.read' || isValidConversationReadEvent(event))) this.events.next(event as MessageSocketEvent);
                    },
                    error: () => this.scheduleReconnect(),
                    complete: () => this.scheduleReconnect(),
                });
            },
            error: () => this.scheduleReconnect(),
        });
    }

    private scheduleReconnect(): void {
        if (this.closed || this.reconnectTimer !== undefined) return;
        this.socketReady = false;
        this.readySubject.next(false);
        const delay = Math.min(1_000 * 2 ** Math.min(this.reconnectAttempt++, 5), 30_000);
        this.reconnectTimer = window.setTimeout(() => {
            this.reconnectTimer = undefined;
            this.connect();
        }, delay);
    }
}
