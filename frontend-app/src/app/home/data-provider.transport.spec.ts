import {HttpClientTestingModule, HttpTestingController} from '@angular/common/http/testing';
import {fakeAsync, TestBed, tick} from '@angular/core/testing';
import {Subject} from 'rxjs';
import {WebSocketSubject, WebSocketSubjectConfig} from 'rxjs/webSocket';

import {backends} from '../../environments/environment';
import {
    DataProviderService,
    MessageSocketEvent,
    WebSocketFactory,
    WEBSOCKET_FACTORY,
    WEBSOCKET_PROTOCOL_VERSION,
} from './data-provider.service';

interface TestSocket {
    socket: FakeSocket;
    config: WebSocketSubjectConfig<unknown>;
}

class FakeSocket extends Subject<unknown> {
    public readonly sent: unknown[] = [];

    public override next(value: unknown): void {
        this.sent.push(value);
    }

    public emit(value: unknown): void {
        super.next(value);
    }

    public fail(error: unknown): void {
        super.error(error);
    }
}

describe('DataProviderService transport', () => {
    let service: DataProviderService;
    let http: HttpTestingController;
    let sockets: TestSocket[];

    beforeEach(() => {
        sockets = [];
        const factory: WebSocketFactory = <T>(config: WebSocketSubjectConfig<T>) => {
            const socket = new FakeSocket();
            sockets.push({socket, config: config as unknown as WebSocketSubjectConfig<unknown>});
            return socket as unknown as WebSocketSubject<T>;
        };
        TestBed.configureTestingModule({
            imports: [HttpClientTestingModule],
            providers: [DataProviderService, {provide: WEBSOCKET_FACTORY, useValue: factory}],
        });
        service = TestBed.inject(DataProviderService);
        http = TestBed.inject(HttpTestingController);
    });

    afterEach(() => {
        service.close();
        http.verify();
    });

    it('uses an encoded ticket, versions outbound events, and filters malformed inbound events', () => {
        const received: MessageSocketEvent[] = [];
        service.getObservable().subscribe(event => received.push(event));

        const first = requestTicket('ticket with / sensitive+characters');
        expect(socketURL(first.config)).toBe(`${backends.websocket}?ticket=${encodeURIComponent('ticket with / sensitive+characters')}`);
        open(first.config);
        expect(service.ready).toBeTrue();

        expect(service.send({type: 'presence.refresh'})).toBeTrue();
        expect(first.socket.sent).toEqual([{type: 'presence.refresh', version: WEBSOCKET_PROTOCOL_VERSION}]);

        first.socket.emit(null);
        first.socket.emit({version: WEBSOCKET_PROTOCOL_VERSION, type: 'presence.snapshot', payload: null});
        first.socket.emit({version: 2, type: 'presence.snapshot', payload: {user_ids: ['peer-1']}});
        first.socket.emit({version: WEBSOCKET_PROTOCOL_VERSION, type: 'message.send', payload: {}});
        first.socket.emit({version: WEBSOCKET_PROTOCOL_VERSION, type: 'presence.snapshot', payload: {user_ids: ['peer-1']}});

        expect(received).toEqual([{
            version: WEBSOCKET_PROTOCOL_VERSION,
            type: 'presence.snapshot',
            payload: {user_ids: ['peer-1']},
        }]);
    });

    it('requests fresh tickets with bounded exponential reconnect delays', fakeAsync(() => {
        service.getObservable().subscribe();
        const initial = requestTicket('ticket-0');
        expect(socketURL(initial.config)).toBe(`${backends.websocket}?ticket=${encodeURIComponent('ticket-0')}`);

        const delays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
        let current = initial;
        for (let attempt = 0; attempt < delays.length; attempt += 1) {
            current.socket.fail(new Error('socket closed'));
            tick(delays[attempt] - 1);
            expect(sockets.length).toBe(attempt + 1);
            tick(1);

            const ticket = `ticket-${attempt + 1}`;
            const next = requestTicket(ticket);
            expect(socketURL(next.config)).toBe(`${backends.websocket}?ticket=${encodeURIComponent(ticket)}`);
            current = next;
        }

        service.close();
        tick(30_000);
        http.expectNone(backends.websocketTicket);
    }));

    it('does not schedule a reconnect after the provider is closed', fakeAsync(() => {
        service.getObservable().subscribe();
        const initial = requestTicket('ticket-0');

        initial.socket.fail(new Error('socket closed'));
        service.close();
        tick(30_000);

        http.expectNone(backends.websocketTicket);
        expect(service.ready).toBeFalse();
    }));

    it('does not open a socket when closed before the ticket response arrives', () => {
        service.getObservable().subscribe();
        const request = http.expectOne(backends.websocketTicket);

        service.close();
        request.flush({ticket: 'late-ticket'});

        expect(sockets).toHaveSize(0);
    });

    function requestTicket(ticket: string): TestSocket {
        const request = http.expectOne(backends.websocketTicket);
        expect(request.request.method).toBe('POST');
        expect(request.request.body).toEqual({});
        request.flush({ticket});
        const socket = sockets[sockets.length - 1];
        if (!socket) throw new Error('WebSocket factory was not called');
        return socket;
    }

    function open(config: WebSocketSubjectConfig<unknown>): void {
        (config.openObserver as {next?: () => void} | undefined)?.next?.();
    }

    function socketURL(config: WebSocketSubjectConfig<unknown>): string {
        return config.url;
    }
});
