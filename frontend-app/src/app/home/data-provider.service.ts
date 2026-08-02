import {HttpClient} from '@angular/common/http';
import {webSocket, WebSocketSubject} from 'rxjs/webSocket';
import {backends} from '../../environments/environment';
import {BehaviorSubject, Observable, switchMap} from 'rxjs';
import {Message} from './message.model';

export interface MessageSendEvent {
    type: 'message.send';
    request_id: string;
    payload: { conversation_id: string; client_message_id: string; body: string };
}

export interface MessageSocketEvent {
    type: 'message.accepted' | 'message.created' | 'message.rejected';
    request_id?: string;
    payload: Message | { error: string };
}

interface WebSocketTicketResponse { ticket: string; }

export class DataProviderService {
    private socket?: WebSocketSubject<MessageSocketEvent | MessageSendEvent>;
    private socketReady = false;
    private readonly readySubject = new BehaviorSubject<boolean>(false);

    public constructor(private http: HttpClient) {}

    public getObservable(): Observable<MessageSocketEvent> {
        return this.http.post<WebSocketTicketResponse>(backends.websocketTicket, {}).pipe(
            switchMap(({ticket}) => {
                const url = `${backends.websocket}?ticket=${encodeURIComponent(ticket)}`;
                this.socket = webSocket<MessageSocketEvent | MessageSendEvent>({
                    url,
                    openObserver: {next: () => {
                        this.socketReady = true;
                        this.readySubject.next(true);
                    }},
                    closeObserver: {next: () => {
                        this.socketReady = false;
                        this.readySubject.next(false);
                    }},
                });
                return this.socket.asObservable() as Observable<MessageSocketEvent>;
            }),
        );
    }

    public send(event: MessageSendEvent): boolean {
        if (!this.socket || !this.socketReady) {
            return false;
        }
        this.socket.next(event);
        return true;
    }

    public get ready(): boolean { return this.socketReady; }
    public get readyChanges(): Observable<boolean> { return this.readySubject.asObservable(); }

    public close(): void {
        this.readySubject.next(false);
        this.socket?.complete();
        this.socket?.unsubscribe();
    }
}
