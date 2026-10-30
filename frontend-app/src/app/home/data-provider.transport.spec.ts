import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import {TestBed} from '@angular/core/testing';
import {fakeAsync, tick} from '../../testing/vitest-timers';
import { Subject } from 'rxjs';
import { WebSocketSubject, WebSocketSubjectConfig } from 'rxjs/webSocket';

import { backends } from '../../environments/environment';
import { DataProviderService, isValidGroupCallClientEvent, MessageSocketEvent, WebSocketFactory, RECONNECT_RANDOM, WEBSOCKET_FACTORY, WEBSOCKET_PROTOCOL_VERSION, } from './data-provider.service';

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
        if (this.isStopped)
            return;
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
            sockets.push({ socket, config: config as unknown as WebSocketSubjectConfig<unknown> });
            return socket as unknown as WebSocketSubject<T>;
        };
        TestBed.configureTestingModule({
            imports: [HttpClientTestingModule],
            providers: [DataProviderService, { provide: WEBSOCKET_FACTORY, useValue: factory }, { provide: RECONNECT_RANDOM, useValue: () => 0.5 }],
        });
        service = TestBed.inject(DataProviderService);
        http = TestBed.inject(HttpTestingController);
    });

    afterEach(() => {
        service.close();
        http.verify();
    });

    it('validates correlated group credential commands and responses', () => {
        const received: MessageSocketEvent[] = [];
        service.getObservable().subscribe(event => received.push(event));
        const socket = requestTicket('ticket');
        open(socket.config);
        socket.socket.emit({version: 3, type: 'presence.snapshot', payload: {user_ids: []}});
        const payload = {conversation_id: 'group-1', room_id: 'room-1', generation: 1};
        expect(service.send({type: 'group.call.credentials', request_id: 'request-1', payload})).toBe(true);
        expect(socket.socket.sent).toContainEqual({version: 3, type: 'group.call.credentials', request_id: 'request-1', payload});
        const credentials = {...payload, ice_servers: [{urls: ['turn:example.test'], username: 'opaque', credential: 'opaque'}], ice_expires_at: '2099-01-01T00:00:00Z'};
        socket.socket.emit({version: 3, type: 'group.call.credentials', request_id: 'request-1', payload: {...credentials, ice_expires_at: 'invalid'}});
        socket.socket.emit({version: 3, type: 'group.call.credentials', payload: credentials});
        socket.socket.emit({version: 3, type: 'group.call.credentials', request_id: 'request-1', payload: credentials});
        expect(received.filter(event => event.type === 'group.call.credentials')).toEqual([{version: 3, type: 'group.call.credentials', request_id: 'request-1', payload: credentials}]);
    });

    it('uses an encoded ticket, versions outbound events, and filters malformed inbound events', () => {
        expect(WEBSOCKET_PROTOCOL_VERSION).toBe(3);
        expect(backends.websocket).toMatch(/\/ws\/v3$/);
        const received: MessageSocketEvent[] = [];
        service.getObservable().subscribe(event => received.push(event));

        const first = requestTicket('ticket with / sensitive+characters');
        expect(socketURL(first.config)).toBe(`${backends.websocket}?ticket=${encodeURIComponent('ticket with / sensitive+characters')}`);
        open(first.config);
        expect(service.ready).toBe(false);

        first.socket.emit(null);
        first.socket.emit({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'presence.snapshot', payload: null });
        first.socket.emit({ version: 1, type: 'presence.snapshot', payload: { user_ids: ['peer-1'] } });
        first.socket.emit({ version: 2, type: 'presence.snapshot', payload: { user_ids: ['peer-1'] } });
        first.socket.emit({ version: 4, type: 'presence.snapshot', payload: { user_ids: ['peer-1'] } });
        first.socket.emit({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'message.send', payload: {} });
        first.socket.emit({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'presence.snapshot', payload: { user_ids: ['peer-1'] } });

        expect(received).toEqual([{
                version: WEBSOCKET_PROTOCOL_VERSION,
                type: 'presence.snapshot',
                payload: { user_ids: ['peer-1'] },
            }]);
        expect(service.ready).toBe(true);
        expect(service.send({ type: 'presence.refresh' })).toBe(true);
        expect(first.socket.sent).toEqual([{ type: 'presence.refresh', version: 3 }]);
    });

    it('validates group start preparation and cancellation messages', () => {
        const received: MessageSocketEvent[] = [];
        service.getObservable().subscribe(event => received.push(event));
        const socket = requestTicket('group-start');
        open(socket.config);
        socket.socket.emit({version: WEBSOCKET_PROTOCOL_VERSION, type: 'presence.snapshot', payload: {user_ids: []}});
        const attempt = 'f9ad4b72-67a1-40fb-b307-428aa956d762';
        expect(service.send({type: 'group.call.prepare_start', request_id: 'request-1', payload: {conversation_id: 'group-1'}})).toBe(true);
        expect(service.send({type: 'group.call.cancel_start', request_id: 'request-2', payload: {conversation_id: 'group-1', attempt_id: attempt}})).toBe(true);
        expect(service.send({type: 'group.call.cancel_start', request_id: 'request-2', payload: {conversation_id: 'group-1', attempt_id: 'bad'}})).toBe(false);
        const prepared = {version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.start_prepared', request_id: 'request-1', payload: {conversation_id: 'group-1', attempt_id: attempt, expires_at: '2026-01-01T00:00:00Z'}};
        const cancelled = {version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.start_cancelled', request_id: 'request-2', payload: {conversation_id: 'group-1', attempt_id: attempt, outcome: 'confirmed'}};
        socket.socket.emit({...prepared, payload: {...prepared.payload, expires_at: 'invalid'}});
        socket.socket.emit({...prepared, payload: {...prepared.payload, attempt_id: 'bad'}});
        socket.socket.emit({...cancelled, payload: {...cancelled.payload, outcome: 'absent'}});
        socket.socket.emit(prepared);
        socket.socket.emit(cancelled);
        socket.socket.emit({...cancelled, payload: {...cancelled.payload, outcome: 'retired'}});
        socket.socket.emit({...cancelled, payload: {...cancelled.payload, outcome: 'unknown'}});
        expect(received.slice(1)).toEqual([prepared, cancelled, {...cancelled, payload: {...cancelled.payload, outcome: 'retired'}}, {...cancelled, payload: {...cancelled.payload, outcome: 'unknown'}}]);
    });

    it('keeps optional mention metadata on correlated message sends and filters malformed inbound mentions', () => {
        const received: MessageSocketEvent[] = [];
        service.getObservable().subscribe(event => received.push(event));
        const socket = requestTicket('mentions');
        open(socket.config);
        socket.socket.emit({version: WEBSOCKET_PROTOCOL_VERSION, type: 'presence.snapshot', payload: {user_ids: []}});
        const command = {type: 'message.send' as const, request_id: 'request-1', payload: {conversation_id: 'chat-1', client_message_id: 'client-1', body: '😀 @Alice', content_type: 'text' as const, mentions: [{user_id: 'alice', start: 3, end: 9}]}};
        expect(service.send(command)).toBe(true);
        expect(socket.socket.sent.at(-1)).toEqual({...command, version: WEBSOCKET_PROTOCOL_VERSION});
        expect(service.send({...command, payload: {...command.payload, mentions: [{user_id: 'alice', start: 1, end: 3}]}})).toBe(false);

        const payload = {id: 'message-1', conversation_id: 'chat-1', sender_id: 'alice', client_message_id: 'client-1', sequence: 1, body: '😀 @Alice', created_at: '2026-01-01T00:00:00Z'};
        socket.socket.emit({version: WEBSOCKET_PROTOCOL_VERSION, type: 'message.created', payload: {...payload, mentions: [{user_id: 'alice', start: 3, end: 9}]}});
        socket.socket.emit({version: WEBSOCKET_PROTOCOL_VERSION, type: 'message.created', payload: {...payload, mentions: [{user_id: 'alice', start: 1, end: 3}]}});
        expect(received.filter(event => event.type === 'message.created')).toHaveLength(1);
    });

    it('rejects sticker and omitted content types before sending', () => {
        service.getObservable().subscribe();
        const socket = requestTicket('legacy-sticker');
        open(socket.config);
        socket.socket.emit({version: WEBSOCKET_PROTOCOL_VERSION, type: 'presence.snapshot', payload: {user_ids: []}});
        const command = {
            type: 'message.send' as const,
            request_id: 'legacy-sticker-request',
            payload: {conversation_id: 'chat-1', client_message_id: 'legacy-sticker-client', body: 'cat', content_type: 'sticker' as const},
        };

        const before = socket.socket.sent.length;
        expect(service.send(command as never)).toBe(false);
        const {content_type: _contentType, ...withoutType} = command.payload;
        expect(service.send({...command, payload: withoutType} as never)).toBe(false);
        expect(socket.socket.sent).toHaveLength(before);
    });

    it('sends generation-bearing group commands and blocks malformed generations before transport', () => {
        service.getObservable().subscribe();
        const socket = requestTicket('ticket-group-generation');
        open(socket.config);
        socket.socket.emit({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'presence.snapshot', payload: { user_ids: [] } });
        const sentBefore = socket.socket.sent.length;
        const room = { conversation_id: 'group-1', room_id: 'room-1', generation: 7 };
        const commands = [
            { type: 'group.call.discover', request_id: 'discover-1', payload: { conversation_id: 'group-1' } },
            { type: 'group.call.start', request_id: 'start-1', payload: { conversation_id: 'group-1', attempt_id: 'f9ad4b72-67a1-40fb-b307-428aa956d762' } },
            { type: 'group.call.join', request_id: 'join-1', payload: room },
            { type: 'group.call.sync', request_id: 'sync-1', payload: { ...room, ownership_status: true } },
            { type: 'group.call.leave', request_id: 'leave-1', payload: room },
            { type: 'group.call.end', request_id: 'end-1', payload: room },
            { type: 'group.call.presenter.start', request_id: 'present-start-1', payload: room },
            { type: 'group.call.presenter.stop', request_id: 'present-stop-1', payload: room },
            { type: 'group.call.signal', request_id: 'signal-1', payload: { ...room, target_user_id: 'peer-1', target_device_id: 'peer-device', signal: { type: 'candidate', candidate: { candidate: '', usernameFragment: 'ice', sdpMid: 'audio' } } } },
        ];
        for (const command of commands)
            expect(service.send(command as never)).toBe(true);
        expect(socket.socket.sent.slice(sentBefore)).toEqual(commands.map(command => ({ ...command, version: WEBSOCKET_PROTOCOL_VERSION })));

        const malformed = [
            { type: 'group.call.join', request_id: 'missing', payload: { conversation_id: 'group-1', room_id: 'room-1' } },
            { type: 'group.call.sync', request_id: 'sync-missing', payload: { ...room, generation: 0 } },
            { type: 'group.call.sync', request_id: 'sync-legacy', payload: room },
            { type: 'group.call.sync', request_id: 'sync-false', payload: { ...room, ownership_status: false } },
            { type: 'group.call.sync', request_id: 'sync-invalid', payload: { ...room, ownership_status: 'true' } },
            { type: 'group.call.leave', request_id: 'zero', payload: { ...room, generation: 0 } },
            { type: 'group.call.end', request_id: 'fraction', payload: { ...room, generation: 1.5 } },
            { type: 'group.call.presenter.start', request_id: 'unsafe', payload: { ...room, generation: Number.MAX_SAFE_INTEGER + 1 } },
            { type: 'group.call.signal', request_id: 'signal-missing', payload: { ...room, generation: undefined, target_user_id: 'peer-1', target_device_id: 'peer-device', signal: { type: 'offer', sdp: 'sdp' } } },
            { type: 'group.call.start', request_id: 'start-with-generation', payload: { conversation_id: 'group-1', generation: 7 } },
            { type: 'group.call.start', request_id: 'start-without-attempt', payload: { conversation_id: 'group-1' } },
        ];
        for (const command of malformed)
            expect(service.send(command as never)).toBe(false);
        expect(socket.socket.sent).toHaveLength(sentBefore + commands.length);
    });

    it('blocks malformed direct call signals before transport', () => {
        service.getObservable().subscribe();
        const socket = requestTicket('ticket-direct-call-validation');
        open(socket.config);
        socket.socket.emit({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'presence.snapshot', payload: { user_ids: [] } });
        const sentBefore = socket.socket.sent.length;

        expect(service.send({type: 'call.signal', request_id: 'valid', payload: {call_id: 'call-1', signal: {type: 'offer', sdp: 'offer sdp'}}})).toBe(true);
        expect(service.send({type: 'call.signal', request_id: 'extra-marker', payload: {call_id: 'call-1', signal: {type: 'screen-share-started', extra: true}}} as never)).toBe(false);
        expect(service.send({type: 'call.signal', request_id: 'extra-offer-field', payload: {call_id: 'call-1', signal: {type: 'offer', sdp: 'offer sdp', extra: true}}} as never)).toBe(false);
        expect(socket.socket.sent).toHaveLength(sentBefore + 1);
        expect(socket.socket.sent[sentBefore]).toEqual({type: 'call.signal', request_id: 'valid', payload: {call_id: 'call-1', signal: {type: 'offer', sdp: 'offer sdp'}}, version: WEBSOCKET_PROTOCOL_VERSION});
    });

    it('sends correlated direct-call recovery and discards malformed recovery projections', () => {
        const received: MessageSocketEvent[] = [];
        service.getObservable().subscribe(event => received.push(event));
        const socket = requestTicket('ticket-call-recovery');
        open(socket.config);
        socket.socket.emit({version: WEBSOCKET_PROTOCOL_VERSION, type: 'presence.snapshot', payload: {user_ids: []}});
        const request = {type: 'call.recover', request_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', payload: {call_id: '11111111-1111-4111-8111-111111111111'}} as const;
        expect(service.send(request)).toBe(true);
        expect(socket.socket.sent.at(-1)).toEqual({...request, version: WEBSOCKET_PROTOCOL_VERSION});
        const ringing = {version: WEBSOCKET_PROTOCOL_VERSION, type: 'call.recovered', request_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', payload: {status: 'ringing', call: {call_id: '11111111-1111-4111-8111-111111111111', conversation_id: '22222222-2222-4222-8222-222222222222', caller_id: '33333333-3333-4333-8333-333333333333', status: 'ringing', expires_at: '2099-01-01T00:00:00Z'}}};
        socket.socket.emit(ringing);
        socket.socket.emit({...ringing, payload: {...ringing.payload, call: {...ringing.payload.call, status: 'active'}}});
        socket.socket.emit({...ringing, payload: {...ringing.payload, unexpected: '/profile'}});
        socket.socket.emit({...request, payload: {call_id: ''}} as never);
        expect(received.filter(event => event.type === 'call.recovered')).toEqual([ringing]);
    });

    it('filters malformed direct and group call signal server events before publishing them', () => {
        const received: MessageSocketEvent[] = [];
        service.getObservable().subscribe(event => received.push(event));
        const socket = requestTicket('ticket-call-signals');
        open(socket.config);
        const validDirect = { version: WEBSOCKET_PROTOCOL_VERSION, type: 'call.signal', payload: { call_id: 'call-1', signal: { type: 'offer', sdp: 'offer sdp' } } };
        const validGroup = { version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.signal', payload: { room_id: 'room-1', generation: 2, from_user_id: 'peer-1', from_device_id: 'device-1', signal: { type: 'candidate', candidate: { candidate: '', usernameFragment: 'ice', sdpMid: 'audio' } } } };

        socket.socket.emit(validDirect);
        const directCandidate = {...validDirect, payload: {...validDirect.payload, signal: {type: 'candidate', candidate: {candidate: 'opaque', extra: true}}}};
        socket.socket.emit(directCandidate);
        socket.socket.emit({ ...validDirect, payload: { ...validDirect.payload, signal: { type: 'offer', sdp: 'offer sdp', candidate: {} } } });
        socket.socket.emit({ ...validDirect, payload: { ...validDirect.payload, signal: { type: 'screen-share-started', sdp: 'unexpected' } } });
        socket.socket.emit(validGroup);
        socket.socket.emit({ ...validGroup, payload: { ...validGroup.payload, signal: { type: 'answer', sdp: '' } } });
        socket.socket.emit({ ...validGroup, payload: { ...validGroup.payload, signal: { type: 'screen-share-stopped', candidate: {} } } });

        expect(received).toEqual([validDirect, directCandidate, validGroup]);
    });

    it('requires canonical non-nil negotiation IDs on group offers and answers only', () => {
        const received: MessageSocketEvent[] = [];
        service.getObservable().subscribe(event => received.push(event));
        const socket = requestTicket('ticket-negotiation');
        open(socket.config);
        const id = '8c72dd14-fafe-4e2d-9735-e09c37358bf1';
        const payload = {room_id: 'room-1', generation: 1, from_user_id: 'peer-1', from_device_id: 'device-1'};
        const commandPayload = {conversation_id: 'group-1', room_id: 'room-1', generation: 1, target_user_id: 'peer-1', target_device_id: 'device-1'};
        for (const type of ['offer', 'answer']) {
            for (const invalid of [undefined, id.toUpperCase(), '00000000-0000-0000-0000-000000000000', 'invalid']) {
                const signal = {type, sdp: 'opaque', negotiation_id: invalid};
                socket.socket.emit({version: 3, type: 'group.call.signal', payload: {...payload, signal}});
                expect(isValidGroupCallClientEvent({type: 'group.call.signal', request_id: 'r', payload: {...commandPayload, signal}})).toBe(false);
            }
            const signal = {type, sdp: 'opaque', negotiation_id: id};
            socket.socket.emit({version: 3, type: 'group.call.signal', payload: {...payload, signal}});
            expect(isValidGroupCallClientEvent({type: 'group.call.signal', request_id: 'r', payload: {...commandPayload, signal}})).toBe(true);
        }
        socket.socket.emit({version: 3, type: 'group.call.signal', payload: {...payload, signal: {type: 'candidate', candidate: {}, negotiation_id: id}}});
        expect(received).toHaveLength(2);
    });

    it('validates group candidates at the command boundary without changing direct calls', () => {
        const payload = {conversation_id: 'group-1', room_id: 'room-1', generation: 1, target_user_id: 'peer-1', target_device_id: 'device-1'};
        const line = 'candidate:1 1 udp 1 example.invalid 9 typ host';
        const group = (candidate: unknown): unknown => ({type: 'group.call.signal', request_id: 'r', payload: {...payload, signal: {type: 'candidate', candidate}}});
        const valid = [
            {candidate: '', usernameFragment: 'ice', sdpMid: 'audio'},
            {candidate: `${line} ufrag ice`, sdpMLineIndex: 0},
            {candidate: '', usernameFragment: 'x'.repeat(256), sdpMid: '😀'.repeat(256), sdpMLineIndex: 65535},
            {candidate: line + ' ' + 'x'.repeat(4096 - line.length - 1), usernameFragment: 'ice', sdpMid: null, sdpMLineIndex: 0},
            {candidate: `${line} ufrag ice\u00a0suffix`, sdpMid: 'audio'},
            {candidate: '', usernameFragment: 'ice\ufeffsuffix', sdpMid: 'audio'},
        ];
        const invalid = [
            {}, {candidate: '', usernameFragment: 'ice'}, {candidate: '', sdpMid: 'audio'},
            {candidate: 'opaque', usernameFragment: 'ice', sdpMid: 'audio'},
            {candidate: `${line} ufrag old`, usernameFragment: 'new', sdpMid: 'audio'},
            {candidate: `${line} ufrag old ufrag old`, sdpMid: 'audio'},
            {candidate: '', usernameFragment: 'x'.repeat(257), sdpMid: 'audio'},
            {candidate: '', usernameFragment: 'ice\u0085suffix', sdpMid: 'audio'},
            {candidate: line.replace('1 1', '1\u000b1'), usernameFragment: 'ice', sdpMid: 'audio'},
            {candidate: '', usernameFragment: 'ice', sdpMid: '😀'.repeat(257)},
            {candidate: line + ' ' + 'x'.repeat(4096 - line.length), usernameFragment: 'ice', sdpMid: 'audio'},
            {candidate: '', usernameFragment: 'ice', sdpMLineIndex: -1},
            {candidate: '', usernameFragment: 'ice', sdpMLineIndex: 65536},
            {candidate: '', usernameFragment: 'ice', sdpMLineIndex: 1.5},
            {candidate: '', usernameFragment: 'ice', sdpMid: 'audio', extra: true},
        ];
        for (const candidate of valid) expect(isValidGroupCallClientEvent(group(candidate))).toBe(true);
        for (const candidate of invalid) expect(isValidGroupCallClientEvent(group(candidate))).toBe(false);
        service.getObservable().subscribe();
        const socket = requestTicket('ticket-direct-ice-compat');
        open(socket.config);
        socket.socket.emit({version: WEBSOCKET_PROTOCOL_VERSION, type: 'presence.snapshot', payload: {user_ids: []}});
        expect(service.send({type: 'call.signal', request_id: 'direct', payload: {call_id: 'call-1', signal: {type: 'candidate', candidate: {candidate: 'opaque', extra: true}}}})).toBe(true);
    });

    it('replaces invalid incoming group candidates with a peer-scoped diagnostic without retaining their payload', () => {
        const received: MessageSocketEvent[] = [];
        service.getObservable().subscribe(event => received.push(event));
        const socket = requestTicket('ticket-group-candidate-validation');
        open(socket.config);
        const payload = {room_id: 'room-1', generation: 1, from_user_id: 'peer-1', from_device_id: 'device-1'};
        const event = (candidate: unknown): void => socket.socket.emit({version: 3, type: 'group.call.signal', payload: {...payload, signal: {type: 'candidate', candidate}}});
        const valid = {candidate: '', usernameFragment: 'ice', sdpMLineIndex: 65535};
        event(valid);
        event({candidate: 'opaque-sensitive-value', usernameFragment: 'ice', sdpMid: 'audio'});
        event({candidate: '', usernameFragment: 'ice', sdpMid: 'audio', extra: true});
        expect(received).toEqual([
            {version: 3, type: 'group.call.signal', payload: {...payload, signal: {type: 'candidate', candidate: valid}}},
            {version: 3, type: 'group.call.invalid_candidate', payload},
            {version: 3, type: 'group.call.invalid_candidate', payload},
        ]);
        expect(JSON.stringify(received)).not.toContain('opaque-sensitive-value');
    });

    it('accepts only correlated discovery snapshots with the requested conversation and valid room shape', () => {
        const received: MessageSocketEvent[] = [];
        service.getObservable().subscribe(event => received.push(event));
        const socket = requestTicket('ticket-group-discovery');
        open(socket.config);
        const room = { room_id: 'room-1', conversation_id: 'group-1', membership_revision: 1, generation: 2, state_revision: 5, status: 'active' as const, expires_at: '2026-01-01T00:00:00Z', participants: [] };
        socket.socket.emit({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.discovered', request_id: 'discover-1', payload: { conversation_id: 'group-1', room } });
        socket.socket.emit({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.discovered', request_id: 'discover-2', payload: { conversation_id: 'group-1', room: { ...room, conversation_id: 'other-group' } } });
        socket.socket.emit({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.discovered', request_id: 'discover-3', payload: { conversation_id: 'group-1', room: { room_id: 'room-1' } } });
        socket.socket.emit({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.discovered', request_id: 'discover-ice', payload: { conversation_id: 'group-1', room: { ...room, ice_servers: [] } } });
        socket.socket.emit({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.discovered', request_id: 'discover-connection-id', payload: { conversation_id: 'group-1', room: { ...room, participants: [{ user_id: 'member-1', device_id: 'device-1', connection_id: 'private-connection' }] } } });
        socket.socket.emit({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.discovered', request_id: 'discover-null', payload: { conversation_id: 'group-1', room: null } });
        expect(received).toEqual([
            { version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.discovered', request_id: 'discover-1', payload: { conversation_id: 'group-1', room } },
            { version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.discovered', request_id: 'discover-null', payload: { conversation_id: 'group-1', room: null } },
        ]);
    });

    it('preserves the group invitation deadline and rejects malformed deadlines', () => {
        const received: MessageSocketEvent[] = [];
        service.getObservable().subscribe(event => received.push(event));
        const socket = requestTicket('ticket-group-ring-deadline');
        open(socket.config);
        const payload = {room_id: 'room-1', conversation_id: 'group-1', membership_revision: 1, generation: 1, state_revision: 1, status: 'ringing' as const, expires_at: '2099-01-01T02:00:00Z', ring_expires_at: '2099-01-01T00:00:30Z', participants: []};
        const event = {version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.started', payload};
        socket.socket.emit(event);
        socket.socket.emit({...event, payload: {...payload, ring_expires_at: 'invalid'}});
        const {ring_expires_at: _deadline, ...missingDeadline} = payload;
        socket.socket.emit({...event, payload: missingDeadline});
        expect(received).toEqual([event]);
    });

    it('maps active snapshots and minimal ended acknowledgements while rejecting malformed revisions', () => {
        const received: MessageSocketEvent[] = [];
        service.getObservable().subscribe(event => received.push(event));
        const socket = requestTicket('ticket-group-sync');
        open(socket.config);
        const payload = { room_id: 'room-1', conversation_id: 'group-1', membership_revision: 3, generation: 7, state_revision: 9, status: 'active' as const, ownership_status: 'active' as const, expires_at: '2026-01-01T00:00:00Z', participants: [{ user_id: 'self-1', device_id: 'device-1' }] };
        socket.socket.emit({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', request_id: 'sync-1', payload });
        socket.socket.emit({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', request_id: 'sync-2', payload: { ...payload, state_revision: -1 } });
        socket.socket.emit({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', payload });
        const ended = { room_id: 'room-1', generation: 7, status: 'ended' as const, ownership_status: 'participant_absent' as const, support_ref: 'group-ref-1' };
        const { ownership_status: _activeOwnership, ...legacyActive } = payload;
        const { ownership_status: _endedOwnership, ...legacyEnded } = ended;
        socket.socket.emit({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', request_id: 'legacy-active', payload: legacyActive });
        socket.socket.emit({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', request_id: 'legacy-ended', payload: legacyEnded });
        socket.socket.emit({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', request_id: 'sync-ended', payload: ended });
        socket.socket.emit({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', request_id: 'sync-ended-with-roster', payload: { ...ended, participants: [] } });
        socket.socket.emit({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', request_id: 'owned', payload: { ...ended, ownership_status: 'owned_elsewhere' } });
        socket.socket.emit({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', request_id: 'bad-status', payload: { ...ended, ownership_status: 'active' } });
        socket.socket.emit({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', request_id: 'bad-active', payload: { ...payload, ownership_status: 'participant_absent' } });
        socket.socket.emit({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', request_id: 'unknown', payload: { ...ended, ownership_status: 'unknown' } });
        expect(received).toEqual([
            { version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', request_id: 'sync-1', payload },
            { version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', request_id: 'sync-ended', payload: ended },
            { version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', request_id: 'owned', payload: { ...ended, ownership_status: 'owned_elsewhere' } },
        ]);
    });

    it('requires state_revision on every ordinary group room event', () => {
        const received: MessageSocketEvent[] = [];
        service.getObservable().subscribe(event => received.push(event));
        const socket = requestTicket('ticket-group-room-revision');
        open(socket.config);
        const payload = { room_id: 'room-1', conversation_id: 'group-1', membership_revision: 3, generation: 7, state_revision: 2, status: 'active' as const, expires_at: '2026-01-01T00:00:00Z', ring_expires_at: '2026-01-01T00:00:00Z', participants: [], support_ref: 'group-ref-1' };

        socket.socket.emit({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.started', payload });
        socket.socket.emit({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.participant.joined', payload: { ...payload, state_revision: 0 } });
        const ended = { room_id: 'room-1', generation: 7, state_revision: 3, status: 'ended' as const, support_ref: 'group-ref-1' };
        socket.socket.emit({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.ended', payload: ended });
        socket.socket.emit({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.ended', payload: { ...ended, participants: [] } });
        socket.socket.emit({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.ended', payload: { ...ended, state_revision: 0 } });

        expect(received).toEqual([
            { version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.started', payload },
            { version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.ended', payload: ended },
        ]);
    });

    it('accepts optional direct-call and rejection support references while preserving legacy payloads', () => {
        const received: MessageSocketEvent[] = [];
        service.getObservable().subscribe(event => received.push(event));
        const socket = requestTicket('ticket-call-support-reference');
        open(socket.config);
        const callPayload = {call_id: 'call-1', conversation_id: 'conversation-1', caller_id: 'caller-1', recipient_id: 'recipient-1', caller_device_id: 'device-1', status: 'ringing' as const, expires_at: '2026-01-01T00:00:00Z'};

        socket.socket.emit({version: WEBSOCKET_PROTOCOL_VERSION, type: 'call.incoming', payload: {...callPayload, support_ref: 'direct-ref-1'}});
        socket.socket.emit({version: WEBSOCKET_PROTOCOL_VERSION, type: 'call.ringing', payload: callPayload});
        socket.socket.emit({version: WEBSOCKET_PROTOCOL_VERSION, type: 'call.rejected', payload: {error: 'unavailable', support_ref: 'rejected-ref-1'}});
        socket.socket.emit({version: WEBSOCKET_PROTOCOL_VERSION, type: 'call.incoming', payload: {...callPayload, support_ref: ''}});

        expect(received).toHaveLength(3);
        expect(received[0].payload).toEqual({...callPayload, support_ref: 'direct-ref-1'});
        expect(received[1].payload).toEqual(callPayload);
        expect(received[2].payload).toEqual({error: 'unavailable', support_ref: 'rejected-ref-1'});
    });

    it('stays recovering until the active reconciliation and presence snapshot complete', () => {
        service.getObservable().subscribe();
        const socket = requestTicket('ticket-0');
        open(socket.config);

        expect(service.connectionState).toBe('recovering');
        expect(service.recover('conversation-1', 4, 'reconcile-1')).toBe(true);
        expect(socket.socket.sent).toContainEqual({version: WEBSOCKET_PROTOCOL_VERSION, type: 'conversation.reconcile', request_id: 'reconcile-1', payload: {conversation_id: 'conversation-1', after_sequence: 4}});

        socket.socket.emit({
            version: WEBSOCKET_PROTOCOL_VERSION,
            type: 'conversation.reconciled',
            request_id: 'reconcile-1',
            payload: { conversation_id: 'conversation-1', messages: [], next_after_sequence: 4, high_watermark: 4, has_more: false, own_read_sequence: 4, peer_read_sequence: 3 },
        });
        expect(service.ready).toBe(false);

        socket.socket.emit({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'presence.snapshot', payload: { user_ids: [] } });
        expect(service.ready).toBe(true);
        expect(service.connectionState).toBe('ready');
    });

    it('keeps an open socket ready when reconciliation is rejected', fakeAsync(async () => {
        service.getObservable().subscribe();
        const socket = requestTicket('ticket-recovery-rejected');
        open(socket.config);
        socket.socket.emit({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'presence.snapshot', payload: { user_ids: [] } });

        expect(service.recover('conversation-1', 4, 'reconcile-1')).toBe(true);
        socket.socket.emit({
            version: WEBSOCKET_PROTOCOL_VERSION,
            type: 'message.rejected',
            request_id: 'reconcile-1',
            payload: { error: 'conversation not found' },
        });

        expect(service.ready).toBe(true);
        expect(service.connectionState).toBe('ready');
        await tick(30000);
        http.expectNone(backends.websocketTicket);
    }));

    it('accepts only a well-formed v3 group membership revision event', () => {
        const received: MessageSocketEvent[] = [];
        service.getObservable().subscribe(event => received.push(event));
        const socket = requestTicket('ticket-group');
        open(socket.config);

        socket.socket.emit({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: { conversation_id: 'group-1', membership_revision: 3, deleted: false } });
        socket.socket.emit({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: { conversation_id: 'group-1', membership_revision: 0, deleted: false } });
        socket.socket.emit({ version: 1, type: 'group.membership.changed', payload: { conversation_id: 'group-1', membership_revision: 4, deleted: false } });

        expect(received).toEqual([{ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.membership.changed', payload: { conversation_id: 'group-1', membership_revision: 3, deleted: false } }]);
    });

    it('requests fresh tickets with bounded exponential reconnect delays', fakeAsync(async () => {
        service.getObservable().subscribe();
        const initial = requestTicket('ticket-0');
        expect(socketURL(initial.config)).toBe(`${backends.websocket}?ticket=${encodeURIComponent('ticket-0')}`);

        const delays = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
        let current = initial;
        for (let attempt = 0; attempt < delays.length; attempt += 1) {
            current.socket.fail(new Error('socket closed'));
            await tick(delays[attempt] - 1);
            expect(sockets.length).toBe(attempt + 1);
            await tick(1);

            const ticket = `ticket-${attempt + 1}`;
            const next = requestTicket(ticket);
            expect(socketURL(next.config)).toBe(`${backends.websocket}?ticket=${encodeURIComponent(ticket)}`);
            current = next;
        }

        service.close();
        await tick(30000);
        http.expectNone(backends.websocketTicket);
    }));

    it('does not schedule a reconnect after the provider is closed', fakeAsync(async () => {
        service.getObservable().subscribe();
        const initial = requestTicket('ticket-0');

        initial.socket.fail(new Error('socket closed'));
        service.close();
        await tick(30000);

        http.expectNone(backends.websocketTicket);
        expect(service.ready).toBe(false);
    }));

    it('does not open a socket when closed before the ticket response arrives', () => {
        service.getObservable().subscribe();
        const request = http.expectOne(backends.websocketTicket);

        service.close();
        request.flush({ ticket: 'late-ticket' });

        expect(sockets).toHaveLength(0);
    });

    it('ignores callbacks and events from a superseded socket generation', fakeAsync(async () => {
        const received: MessageSocketEvent[] = [];
        service.getObservable().subscribe(event => received.push(event));
        const first = requestTicket('ticket-0');
        open(first.config);
        first.socket.fail(new Error('socket closed'));
        await tick(1000);

        const second = requestTicket('ticket-1');
        open(second.config);
        (first.config.openObserver as {
            next?: () => void;
        } | undefined)?.next?.();
        (first.config.closeObserver as {
            next?: () => void;
        } | undefined)?.next?.();
        first.socket.emit({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'presence.snapshot', payload: { user_ids: ['stale-peer'] } });
        second.socket.emit({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'presence.snapshot', payload: { user_ids: ['current-peer'] } });

        expect(service.ready).toBe(true);
        expect(received).toEqual([{ version: WEBSOCKET_PROTOCOL_VERSION, type: 'presence.snapshot', payload: { user_ids: ['current-peer'] } }]);
    }));

    function requestTicket(ticket: string): TestSocket {
        const request = http.expectOne(backends.websocketTicket);
        expect(request.request.method).toBe('POST');
        expect(request.request.body).toEqual({});
        request.flush({ ticket });
        const socket = sockets[sockets.length - 1];
        if (!socket)
            throw new Error('WebSocket factory was not called');
        return socket;
    }

    function open(config: WebSocketSubjectConfig<unknown>): void {
        (config.openObserver as {
            next?: () => void;
        } | undefined)?.next?.();
    }

    function socketURL(config: WebSocketSubjectConfig<unknown>): string {
        return config.url;
    }
});
