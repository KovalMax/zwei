import {HttpClientTestingModule, HttpTestingController} from '@angular/common/http/testing';
import {fakeAsync, TestBed, tick} from '@angular/core/testing';
import {Subject} from 'rxjs';
import {WebSocketSubject, WebSocketSubjectConfig} from 'rxjs/webSocket';

import {backends} from '../../environments/environment';
import {
    DataProviderService,
    MessageSocketEvent,
    WebSocketFactory,
    RECONNECT_RANDOM,
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
        if (this.isStopped) return;
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
            providers: [DataProviderService, {provide: WEBSOCKET_FACTORY, useValue: factory}, {provide: RECONNECT_RANDOM, useValue: () => 0.5}],
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
        expect(service.ready).toBeFalse();

        first.socket.emit(null);
        first.socket.emit({version: WEBSOCKET_PROTOCOL_VERSION, type: 'presence.snapshot', payload: null});
        first.socket.emit({version: 1, type: 'presence.snapshot', payload: {user_ids: ['peer-1']}});
        first.socket.emit({version: WEBSOCKET_PROTOCOL_VERSION, type: 'message.send', payload: {}});
        first.socket.emit({version: WEBSOCKET_PROTOCOL_VERSION, type: 'presence.snapshot', payload: {user_ids: ['peer-1']}});

        expect(received).toEqual([{
            version: WEBSOCKET_PROTOCOL_VERSION,
            type: 'presence.snapshot',
            payload: {user_ids: ['peer-1']},
        }]);
        expect(service.ready).toBeTrue();
        expect(service.send({type: 'presence.refresh'})).toBeTrue();
        expect(first.socket.sent).toEqual([{type: 'presence.refresh', version: WEBSOCKET_PROTOCOL_VERSION}]);
    });

    it('sends generation-bearing group commands and blocks malformed generations before transport', () => {
        service.getObservable().subscribe();
        const socket = requestTicket('ticket-group-generation');
        open(socket.config);
        socket.socket.emit({version: WEBSOCKET_PROTOCOL_VERSION, type: 'presence.snapshot', payload: {user_ids: []}});
        const sentBefore = socket.socket.sent.length;
        const room = {conversation_id: 'group-1', room_id: 'room-1', generation: 7};
        const commands = [
            {type: 'group.call.start', request_id: 'start-1', payload: {conversation_id: 'group-1'}},
            {type: 'group.call.join', request_id: 'join-1', payload: room},
            {type: 'group.call.sync', request_id: 'sync-1', payload: room},
            {type: 'group.call.leave', request_id: 'leave-1', payload: room},
            {type: 'group.call.end', request_id: 'end-1', payload: room},
            {type: 'group.call.presenter.start', request_id: 'present-start-1', payload: room},
            {type: 'group.call.presenter.stop', request_id: 'present-stop-1', payload: room},
            {type: 'group.call.signal', request_id: 'signal-1', payload: {...room, target_user_id: 'peer-1', target_device_id: 'peer-device', signal: {type: 'candidate', candidate: {candidate: 'candidate'}}}},
        ];
        for (const command of commands) expect(service.send(command as never)).toBeTrue();
        expect(socket.socket.sent.slice(sentBefore)).toEqual(commands.map(command => ({...command, version: WEBSOCKET_PROTOCOL_VERSION})));

        const malformed = [
            {type: 'group.call.join', request_id: 'missing', payload: {conversation_id: 'group-1', room_id: 'room-1'}},
            {type: 'group.call.sync', request_id: 'sync-missing', payload: {...room, generation: 0}},
            {type: 'group.call.leave', request_id: 'zero', payload: {...room, generation: 0}},
            {type: 'group.call.end', request_id: 'fraction', payload: {...room, generation: 1.5}},
            {type: 'group.call.presenter.start', request_id: 'unsafe', payload: {...room, generation: Number.MAX_SAFE_INTEGER + 1}},
            {type: 'group.call.signal', request_id: 'signal-missing', payload: {...room, generation: undefined, target_user_id: 'peer-1', target_device_id: 'peer-device', signal: {type: 'offer', sdp: 'sdp'}}},
            {type: 'group.call.start', request_id: 'start-with-generation', payload: {conversation_id: 'group-1', generation: 7}},
        ];
        for (const command of malformed) expect(service.send(command as never)).toBeFalse();
        expect(socket.socket.sent).toHaveSize(sentBefore + commands.length);
    });

    it('maps active snapshots and minimal ended acknowledgements while rejecting malformed revisions', () => {
        const received: MessageSocketEvent[] = [];
        service.getObservable().subscribe(event => received.push(event));
        const socket = requestTicket('ticket-group-sync');
        open(socket.config);
        const payload = {room_id: 'room-1', conversation_id: 'group-1', membership_revision: 3, generation: 7, state_revision: 9, status: 'active' as const, expires_at: '2026-01-01T00:00:00Z', participants: [{user_id: 'self-1', device_id: 'device-1'}]};
        socket.socket.emit({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', request_id: 'sync-1', payload});
        socket.socket.emit({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', request_id: 'sync-2', payload: {...payload, state_revision: -1}});
        socket.socket.emit({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', payload});
        const ended = {room_id: 'room-1', generation: 7, status: 'ended' as const};
        socket.socket.emit({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', request_id: 'sync-ended', payload: ended});
        socket.socket.emit({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', request_id: 'sync-ended-with-roster', payload: {...ended, participants: []}});
        expect(received).toEqual([
            {version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', request_id: 'sync-1', payload},
            {version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', request_id: 'sync-ended', payload: ended},
        ]);
    });

    it('requires state_revision on every ordinary group room event', () => {
        const received: MessageSocketEvent[] = [];
        service.getObservable().subscribe(event => received.push(event));
        const socket = requestTicket('ticket-group-room-revision');
        open(socket.config);
        const payload = {room_id: 'room-1', conversation_id: 'group-1', membership_revision: 3, generation: 7, state_revision: 2, status: 'active' as const, expires_at: '2026-01-01T00:00:00Z', participants: []};

        socket.socket.emit({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.started', payload});
        socket.socket.emit({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.participant.joined', payload: {...payload, state_revision: 0}});
        const ended = {room_id: 'room-1', generation: 7, state_revision: 3, status: 'ended' as const};
        socket.socket.emit({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.ended', payload: ended});
        socket.socket.emit({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.ended', payload: {...ended, participants: []}});
        socket.socket.emit({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.ended', payload: {...ended, state_revision: 0}});

        expect(received).toEqual([
            {version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.started', payload},
            {version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.ended', payload: ended},
        ]);
    });

    it('stays recovering until the active reconciliation and presence snapshot complete', () => {
        service.getObservable().subscribe();
        const socket = requestTicket('ticket-0');
        open(socket.config);

        expect(service.connectionState).toBe('recovering');
        expect(service.recover('conversation-1', 4, 'reconcile-1')).toBeTrue();
        expect(socket.socket.sent).toContain({type: 'conversation.reconcile', request_id: 'reconcile-1', payload: {conversation_id: 'conversation-1', after_sequence: 4}, version: WEBSOCKET_PROTOCOL_VERSION});

        socket.socket.emit({
            version: WEBSOCKET_PROTOCOL_VERSION,
            type: 'conversation.reconciled',
            request_id: 'reconcile-1',
            payload: {conversation_id: 'conversation-1', messages: [], next_after_sequence: 4, high_watermark: 4, has_more: false, own_read_sequence: 4, peer_read_sequence: 3},
        });
        expect(service.ready).toBeFalse();

        socket.socket.emit({version: WEBSOCKET_PROTOCOL_VERSION, type: 'presence.snapshot', payload: {user_ids: []}});
        expect(service.ready).toBeTrue();
        expect(service.connectionState).toBe('ready');
    });

    it('keeps an open socket ready when reconciliation is rejected', fakeAsync(() => {
        service.getObservable().subscribe();
        const socket = requestTicket('ticket-recovery-rejected');
        open(socket.config);
        socket.socket.emit({version: WEBSOCKET_PROTOCOL_VERSION, type: 'presence.snapshot', payload: {user_ids: []}});

        expect(service.recover('conversation-1', 4, 'reconcile-1')).toBeTrue();
        socket.socket.emit({
            version: WEBSOCKET_PROTOCOL_VERSION,
            type: 'message.rejected',
            request_id: 'reconcile-1',
            payload: {error: 'conversation not found'},
        });

        expect(service.ready).toBeTrue();
        expect(service.connectionState).toBe('ready');
        tick(30_000);
        http.expectNone(backends.websocketTicket);
    }));

    it('accepts only a well-formed v2 group membership revision event', () => {
        const received: MessageSocketEvent[] = [];
        service.getObservable().subscribe(event => received.push(event));
        const socket = requestTicket('ticket-group');
        open(socket.config);

        socket.socket.emit({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: {conversation_id: 'group-1', membership_revision: 3, deleted: false}});
        socket.socket.emit({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: {conversation_id: 'group-1', membership_revision: 0, deleted: false}});
        socket.socket.emit({version: 1, type: 'group.membership.changed', payload: {conversation_id: 'group-1', membership_revision: 4, deleted: false}});

        expect(received).toEqual([{version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: {conversation_id: 'group-1', membership_revision: 3, deleted: false}}]);
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

    it('ignores callbacks and events from a superseded socket generation', fakeAsync(() => {
        const received: MessageSocketEvent[] = [];
        service.getObservable().subscribe(event => received.push(event));
        const first = requestTicket('ticket-0');
        open(first.config);
        first.socket.fail(new Error('socket closed'));
        tick(1_000);

        const second = requestTicket('ticket-1');
        open(second.config);
        (first.config.openObserver as {next?: () => void} | undefined)?.next?.();
        (first.config.closeObserver as {next?: () => void} | undefined)?.next?.();
        first.socket.emit({version: WEBSOCKET_PROTOCOL_VERSION, type: 'presence.snapshot', payload: {user_ids: ['stale-peer']}});
        second.socket.emit({version: WEBSOCKET_PROTOCOL_VERSION, type: 'presence.snapshot', payload: {user_ids: ['current-peer']}});

        expect(service.ready).toBeTrue();
        expect(received).toEqual([{version: WEBSOCKET_PROTOCOL_VERSION, type: 'presence.snapshot', payload: {user_ids: ['current-peer']}}]);
    }));

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
