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

export type ClientSocketEvent = MessageSendEvent | TypingClientEvent | PresenceRefreshEvent | ConversationReadEvent;

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
    payload: { conversation_id: string; sequence: number };
}

export type MessageSocketEvent = MessageAcceptedEvent | MessageCreatedEvent | MessageRejectedEvent | PresenceSnapshotEvent | PresenceChangedEvent | TypingSocketEvent | ConversationCreatedEvent | ConversationReadSocketEvent;

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
                        if (event.version === WEBSOCKET_PROTOCOL_VERSION) this.events.next(event as MessageSocketEvent);
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
