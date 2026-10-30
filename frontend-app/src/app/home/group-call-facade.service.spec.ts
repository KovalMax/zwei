import {fakeAsync, tick} from '../../testing/vitest-timers';
import { BehaviorSubject, Subject } from 'rxjs';
import type { Mock } from 'vitest';
import { CallSignal, DataProviderService, GroupCallActiveSyncPayload, GroupCallParticipant, GroupCallRoomEventPayload, GroupCallRoomPayload, GroupCallRoomSocketEvent, GroupCallSignalEvent, GroupCallSyncedSocketEvent, MessageSocketEvent, WEBSOCKET_PROTOCOL_VERSION } from './data-provider.service';
import { GroupCallFacade } from './group-call-facade.service';

describe('GroupCallFacade', () => {
    let events: Subject<MessageSocketEvent>;
    let send: Mock;
    let ready: BehaviorSubject<boolean>;
    let facade: GroupCallFacade;
    let track: {
        kind: string;
        enabled: boolean;
        stop: Mock;
    };
    let addedTrackKinds: string[];
    let senders: Array<{
        kind: string;
        replaceTrack: Mock;
        sender: RTCRtpSender;
    }>;
    let peerConnections: RTCPeerConnection[];
    let addedTransceivers: Array<{
        kind: string;
        direction: RTCRtpTransceiverDirection;
    }>;
    let mediaDevices: PropertyDescriptor | undefined;
    let peerConnectionDescriptor: PropertyDescriptor | undefined;

    // Model the private acknowledgement separately from the public room event.
    function acceptStarted(started: GroupCallRoomSocketEvent & {payload: GroupCallRoomEventPayload}): void {
        const command = [...send.mock.calls].reverse().map(([value]) => value).find(value => value.type === 'group.call.start' && value.payload.conversation_id === started.payload.conversation_id);
        if (!command) throw new Error('No matching start command for acknowledged room');
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.start_accepted', request_id: command.request_id, payload: {conversation_id: started.payload.conversation_id, room_id: started.payload.room_id, generation: started.payload.generation}});
        events.next(started);
    }

    beforeEach(() => {
        events = new Subject<MessageSocketEvent>();
        ready = new BehaviorSubject<boolean>(true);
        send = vi.fn().mockName('send').mockImplementation(command => {
            if (command.type === 'group.call.prepare_start') events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.start_prepared', request_id: command.request_id, payload: {conversation_id: command.payload.conversation_id, attempt_id: 'f9ad4b72-67a1-40fb-b307-428aa956d762', expires_at: '2099-01-01T00:00:00Z'}});
            return true;
        });
        addedTrackKinds = [];
        senders = [];
        peerConnections = [];
        addedTransceivers = [];
        track = { kind: 'audio', enabled: true, stop: vi.fn().mockName('stop') };
        mediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
        peerConnectionDescriptor = Object.getOwnPropertyDescriptor(window, 'RTCPeerConnection');
        Object.defineProperty(window, 'RTCPeerConnection', { configurable: true, value: class {
                public constructor(public initialConfiguration: RTCConfiguration) { peerConnections.push(this as unknown as RTCPeerConnection); }
                public signalingState = 'stable';
                public connectionState = 'new';
                public pendingRemoteDescription: RTCSessionDescriptionInit | null = null;
                public currentRemoteDescription: RTCSessionDescriptionInit | null = null;
                public onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
                public ontrack: ((event: RTCTrackEvent) => void) | null = null;
                public onconnectionstatechange: (() => void) | null = null;
                public addTrack(mediaTrack: MediaStreamTrack): RTCRtpSender {
                    addedTrackKinds.push(mediaTrack.kind);
                    const fake: {track: MediaStreamTrack | null; replaceTrack: Mock} = {track: mediaTrack, replaceTrack: vi.fn().mockName('replaceTrack')};
                    fake.replaceTrack.mockImplementation(async (next: MediaStreamTrack | null) => { fake.track = next; });
                    const sender = fake as unknown as RTCRtpSender;
                    senders.push({kind: mediaTrack.kind, replaceTrack: fake.replaceTrack, sender});
                    return sender;
                }
                public addTransceiver(kind: string, init?: RTCRtpTransceiverInit): RTCRtpTransceiver { addedTransceivers.push({ kind, direction: init?.direction || 'sendrecv' }); return {} as RTCRtpTransceiver; }
                public getTransceivers(): RTCRtpTransceiver[] { return []; }
                public getConfiguration(): RTCConfiguration { return this.initialConfiguration; }
                public setConfiguration = vi.fn();
                public restartIce = vi.fn();
                public createOffer(): Promise<RTCSessionDescriptionInit> { return Promise.resolve({ type: 'offer', sdp: 'offer' }); }
                public createAnswer(): Promise<RTCSessionDescriptionInit> { return Promise.resolve({ type: 'answer', sdp: 'answer' }); }
                public setLocalDescription(): Promise<void> { return Promise.resolve(); }
                public setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
                    if (description.type === 'offer') this.pendingRemoteDescription = description;
                    else { this.currentRemoteDescription = description; this.pendingRemoteDescription = null; }
                    return Promise.resolve();
                }
                public addIceCandidate(): Promise<void> { return Promise.resolve(); }
                public close(): void { this.connectionState = 'closed'; }
            } as unknown as typeof RTCPeerConnection });
        Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn().mockName('getUserMedia').mockResolvedValue({ getTracks: () => [track], getAudioTracks: () => [track] }) } });
        facade = new GroupCallFacade({ getObservable: () => events.asObservable(), readyChanges: ready.asObservable(), get ready() { return ready.value; }, send } as unknown as DataProviderService);
    });

    it('queues a future ICE generation and applies it only after its SDP is installed', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-1'}]));
        await tick(0);
        const peer = peerConnections[0];
        const add = vi.spyOn(peer, 'addIceCandidate');
        const candidate = {candidate: 'candidate:1 1 udp 2122260223 192.0.2.1 5000 typ host ufrag next', sdpMid: 'audio', sdpMLineIndex: 0, usernameFragment: 'next'};
        const signal = (value: GroupCallSignalEvent['payload']['signal']): void => events.next({version: 3, type: 'group.call.signal', payload: {room_id: 'room-1', generation: 1, from_user_id: 'peer-1', from_device_id: 'peer-1', signal: value}});
        signal({type: 'candidate', candidate});
        await tick(0);
        expect(add).not.toHaveBeenCalled();
        signal({type: 'offer', sdp: iceSDP('next'), negotiation_id: '8c72dd14-fafe-4e2d-9735-e09c37358bf1'});
        await tick(0);
        expect(add).toHaveBeenCalledWith(candidate);
        facade.end();
    }));

    it('isolates an ambiguous peer without ending the group call', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-1'}, {user_id: 'peer-2', device_id: 'peer-2'}]));
        await tick(0);
        events.next({version: 3, type: 'group.call.invalid_candidate', payload: {room_id: 'room-1', generation: 1, from_user_id: 'peer-1', from_device_id: 'peer-1'}});
        await tick(0);
        expect(facade.state.errorLabel).toContain('rejoin');
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.leave'}));
        expect(peerConnections[0].connectionState).toBe('closed');
        expect(peerConnections[1].connectionState).not.toBe('closed');
        expect(facade.state.phase).toBe('active');
        expect(track.stop).not.toHaveBeenCalled();
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 2, [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-1'}, {user_id: 'peer-2', device_id: 'peer-2'}]));
        await tick(0);
        expect(peerConnections).toHaveLength(2);
        expect(facade.state.statusLabel).toContain('rejoin');
    }));

    it('drops old ICE generations and applies only matching current media', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-1'}]));
        await tick(0);
        const peer = peerConnections[0];
        const add = vi.spyOn(peer, 'addIceCandidate');
        const signal = (value: GroupCallSignalEvent['payload']['signal']): void => events.next({version: 3, type: 'group.call.signal', payload: {room_id: 'room-1', generation: 1, from_user_id: 'peer-1', from_device_id: 'peer-1', signal: value}});
        signal({type: 'offer', sdp: iceSDP('old'), negotiation_id: '8c72dd14-fafe-4e2d-9735-e09c37358bf1'});
        await tick(0);
        signal({type: 'offer', sdp: iceSDP('new'), negotiation_id: '8c72dd14-fafe-4e2d-9735-e09c37358bf2'});
        await tick(0);
        const old = {candidate: 'candidate:1 1 udp 1 192.0.2.1 5000 typ host ufrag old', sdpMid: 'audio', sdpMLineIndex: 0};
        const current = {candidate: 'candidate:2 1 udp 1 192.0.2.1 5001 typ host', usernameFragment: 'new', sdpMid: 'audio', sdpMLineIndex: 0};
        signal({type: 'candidate', candidate: old});
        signal({type: 'candidate', candidate: current});
        await tick(0);
        expect(add).toHaveBeenCalledTimes(1);
        expect(add).toHaveBeenCalledWith(current);
        expect(facade.state.phase).toBe('active');
        facade.end();
    }));

    it('accepts a bundled video candidate using the audio tag transport', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-1'}]));
        await tick(0);
        const peer = peerConnections[0];
        const add = vi.spyOn(peer, 'addIceCandidate');
        const signal = (value: GroupCallSignalEvent['payload']['signal']): void => events.next({version: 3, type: 'group.call.signal', payload: {room_id: 'room-1', generation: 1, from_user_id: 'peer-1', from_device_id: 'peer-1', signal: value}});
        const sdp = 'v=0\r\na=group:BUNDLE audio video\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:audio\r\na=ice-ufrag:bundle\r\na=ice-pwd:abcdefghijklmnopqrstuv\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:video\r\na=bundle-only\r\n';
        signal({type: 'offer', sdp, negotiation_id: '8c72dd14-fafe-4e2d-9735-e09c37358bf1'});
        await tick(0);
        const candidate = {candidate: 'candidate:1 1 udp 1 192.0.2.1 5000 typ host', sdpMid: 'video', sdpMLineIndex: 1, usernameFragment: 'bundle'};
        signal({type: 'candidate', candidate});
        await tick(0);
        expect(add).toHaveBeenCalledWith(candidate);
        expect(facade.state.phase).toBe('active');
        facade.end();
    }));

    it('continues through more than 64 remote ICE renewals and never applies an evicted generation', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-1'}]));
        await tick(0);
        const peer = peerConnections[0];
        const add = vi.spyOn(peer, 'addIceCandidate');
        const signal = (value: GroupCallSignalEvent['payload']['signal']): void => events.next({version: 3, type: 'group.call.signal', payload: {room_id: 'room-1', generation: 1, from_user_id: 'peer-1', from_device_id: 'peer-1', signal: value}});
        for (let i = 0; i < 70; i++) { signal({type: 'offer', sdp: iceSDP(`ice${i}`), negotiation_id: '8c72dd14-fafe-4e2d-9735-e09c37358bf1'}); await tick(0); }
        expect(peer.connectionState).not.toBe('closed');
        const current = {candidate: 'candidate:2 1 udp 1 192.0.2.1 5001 typ host', sdpMid: 'audio', usernameFragment: 'ice69'};
        signal({type: 'candidate', candidate: current});
        await tick(0);
        expect(add).toHaveBeenCalledWith(current);
        signal({type: 'candidate', candidate: {candidate: 'candidate:1 1 udp 1 192.0.2.1 5000 typ host', sdpMid: 'audio', usernameFragment: 'ice0'}});
        await tick(15_000);
        expect(add).toHaveBeenCalledTimes(1);
        expect(facade.state.phase).toBe('active');
        expect(peer.connectionState).not.toBe('closed');
        facade.end();
    }));

    it('does not let stalled signaling for one peer block another peer', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        const self = {user_id: 'self-1', device_id: 'device-1'};
        const a = {user_id: 'peer-a', device_id: 'device-a'};
        const b = {user_id: 'peer-b', device_id: 'device-b'};
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [self, a, b]));
        await tick(0);
        let release: (() => void) | undefined;
        vi.spyOn(peerConnections[0], 'setRemoteDescription').mockReturnValue(new Promise<void>(resolve => { release = resolve; }));
        const add = vi.spyOn(peerConnections[1], 'addIceCandidate');
        const signal = (peer: GroupCallParticipant, value: GroupCallSignalEvent['payload']['signal']): void => events.next({version: 3, type: 'group.call.signal', payload: {room_id: 'room-1', generation: 1, from_user_id: peer.user_id, from_device_id: peer.device_id, signal: value}});
        signal(a, {type: 'offer', sdp: iceSDP('a'), negotiation_id: '8c72dd14-fafe-4e2d-9735-e09c37358bf1'});
        await tick(0);
        signal(a, {type: 'candidate', candidate: {candidate: 'candidate:1 1 udp 1 192.0.2.1 5000 typ host', sdpMid: 'audio', usernameFragment: 'a'}});
        signal(b, {type: 'offer', sdp: iceSDP('b'), negotiation_id: '8c72dd14-fafe-4e2d-9735-e09c37358bf2'});
        const candidate = {candidate: 'candidate:2 1 udp 1 192.0.2.1 5001 typ host', sdpMid: 'audio', usernameFragment: 'b'};
        signal(b, {type: 'candidate', candidate});
        await tick(15_000);
        expect(add).toHaveBeenCalledWith(candidate);
        expect(peerConnections[0].connectionState).toBe('closed');
        expect(peerConnections[1].connectionState).not.toBe('closed');
        expect(facade.state.phase).toBe('active');
        release?.();
        await tick(0);
        facade.end();
    }));

    it('orders presentation and signaling per peer without delaying another peer', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        const self = {user_id: 'self-1', device_id: 'device-1'};
        const a = {user_id: 'peer-a', device_id: 'device-a'};
        const b = {user_id: 'peer-b', device_id: 'device-b'};
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [self, a, b]));
        await tick(0);
        let release: (() => void) | undefined;
        const video = {kind: 'video', readyState: 'live', stop: vi.fn(), addEventListener: vi.fn()};
        Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {configurable: true, value: vi.fn().mockResolvedValue({getTracks: () => [video], getVideoTracks: () => [video], getAudioTracks: () => []})});
        vi.spyOn(peerConnections[0], 'addTrack').mockReturnValue({replaceTrack: () => new Promise<void>(resolve => { release = resolve; })} as unknown as RTCRtpSender);
        const remoteA = vi.spyOn(peerConnections[0], 'setRemoteDescription');
        const remoteB = vi.spyOn(peerConnections[1], 'setRemoteDescription');
        const presentation = facade.startPresentation('720p');
        await tick(0);
        const signal = (peer: GroupCallParticipant): void => events.next({version: 3, type: 'group.call.signal', payload: {room_id: 'room-1', generation: 1, from_user_id: peer.user_id, from_device_id: peer.device_id, signal: {type: 'offer', sdp: iceSDP(peer.user_id), negotiation_id: '8c72dd14-fafe-4e2d-9735-e09c37358bf1'}}});
        signal(a); signal(b);
        await tick(0);
        expect(remoteA).not.toHaveBeenCalled();
        expect(remoteB).toHaveBeenCalled();
        release?.();
        await tick(0);
        await presentation;
        expect(remoteA).toHaveBeenCalled();
        facade.end();
    }));

    it('warns without closing a healthy peer when a future generation remains unknown', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-1'}]));
        await tick(0);
        const peer = peerConnections[0];
        const signal = (value: GroupCallSignalEvent['payload']['signal']): void => events.next({version: 3, type: 'group.call.signal', payload: {room_id: 'room-1', generation: 1, from_user_id: 'peer-1', from_device_id: 'peer-1', signal: value}});
        signal({type: 'offer', sdp: iceSDP('current'), negotiation_id: '8c72dd14-fafe-4e2d-9735-e09c37358bf1'});
        await tick(0);
        signal({type: 'candidate', candidate: {candidate: 'candidate:1 1 udp 1 192.0.2.1 5000 typ host', usernameFragment: 'future', sdpMid: 'audio'}});
        await tick(15_000);
        expect(peer.connectionState).not.toBe('closed');
        expect(facade.state.phase).toBe('active');
        expect(facade.state.errorLabel).toContain('rejoin');
        signal({type: 'offer', sdp: iceSDP('unrelated'), negotiation_id: '8c72dd14-fafe-4e2d-9735-e09c37358bf2'});
        await tick(0);
        expect(facade.state.errorLabel).toContain('rejoin');
        signal({type: 'offer', sdp: iceSDP('future'), negotiation_id: '8c72dd14-fafe-4e2d-9735-e09c37358bf2'});
        await tick(0);
        expect(facade.state.errorLabel).toContain('rejoin');
        Object.defineProperty(peer, 'connectionState', {configurable: true, writable: true, value: 'connected'});
        signal({type: 'candidate', candidate: {candidate: 'candidate:2 1 udp 1 192.0.2.1 5001 typ host', usernameFragment: 'future', sdpMid: 'audio'}});
        await tick(0);
        expect(facade.state.errorLabel).toBeUndefined();
        facade.end();
    }));

    it('does not claim recovery when late SDP arrives after the only relay candidate expired', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-1'}]));
        await tick(0);
        const peer = peerConnections[0];
        const add = vi.spyOn(peer, 'addIceCandidate');
        const signal = (value: GroupCallSignalEvent['payload']['signal']): void => events.next({version: 3, type: 'group.call.signal', payload: {room_id: 'room-1', generation: 1, from_user_id: 'peer-1', from_device_id: 'peer-1', signal: value}});
        signal({type: 'offer', sdp: iceSDP('old'), negotiation_id: '8c72dd14-fafe-4e2d-9735-e09c37358bf1'});
        await tick(0);
        signal({type: 'candidate', candidate: {candidate: 'candidate:1 1 udp 1 192.0.2.1 5000 typ relay', usernameFragment: 'future', sdpMid: 'audio'}});
        await tick(15_000);
        expect(facade.state.errorLabel).toContain('rejoin');
        signal({type: 'offer', sdp: iceSDP('future'), negotiation_id: '8c72dd14-fafe-4e2d-9735-e09c37358bf2'});
        await tick(0);
        expect(add).not.toHaveBeenCalled();
        expect(facade.state.errorLabel).toContain('rejoin');
        expect(peer.connectionState).not.toBe('closed');
        send.mockClear();
        facade.leave();
        expect(facade.state.errorLabel).toBeUndefined();
        events.next(room('group.call.participant.left', 'active', 'group-1', 1, 2, [{user_id: 'peer-1', device_id: 'peer-device'}]));
        facade.rejoin('self-1');
        confirmRejoinDiscovery(2);
        await tick(0);
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 3, [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-device'}]));
        await tick(0);
        expect(facade.state.phase).toBe('active');
        expect(facade.state.errorLabel).toBeUndefined();
        expect(peerConnections).toHaveLength(2);
        facade.end();
    }));

    it('requires an applied replacement candidate and connected transport before clearing uncertainty', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-1'}]));
        await tick(0);
        const peer = peerConnections[0];
        const signal = (value: GroupCallSignalEvent['payload']['signal']): void => events.next({version: 3, type: 'group.call.signal', payload: {room_id: 'room-1', generation: 1, from_user_id: 'peer-1', from_device_id: 'peer-1', signal: value}});
        signal({type: 'offer', sdp: iceSDP('old'), negotiation_id: '8c72dd14-fafe-4e2d-9735-e09c37358bf1'});
        await tick(0);
        signal({type: 'candidate', candidate: {candidate: 'candidate:1 1 udp 1 192.0.2.1 5000 typ relay', usernameFragment: 'future', sdpMid: 'audio'}});
        await tick(15_000);
        signal({type: 'offer', sdp: iceSDP('future'), negotiation_id: '8c72dd14-fafe-4e2d-9735-e09c37358bf2'});
        await tick(0);
        signal({type: 'candidate', candidate: {candidate: '', usernameFragment: 'future', sdpMid: 'audio'}});
        await tick(0);
        Object.defineProperty(peer, 'connectionState', {configurable: true, writable: true, value: 'connected'});
        peer.onconnectionstatechange?.call(peer, new Event('connectionstatechange'));
        expect(facade.state.errorLabel).toContain('rejoin');
        Object.defineProperty(peer, 'connectionState', {configurable: true, writable: true, value: 'connecting'});
        signal({type: 'candidate', candidate: {candidate: 'candidate:2 1 udp 1 192.0.2.1 5001 typ relay', usernameFragment: 'future', sdpMid: 'audio'}});
        await tick(0);
        expect(facade.state.errorLabel).toContain('rejoin');
        Object.defineProperty(peer, 'connectionState', {configurable: true, writable: true, value: 'connected'});
        peer.onconnectionstatechange?.call(peer, new Event('connectionstatechange'));
        expect(facade.state.errorLabel).toBeUndefined();
        facade.end();
    }));

    it('keeps recovery visible if an uncertain connection subsequently fails', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-1'}]));
        await tick(0);
        const peer = peerConnections[0];
        const signal = (value: GroupCallSignalEvent['payload']['signal']): void => events.next({version: 3, type: 'group.call.signal', payload: {room_id: 'room-1', generation: 1, from_user_id: 'peer-1', from_device_id: 'peer-1', signal: value}});
        signal({type: 'offer', sdp: iceSDP('current'), negotiation_id: '8c72dd14-fafe-4e2d-9735-e09c37358bf1'});
        await tick(0);
        signal({type: 'candidate', candidate: {candidate: 'candidate:1 1 udp 1 192.0.2.1 5000 typ host', usernameFragment: 'future', sdpMid: 'audio'}});
        await tick(15_000);
        Object.defineProperty(peer, 'connectionState', {configurable: true, writable: true, value: 'failed'});
        peer.onconnectionstatechange?.call(peer, new Event('connectionstatechange'));
        expect(peer.connectionState).toBe('closed');
        expect(facade.state.errorLabel).toContain('rejoin');
        expect(facade.state.phase).toBe('active');
        facade.end();
    }));

    it('keeps a healthy peer and its warning after over 64 evicted generations expire', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-1'}]));
        await tick(0);
        const peer = peerConnections[0];
        Object.defineProperty(peer, 'connectionState', {configurable: true, writable: true, value: 'connected'});
        const add = vi.spyOn(peer, 'addIceCandidate');
        const signal = (value: GroupCallSignalEvent['payload']['signal']): void => events.next({version: 3, type: 'group.call.signal', payload: {room_id: 'room-1', generation: 1, from_user_id: 'peer-1', from_device_id: 'peer-1', signal: value}});
        for (let i = 0; i < 135; i++) { signal({type: 'offer', sdp: iceSDP(`ice${i}`), negotiation_id: '8c72dd14-fafe-4e2d-9735-e09c37358bf1'}); await tick(0); }
        for (let batch = 0; batch < 2; batch++) {
            const start = batch * 35;
            for (let i = start; i < start + 35; i++) signal({type: 'candidate', candidate: {candidate: 'candidate:1 1 udp 1 192.0.2.1 5000 typ host', usernameFragment: `ice${i}`, sdpMid: 'audio'}});
            await tick(15_000);
        }
        expect(add).not.toHaveBeenCalled();
        expect(peer.connectionState).toBe('connected');
        expect(facade.state.phase).toBe('active');
        expect(facade.state.errorLabel).toContain('rejoin');
        signal({type: 'candidate', candidate: {candidate: 'candidate:2 1 udp 1 192.0.2.1 5001 typ host', usernameFragment: 'ice134', sdpMid: 'audio'}});
        await tick(0);
        expect(add).toHaveBeenCalledTimes(1);
        expect(facade.state.errorLabel).toContain('rejoin');
        send.mockClear();
        facade.leave();
        events.next(room('group.call.participant.left', 'active', 'group-1', 1, 2, [{user_id: 'peer-1', device_id: 'peer-device'}]));
        facade.rejoin('self-1');
        confirmRejoinDiscovery(2);
        await tick(0);
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 3, [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-device'}]));
        await tick(0);
        expect(facade.state.phase).toBe('active');
        expect(facade.state.errorLabel).toBeUndefined();
        expect(peerConnections).toHaveLength(2);
        facade.end();
    }));

    it('warns rather than quarantining a connected peer when a stale candidate expires during negotiation', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-1'}]));
        await tick(0);
        const peer = peerConnections[0];
        const signal = (value: GroupCallSignalEvent['payload']['signal']): void => events.next({version: 3, type: 'group.call.signal', payload: {room_id: 'room-1', generation: 1, from_user_id: 'peer-1', from_device_id: 'peer-1', signal: value}});
        signal({type: 'offer', sdp: iceSDP('current'), negotiation_id: '8c72dd14-fafe-4e2d-9735-e09c37358bf1'});
        await tick(0);
        Object.defineProperty(peer, 'connectionState', {configurable: true, writable: true, value: 'connected'});
        Object.defineProperty(peer, 'signalingState', {configurable: true, writable: true, value: 'have-local-offer'});
        signal({type: 'candidate', candidate: {candidate: 'candidate:1 1 udp 1 192.0.2.1 5000 typ host', usernameFragment: 'unknown', sdpMid: 'audio'}});
        await tick(15_000);
        expect(peer.connectionState).toBe('connected');
        expect(facade.state.errorLabel).toContain('rejoin');
        facade.end();
    }));

    it('applies a future-generation candidate when its SDP arrives before expiry', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-1'}]));
        await tick(0);
        const peer = peerConnections[0];
        const add = vi.spyOn(peer, 'addIceCandidate');
        const signal = (value: GroupCallSignalEvent['payload']['signal']): void => events.next({version: 3, type: 'group.call.signal', payload: {room_id: 'room-1', generation: 1, from_user_id: 'peer-1', from_device_id: 'peer-1', signal: value}});
        signal({type: 'offer', sdp: iceSDP('current'), negotiation_id: '8c72dd14-fafe-4e2d-9735-e09c37358bf1'});
        await tick(0);
        const candidate = {candidate: 'candidate:1 1 udp 1 192.0.2.1 5000 typ host', sdpMid: 'audio', usernameFragment: 'future'};
        signal({type: 'candidate', candidate});
        await tick(14_000);
        signal({type: 'offer', sdp: iceSDP('future'), negotiation_id: '8c72dd14-fafe-4e2d-9735-e09c37358bf2'});
        await tick(1_000);
        expect(add).toHaveBeenCalledWith(candidate);
        expect(peer.connectionState).not.toBe('closed');
        expect(facade.state.errorLabel).toBeUndefined();
        facade.end();
    }));

    it('isolates an unknown-candidate flood without disturbing another peer', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        const participants = [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-a', device_id: 'device-a'}, {user_id: 'peer-b', device_id: 'device-b'}];
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, participants));
        await tick(0);
        const signal = (value: GroupCallSignalEvent['payload']['signal']): void => events.next({version: 3, type: 'group.call.signal', payload: {room_id: 'room-1', generation: 1, from_user_id: 'peer-a', from_device_id: 'device-a', signal: value}});
        signal({type: 'offer', sdp: iceSDP('current'), negotiation_id: '8c72dd14-fafe-4e2d-9735-e09c37358bf1'});
        await tick(0);
        for (let i = 0; i < 65; i++) signal({type: 'candidate', candidate: {candidate: 'candidate:1 1 udp 1 192.0.2.1 5000 typ host', sdpMid: 'audio', usernameFragment: 'unknown'}});
        await tick(0);
        expect(peerConnections[0].connectionState).toBe('closed');
        expect(peerConnections[1].connectionState).not.toBe('closed');
        expect(facade.state.errorLabel).toContain('rejoin');
        expect(facade.state.phase).toBe('active');
        facade.end();
    }));

    it('bounds a stalled peer offer flood without closing other peers', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-a', device_id: 'device-a'}, {user_id: 'peer-b', device_id: 'device-b'}]));
        await tick(0);
        let release: (() => void) | undefined;
        vi.spyOn(peerConnections[0], 'setRemoteDescription').mockReturnValue(new Promise<void>(resolve => { release = resolve; }));
        const signal = {type: 'offer' as const, sdp: iceSDP('future'), negotiation_id: '8c72dd14-fafe-4e2d-9735-e09c37358bf1'};
        events.next({version: 3, type: 'group.call.signal', payload: {room_id: 'room-1', generation: 1, from_user_id: 'peer-a', from_device_id: 'device-a', signal}});
        await tick(0);
        for (let i = 0; i < 64; i++) events.next({version: 3, type: 'group.call.signal', payload: {room_id: 'room-1', generation: 1, from_user_id: 'peer-a', from_device_id: 'device-a', signal}});
        await tick(0);
        expect(peerConnections[0].connectionState).toBe('closed');
        expect(peerConnections[1].connectionState).not.toBe('closed');
        expect(facade.state.errorLabel).toContain('rejoin');
        release?.();
        await tick(0);
        facade.end();
    }));

    it('bounds queued credential restarts behind a stalled peer without blocking healthy peers', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        const participants = [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-a', device_id: 'device-a'}, {user_id: 'peer-b', device_id: 'device-b'}];
        const started = room('group.call.started', 'active', 'group-1', 1, 1, participants);
        acceptStarted({...started, payload: {...started.payload, ice_expires_at: new Date(Date.now() + 60_000).toISOString()}});
        await tick(0);
        let release: ((offer: RTCSessionDescriptionInit) => void) | undefined;
        vi.spyOn(peerConnections[0], 'createOffer').mockReturnValue(new Promise<RTCSessionDescriptionInit>(resolve => { release = resolve; }) as never);
        for (let i = 0; i < 65; i++) {
            const event = room('group.call.participant.joined', 'active', 'group-1', 1, i + 2, participants);
            events.next({...event, payload: {...event.payload, ice_expires_at: new Date(Date.now() + 120_000 + i * 1000).toISOString()}});
            await tick(0);
        }
        expect(peerConnections[0].connectionState).toBe('closed');
        expect(peerConnections[1].connectionState).not.toBe('closed');
        expect(facade.state.errorLabel).toContain('rejoin');
        release?.({type: 'offer', sdp: iceSDP('old')});
        await tick(0);
        facade.end();
    }));

    it('fences stalled peer operations and their timers across call teardown and a new room', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-a', device_id: 'device-a'}]));
        await tick(0);
        let release: (() => void) | undefined;
        vi.spyOn(peerConnections[0], 'setRemoteDescription').mockReturnValue(new Promise<void>(resolve => { release = resolve; }));
        events.next({version: 3, type: 'group.call.signal', payload: {room_id: 'room-1', generation: 1, from_user_id: 'peer-a', from_device_id: 'device-a', signal: {type: 'offer', sdp: iceSDP('old'), negotiation_id: '8c72dd14-fafe-4e2d-9735-e09c37358bf1'}}});
        await tick(0);
        events.next({version: 3, type: 'group.call.signal', payload: {room_id: 'room-1', generation: 1, from_user_id: 'peer-a', from_device_id: 'device-a', signal: {type: 'candidate', candidate: {candidate: 'candidate:1 1 udp 1 192.0.2.1 5000 typ host', sdpMid: 'audio', usernameFragment: 'old'}}}});
        facade.abort('group-1');
        await facade.start('group-2', 'self-1');
        const started = room('group.call.started', 'active', 'group-2', 2, 1, [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-b', device_id: 'device-b'}]);
        acceptStarted({...started, payload: {...started.payload, room_id: 'room-2'}});
        await tick(0);
        release?.();
        await tick(15_000);
        expect(facade.state.room?.room_id).toBe('room-2');
        expect(facade.state.phase).toBe('active');
        expect(facade.state.errorLabel).toBeUndefined();
        expect(peerConnections[1].connectionState).not.toBe('closed');
        facade.end();
    }));

    it('releases pending presentation capture and allows a new call after a stalled peer teardown', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-a', device_id: 'device-a'}]));
        await tick(0);
        let release: (() => void) | undefined;
        vi.spyOn(peerConnections[0], 'addTrack').mockReturnValue({replaceTrack: () => new Promise<void>(resolve => { release = resolve; })} as unknown as RTCRtpSender);
        const oldVideo = {kind: 'video', readyState: 'live', stop: vi.fn(), addEventListener: vi.fn()};
        const newVideo = {kind: 'video', readyState: 'live', stop: vi.fn(), addEventListener: vi.fn()};
        const stream = (video: typeof oldVideo): MediaStream => ({getTracks: () => [video], getVideoTracks: () => [video], getAudioTracks: () => []} as unknown as MediaStream);
        Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {configurable: true, value: vi.fn().mockResolvedValueOnce(stream(oldVideo)).mockResolvedValueOnce(stream(newVideo))});
        const previous = facade.startPresentation('720p');
        await tick(0);
        facade.abort('group-1');
        expect(oldVideo.stop).toHaveBeenCalled();
        await facade.start('group-2', 'self-1');
        const started = room('group.call.started', 'active', 'group-2', 2, 1, [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-b', device_id: 'device-b'}]);
        acceptStarted({...started, payload: {...started.payload, room_id: 'room-2'}});
        await tick(0);
        const next = facade.startPresentation('720p');
        await tick(0);
        await next;
        expect(facade.state.sharing).toBe(true);
        release?.();
        await tick(0);
        await previous;
        expect(facade.state.sharing).toBe(true);
        expect(facade.state.room?.room_id).toBe('room-2');
        facade.end();
        expect(newVideo.stop).toHaveBeenCalled();
    }));

    it('does not close a replacement peer when its predecessor fails a pending sender operation', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        const self = {user_id: 'self-1', device_id: 'device-1'};
        const peer = {user_id: 'peer-a', device_id: 'device-a'};
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [self, peer]));
        await tick(0);
        let reject: ((reason: Error) => void) | undefined;
        vi.spyOn(peerConnections[0], 'addTrack').mockReturnValue({replaceTrack: () => new Promise<void>((_resolve, fail) => { reject = fail; })} as unknown as RTCRtpSender);
        const video = {kind: 'video', readyState: 'live', stop: vi.fn(), addEventListener: vi.fn()};
        Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {configurable: true, value: vi.fn().mockResolvedValue({getTracks: () => [video], getVideoTracks: () => [video], getAudioTracks: () => []})});
        const presentation = facade.startPresentation('720p');
        await tick(0);
        events.next(room('group.call.participant.left', 'active', 'group-1', 1, 2, [self]));
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 3, [self, peer]));
        await tick(0);
        reject?.(new Error('old peer failed'));
        await tick(0);
        await presentation;
        expect(peerConnections).toHaveLength(2);
        expect(peerConnections[1].connectionState).not.toBe('closed');
        expect(facade.state.phase).toBe('active');
        facade.end();
    }));

    it('enriches outgoing candidates and fences callbacks from replaced peers', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        const self = {user_id: 'self-1', device_id: 'device-1'};
        const remote = {user_id: 'peer-1', device_id: 'peer-1'};
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [self, remote]));
        await tick(0);
        const old = peerConnections[0];
        Object.defineProperty(old, 'currentLocalDescription', {configurable: true, value: {type: 'answer', sdp: iceSDP('local')}});
        const line = 'candidate:1 1 udp 1 192.0.2.1 5000 typ host';
        const browserCandidate = {candidate: line, sdpMid: 'audio', sdpMLineIndex: 0, usernameFragment: null, toJSON: () => ({candidate: line, sdpMid: 'audio', sdpMLineIndex: 0})} as RTCIceCandidate;
        const callback = old.onicecandidate;
        callback?.call(old, {candidate: browserCandidate} as RTCPeerConnectionIceEvent);
        expect(send).toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.signal', payload: expect.objectContaining({signal: {type: 'candidate', candidate: {candidate: line, sdpMid: 'audio', sdpMLineIndex: 0, usernameFragment: 'local'}}})}));
        events.next(room('group.call.participant.left', 'active', 'group-1', 1, 2, [self]));
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 3, [self, remote]));
        await tick(0);
        const before = send.mock.calls.length;
        callback?.call(old, {candidate: browserCandidate} as RTCPeerConnectionIceEvent);
        expect(send.mock.calls).toHaveLength(before);
        expect(facade.state.errorLabel).toBeUndefined();
        facade.end();
    }));

    it('isolates only the sender peer when browser candidate identifiers conflict', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-1'}]));
        await tick(0);
        const peer = peerConnections[0];
        Object.defineProperty(peer, 'currentLocalDescription', {configurable: true, value: {type: 'answer', sdp: iceSDP('local')}});
        const line = 'candidate:1 1 udp 1 192.0.2.1 5000 typ host';
        const browserCandidate = {candidate: line, sdpMid: 'audio', sdpMLineIndex: 0, usernameFragment: 'old', toJSON: () => ({candidate: line, sdpMid: 'audio', usernameFragment: 'local'})} as RTCIceCandidate;
        peer.onicecandidate?.call(peer, {candidate: browserCandidate} as RTCPeerConnectionIceEvent);
        expect(peer.connectionState).toBe('closed');
        expect(facade.state.phase).toBe('active');
        expect(facade.state.errorLabel).toContain('rejoin');
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.leave'}));
    }));

    it('drops stale local-generation callbacks and refuses to guess missing ufrags after a restart', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-1'}]));
        await tick(0);
        const peer = peerConnections[0];
        let local = 'old';
        vi.spyOn(peer, 'setLocalDescription').mockImplementation(async () => {
            Object.defineProperty(peer, 'currentLocalDescription', {configurable: true, value: {type: 'answer', sdp: iceSDP(local)}});
        });
        const signal = (sdp: string): void => events.next({version: 3, type: 'group.call.signal', payload: {room_id: 'room-1', generation: 1, from_user_id: 'peer-1', from_device_id: 'peer-1', signal: {type: 'offer', sdp, negotiation_id: '8c72dd14-fafe-4e2d-9735-e09c37358bf1'}}});
        signal(iceSDP('remote-old'));
        await tick(0);
        local = 'new';
        signal(iceSDP('remote-new'));
        await tick(0);
        const line = 'candidate:1 1 udp 1 192.0.2.1 5000 typ host';
        const candidate = (usernameFragment: string | null): RTCIceCandidate => ({candidate: line, sdpMid: 'audio', sdpMLineIndex: 0, usernameFragment, toJSON: () => ({candidate: line, sdpMid: 'audio', sdpMLineIndex: 0})} as RTCIceCandidate);
        const before = send.mock.calls.length;
        peer.onicecandidate?.call(peer, {candidate: candidate('old')} as RTCPeerConnectionIceEvent);
        expect(send.mock.calls).toHaveLength(before);
        expect(peer.connectionState).not.toBe('closed');
        peer.onicecandidate?.call(peer, {candidate: candidate(null)} as RTCPeerConnectionIceEvent);
        expect(peer.connectionState).toBe('closed');
        expect(facade.state.errorLabel).toContain('rejoin');
        expect(facade.state.phase).toBe('active');
    }));

    it('discards an early candidate when its colliding offer is ignored', fakeAsync(async () => {
        await facade.start('group-1', 'a-self');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'a-self', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-1'}]));
        await tick(0);
        const peer = peerConnections[0];
        Object.defineProperty(peer, 'signalingState', {configurable: true, writable: true, value: 'have-local-offer'});
        const add = vi.spyOn(peer, 'addIceCandidate');
        const signal = (value: GroupCallSignalEvent['payload']['signal']): void => events.next({version: 3, type: 'group.call.signal', payload: {room_id: 'room-1', generation: 1, from_user_id: 'peer-1', from_device_id: 'peer-1', signal: value}});
        signal({type: 'candidate', candidate: {candidate: 'candidate:1 1 udp 1 192.0.2.1 5000 typ host', sdpMid: 'audio', usernameFragment: 'ignored'}});
        await tick(0);
        signal({type: 'offer', sdp: iceSDP('ignored'), negotiation_id: '8c72dd14-fafe-4e2d-9735-e09c37358bf1'});
        await tick(16_000);
        expect(add).not.toHaveBeenCalled();
        expect(facade.state.phase).toBe('active');
        facade.end();
    }));

    it('fails instead of guessing when a ufrag is reused with different ICE credentials', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-1'}]));
        await tick(0);
        const signal = (value: GroupCallSignalEvent['payload']['signal']): void => events.next({version: 3, type: 'group.call.signal', payload: {room_id: 'room-1', generation: 1, from_user_id: 'peer-1', from_device_id: 'peer-1', signal: value}});
        signal({type: 'offer', sdp: iceSDP('reused'), negotiation_id: '8c72dd14-fafe-4e2d-9735-e09c37358bf1'});
        await tick(0);
        signal({type: 'offer', sdp: iceSDP('reused').replace('abcdefghijklmnopqrstuv', 'zyxwvutsrqponmlkjihgfe'), negotiation_id: '8c72dd14-fafe-4e2d-9735-e09c37358bf2'});
        await tick(0);
        const add = vi.spyOn(peerConnections[0], 'addIceCandidate');
        signal({type: 'candidate', candidate: {candidate: 'candidate:1 1 udp 1 192.0.2.1 5000 typ host', usernameFragment: 'reused', sdpMid: 'audio'}});
        await tick(0);
        expect(add).not.toHaveBeenCalled();
        expect(facade.state.errorLabel).toContain('rejoin');
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.leave'}));
    }));

    for (const failure of ['timeout', 'overflow', 'media mismatch', 'browser rejection'] as const) it(`isolates the peer visibly on ICE ${failure}`, fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-1'}]));
        await tick(0);
        const peer = peerConnections[0];
        const signal = (value: GroupCallSignalEvent['payload']['signal']): void => events.next({version: 3, type: 'group.call.signal', payload: {room_id: 'room-1', generation: 1, from_user_id: 'peer-1', from_device_id: 'peer-1', signal: value}});
        if (failure === 'media mismatch' || failure === 'browser rejection') {
            signal({type: 'offer', sdp: iceSDP('current'), negotiation_id: '8c72dd14-fafe-4e2d-9735-e09c37358bf1'});
            await tick(0);
        }
        if (failure === 'browser rejection') vi.spyOn(peer, 'addIceCandidate').mockRejectedValue(new Error('browser rejected'));
        const candidate = {candidate: 'candidate:1 1 udp 1 192.0.2.1 5000 typ host', usernameFragment: failure === 'timeout' || failure === 'overflow' ? 'future' : 'current', sdpMid: failure === 'media mismatch' ? 'video' : 'audio', sdpMLineIndex: 0};
        for (let i = 0; i < (failure === 'overflow' ? 65 : 1); i++) signal({type: 'candidate', candidate});
        await tick(failure === 'timeout' ? 15_000 : 0);
        expect(facade.state.errorLabel).toContain('rejoin');
        expect(peer.connectionState).toBe('closed');
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.leave'}));
        expect(facade.state.phase).toBe('active');
    }));

    it('cancels the ICE expiry when the call ends', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-1'}]));
        await tick(0);
        events.next({version: 3, type: 'group.call.signal', payload: {room_id: 'room-1', generation: 1, from_user_id: 'peer-1', from_device_id: 'peer-1', signal: {type: 'candidate', candidate: {candidate: 'candidate:1 1 udp 1 192.0.2.1 5000 typ host', usernameFragment: 'future', sdpMid: 'audio'}}}});
        await tick(0);
        facade.end();
        await tick(15_000);
        expect(facade.state.errorLabel).toBeUndefined();
        expect(send.mock.calls.filter(([command]) => command.type === 'group.call.leave')).toHaveLength(0);
    }));

    it('expires candidates even while a remote description operation is stalled', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-1'}]));
        await tick(0);
        const peer = peerConnections[0];
        let release: (() => void) | undefined;
        const add = vi.spyOn(peer, 'addIceCandidate');
        vi.spyOn(peer, 'setRemoteDescription').mockReturnValue(new Promise<void>(resolve => { release = resolve; }));
        const signal = (value: GroupCallSignalEvent['payload']['signal']): void => events.next({version: 3, type: 'group.call.signal', payload: {room_id: 'room-1', generation: 1, from_user_id: 'peer-1', from_device_id: 'peer-1', signal: value}});
        signal({type: 'offer', sdp: iceSDP('future'), negotiation_id: '8c72dd14-fafe-4e2d-9735-e09c37358bf1'});
        await tick(0);
        signal({type: 'candidate', candidate: {candidate: 'candidate:1 1 udp 1 192.0.2.1 5000 typ host', usernameFragment: 'future', sdpMid: 'audio'}});
        await tick(15_000);
        expect(facade.state.errorLabel).toContain('rejoin');
        expect(peer.connectionState).toBe('closed');
        release?.();
        await tick(0);
        expect(add).not.toHaveBeenCalled();
    }));

    it('renews credentials before expiry and ignores stale correlated replies', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        const started = room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-1'}]);
        acceptStarted({...started, payload: {...started.payload, ice_expires_at: new Date(Date.now() + 40000).toISOString()}});
        await tick(30000);
        const request = send.mock.calls.map(([command]) => command).find(command => command.type === 'group.call.credentials');
        expect(request).toBeDefined();
        const payload = {...request.payload, ice_servers: [{urls: ['turn:new.example'], username: 'opaque', credential: 'opaque'}], ice_expires_at: new Date(Date.now() + 120000).toISOString()};
        events.next({version: 3, type: 'group.call.credentials', request_id: 'stale', payload});
        expect(peerConnections[0].restartIce).not.toHaveBeenCalled();
        events.next({version: 3, type: 'group.call.credentials', request_id: request.request_id, payload});
        await tick(0);
        expect(peerConnections[0].setConfiguration).toHaveBeenCalledWith({iceServers: payload.ice_servers});
        expect(peerConnections[0].restartIce).toHaveBeenCalled();
        expect(facade.state.phase).toBe('active');
    }));

    it('bounds lost renewal retries without stopping media and fences late replies after end', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        const started = room('group.call.started', 'active');
        acceptStarted({...started, payload: {...started.payload, ice_expires_at: new Date(Date.now() + 4000).toISOString()}});
        await tick(20000);
        const requests = send.mock.calls.map(([command]) => command).filter(command => command.type === 'group.call.credentials');
        expect(requests).toHaveLength(4);
        expect(track.stop).not.toHaveBeenCalled();
        facade.end();
        events.next({version: 3, type: 'group.call.credentials', request_id: requests[3].request_id, payload: {...requests[3].payload, ice_servers: [], ice_expires_at: new Date(Date.now() + 60000).toISOString()}});
        await tick(30000);
        expect(facade.state.room).toBeUndefined();
        expect(send.mock.calls.map(([command]) => command).filter(command => command.type === 'group.call.credentials')).toHaveLength(4);
    }));

    it('serializes incoming offers behind the same peer restart while presentation capture remains independent', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        const started = room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-1'}]);
        acceptStarted({...started, payload: {...started.payload, ice_expires_at: new Date(Date.now() + 4000).toISOString()}});
        await tick(3000);
        const peer = peerConnections[0];
        let release: ((offer: RTCSessionDescriptionInit) => void) | undefined;
        const delayedOffer = new Promise<RTCSessionDescriptionInit>(resolve => { release = resolve; });
        vi.spyOn(peer, 'createOffer').mockReturnValue(delayedOffer as never);
        const remote = vi.spyOn(peer, 'setRemoteDescription');
        const display = vi.fn().mockRejectedValue(new Error('cancelled'));
        Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {configurable: true, value: display});
        const request = send.mock.calls.map(([command]) => command).find(command => command.type === 'group.call.credentials');
        events.next({version: 3, type: 'group.call.credentials', request_id: request.request_id, payload: {...request.payload, ice_servers: [], ice_expires_at: new Date(Date.now() + 120000).toISOString()}});
        await tick(0);
        events.next({version: 3, type: 'group.call.signal', payload: {room_id: 'room-1', generation: 1, from_user_id: 'peer-1', from_device_id: 'peer-1', signal: {type: 'offer', sdp: 'remote', negotiation_id: '8c72dd14-fafe-4e2d-9735-e09c37358bf1'}}});
        const presentation = facade.startPresentation('720p');
        await tick(0);
        expect(remote).not.toHaveBeenCalled();
        expect(display).toHaveBeenCalled();
        release?.({type: 'offer', sdp: 'restart'});
        await tick(0);
        expect(remote).toHaveBeenCalledWith({type: 'offer', sdp: 'remote'});
        expect(send.mock.calls.map(([command]) => command).find(command => command.type === 'group.call.signal' && command.payload.signal.type === 'answer')?.payload.signal.negotiation_id).toBe('8c72dd14-fafe-4e2d-9735-e09c37358bf1');
        await presentation;
        expect(display).toHaveBeenCalled();
        facade.end();
    }));

    it('defers a restart while an offer is outstanding and resumes after its answer', fakeAsync(async () => {
        await facade.start('group-1', 'a-self');
        const started = room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'a-self', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-1'}]);
        acceptStarted({...started, payload: {...started.payload, ice_expires_at: new Date(Date.now() + 4000).toISOString()}});
        await tick(3000);
        const peer = peerConnections[0];
        Object.defineProperty(peer, 'signalingState', {configurable: true, writable: true, value: 'have-local-offer'});
        const offer = vi.spyOn(peer, 'createOffer');
        vi.spyOn(peer, 'setRemoteDescription').mockImplementation(async () => { Object.defineProperty(peer, 'signalingState', {configurable: true, writable: true, value: 'stable'}); });
        const request = send.mock.calls.map(([command]) => command).find(command => command.type === 'group.call.credentials');
        events.next({version: 3, type: 'group.call.credentials', request_id: request.request_id, payload: {...request.payload, ice_servers: [], ice_expires_at: new Date(Date.now() + 120000).toISOString()}});
        await tick(0);
        expect(offer).not.toHaveBeenCalled();
        events.next({version: 3, type: 'group.call.signal', payload: {room_id: 'room-1', generation: 1, from_user_id: 'peer-1', from_device_id: 'peer-1', signal: {type: 'answer', sdp: 'answer', negotiation_id: lastOfferID('peer-1')}}});
        await tick(0);
        expect(offer).toHaveBeenCalledTimes(1);
        facade.end();
    }));

    it('reoffers a rolled-back ICE restart after an incoming offer collision', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        const started = room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-1'}]);
        acceptStarted({...started, payload: {...started.payload, ice_expires_at: new Date(Date.now() + 4000).toISOString()}});
        await tick(3000);
        const peer = peerConnections[0];
        Object.defineProperty(peer, 'signalingState', {configurable: true, writable: true, value: 'stable'});
        const offer = vi.spyOn(peer, 'createOffer');
        vi.spyOn(peer, 'setLocalDescription').mockImplementation(async (description: RTCLocalSessionDescriptionInit) => {
            Object.defineProperty(peer, 'signalingState', {configurable: true, writable: true, value: description?.type === 'offer' ? 'have-local-offer' : 'stable'});
        });
        const request = send.mock.calls.map(([command]) => command).find(command => command.type === 'group.call.credentials');
        events.next({version: 3, type: 'group.call.credentials', request_id: request.request_id, payload: {...request.payload, ice_servers: [], ice_expires_at: new Date(Date.now() + 120000).toISOString()}});
        await tick(0);
        expect(offer).toHaveBeenCalledTimes(1);
        events.next({version: 3, type: 'group.call.signal', payload: {room_id: 'room-1', generation: 1, from_user_id: 'peer-1', from_device_id: 'peer-1', signal: {type: 'offer', sdp: 'remote', negotiation_id: '8c72dd14-fafe-4e2d-9735-e09c37358bf1'}}});
        await tick(0);
        expect(peer.setLocalDescription).toHaveBeenCalledWith({type: 'rollback'});
        expect(offer).toHaveBeenCalledTimes(2);
        facade.end();
    }));

    it('rebinds the owned microphone after a polite rollback settles', fakeAsync(async () => {
        await facade.start('group-1', 'z-self');
        const self = {user_id: 'z-self', device_id: 'device-1'};
        const remote = {user_id: 'a-peer', device_id: 'peer-1'};
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [self, remote]));
        await tick(0);
        const peer = peerConnections[0];
        const signal = (sdp: string): void => events.next({version: 3, type: 'group.call.signal', payload: {room_id: 'room-1', generation: 1, from_user_id: remote.user_id, from_device_id: remote.device_id, signal: {type: 'offer', sdp, negotiation_id: '8c72dd14-fafe-4e2d-9735-e09c37358bf1'}}});
        signal(iceSDP('initial'));
        await tick(0);
        expect(senders[0].replaceTrack).not.toHaveBeenCalled();
        facade.toggleMute();
        Object.defineProperty(track, 'readyState', {configurable: true, value: 'live'});
        Object.defineProperty(peer, 'signalingState', {configurable: true, writable: true, value: 'have-local-offer'});
        const order: string[] = [];
        vi.spyOn(peer, 'setLocalDescription').mockImplementation(async description => {
            order.push(description.type ?? 'auto');
            Object.defineProperty(peer, 'signalingState', {configurable: true, writable: true, value: 'stable'});
        });
        vi.spyOn(peer, 'setRemoteDescription').mockImplementation(async description => {
            order.push(`remote-${description.type}`);
            Object.defineProperty(peer, 'pendingRemoteDescription', {configurable: true, writable: true, value: description});
            Object.defineProperty(peer, 'signalingState', {configurable: true, writable: true, value: 'have-remote-offer'});
        });
        senders[0].replaceTrack.mockImplementation(async (next: MediaStreamTrack | null) => {
            order.push(next ? 'reattach' : 'detach');
            Object.defineProperty(senders[0].sender, 'track', {configurable: true, writable: true, value: next});
        });
        signal(iceSDP('restart'));
        await tick(0);
        expect(order).toEqual(['rollback', 'remote-offer', 'answer', 'detach', 'reattach']);
        expect(senders[0].replaceTrack).toHaveBeenNthCalledWith(1, null);
        expect(senders[0].replaceTrack).toHaveBeenNthCalledWith(2, track);
        expect(track.enabled).toBe(false);
        expect(track.stop).not.toHaveBeenCalled();
        expect(facade.state.phase).toBe('active');
        facade.end();
    }));

    it('serializes microphone selection behind a rollback repair and preserves mute', fakeAsync(async () => {
        await facade.start('group-1', 'z-self');
        const remote = {user_id: 'a-peer', device_id: 'peer-1'};
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'z-self', device_id: 'device-1'}, remote]));
        await tick(0);
        facade.toggleMute();
        const peer = peerConnections[0];
        Object.defineProperty(peer, 'signalingState', {configurable: true, writable: true, value: 'have-local-offer'});
        let release: (() => void) | undefined;
        senders[0].replaceTrack.mockImplementation((next: MediaStreamTrack | null) => {
            if (next === null) return new Promise<void>(resolve => { release = () => { Object.defineProperty(senders[0].sender, 'track', {configurable: true, writable: true, value: null}); resolve(); }; });
            Object.defineProperty(senders[0].sender, 'track', {configurable: true, writable: true, value: next});
            return Promise.resolve();
        });
        events.next({version: 3, type: 'group.call.signal', payload: {room_id: 'room-1', generation: 1, from_user_id: remote.user_id, from_device_id: remote.device_id, signal: {type: 'offer', sdp: iceSDP('restart'), negotiation_id: '8c72dd14-fafe-4e2d-9735-e09c37358bf1'}}});
        await tick(0);
        const replacement = {kind: 'audio', enabled: true, readyState: 'live', stop: vi.fn()};
        vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValueOnce({getTracks: () => [replacement], getAudioTracks: () => [replacement]} as unknown as MediaStream);
        const change = facade.selectInputDevice('new-microphone');
        await tick(0);
        expect(senders[0].replaceTrack).toHaveBeenCalledTimes(1);
        expect(replacement.enabled).toBe(false);
        release?.();
        await tick(0);
        await change;
        expect(senders[0].replaceTrack).toHaveBeenNthCalledWith(1, null);
        expect(senders[0].replaceTrack).toHaveBeenNthCalledWith(2, track);
        expect(senders[0].replaceTrack).toHaveBeenNthCalledWith(3, replacement);
        expect(senders[0].sender.track).toBe(replacement);
        expect(facade.state.selectedInputID).toBe('new-microphone');
        expect(replacement.enabled).toBe(false);
        facade.end();
        expect(replacement.stop).toHaveBeenCalled();
    }));

    it('fences a delayed rollback repair after teardown', fakeAsync(async () => {
        await facade.start('group-1', 'z-self');
        const remote = {user_id: 'a-peer', device_id: 'peer-1'};
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'z-self', device_id: 'device-1'}, remote]));
        await tick(0);
        Object.defineProperty(peerConnections[0], 'signalingState', {configurable: true, writable: true, value: 'have-local-offer'});
        let release: (() => void) | undefined;
        senders[0].replaceTrack.mockReturnValueOnce(new Promise<void>(resolve => { release = resolve; }));
        events.next({version: 3, type: 'group.call.signal', payload: {room_id: 'room-1', generation: 1, from_user_id: remote.user_id, from_device_id: remote.device_id, signal: {type: 'offer', sdp: iceSDP('restart'), negotiation_id: '8c72dd14-fafe-4e2d-9735-e09c37358bf1'}}});
        await tick(0);
        expect(senders[0].replaceTrack).toHaveBeenCalledWith(null);
        facade.abort('group-1');
        expect(track.stop).toHaveBeenCalled();
        release?.();
        await tick(0);
        expect(senders[0].replaceTrack).toHaveBeenCalledTimes(1);
        expect(peerConnections[0].connectionState).toBe('closed');
    }));

    it('isolates a peer visibly if its microphone cannot be reattached after rollback', fakeAsync(async () => {
        await facade.start('group-1', 'z-self');
        const self = {user_id: 'z-self', device_id: 'device-1'};
        const remote = {user_id: 'a-peer', device_id: 'peer-1'};
        const other = {user_id: 'b-peer', device_id: 'peer-2'};
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [self, remote, other]));
        await tick(0);
        Object.defineProperty(peerConnections[0], 'signalingState', {configurable: true, writable: true, value: 'have-local-offer'});
        senders[0].replaceTrack.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('reattachment failed'));
        events.next({version: 3, type: 'group.call.signal', payload: {room_id: 'room-1', generation: 1, from_user_id: remote.user_id, from_device_id: remote.device_id, signal: {type: 'offer', sdp: iceSDP('restart'), negotiation_id: '8c72dd14-fafe-4e2d-9735-e09c37358bf1'}}});
        await tick(0);
        expect(peerConnections[0].connectionState).toBe('closed');
        expect(peerConnections[1].connectionState).not.toBe('closed');
        expect(facade.state.phase).toBe('active');
        expect(facade.state.errorLabel).toContain('rejoin');
        expect(track.stop).not.toHaveBeenCalled();
        facade.end();
    }));

    it('does not reattach a microphone that ends while rollback repair is pending', fakeAsync(async () => {
        await facade.start('group-1', 'z-self');
        const remote = {user_id: 'a-peer', device_id: 'peer-1'};
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'z-self', device_id: 'device-1'}, remote]));
        await tick(0);
        Object.defineProperty(track, 'readyState', {configurable: true, writable: true, value: 'live'});
        Object.defineProperty(peerConnections[0], 'signalingState', {configurable: true, writable: true, value: 'have-local-offer'});
        let release: (() => void) | undefined;
        senders[0].replaceTrack.mockReturnValueOnce(new Promise<void>(resolve => { release = resolve; }));
        events.next({version: 3, type: 'group.call.signal', payload: {room_id: 'room-1', generation: 1, from_user_id: remote.user_id, from_device_id: remote.device_id, signal: {type: 'offer', sdp: iceSDP('restart'), negotiation_id: '8c72dd14-fafe-4e2d-9735-e09c37358bf1'}}});
        await tick(0);
        Object.defineProperty(track, 'readyState', {configurable: true, writable: true, value: 'ended'});
        release?.();
        await tick(0);
        expect(senders[0].replaceTrack).toHaveBeenCalledTimes(1);
        expect(peerConnections[0].connectionState).toBe('closed');
        expect(facade.state.errorLabel).toContain('rejoin');
        facade.end();
    }));

    it('converges when two facades restart ICE simultaneously', fakeAsync(async () => {
        const otherEvents = new Subject<MessageSocketEvent>();
        const otherReady = new BehaviorSubject<boolean>(true);
        const otherSend = vi.fn().mockReturnValue(true);
        const otherFacade = new GroupCallFacade({getObservable: () => otherEvents.asObservable(), readyChanges: otherReady.asObservable(), get ready() { return otherReady.value; }, send: otherSend} as unknown as DataProviderService);
        const self = {user_id: 'a-user', device_id: 'a-device'};
        const other = {user_id: 'z-user', device_id: 'z-device'};
        await facade.start('group-1', self.user_id);
        const expiry = new Date(Date.now() + 4000).toISOString();
        const started = room('group.call.started', 'active', 'group-1', 1, 1, [self]);
        acceptStarted({...started, payload: {...started.payload, ice_expires_at: expiry}});
        otherEvents.next({...started, payload: {...started.payload, ice_expires_at: expiry}});
        await otherFacade.join({...started.payload, ice_expires_at: expiry}, other.user_id);
        const joined = room('group.call.participant.joined', 'active', 'group-1', 1, 2, [self, other]);
        events.next({...joined, payload: {...joined.payload, ice_expires_at: expiry}});
        otherEvents.next({...joined, payload: {...joined.payload, ice_expires_at: expiry}});
        const a = peerConnections[0];
        const b = peerConnections[1];
        let bOffer = 0;
        vi.spyOn(b, 'createOffer').mockImplementation((async () => ({type: 'offer', sdp: iceSDP(`b-offer-${++bOffer}`)})) as never);
        vi.spyOn(a, 'createAnswer').mockReturnValue(Promise.resolve({type: 'answer', sdp: iceSDP('a-answer')}) as never);
        vi.spyOn(b, 'createAnswer').mockReturnValue(Promise.resolve({type: 'answer', sdp: iceSDP('b-answer')}) as never);
        for (const connection of [a, b]) {
            Object.defineProperty(connection, 'signalingState', {configurable: true, writable: true, value: 'stable'});
            vi.spyOn(connection, 'setLocalDescription').mockImplementation(async (description: RTCLocalSessionDescriptionInit) => {
                const value = description.type === 'offer' ? 'have-local-offer' : 'stable';
                Object.defineProperty(connection, 'signalingState', {configurable: true, writable: true, value});
            });
            vi.spyOn(connection, 'setRemoteDescription').mockImplementation(async description => {
                const value = description.type === 'offer' ? 'have-remote-offer' : 'stable';
                Object.defineProperty(connection, 'signalingState', {configurable: true, writable: true, value});
                Object.defineProperty(connection, description.type === 'offer' ? 'pendingRemoteDescription' : 'currentRemoteDescription', {configurable: true, writable: true, value: description});
            });
        }
        const signals = (mock: Mock): GroupCallSignalEvent[] => mock.mock.calls.map(([command]) => command).filter(command => command.type === 'group.call.signal');
        const deliver = (event: GroupCallSignalEvent, source: GroupCallParticipant, target: Subject<MessageSocketEvent>): void => {
            target.next({version: 3, type: 'group.call.signal', payload: {room_id: event.payload.room_id, generation: event.payload.generation, from_user_id: source.user_id, from_device_id: source.device_id, signal: event.payload.signal}});
        };
        await tick(0);
        deliver(signals(send)[0], self, otherEvents);
        await tick(0);
        deliver(signals(otherSend)[0], other, events);
        await tick(0);
        expect(a.signalingState).toBe('stable');
        expect(b.signalingState).toBe('stable');
        await tick(3000);
        const requestA = send.mock.calls.map(([command]) => command).find(command => command.type === 'group.call.credentials');
        const requestB = otherSend.mock.calls.map(([command]) => command).find(command => command.type === 'group.call.credentials');
        const credentials = {ice_servers: [], ice_expires_at: new Date(Date.now() + 120000).toISOString()};
        events.next({version: 3, type: 'group.call.credentials', request_id: requestA.request_id, payload: {...requestA.payload, ...credentials}});
        otherEvents.next({version: 3, type: 'group.call.credentials', request_id: requestB.request_id, payload: {...requestB.payload, ...credentials}});
        await tick(0);
        const offerA = signals(send).at(-1);
        const offerB = signals(otherSend).at(-1);
        if (!offerA || !offerB) throw new Error('Both restart offers are required');
        expect(offerA.payload.signal.type).toBe('offer');
        expect(offerB.payload.signal.type).toBe('offer');
        const aBefore = signals(send).length;
        const bBefore = signals(otherSend).length;
        deliver(offerA, self, otherEvents);
        deliver(offerB, other, events);
        await tick(0);
        const responses = signals(otherSend).slice(bBefore);
        expect(responses.map(event => event.payload.signal.type)).toEqual(['answer', 'offer']);
        expect(a.setLocalDescription).not.toHaveBeenCalledWith({type: 'rollback'});
        expect(b.setLocalDescription).toHaveBeenCalledWith({type: 'rollback'});
        expect(senders[0].replaceTrack).not.toHaveBeenCalled();
        expect(senders[1].replaceTrack).not.toHaveBeenCalled();
        const addCandidate = vi.spyOn(a, 'addIceCandidate');
        const ignoredCandidate = {candidate: 'candidate:1 1 udp 2122260223 192.0.2.1 5000 typ host ufrag b-offer-1', sdpMid: 'audio', sdpMLineIndex: 0, usernameFragment: 'b-offer-1'};
        events.next({version: 3, type: 'group.call.signal', payload: {room_id: 'room-1', generation: 1, from_user_id: other.user_id, from_device_id: other.device_id, signal: {type: 'candidate', candidate: ignoredCandidate}}});
        if (offerB.payload.signal.type !== 'offer') throw new Error('Expected offer');
        events.next({version: 3, type: 'group.call.signal', payload: {room_id: 'room-1', generation: 1, from_user_id: other.user_id, from_device_id: other.device_id, signal: {type: 'answer', sdp: 'stale', negotiation_id: offerB.payload.signal.negotiation_id}}});
        await tick(0);
        expect(a.connectionState).not.toBe('closed');
        expect(a.signalingState).toBe('have-local-offer');
        // Lose the polite peer's follow-up offer. Its timeout must retry with a
        // fresh correlation ID without disturbing the impolite peer's answer.
        deliver(responses[0], other, events);
        await tick(0);
        // An ICE candidate for the ignored collision can arrive after the
        // accepted answer; it must not be passed to the live peer.
        events.next({version: 3, type: 'group.call.signal', payload: {room_id: 'room-1', generation: 1, from_user_id: other.user_id, from_device_id: other.device_id, signal: {type: 'candidate', candidate: ignoredCandidate}}});
        await tick(0);
        expect(addCandidate).not.toHaveBeenCalled();
        expect(a.connectionState).not.toBe('closed');
        await tick(9000);
        const retried = signals(otherSend).at(-1);
        if (!retried || retried.payload.signal.type !== 'offer' || responses[1].payload.signal.type !== 'offer') throw new Error('Expected restart retry');
        expect(retried.payload.signal.negotiation_id).not.toBe(responses[1].payload.signal.negotiation_id);
        otherEvents.next({version: 3, type: 'group.call.signal', payload: {room_id: 'room-1', generation: 1, from_user_id: self.user_id, from_device_id: self.device_id, signal: {type: 'answer', sdp: 'stale', negotiation_id: responses[1].payload.signal.negotiation_id}}});
        await tick(0);
        expect(b.signalingState).toBe('have-local-offer');
        deliver(retried, other, events);
        await tick(0);
        const lastResponses = signals(send).slice(aBefore);
        expect(lastResponses.map(event => event.payload.signal.type)).toEqual(['answer']);
        deliver(lastResponses[0], self, otherEvents);
        await tick(0);
        expect(a.signalingState).toBe('stable');
        expect(b.signalingState).toBe('stable');
        expect(senders[0].replaceTrack).not.toHaveBeenCalled();
        expect(senders[1].replaceTrack).toHaveBeenNthCalledWith(1, null);
        expect(senders[1].replaceTrack).toHaveBeenNthCalledWith(2, track);
        const finalA = signals(send).length;
        const finalB = signals(otherSend).length;
        await tick(9000);
        expect(signals(send)).toHaveLength(finalA);
        expect(signals(otherSend)).toHaveLength(finalB);
        expect(facade.state.phase).toBe('active');
        expect(otherFacade.state.phase).toBe('active');
        facade.end();
        otherFacade.close();
        await tick(30000);
        expect(signals(send)).toHaveLength(finalA);
        expect(signals(otherSend)).toHaveLength(finalB);
    }));

    it('retries configuration per peer with a bounded budget and cancels on replacement or teardown', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        const self = {user_id: 'self-1', device_id: 'device-1'};
        const other = {user_id: 'peer-1', device_id: 'peer-1'};
        const started = room('group.call.started', 'active', 'group-1', 1, 1, [self, other]);
        acceptStarted({...started, payload: {...started.payload, ice_expires_at: new Date(Date.now() + 4000).toISOString()}});
        await tick(3000);
        const old = peerConnections[0];
        vi.mocked(old.setConfiguration).mockImplementation(() => { throw new Error('transient'); });
        const request = send.mock.calls.map(([command]) => command).find(command => command.type === 'group.call.credentials');
        events.next({version: 3, type: 'group.call.credentials', request_id: request.request_id, payload: {...request.payload, ice_servers: [], ice_expires_at: new Date(Date.now() + 120000).toISOString()}});
        await tick(7000);
        expect(old.setConfiguration).toHaveBeenCalledTimes(4);
        expect(track.stop).not.toHaveBeenCalled();
        events.next(room('group.call.participant.left', 'active', 'group-1', 1, 2, [self]));
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 3, [self, other]));
        await tick(0);
        expect(peerConnections).toHaveLength(2);
        facade.end();
        await tick(10000);
        expect(old.setConfiguration).toHaveBeenCalledTimes(4);
        expect(peerConnections[1].restartIce).not.toHaveBeenCalled();
    }));

    it('cancels a pending peer restart retry when the same identity reconnects', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        const self = {user_id: 'self-1', device_id: 'device-1'};
        const other = {user_id: 'peer-1', device_id: 'peer-1'};
        const started = room('group.call.started', 'active', 'group-1', 1, 1, [self, other]);
        acceptStarted({...started, payload: {...started.payload, ice_expires_at: new Date(Date.now() + 4000).toISOString()}});
        await tick(3000);
        const old = peerConnections[0];
        vi.mocked(old.setConfiguration).mockImplementation(() => { throw new Error('transient'); });
        const request = send.mock.calls.map(([command]) => command).find(command => command.type === 'group.call.credentials');
        events.next({version: 3, type: 'group.call.credentials', request_id: request.request_id, payload: {...request.payload, ice_servers: [], ice_expires_at: new Date(Date.now() + 120000).toISOString()}});
        await tick(0);
        events.next(room('group.call.participant.left', 'active', 'group-1', 1, 2, [self]));
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 3, [self, other]));
        await tick(10000);
        expect(old.setConfiguration).toHaveBeenCalledTimes(1);
        expect(peerConnections).toHaveLength(2);
        expect(peerConnections[1].restartIce).not.toHaveBeenCalled();
        facade.end();
    }));

    it('retries failed restart offers without removing media and cancels retries on end', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        const started = room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-1'}]);
        acceptStarted({...started, payload: {...started.payload, ice_expires_at: new Date(Date.now() + 4000).toISOString()}});
        await tick(3000);
        const peer = peerConnections[0];
        const offer = vi.spyOn(peer, 'createOffer').mockReturnValue(Promise.reject(new Error('transient')) as never);
        const request = send.mock.calls.map(([command]) => command).find(command => command.type === 'group.call.credentials');
        events.next({version: 3, type: 'group.call.credentials', request_id: request.request_id, payload: {...request.payload, ice_servers: [], ice_expires_at: new Date(Date.now() + 120000).toISOString()}});
        await tick(1000);
        expect(offer).toHaveBeenCalledTimes(2);
        expect(track.stop).not.toHaveBeenCalled();
        expect(peer.connectionState).not.toBe('closed');
        facade.end();
        await tick(10000);
        expect(offer).toHaveBeenCalledTimes(2);
    }));

    it('restarts healthy peers independently when another peer fails', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        const started = room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-1'}, {user_id: 'peer-2', device_id: 'peer-2'}]);
        acceptStarted({...started, payload: {...started.payload, ice_expires_at: new Date(Date.now() + 4000).toISOString()}});
        await tick(3000);
        vi.mocked(peerConnections[0].setConfiguration).mockImplementation(() => { throw new Error('transient'); });
        const request = send.mock.calls.map(([command]) => command).find(command => command.type === 'group.call.credentials');
        events.next({version: 3, type: 'group.call.credentials', request_id: request.request_id, payload: {...request.payload, ice_servers: [], ice_expires_at: new Date(Date.now() + 120000).toISOString()}});
        await tick(1000);
        expect(peerConnections[0].setConfiguration).toHaveBeenCalledTimes(2);
        expect(peerConnections[1].setConfiguration).toHaveBeenCalledTimes(1);
        expect(peerConnections[1].restartIce).toHaveBeenCalledTimes(1);
        expect(track.stop).not.toHaveBeenCalled();
        facade.end();
    }));

    it('recovers after a bounded restart retry cycle and retains warning until every peer updates', fakeAsync(async () => {
        await facade.start('group-1', 'a-self');
        const participants = [{user_id: 'a-self', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-1'}, {user_id: 'peer-2', device_id: 'peer-2'}];
        const started = room('group.call.started', 'active', 'group-1', 1, 1, participants);
        acceptStarted({...started, payload: {...started.payload, ice_expires_at: new Date(Date.now() + 4000).toISOString()}});
        await tick(3000);
        const first = peerConnections[0];
        const second = peerConnections[1];
        let failures = 0;
        vi.mocked(first.setConfiguration).mockImplementation(() => { if (++failures <= 4) throw new Error('transient'); });
        Object.defineProperty(second, 'signalingState', {configurable: true, writable: true, value: 'have-local-offer'});
        vi.spyOn(second, 'setRemoteDescription').mockImplementation(async () => { Object.defineProperty(second, 'signalingState', {configurable: true, writable: true, value: 'stable'}); });
        const request = send.mock.calls.map(([command]) => command).find(command => command.type === 'group.call.credentials');
        events.next({version: 3, type: 'group.call.credentials', request_id: request.request_id, payload: {...request.payload, ice_servers: [], ice_expires_at: new Date(Date.now() + 120000).toISOString()}});
        const ack = () => {
            const sync = [...send.mock.calls].reverse().map(([command]) => command).find(command => command.type === 'group.call.sync');
            if (sync) events.next(synced(sync.request_id, {participants}));
        };
        await tick(7000); ack();
        expect(first.setConfiguration).toHaveBeenCalledTimes(4);
        expect(facade.state.statusLabel).toContain('Retrying automatically');
        facade.toggleMute();
        expect(facade.state.statusLabel).toContain('Retrying automatically');
        await tick(10000); ack();
        await tick(10000); ack();
        expect(first.setConfiguration).toHaveBeenCalledTimes(4);
        await tick(10000); ack();
        expect(first.setConfiguration).toHaveBeenCalledTimes(5);
        expect(first.restartIce).toHaveBeenCalled();
        expect(facade.state.statusLabel).toContain('Retrying automatically');
        Object.defineProperty(first, 'signalingState', {configurable: true, writable: true, value: 'have-local-offer'});
        events.next({version: 3, type: 'group.call.signal', payload: {room_id: 'room-1', generation: 1, from_user_id: 'peer-1', from_device_id: 'peer-1', signal: {type: 'answer', sdp: 'answer', negotiation_id: lastOfferID('peer-1')}}});
        events.next({version: 3, type: 'group.call.signal', payload: {room_id: 'room-1', generation: 1, from_user_id: 'peer-2', from_device_id: 'peer-2', signal: {type: 'answer', sdp: 'answer', negotiation_id: lastOfferID('peer-2')}}});
        await tick(0);
        expect(facade.state.statusLabel).toContain('Retrying automatically');
        Object.defineProperty(second, 'signalingState', {configurable: true, writable: true, value: 'have-local-offer'});
        events.next({version: 3, type: 'group.call.signal', payload: {room_id: 'room-1', generation: 1, from_user_id: 'peer-2', from_device_id: 'peer-2', signal: {type: 'answer', sdp: 'answer', negotiation_id: lastOfferID('peer-2')}}});
        await tick(0);
        expect(facade.state.statusLabel).not.toContain('Retrying automatically');
        expect(senders[0].replaceTrack).not.toHaveBeenCalled();
        expect(senders[1].replaceTrack).not.toHaveBeenCalled();
        expect(track.stop).not.toHaveBeenCalled();
        facade.end();
    }));

    it('fences a pending failed restart when a newer credential epoch arrives', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        const participants = [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-1'}];
        const started = room('group.call.started', 'active', 'group-1', 1, 1, participants);
        acceptStarted({...started, payload: {...started.payload, ice_expires_at: new Date(Date.now() + 4000).toISOString()}});
        await tick(3000);
        const peer = peerConnections[0];
        vi.mocked(peer.setConfiguration).mockImplementationOnce(() => { throw new Error('transient'); });
        const request = send.mock.calls.map(([command]) => command).find(command => command.type === 'group.call.credentials');
        events.next({version: 3, type: 'group.call.credentials', request_id: request.request_id, payload: {...request.payload, ice_servers: [], ice_expires_at: new Date(Date.now() + 120000).toISOString()}});
        await tick(0);
        expect(facade.state.statusLabel).toContain('Retrying automatically');
        const servers = [{urls: ['turn:new.example'], username: 'opaque', credential: 'opaque'}];
        const newer = room('group.call.participant.joined', 'active', 'group-1', 1, 2, participants);
        events.next({...newer, payload: {...newer.payload, ice_servers: servers, ice_expires_at: new Date(Date.now() + 180000).toISOString()}});
        await tick(5000);
        expect(peer.setConfiguration).toHaveBeenCalledTimes(2);
        expect(peer.setConfiguration).toHaveBeenLastCalledWith({iceServers: servers});
        expect(facade.state.statusLabel).toContain('Retrying automatically');
        Object.defineProperty(peer, 'signalingState', {configurable: true, writable: true, value: 'have-local-offer'});
        events.next({version: 3, type: 'group.call.signal', payload: {room_id: 'room-1', generation: 1, from_user_id: 'peer-1', from_device_id: 'peer-1', signal: {type: 'answer', sdp: 'answer', negotiation_id: lastOfferID('peer-1')}}});
        await tick(0);
        expect(facade.state.statusLabel).not.toContain('Retrying automatically');
        facade.end();
        await tick(30000);
        expect(peer.setConfiguration).toHaveBeenCalledTimes(2);
    }));

    it.each(['send failure', 'rejection', 'answer timeout'] as const)('rolls back and retries a restart after %s until an answer arrives', failure => fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        const participants = [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-1'}];
        const started = room('group.call.started', 'active', 'group-1', 1, 1, participants);
        acceptStarted({...started, payload: {...started.payload, ice_expires_at: new Date(Date.now() + 4000).toISOString()}});
        await tick(3000);
        const peer = peerConnections[0];
        Object.defineProperty(peer, 'signalingState', {configurable: true, writable: true, value: 'stable'});
        facade.toggleMute();
        vi.spyOn(peer, 'setLocalDescription').mockImplementation(async (description: RTCLocalSessionDescriptionInit) => {
            Object.defineProperty(peer, 'signalingState', {configurable: true, writable: true, value: description.type === 'offer' ? 'have-local-offer' : 'stable'});
        });
        vi.spyOn(peer, 'setRemoteDescription').mockImplementation(async () => { Object.defineProperty(peer, 'signalingState', {configurable: true, writable: true, value: 'stable'}); });
        let failedSend = false;
        send.mockImplementation(command => {
            if (failure === 'send failure' && !failedSend && command.type === 'group.call.signal' && command.payload.signal.type === 'offer') { failedSend = true; return false; }
            return true;
        });
        const request = send.mock.calls.map(([command]) => command).find(command => command.type === 'group.call.credentials');
        events.next({version: 3, type: 'group.call.credentials', request_id: request.request_id, payload: {...request.payload, ice_servers: [], ice_expires_at: new Date(Date.now() + 120000).toISOString()}});
        await tick(0);
        const offers = () => send.mock.calls.map(([command]) => command).filter(command => command.type === 'group.call.signal' && command.payload.signal.type === 'offer');
        const initial = offers().at(-1);
        if (failure === 'rejection') events.next(rejected(initial.request_id, 'unavailable'));
        if (failure === 'answer timeout') await tick(8000);
        expect(facade.state.statusLabel).toContain('Retrying automatically');
        expect(facade.state.phase).toBe('active');
        await tick(1000);
        expect(peer.setLocalDescription).toHaveBeenCalledWith({type: 'rollback'});
        expect(offers().length).toBeGreaterThanOrEqual(2);
        expect(facade.state.statusLabel).toContain('Retrying automatically');
        events.next({version: 3, type: 'group.call.signal', payload: {room_id: 'room-1', generation: 1, from_user_id: 'peer-1', from_device_id: 'peer-1', signal: {type: 'answer', sdp: 'answer', negotiation_id: lastOfferID('peer-1')}}});
        await tick(0);
        expect(facade.state.statusLabel).not.toContain('Retrying automatically');
        expect(senders[0].replaceTrack).toHaveBeenNthCalledWith(1, null);
        expect(senders[0].replaceTrack).toHaveBeenNthCalledWith(2, track);
        expect(track.enabled).toBe(false);
        expect(track.stop).not.toHaveBeenCalled();
        facade.end();
    })());

    it('repairs the microphone after newer credentials roll back an outstanding restart offer', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        const participants = [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-1'}];
        const started = room('group.call.started', 'active', 'group-1', 1, 1, participants);
        acceptStarted({...started, payload: {...started.payload, ice_expires_at: new Date(Date.now() + 4000).toISOString()}});
        await tick(3000);
        const peer = peerConnections[0];
        Object.defineProperty(peer, 'signalingState', {configurable: true, writable: true, value: 'stable'});
        Object.defineProperty(peer, 'currentLocalDescription', {configurable: true, writable: true, value: {type: 'answer', sdp: iceSDP('local-current')}});
        let offerNumber = 0;
        vi.spyOn(peer, 'createOffer').mockImplementation((async () => ({type: 'offer', sdp: iceSDP(`local-${++offerNumber}`)})) as never);
        vi.spyOn(peer, 'setLocalDescription').mockImplementation(async description => {
            Object.defineProperty(peer, 'signalingState', {configurable: true, writable: true, value: description.type === 'offer' ? 'have-local-offer' : 'stable'});
            Object.defineProperty(peer, 'pendingLocalDescription', {configurable: true, writable: true, value: description.type === 'offer' ? description : null});
        });
        vi.spyOn(peer, 'setRemoteDescription').mockImplementation(async () => { Object.defineProperty(peer, 'signalingState', {configurable: true, writable: true, value: 'stable'}); });
        const request = send.mock.calls.map(([command]) => command).find(command => command.type === 'group.call.credentials');
        events.next({version: 3, type: 'group.call.credentials', request_id: request.request_id, payload: {...request.payload, ice_servers: [], ice_expires_at: new Date(Date.now() + 120000).toISOString()}});
        await tick(0);
        const oldID = lastOfferID('peer-1');
        const newer = room('group.call.participant.joined', 'active', 'group-1', 1, 2, participants);
        events.next({...newer, payload: {...newer.payload, ice_expires_at: new Date(Date.now() + 180000).toISOString()}});
        await tick(0);
        const nextID = lastOfferID('peer-1');
        expect(nextID).not.toBe(oldID);
        expect(peer.setLocalDescription).toHaveBeenCalledWith({type: 'rollback'});
        const beforeStale = send.mock.calls.length;
        const staleLine = 'candidate:1 1 udp 1 192.0.2.1 5000 typ host ufrag local-1';
        const stale = {candidate: staleLine, sdpMid: 'audio', sdpMLineIndex: 0, usernameFragment: 'local-1', toJSON: () => ({candidate: staleLine, sdpMid: 'audio', sdpMLineIndex: 0, usernameFragment: 'local-1'})} as RTCIceCandidate;
        peer.onicecandidate?.call(peer, {candidate: stale} as RTCPeerConnectionIceEvent);
        expect(send.mock.calls).toHaveLength(beforeStale);
        expect(facade.state.errorLabel).toBeUndefined();
        events.next({version: 3, type: 'group.call.signal', payload: {room_id: 'room-1', generation: 1, from_user_id: 'peer-1', from_device_id: 'peer-1', signal: {type: 'answer', sdp: 'answer', negotiation_id: oldID}}});
        await tick(0);
        expect(senders[0].replaceTrack).not.toHaveBeenCalled();
        events.next({version: 3, type: 'group.call.signal', payload: {room_id: 'room-1', generation: 1, from_user_id: 'peer-1', from_device_id: 'peer-1', signal: {type: 'answer', sdp: 'answer', negotiation_id: nextID}}});
        await tick(0);
        expect(senders[0].replaceTrack).toHaveBeenNthCalledWith(1, null);
        expect(senders[0].replaceTrack).toHaveBeenNthCalledWith(2, track);
        expect(track.stop).not.toHaveBeenCalled();
        expect(facade.state.phase).toBe('active');
        facade.end();
    }));

    it('retains microphone repair when a newer credential epoch wins during rollback', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        const participants = [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-1'}];
        const started = room('group.call.started', 'active', 'group-1', 1, 1, participants);
        acceptStarted({...started, payload: {...started.payload, ice_expires_at: new Date(Date.now() + 4000).toISOString()}});
        await tick(3000);
        const peer = peerConnections[0];
        Object.defineProperty(peer, 'signalingState', {configurable: true, writable: true, value: 'stable'});
        let release: (() => void) | undefined;
        vi.spyOn(peer, 'setLocalDescription').mockImplementation(description => {
            if (description.type === 'rollback') return new Promise<void>(resolve => { release = () => { Object.defineProperty(peer, 'signalingState', {configurable: true, writable: true, value: 'stable'}); resolve(); }; });
            Object.defineProperty(peer, 'signalingState', {configurable: true, writable: true, value: 'have-local-offer'});
            return Promise.resolve();
        });
        vi.spyOn(peer, 'setRemoteDescription').mockImplementation(async () => { Object.defineProperty(peer, 'signalingState', {configurable: true, writable: true, value: 'stable'}); });
        const request = send.mock.calls.map(([command]) => command).find(command => command.type === 'group.call.credentials');
        events.next({version: 3, type: 'group.call.credentials', request_id: request.request_id, payload: {...request.payload, ice_servers: [], ice_expires_at: new Date(Date.now() + 120000).toISOString()}});
        await tick(0);
        const next = room('group.call.participant.joined', 'active', 'group-1', 1, 2, participants);
        events.next({...next, payload: {...next.payload, ice_expires_at: new Date(Date.now() + 180000).toISOString()}});
        await tick(0);
        expect(release).toBeDefined();
        const latest = room('group.call.participant.joined', 'active', 'group-1', 1, 3, participants);
        events.next({...latest, payload: {...latest.payload, ice_expires_at: new Date(Date.now() + 240000).toISOString()}});
        release?.();
        await tick(0);
        events.next({version: 3, type: 'group.call.signal', payload: {room_id: 'room-1', generation: 1, from_user_id: 'peer-1', from_device_id: 'peer-1', signal: {type: 'answer', sdp: 'answer', negotiation_id: lastOfferID('peer-1')}}});
        await tick(0);
        expect(senders[0].replaceTrack).toHaveBeenNthCalledWith(1, null);
        expect(senders[0].replaceTrack).toHaveBeenNthCalledWith(2, track);
        expect(track.stop).not.toHaveBeenCalled();
        facade.end();
    }));

    it('does not repair or signal from a rollback that resolves after teardown', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        const participants = [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-1'}];
        const started = room('group.call.started', 'active', 'group-1', 1, 1, participants);
        acceptStarted({...started, payload: {...started.payload, ice_expires_at: new Date(Date.now() + 4000).toISOString()}});
        await tick(3000);
        const peer = peerConnections[0];
        Object.defineProperty(peer, 'signalingState', {configurable: true, writable: true, value: 'stable'});
        let release: (() => void) | undefined;
        vi.spyOn(peer, 'setLocalDescription').mockImplementation(description => {
            if (description.type === 'rollback') return new Promise<void>(resolve => { release = resolve; });
            Object.defineProperty(peer, 'signalingState', {configurable: true, writable: true, value: 'have-local-offer'});
            return Promise.resolve();
        });
        const request = send.mock.calls.map(([command]) => command).find(command => command.type === 'group.call.credentials');
        events.next({version: 3, type: 'group.call.credentials', request_id: request.request_id, payload: {...request.payload, ice_servers: [], ice_expires_at: new Date(Date.now() + 120000).toISOString()}});
        await tick(0);
        const next = room('group.call.participant.joined', 'active', 'group-1', 1, 2, participants);
        events.next({...next, payload: {...next.payload, ice_expires_at: new Date(Date.now() + 180000).toISOString()}});
        await tick(0);
        expect(release).toBeDefined();
        facade.abort('group-1');
        const sentBefore = send.mock.calls.length;
        release?.();
        await tick(0);
        expect(peer.connectionState).toBe('closed');
        expect(senders[0].replaceTrack).not.toHaveBeenCalled();
        expect(send.mock.calls).toHaveLength(sentBefore);
    }));

    it('fences rejected outstanding restart offers across newer credentials and teardown', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        const participants = [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-1'}];
        const started = room('group.call.started', 'active', 'group-1', 1, 1, participants);
        acceptStarted({...started, payload: {...started.payload, ice_expires_at: new Date(Date.now() + 4000).toISOString()}});
        await tick(3000);
        const peer = peerConnections[0];
        Object.defineProperty(peer, 'signalingState', {configurable: true, writable: true, value: 'stable'});
        vi.spyOn(peer, 'setLocalDescription').mockImplementation(async (description: RTCLocalSessionDescriptionInit) => {
            Object.defineProperty(peer, 'signalingState', {configurable: true, writable: true, value: description.type === 'offer' ? 'have-local-offer' : 'stable'});
        });
        const request = send.mock.calls.map(([command]) => command).find(command => command.type === 'group.call.credentials');
        events.next({version: 3, type: 'group.call.credentials', request_id: request.request_id, payload: {...request.payload, ice_servers: [], ice_expires_at: new Date(Date.now() + 120000).toISOString()}});
        await tick(0);
        const old = [...send.mock.calls].reverse().map(([command]) => command).find(command => command.type === 'group.call.signal' && command.payload.signal.type === 'offer');
        const next = room('group.call.participant.joined', 'active', 'group-1', 1, 2, participants);
        events.next({...next, payload: {...next.payload, ice_expires_at: new Date(Date.now() + 180000).toISOString()}});
        await tick(0);
        expect(peer.setLocalDescription).toHaveBeenCalledWith({type: 'rollback'});
        const offers = () => send.mock.calls.map(([command]) => command).filter(command => command.type === 'group.call.signal' && command.payload.signal.type === 'offer');
        expect(offers()).toHaveLength(2);
        events.next(rejected(old.request_id, 'late'));
        facade.end();
        await tick(30000);
        expect(offers()).toHaveLength(2);
    }));

    it('ignores a delayed answer for offer A after restart offer B and ignores duplicate answers', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        const started = room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-1'}]);
        acceptStarted({...started, payload: {...started.payload, ice_expires_at: new Date(Date.now() + 4000).toISOString()}});
        await tick(3000);
        const peer = peerConnections[0];
        Object.defineProperty(peer, 'signalingState', {configurable: true, writable: true, value: 'stable'});
        vi.spyOn(peer, 'setLocalDescription').mockImplementation(async (description: RTCLocalSessionDescriptionInit) => {
            Object.defineProperty(peer, 'signalingState', {configurable: true, writable: true, value: description.type === 'offer' ? 'have-local-offer' : 'stable'});
        });
        const remote = vi.spyOn(peer, 'setRemoteDescription').mockImplementation(async () => { Object.defineProperty(peer, 'signalingState', {configurable: true, writable: true, value: 'stable'}); });
        const request = send.mock.calls.map(([command]) => command).find(command => command.type === 'group.call.credentials');
        events.next({version: 3, type: 'group.call.credentials', request_id: request.request_id, payload: {...request.payload, ice_servers: [], ice_expires_at: new Date(Date.now() + 120000).toISOString()}});
        await tick(0);
        const first = lastOfferID('peer-1');
        await tick(9000);
        const second = lastOfferID('peer-1');
        expect(first).not.toBe(second);
        const answer = (id: string) => ({version: 3 as const, type: 'group.call.signal' as const, payload: {room_id: 'room-1', generation: 1, from_user_id: 'peer-1', from_device_id: 'peer-1', signal: {type: 'answer' as const, sdp: 'answer', negotiation_id: id}}});
        events.next(answer(first));
        events.next(answer('INVALID'));
        await tick(0);
        expect(remote).not.toHaveBeenCalled();
        expect(facade.state.statusLabel).toContain('Retrying automatically');
        events.next(answer(second));
        await tick(0);
        expect(remote).toHaveBeenCalledTimes(1);
        expect(facade.state.statusLabel).not.toContain('Retrying automatically');
        Object.defineProperty(peer, 'signalingState', {configurable: true, writable: true, value: 'have-local-offer'});
        events.next(answer(second));
        await tick(0);
        expect(remote).toHaveBeenCalledTimes(1);
        facade.end();
    }));

    it('restarts existing peers for newer lifecycle credentials and uses them for newly joined peers', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        const self = {user_id: 'self-1', device_id: 'device-1'};
        const peer = {user_id: 'peer-1', device_id: 'peer-1'};
        const newcomer = {user_id: 'peer-2', device_id: 'peer-2'};
        const started = room('group.call.started', 'active', 'group-1', 1, 1, [self, peer]);
        acceptStarted({...started, payload: {...started.payload, ice_expires_at: new Date(Date.now() + 40000).toISOString()}});
        const newer = room('group.call.participant.joined', 'active', 'group-1', 1, 2, [self, peer, newcomer]);
        const servers = [{urls: ['turn:new.example'], username: 'opaque', credential: 'opaque'}];
        events.next({...newer, payload: {...newer.payload, ice_servers: servers, ice_expires_at: new Date(Date.now() + 120000).toISOString()}});
        await tick(0);
        expect(peerConnections[0].setConfiguration).toHaveBeenCalledWith({iceServers: servers});
        expect(peerConnections[0].restartIce).toHaveBeenCalledTimes(1);
        expect(peerConnections[1].getConfiguration().iceServers).toEqual(servers);
        events.next({...newer, payload: {...newer.payload, state_revision: 3, ice_expires_at: new Date(Date.now() + 40000).toISOString()}});
        await tick(0);
        expect(peerConnections[0].restartIce).toHaveBeenCalledTimes(1);
        expect(facade.state.room?.ice_servers).toEqual(servers);
        facade.end();
    }));

    it('surfaces send failures, retries in bounded cycles after expiry, and clears the warning on recovery', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        const started = room('group.call.started', 'active');
        acceptStarted({...started, payload: {...started.payload, ice_expires_at: new Date(Date.now() + 4000).toISOString()}});
        send.mockImplementation(command => command.type !== 'group.call.credentials');
        const credentials = () => send.mock.calls.map(([command]) => command).filter(command => command.type === 'group.call.credentials');
        const acknowledgeSync = () => {
            const sync = [...send.mock.calls].reverse().map(([command]) => command).find(command => command.type === 'group.call.sync');
            if (sync) events.next(synced(sync.request_id, {}));
        };
        await tick(10000); acknowledgeSync();
        expect(credentials()).toHaveLength(3);
        expect(facade.state.statusLabel).toContain('Retrying automatically');
        expect(track.stop).not.toHaveBeenCalled();
        await tick(10000); acknowledgeSync();
        expect(credentials()).toHaveLength(4);
        await tick(10000); acknowledgeSync();
        await tick(10000); acknowledgeSync();
        expect(credentials()).toHaveLength(4);
        send.mockImplementation(() => true);
        await tick(7000);
        expect(credentials()).toHaveLength(5);
        const request = credentials()[4];
        events.next({version: 3, type: 'group.call.credentials', request_id: request.request_id, payload: {...request.payload, ice_servers: [], ice_expires_at: new Date(Date.now() + 120000).toISOString()}});
        expect(facade.state.statusLabel).not.toContain('Retrying automatically');
        expect(facade.state.phase).toBe('active');
        facade.end();
    }));

    it('retries a rejected renewal and ignores stale replies and teardown timers', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        const started = room('group.call.started', 'active');
        const expiry = new Date(Date.now() + 4000).toISOString();
        acceptStarted({...started, payload: {...started.payload, ice_expires_at: expiry}});
        await tick(3000);
        const commands = () => send.mock.calls.map(([command]) => command).filter(command => command.type === 'group.call.credentials');
        const first = commands()[0];
        events.next(rejected(first.request_id, 'unavailable'));
        expect(facade.state.statusLabel).toContain('Retrying automatically');
        const unchanged = room('group.call.participant.joined', 'active', 'group-1', 1, 2);
        events.next({...unchanged, payload: {...unchanged.payload, ice_expires_at: expiry}});
        await tick(2000);
        expect(commands()).toHaveLength(2);
        events.next({version: 3, type: 'group.call.credentials', request_id: first.request_id, payload: {...first.payload, ice_servers: [], ice_expires_at: new Date(Date.now() + 120000).toISOString()}});
        expect(facade.state.statusLabel).toContain('Retrying automatically');
        facade.end();
        await tick(30000);
        expect(commands()).toHaveLength(2);
    }));

    it('requires a matching private start acknowledgement before adopting a broadcast', async () => {
        await facade.start('group-1', 'self-1');
        const request = sentRequestID('group.call.start');
        const started = room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'self-1', device_id: 'device-1'}]);
        events.next(started);
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.start_accepted', request_id: 'stale', payload: {conversation_id: 'group-1', room_id: started.payload.room_id, generation: 1}});
        expect(facade.state.room).toBeUndefined();
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.start_accepted', request_id: request, payload: {conversation_id: 'group-1', room_id: started.payload.room_id, generation: 1}});
        expect(facade.state.room?.room_id).toBe(started.payload.room_id);
    });

    it('reconciles a dropped terminal event for an observer without acquiring media', fakeAsync(async () => {
        events.next(room('group.call.started', 'ringing', 'group-1', 1, 1, [{user_id: 'peer-1', device_id: 'peer-1'}]));
        await tick(10000);
        const request = sentRequestID('group.call.discover');
        events.next({version: 3, type: 'group.call.discovered', request_id: request, payload: {conversation_id: 'group-1', room: null}});
        expect(facade.state.phase).toBe('ended');
        expect(facade.state.room).toBeUndefined();
        expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
        expect(send.mock.calls.some(([command]) => command.type === 'group.call.join')).toBe(false);
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 2, [{user_id: 'peer-1', device_id: 'peer-1'}]));
        expect(facade.state.phase).toBe('ended');
        await tick(30000);
        expect(send.mock.calls.filter(([command]) => command.type === 'group.call.discover')).toHaveLength(1);
    }));

    it('ignores stale observer discovery after a newer room event and rechecks absence', fakeAsync(async () => {
        const peer = {user_id: 'peer-1', device_id: 'peer-1'};
        events.next(room('group.call.started', 'ringing', 'group-1', 1, 1, [peer]));
        await tick(10000);
        const first = sentRequestID('group.call.discover');
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 2, [peer]));
        events.next({version: 3, type: 'group.call.discovered', request_id: first, payload: {conversation_id: 'group-1', room: null}});
        expect(facade.state.phase).toBe('ringing');
        await tick(10000);
        const second = sentRequestID('group.call.discover', 1);
        events.next({version: 3, type: 'group.call.discovered', request_id: first, payload: {conversation_id: 'group-1', room: null}});
        expect(facade.state.phase).toBe('ringing');
        events.next({version: 3, type: 'group.call.discovered', request_id: second, payload: {conversation_id: 'group-1', room: null}});
        expect(facade.state.phase).toBe('ended');
    }));

    it('keeps observer status unknown on rejection or disconnect and retries with bounded delay', fakeAsync(async () => {
        events.next(room('group.call.started', 'ringing', 'group-1', 1, 1, [{user_id: 'peer-1', device_id: 'peer-1'}]));
        await tick(10000);
        events.next(rejected(sentRequestID('group.call.discover'), 'unavailable'));
        expect(facade.state.statusLabel).toContain('unknown');
        await tick(4999);
        expect(send.mock.calls.filter(([command]) => command.type === 'group.call.discover')).toHaveLength(1);
        await tick(1);
        expect(send.mock.calls.filter(([command]) => command.type === 'group.call.discover')).toHaveLength(2);
        ready.next(false);
        expect(facade.state.phase).toBe('ringing');
        expect(facade.state.statusLabel).toContain('unknown');
        await tick(60000);
        expect(send.mock.calls.filter(([command]) => command.type === 'group.call.discover')).toHaveLength(2);
        ready.next(true);
        await tick(0);
        expect(send.mock.calls.filter(([command]) => command.type === 'group.call.discover')).toHaveLength(3);
        events.next({version: 3, type: 'group.call.discovered', request_id: sentRequestID('group.call.discover', 2), payload: {conversation_id: 'group-1', room: null}});
        expect(facade.state.phase).toBe('ended');
        expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    }));

    it('backs off observer discovery after failed sends and unanswered requests', fakeAsync(async () => {
        events.next(room('group.call.started', 'ringing', 'group-1', 1, 1, [{user_id: 'peer-1', device_id: 'peer-1'}]));
        send.mockImplementation(command => command.type !== 'group.call.discover');
        await tick(10000);
        expect(facade.state.statusLabel).toContain('unknown');
        expect(send.mock.calls.filter(([command]) => command.type === 'group.call.discover')).toHaveLength(1);
        send.mockImplementation(() => true);
        await tick(5000);
        await tick(8000);
        expect(facade.state.phase).toBe('ringing');
        expect(facade.state.statusLabel).toContain('unknown');
        await tick(9999);
        expect(send.mock.calls.filter(([command]) => command.type === 'group.call.discover')).toHaveLength(2);
        await tick(1);
        expect(send.mock.calls.filter(([command]) => command.type === 'group.call.discover')).toHaveLength(3);
        facade.close();
    }));

    it('fences observer discovery across room replacement and teardown', fakeAsync(async () => {
        events.next(room('group.call.started', 'ringing', 'group-1', 1, 1, [{user_id: 'peer-1', device_id: 'peer-1'}]));
        await tick(10000);
        const first = sentRequestID('group.call.discover');
        events.next(room('group.call.ended', 'ended', 'group-1', 1, 2, [{user_id: 'peer-1', device_id: 'peer-1'}]));
        const next = room('group.call.started', 'ringing', 'group-2', 2, 1, [{user_id: 'peer-2', device_id: 'peer-2'}]);
        events.next({...next, payload: {...next.payload, room_id: 'room-2'}});
        events.next({version: 3, type: 'group.call.discovered', request_id: first, payload: {conversation_id: 'group-1', room: null}});
        expect(facade.state.room?.room_id).toBe('room-2');
        await tick(10000);
        expect(send.mock.calls.filter(([command]) => command.type === 'group.call.discover')).toHaveLength(2);
        facade.close();
        await tick(60000);
        expect(send.mock.calls.filter(([command]) => command.type === 'group.call.discover')).toHaveLength(2);
    }));

    it('ignores a stale ended snapshot but accepts a current ended observer snapshot', fakeAsync(async () => {
        const peer = {user_id: 'peer-1', device_id: 'peer-1'};
        events.next(room('group.call.started', 'ringing', 'group-1', 1, 3, [peer]));
        const ended = room('group.call.ended', 'ended', 'group-1', 1, 2, [peer]).payload;
        const {ice_servers: _servers, ice_expires_at: _expiry, ...snapshot} = ended;
        await tick(10000);
        events.next({version: 3, type: 'group.call.discovered', request_id: sentRequestID('group.call.discover'), payload: {conversation_id: 'group-1', room: snapshot}});
        expect(facade.state.phase).toBe('ringing');
        await tick(10000);
        events.next({version: 3, type: 'group.call.discovered', request_id: sentRequestID('group.call.discover', 1), payload: {conversation_id: 'group-1', room: {...snapshot, state_revision: 4}}});
        expect(facade.state.phase).toBe('ended');
    }));

    it('does not let an observer reply terminate a join already requesting media', fakeAsync(async () => {
        const incoming = room('group.call.started', 'ringing', 'group-1', 1, 1, [{user_id: 'peer-1', device_id: 'peer-1'}]);
        events.next(incoming);
        await tick(10000);
        const observerRequest = sentRequestID('group.call.discover');
        let resolveMedia: ((stream: MediaStream) => void) | undefined;
        vi.mocked(navigator.mediaDevices.getUserMedia).mockReturnValue(new Promise(resolve => { resolveMedia = resolve; }));
        const join = facade.join(incoming.payload, 'self-1');
        events.next({version: 3, type: 'group.call.discovered', request_id: observerRequest, payload: {conversation_id: 'group-1', room: null}});
        expect(facade.state.phase).toBe('requesting');
        resolveMedia?.({getTracks: () => [track], getAudioTracks: () => [track]} as unknown as MediaStream);
        await join;
        expect(facade.state.phase).toBe('joining');
        expect(track.stop).not.toHaveBeenCalled();
        facade.close();
    }));

    it('stops an invitation at its deadline without ending or removing the joinable room', fakeAsync(async () => {
        const incoming = room('group.call.started', 'ringing', 'group-1', 1, 1, [{user_id: 'peer-1', device_id: 'peer-1'}]);
        events.next({...incoming, payload: {...incoming.payload, ring_expires_at: new Date(Date.now() + 30000).toISOString()}});
        expect(facade.state.invitationRinging).toBe(true);
        await tick(30000);
        expect(facade.state.invitationRinging).toBe(false);
        expect(facade.state.room?.room_id).toBe('room-1');
        expect(facade.state.phase).toBe('ringing');
        expect(send.mock.calls.some(([command]) => command.type === 'group.call.end')).toBe(false);
    }));

    it('prompts the acknowledged solo starter once, without automatically ending', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        const started = room('group.call.started', 'ringing');
        acceptStarted({...started, payload: {...started.payload, ring_expires_at: new Date(Date.now() + 30000).toISOString()}});
        await tick(30000);
        expect(facade.state.soloPrompt).toBe(true);
        expect(send.mock.calls.some(([command]) => command.type === 'group.call.end')).toBe(false);
        facade.stayInSoloCall();
        expect(facade.state.soloPrompt).toBe(false);
        await tick(1000);
        expect(facade.state.soloPrompt).toBe(false);
    }));

    it('shows the current participant count throughout the starter invitation', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        const started = room('group.call.started', 'ringing');
        acceptStarted({...started, payload: {...started.payload, ring_expires_at: new Date(Date.now() + 30000).toISOString()}});
        expect(facade.state.statusLabel).toContain('1 participant in the group call.');
        expect(facade.state.invitationRinging).toBe(true);
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 2, [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-1'}]));
        expect(facade.state.statusLabel).toContain('2 participants in the group call.');
        await tick(30000);
        expect(facade.state.statusLabel).toContain('2 participants in the group call.');
        facade.end();
    }));

    it('dismisses the starter prompt when a peer joins', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        const started = room('group.call.started', 'ringing');
        acceptStarted({...started, payload: {...started.payload, ring_expires_at: new Date(Date.now() + 30000).toISOString()}});
        await tick(30000);
        expect(facade.state.soloPrompt).toBe(true);
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 2, [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-1'}]));
        expect(facade.state.soloPrompt).toBe(false);
    }));

    it('does not prompt after a peer joined before the deadline, even if they leave', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        const started = room('group.call.started', 'ringing');
        acceptStarted({...started, payload: {...started.payload, ring_expires_at: new Date(Date.now() + 30000).toISOString()}});
        const self = {user_id: 'self-1', device_id: 'device-1'};
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 2, [self, {user_id: 'peer-1', device_id: 'peer-1'}]));
        events.next(room('group.call.participant.left', 'active', 'group-1', 1, 3, [self]));
        await tick(30000);
        expect(facade.state.soloPrompt).toBe(false);
    }));

    it('does not let an old invitation deadline change a later room', fakeAsync(async () => {
        const incoming = room('group.call.started', 'ringing', 'group-1', 1, 1, [{user_id: 'peer-1', device_id: 'peer-1'}]);
        events.next({...incoming, payload: {...incoming.payload, ring_expires_at: new Date(Date.now() + 30000).toISOString()}});
        facade.abort('group-1');
        const later = room('group.call.started', 'ringing', 'group-2', 2, 1, [{user_id: 'peer-2', device_id: 'peer-2'}]);
        events.next({...later, payload: {...later.payload, room_id: 'room-2', ring_expires_at: new Date(Date.now() + 60000).toISOString()}});
        await tick(30000);
        expect(facade.state.room?.room_id).toBe('room-2');
        expect(facade.state.invitationRinging).toBe(true);
        expect(facade.state.soloPrompt).toBeFalsy();
    }));

    it('does not adopt sibling room events or a late acknowledgement after cancellation', async () => {
        await facade.start('group-1', 'self-1');
        const request = sentRequestID('group.call.start');
        const sibling = room('group.call.started', 'active');
        events.next(sibling);
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 2));
        expect(facade.state.room).toBeUndefined();
        facade.abort('group-1');
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.start_accepted', request_id: request, payload: {conversation_id: 'group-1', room_id: sibling.payload.room_id, generation: 1}});
        events.next(sibling);
        expect(facade.state.room).toBeUndefined();
        expect(track.stop).toHaveBeenCalled();
    });

    it('waits for the correlated permit before capture and sends it with start', async () => {
        send.mockReturnValue(true);
        const start = facade.start('group-1', 'self-1');
        const request = sentRequestID('group.call.prepare_start');
        expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.start_prepared', request_id: 'stale', payload: {conversation_id: 'group-1', attempt_id: 'f9ad4b72-67a1-40fb-b307-428aa956d762', expires_at: '2099-01-01T00:00:00Z'}});
        expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.start_prepared', request_id: request, payload: {conversation_id: 'group-1', attempt_id: 'f9ad4b72-67a1-40fb-b307-428aa956d762', expires_at: '2099-01-01T00:00:00Z'}});
        await start;
        expect(send).toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.start', payload: {conversation_id: 'group-1', attempt_id: 'f9ad4b72-67a1-40fb-b307-428aa956d762'}}));
    });

    it('cancels timed-out starts idempotently and blocks new attempts until the matching acknowledgement', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        await tick(8000);
        expect(track.stop).toHaveBeenCalled();
        const cancellation = send.mock.calls.find(([event]) => event.type === 'group.call.cancel_start')?.[0];
        expect(cancellation).toBeDefined();
        await tick(8000);
        expect(send.mock.calls.filter(([event]) => event.type === 'group.call.cancel_start').map(([event]) => event)).toEqual([cancellation, cancellation]);
        await facade.start('group-2', 'self-1');
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.prepare_start', payload: {conversation_id: 'group-2'}}));
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.start_cancelled', request_id: 'stale', payload: {...cancellation.payload, outcome: 'confirmed'}});
        await facade.start('group-2', 'self-1');
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.prepare_start', payload: {conversation_id: 'group-2'}}));
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.start_cancelled', request_id: cancellation.request_id, payload: {...cancellation.payload, outcome: 'confirmed'}});
        await facade.start('group-2', 'self-1');
        expect(send).toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.prepare_start', payload: {conversation_id: 'group-2'}}));
    }));

    it('fences a late preparation after timeout without opening the microphone', fakeAsync(async () => {
        send.mockReturnValue(true);
        const starting = facade.start('group-1', 'self-1');
        const request = sentRequestID('group.call.prepare_start');
        await tick(8000);
        await starting;
        expect(facade.state.phase).toBe('error');
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.start_prepared', request_id: request, payload: {conversation_id: 'group-1', attempt_id: 'f9ad4b72-67a1-40fb-b307-428aa956d762', expires_at: '2099-01-01T00:00:00Z'}});
        expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.cancel_start', payload: {conversation_id: 'group-1', attempt_id: 'f9ad4b72-67a1-40fb-b307-428aa956d762'}}));
    }));

    it('bounds an unanswered preparation and allows retry after its retention expires', fakeAsync(async () => {
        send.mockReturnValue(true);
        const starting = facade.start('group-1', 'self-1');
        await tick(8000);
        await starting;
        void facade.start('group-2', 'self-1');
        expect(send.mock.calls.filter(([event]) => event.type === 'group.call.prepare_start')).toHaveLength(1);
        await tick(40000);
        void facade.start('group-2', 'self-1');
        expect(send.mock.calls.filter(([event]) => event.type === 'group.call.prepare_start')).toHaveLength(2);
        facade.close();
    }));

    it('times out pending microphone permission and stops a late stream', fakeAsync(async () => {
        let resolveMedia: (stream: MediaStream) => void = () => undefined;
        vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementationOnce(() => new Promise(resolve => resolveMedia = resolve));
        const starting = facade.start('group-1', 'self-1');
        await tick();
        await tick(8000);
        expect(send).toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.cancel_start'}));
        resolveMedia({getTracks: () => [track], getAudioTracks: () => [track]} as unknown as MediaStream);
        await starting;
        expect(track.stop).toHaveBeenCalled();
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.start'}));
    }));

    it.each(['confirmed', 'retired'] as const)('retries after reconnect and permits recovery only on %s', outcome => fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        await tick(8000);
        const first = send.mock.calls.find(([event]) => event.type === 'group.call.cancel_start')?.[0];
        ready.next(false);
        ready.next(true);
        const retries = send.mock.calls.filter(([event]) => event.type === 'group.call.cancel_start').map(([event]) => event);
        expect(retries).toEqual([first, first]);
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.start_cancelled', request_id: first.request_id, payload: {...first.payload, outcome: 'unknown'}});
        await facade.start('group-2', 'self-1');
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.prepare_start', payload: {conversation_id: 'group-2'}}));
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.start_cancelled', request_id: first.request_id, payload: {...first.payload, outcome}});
        await facade.start('group-2', 'self-1');
        expect(send).toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.prepare_start', payload: {conversation_id: 'group-2'}}));
    })());

    it('bounds denial retries and requires a user retry with fresh correlation', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        await tick(8000);
        const first = send.mock.calls.find(([event]) => event.type === 'group.call.cancel_start')?.[0];
        events.next(rejected(first.request_id, 'call not allowed'));
        await tick(30000);
        expect(send.mock.calls.filter(([event]) => event.type === 'group.call.cancel_start')).toHaveLength(4);
        await tick(60000);
        expect(send.mock.calls.filter(([event]) => event.type === 'group.call.cancel_start')).toHaveLength(4);
        expect(facade.state.errorLabel).toContain('could not be verified');
        await facade.start('group-2', 'self-1');
        const last = send.mock.calls.filter(([event]) => event.type === 'group.call.cancel_start').at(-1)?.[0];
        expect(last.request_id).not.toBe(first.request_id);
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.start_cancelled', request_id: first.request_id, payload: {...first.payload, outcome: 'confirmed'}});
        await facade.start('group-2', 'self-1');
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.prepare_start', payload: {conversation_id: 'group-2'}}));
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.start_cancelled', request_id: last.request_id, payload: {...last.payload, outcome: 'retired'}});
        await facade.start('group-2', 'self-1');
        expect(send).toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.prepare_start', payload: {conversation_id: 'group-2'}}));
    }));

    it('cancels an expired permit and clears retry timers on close', fakeAsync(async () => {
        send.mockReturnValue(true);
        const starting = facade.start('group-1', 'self-1');
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.start_prepared', request_id: sentRequestID('group.call.prepare_start'), payload: {conversation_id: 'group-1', attempt_id: 'f9ad4b72-67a1-40fb-b307-428aa956d762', expires_at: '2000-01-01T00:00:00Z'}});
        await starting;
        expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.cancel_start'}));
        facade.close();
        const count = send.mock.calls.length;
        await tick(60000);
        expect(send.mock.calls).toHaveLength(count);
    }));

    it.each([['leave', 0], ['end', 0], ['leave', 5000], ['end', 5000]] as const)('checks pending %s before a new attempt and handles rejection after %i ms', (action, delay) => fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-a', device_id: 'device-a'}]));
        facade[action]();
        const control = sentGroupRequest(`group.call.${action}`);
        await tick(delay);
        facade.discoverAndStart('group-2', 'self-1');
        const sync = sentRequestID('group.call.sync');
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.discover'}));
        events.next(rejected(control, 'unavailable'));
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', request_id: sync, payload: {room_id: 'room-1', generation: 1, status: 'ended', ownership_status: 'owned_elsewhere'}});
        await facade.start('group-2', 'self-1');
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.start', payload: {conversation_id: 'group-2'}}));
    })());

    it.each(['leave', 'end'] as const)('permits a new attempt after confirming successful %s without an acknowledgement', async action => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-a', device_id: 'device-a'}]));
        facade[action]();
        facade.discoverAndStart('group-2', 'self-1');
        expect(send).toHaveBeenLastCalledWith(expect.objectContaining({type: 'group.call.sync', payload: expect.objectContaining({ownership_status: true})}));
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', request_id: sentRequestID('group.call.sync'), payload: {room_id: 'room-1', generation: 1, status: 'ended', ownership_status: 'participant_absent'}});
        expect(send).toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.discover', payload: {conversation_id: 'group-2'}}));
    });

    it.each(['leave', 'end'] as const)('retries dropped %s in an owned solo ringing room and completes the deferred attempt', async action => {
        const self = {user_id: 'self-1', device_id: 'device-1'};
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'ringing', 'group-1', 1, 1, [self]));
        facade[action]();
        facade.discoverAndStart('group-2', 'self-1');
        const sync = sentRequestID('group.call.sync');
        events.next(synced('stale-request', {status: 'ringing', ownership_status: 'active', participants: [self]}));
        expect(send.mock.calls.filter(([command]) => command.type === `group.call.${action}`)).toHaveLength(1);
        events.next(synced(sync, {status: 'ringing', ownership_status: 'active', participants: [self]}));
        expect(send.mock.calls.filter(([command]) => command.type === `group.call.${action}`)).toHaveLength(2);
        const followup = sentRequestID('group.call.sync', 1);
        events.next(absentSync(sync));
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.discover'}));
        events.next(absentSync(followup));
        expect(send).toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.discover', payload: {conversation_id: 'group-2'}}));
    });

    it.each(['owned_elsewhere', 'participant_absent'] as const)('handles %s after dropped solo ringing leave', async ownership => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'ringing'));
        facade.leave();
        facade.discoverAndStart('group-2', 'self-1');
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', request_id: sentRequestID('group.call.sync'), payload: {room_id: 'room-1', generation: 1, status: 'ended', ownership_status: ownership}});
        expect(send.mock.calls.filter(([command]) => command.type === 'group.call.leave')).toHaveLength(1);
        expect(send.mock.calls.filter(([command]) => command.type === 'group.call.discover')).toHaveLength(ownership === 'participant_absent' ? 1 : 0);
    });

    it.each(['conversation', 'revision', 'device', 'room', 'generation'] as const)('does not retry a ringing leave for mismatched %s', async mismatch => {
        const self = {user_id: 'self-1', device_id: 'device-1'};
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'ringing', 'group-1', 1, 2, [self]));
        facade.leave();
        facade.discoverAndStart('group-2', 'self-1');
        const changes: Partial<GroupCallActiveSyncPayload> = mismatch === 'conversation' ? {conversation_id: 'other'} :
            mismatch === 'revision' ? {state_revision: 1} : mismatch === 'device' ? {participants: [{...self, device_id: 'other'}]} :
            mismatch === 'room' ? {room_id: 'other'} : {generation: 2};
        events.next(synced(sentRequestID('group.call.sync'), {status: 'ringing', ownership_status: 'active', state_revision: 2, participants: [self], ...changes}));
        expect(send.mock.calls.filter(([command]) => command.type === 'group.call.leave')).toHaveLength(1);
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.discover'}));
    });

    it('discovers the original room after a deferred rejoin and does not start a replacement', async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-a', device_id: 'device-a'}]));
        facade.leave();
        facade.rejoin('self-1');
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', request_id: sentRequestID('group.call.sync'), payload: {room_id: 'room-1', generation: 1, status: 'ended', ownership_status: 'participant_absent'}});
        expect(send).toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.discover', payload: {conversation_id: 'group-1'}}));
        const discovery = sentRequestID('group.call.discover');
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.discovered', request_id: discovery, payload: {conversation_id: 'group-1', room: null}});
        expect(send.mock.calls.filter(([command]) => command.type === 'group.call.start')).toHaveLength(1);
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.join'}));
    });

    it.each(['disconnect', 'conversation'] as const)('cancels a deferred attempt on %s', async reason => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-a', device_id: 'device-a'}]));
        facade.leave();
        facade.discoverAndStart('group-2', 'self-1');
        const sync = sentRequestID('group.call.sync');
        if (reason === 'disconnect') { ready.next(false); ready.next(true); }
        else facade.cancelDeferredIntentForConversation('group-3');
        events.next(absentSync(sync));
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.discover'}));
        expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    });

    it.each(['leave', 'end'] as const)('keeps a pending %s blocked after sync timeout and late rejection', action => fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-a', device_id: 'device-a'}]));
        facade[action]();
        const control = sentGroupRequest(`group.call.${action}`);
        facade.discoverAndStart('group-2', 'self-1');
        const sync = sentRequestID('group.call.sync');
        await tick(8000);
        events.next(rejected(control, 'unavailable'));
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', request_id: sync, payload: {room_id: 'room-1', generation: 1, status: 'ended', ownership_status: 'participant_absent'}});
        await facade.start('group-2', 'self-1');
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.start', payload: {conversation_id: 'group-2'}}));
    })());

    it('retains the server support reference from room events through the terminal notice', async () => {
        await facade.start('group-1', 'self-1');
        const started = room('group.call.started', 'active');
        acceptStarted({...started, payload: {...started.payload, support_ref: 'group-ref-1'}});
        expect(facade.state.supportRef).toBe('group-ref-1');
        const ended = room('group.call.ended', 'ended');
        events.next({...ended, payload: {...ended.payload, support_ref: 'group-ref-1'}});
        expect(facade.state.phase).toBe('ended');
        expect(facade.state.supportRef).toBe('group-ref-1');
    });

    it.each(['leave', 'end'] as const)('retries an uncertain rejected %s after reconnect using correlated ownership sync', action => fakeAsync(async () => {
        const self = {user_id: 'self-1', device_id: 'device-1'};
        const peer = {user_id: 'peer-a', device_id: 'device-a'};
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [self, peer]));
        facade[action]();
        events.next(rejected(sentGroupRequest(`group.call.${action}`), 'unavailable'));
        const first = sentRequestID('group.call.sync');
        await tick(8000);
        ready.next(false);
        ready.next(true);
        facade.discoverAndStart('group-2', 'self-1');
        const retry = sentRequestID('group.call.sync', 1);
        expect(retry).not.toBe(first);
        expect(send).toHaveBeenLastCalledWith(expect.objectContaining({type: 'group.call.sync', payload: expect.objectContaining({ownership_status: true})}));
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', request_id: first, payload: {room_id: 'room-1', generation: 1, status: 'ended', ownership_status: 'participant_absent'}});
        await facade.start('group-2', 'self-1');
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.start', payload: {conversation_id: 'group-2'}}));
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', request_id: retry, payload: {room_id: 'room-1', generation: 1, status: 'ended', ownership_status: 'participant_absent'}});
        facade.discoverAndStart('group-2', 'self-1');
        expect(send).toHaveBeenLastCalledWith(expect.objectContaining({type: 'group.call.discover'}));
    })());

    it.each(['join'] as const)('stops capture after a dropped %s acknowledgement and verifies active ownership before leaving', operation => fakeAsync(async () => {
        void facade.join(room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'peer-1', device_id: 'peer-device'}]).payload, 'self-1');
        await tick();
        await tick(8000);
        expect(track.stop).toHaveBeenCalled();
        expect(facade.state.phase).toBe('error');
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.leave'}));
        const check = sentRequestID('group.call.sync');
        events.next(synced(check, {participants: [{user_id: 'self-1', device_id: 'device-1'}]}));
        expect(send).toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.leave'}));
        const confirm = sentRequestID('group.call.sync', 1);
        events.next(absentSync(confirm));
        await facade.start('group-2', 'self-1');
        expect(send).toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.start', payload: expect.objectContaining({conversation_id: 'group-2'})}));
    })());

    it.each(['join'] as const)('blocks new capture when timed-out %s ownership is unavailable and retries safely', operation => fakeAsync(async () => {
        void facade.join(room('group.call.started', 'active').payload, 'self-1');
        await tick();
        await tick(8000);
        expect(track.stop).toHaveBeenCalled();
        const check = sentRequestID('group.call.sync');
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', request_id: check, payload: {room_id: 'room-1', generation: 1, status: 'ended', ownership_status: 'room_unavailable'}});
        facade.discoverAndStart('group-2', 'self-1');
        const retry = sentRequestID('group.call.sync', 1);
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.leave'}));
        events.next(absentSync(check));
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.discover', payload: {conversation_id: 'group-2'}}));
        events.next(absentSync(retry));
        expect(send).toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.discover', payload: {conversation_id: 'group-2'}}));
    })());

    it('keeps a timed-out start blocked when discovery has no room and ignores a late acknowledgement', fakeAsync(async () => {
        void facade.start('group-1', 'self-1');
        await tick();
        await tick(8000);
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.discovered', request_id: sentRequestID('group.call.discover'), payload: {conversation_id: 'group-1', room: null}});
        events.next(room('group.call.started', 'active'));
        facade.end();
        await facade.start('group-2', 'self-1');
        expect(track.stop).toHaveBeenCalled();
        expect(facade.state.phase).toBe('error');
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.start', payload: {conversation_id: 'group-2'}}));
    }));

    it('confirms a timed-out join is absent before permitting another call', fakeAsync(async () => {
        void facade.join(room('group.call.started', 'active').payload, 'self-1');
        await tick();
        await tick(8000);
        events.next(absentSync(sentRequestID('group.call.sync')));
        await facade.start('group-2', 'self-1');
        expect(track.stop).toHaveBeenCalled();
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.leave'}));
        expect(send).toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.start', payload: expect.objectContaining({conversation_id: 'group-2'})}));
    }));

    it.each(['leave', 'end'] as const)('keeps a rejected %s blocked when retry ownership is elsewhere', action => fakeAsync(async () => {
        const self = {user_id: 'self-1', device_id: 'device-1'};
        const peer = {user_id: 'peer-a', device_id: 'device-a'};
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [self, peer]));
        facade[action]();
        events.next(rejected(sentGroupRequest(`group.call.${action}`), 'unavailable'));
        await tick(8000);
        facade.discoverAndStart('group-2', 'self-1');
        const retry = sentRequestID('group.call.sync', 1);
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', request_id: retry, payload: {room_id: 'room-1', generation: 1, status: 'ended', ownership_status: 'owned_elsewhere'}});
        await facade.start('group-2', 'self-1');
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.start', payload: {conversation_id: 'group-2'}}));
        facade.discoverAndStart('group-2', 'self-1');
        expect(sentRequestID('group.call.sync', 2)).not.toBe(retry);
    })());

    it('leaves an established room on local peer setup failure while the socket remains ready', async () => {
        const self = {user_id: 'self-1', device_id: 'device-1'};
        const peer = {user_id: 'peer-a', device_id: 'device-a'};
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [self]));
        expect(facade.state.phase).toBe('active');
        Object.defineProperty(window, 'RTCPeerConnection', {configurable: true, value: class { constructor() { throw new Error('unsupported'); } }});
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 2, [self, peer]));
        const leaves = send.mock.calls.map(call => call[0]).filter(command => command.type === 'group.call.leave');
        expect(leaves).toHaveLength(1);
        expect(leaves[0].payload).toEqual({conversation_id: 'group-1', room_id: 'room-1', generation: 1});
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.end'}));
        expect(track.stop).toHaveBeenCalled();
        expect(facade.state.phase).toBe('error');
    });

    it.each(['send failure', 'rejection', 'sync rejection', 'still present'] as const)('blocks new calls when failure cleanup is unverified: %s', async outcome => {
        const self = {user_id: 'self-1', device_id: 'device-1'};
        const peer = {user_id: 'peer-a', device_id: 'device-a'};
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [self]));
        if (outcome === 'send failure') send.mockImplementation(event => event.type !== 'group.call.leave');
        Object.defineProperty(window, 'RTCPeerConnection', {configurable: true, value: class { constructor() { throw new Error('unsupported'); } }});
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 2, [self, peer]));
        if (outcome === 'rejection') events.next(rejected(sentGroupRequest('group.call.leave'), 'call unavailable'));
        if (outcome === 'sync rejection') events.next(rejected(sentRequestID('group.call.sync'), 'sync unavailable'));
        if (outcome === 'still present') events.next(synced(sentRequestID('group.call.sync'), {state_revision: 2, participants: [self, peer]}));
        expect(facade.state.errorLabel).toContain('could not be verified');
        const count = send.mock.calls.length;
        await facade.start('group-2', 'self-1');
        expect(send).toHaveBeenCalledTimes(count);
    });

    it('confirms cleanup before allowing another call and ignores a delayed cleanup reply', fakeAsync(async () => {
        const self = {user_id: 'self-1', device_id: 'device-1'};
        const peer = {user_id: 'peer-a', device_id: 'device-a'};
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [self]));
        Object.defineProperty(window, 'RTCPeerConnection', {configurable: true, value: class { constructor() { throw new Error('unsupported'); } }});
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 2, [self, peer]));
        const leaveID = sentGroupRequest('group.call.leave');
        const syncID = sentRequestID('group.call.sync');
        await facade.start('group-2', 'self-1');
        expect(send.mock.calls.filter(([event]) => event.type === 'group.call.start')).toHaveLength(1);
        events.next(absentSync(syncID));
        await facade.start('group-2', 'self-1');
        expect(send.mock.calls.filter(([event]) => event.type === 'group.call.start')).toHaveLength(2);
        events.next(rejected(leaveID, 'late rejection'));
        events.next(synced(syncID, {state_revision: 4, participants: [self, peer]}));
        expect(facade.state.phase).toBe('ringing');
    }));

    it.each(['legacy', 'room_unavailable', 'owned_elsewhere', 'active'] as const)('keeps cleanup blocked for %s ownership', async ownership => {
        const self = {user_id: 'self-1', device_id: 'device-1'};
        const peer = {user_id: 'peer-a', device_id: 'device-a'};
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [self]));
        Object.defineProperty(window, 'RTCPeerConnection', {configurable: true, value: class { constructor() { throw new Error('unsupported'); } }});
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 2, [self, peer]));
        const syncID = sentRequestID('group.call.sync');
        expect(send).toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.sync', payload: expect.objectContaining({ownership_status: true})}));
        if (ownership === 'active') events.next(synced(syncID, {ownership_status: 'active', participants: [self, peer], state_revision: 3}));
        else events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', request_id: syncID, payload: {room_id: 'room-1', generation: 1, status: 'ended', ...(ownership === 'legacy' ? {} : {ownership_status: ownership})}} as never);
        await facade.start('group-2', 'self-1');
        expect(send.mock.calls.filter(([event]) => event.type === 'group.call.start')).toHaveLength(1);
        if (ownership === 'owned_elsewhere') expect(facade.state.errorLabel).toContain('another connection');
    });

    it.each(['unsent', 'rejected'] as const)('retries %s cleanup only after an explicit ownership check and confirms absence', async outcome => {
        const self = {user_id: 'self-1', device_id: 'device-1'};
        const peer = {user_id: 'peer-a', device_id: 'device-a'};
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [self]));
        if (outcome === 'unsent') send.mockImplementation(event => event.type !== 'group.call.leave');
        Object.defineProperty(window, 'RTCPeerConnection', {configurable: true, value: class { constructor() { throw new Error('unsupported'); } }});
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 2, [self, peer]));
        if (outcome === 'rejected') events.next(rejected(sentGroupRequest('group.call.leave'), 'unavailable'));
        send.mockReturnValue(true);
        facade.discoverAndStart('group-2', 'self-1');
        const sync = sentRequestID('group.call.sync', outcome === 'unsent' ? 0 : 1);
        events.next(synced(sync, {ownership_status: 'active', participants: [self, peer], state_revision: 3}));
        expect(send.mock.calls.filter(([event]) => event.type === 'group.call.leave')).toHaveLength(2);
        const followup = sentRequestID('group.call.sync', outcome === 'unsent' ? 1 : 2);
        events.next(absentSync(sync));
        facade.discoverAndStart('group-2', 'self-1');
        expect(send.mock.calls.filter(([event]) => event.type === 'group.call.discover')).toHaveLength(0);
        events.next(absentSync(followup));
        facade.discoverAndStart('group-2', 'self-1');
        expect(send.mock.calls.filter(([event]) => event.type === 'group.call.discover')).toHaveLength(1);
    });

    it('never retries a leave when explicit ownership check reports a sibling connection', async () => {
        const self = {user_id: 'self-1', device_id: 'device-1'};
        const peer = {user_id: 'peer-a', device_id: 'device-a'};
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [self]));
        Object.defineProperty(window, 'RTCPeerConnection', {configurable: true, value: class { constructor() { throw new Error('unsupported'); } }});
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 2, [self, peer]));
        events.next(rejected(sentRequestID('group.call.sync'), 'unavailable'));
        facade.discoverAndStart('group-2', 'self-1');
        const sync = sentRequestID('group.call.sync', 1);
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', request_id: sync, payload: {room_id: 'room-1', generation: 1, status: 'ended', ownership_status: 'owned_elsewhere'}});
        expect(send.mock.calls.filter(([event]) => event.type === 'group.call.leave')).toHaveLength(1);
    });

    it('bounds cleanup to one leave per explicit attempt even if the follow-up remains active', async () => {
        const self = {user_id: 'self-1', device_id: 'device-1'};
        const peer = {user_id: 'peer-a', device_id: 'device-a'};
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [self]));
        Object.defineProperty(window, 'RTCPeerConnection', {configurable: true, value: class { constructor() { throw new Error('unsupported'); } }});
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 2, [self, peer]));
        events.next(rejected(sentRequestID('group.call.sync'), 'unavailable'));
        facade.discoverAndStart('group-2', 'self-1');
        events.next(synced(sentRequestID('group.call.sync', 1), {ownership_status: 'active', participants: [self, peer], state_revision: 3}));
        events.next(synced(sentRequestID('group.call.sync', 2), {ownership_status: 'active', participants: [self, peer], state_revision: 3}));
        expect(send.mock.calls.filter(([event]) => event.type === 'group.call.leave')).toHaveLength(2);
        expect(facade.state.phase).toBe('error');
        expect(facade.state.errorLabel).toContain('could not be verified');
    });

    it('keeps cleanup unverified after a sync timeout and ignores the late reply', fakeAsync(async () => {
        const self = {user_id: 'self-1', device_id: 'device-1'};
        const peer = {user_id: 'peer-a', device_id: 'device-a'};
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [self]));
        Object.defineProperty(window, 'RTCPeerConnection', {configurable: true, value: class { constructor() { throw new Error('unsupported'); } }});
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 2, [self, peer]));
        const syncID = sentRequestID('group.call.sync');
        await tick(8_000);
        expect(facade.state.errorLabel).toContain('could not be verified');
        events.next(synced(syncID, {state_revision: 3, participants: [peer]}));
        await facade.start('group-2', 'self-1');
        expect(send.mock.calls.filter(([event]) => event.type === 'group.call.start')).toHaveLength(1);
    }));

    it.each(['owned_elsewhere', 'rejection', 'timeout'] as const)('rechecks cleanup on a new call attempt after %s', outcome => fakeAsync(async () => {
        const self = {user_id: 'self-1', device_id: 'device-1'};
        const peer = {user_id: 'peer-a', device_id: 'device-a'};
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [self]));
        Object.defineProperty(window, 'RTCPeerConnection', {configurable: true, value: class { constructor() { throw new Error('unsupported'); } }});
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 2, [self, peer]));
        const originalFailure = facade.state.errorLabel;
        expect(originalFailure).toBeTruthy();
        const first = sentRequestID('group.call.sync');
        if (outcome === 'owned_elsewhere') events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', request_id: first, payload: {room_id: 'room-1', generation: 1, status: 'ended', ownership_status: 'owned_elsewhere'}});
        else if (outcome === 'rejection') events.next(rejected(first, 'sync unavailable'));
        else await tick(8_000);
        facade.discoverAndStart('group-2', 'self-1');
        const retry = sentRequestID('group.call.sync', 1);
        expect(retry).not.toBe(first);
        events.next(absentSync(first));
        facade.discoverAndStart('group-2', 'self-1');
        expect(send.mock.calls.filter(([event]) => event.type === 'group.call.discover')).toHaveLength(0);
        events.next(absentSync(retry));
        expect(facade.state.statusLabel).toContain('Checking for an active group call');
        expect(send.mock.calls.filter(([event]) => event.type === 'group.call.discover')).toHaveLength(1);
    })());

    it('does not accept an old cleanup snapshot after the socket disconnects', async () => {
        const self = {user_id: 'self-1', device_id: 'device-1'};
        const peer = {user_id: 'peer-a', device_id: 'device-a'};
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [self]));
        Object.defineProperty(window, 'RTCPeerConnection', {configurable: true, value: class { constructor() { throw new Error('unsupported'); } }});
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 2, [self, peer]));
        const syncID = sentRequestID('group.call.sync');
        ready.next(false);
        ready.next(true);
        events.next(absentSync(syncID));
        await facade.start('group-2', 'self-1');
        expect(send.mock.calls.filter(([event]) => event.type === 'group.call.start')).toHaveLength(1);
        expect(facade.state.errorLabel).toContain('could not be verified');
        const retryID = sentRequestID('group.call.sync', 1);
        expect(retryID).not.toBe(syncID);
        events.next(absentSync(retryID));
        await facade.start('group-2', 'self-1');
        expect(send.mock.calls.filter(([event]) => event.type === 'group.call.start')).toHaveLength(2);
    });

    it('keeps cleanup retryable when a correlated snapshot names the wrong room', async () => {
        const self = {user_id: 'self-1', device_id: 'device-1'};
        const peer = {user_id: 'peer-a', device_id: 'device-a'};
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [self]));
        Object.defineProperty(window, 'RTCPeerConnection', {configurable: true, value: class { constructor() { throw new Error('unsupported'); } }});
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 2, [self, peer]));
        const first = sentRequestID('group.call.sync');
        events.next({...absentSync(first), payload: {...absentSync(first).payload, room_id: 'other-room'}});
        facade.discoverAndStart('group-2', 'self-1');
        const retry = sentRequestID('group.call.sync', 1);
        expect(retry).not.toBe(first);
        expect(send.mock.calls.filter(([event]) => event.type === 'group.call.discover')).toHaveLength(0);
        events.next(absentSync(retry));
        facade.discoverAndStart('group-2', 'self-1');
        expect(send.mock.calls.filter(([event]) => event.type === 'group.call.discover')).toHaveLength(1);
    });

    it('reconciles timed-out cleanup on reconnect without resending leave', fakeAsync(async () => {
        const self = {user_id: 'self-1', device_id: 'device-1'};
        const peer = {user_id: 'peer-a', device_id: 'device-a'};
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [self]));
        Object.defineProperty(window, 'RTCPeerConnection', {configurable: true, value: class { constructor() { throw new Error('unsupported'); } }});
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 2, [self, peer]));
        await tick(8_000);
        ready.next(false);
        ready.next(true);
        expect(send.mock.calls.filter(([event]) => event.type === 'group.call.leave')).toHaveLength(1);
        const retryID = sentRequestID('group.call.sync', 1);
        events.next(absentSync(retryID));
        await facade.start('group-2', 'self-1');
        expect(send.mock.calls.filter(([event]) => event.type === 'group.call.start')).toHaveLength(2);
    }));

    it('joins a peer room started during discovery exactly once', async () => {
        facade.discoverAndStart('group-1', 'self-1');
        const discovery = sentRequestID('group.call.discover');
        const started = room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'peer-1', device_id: 'peer-device'}]);
        events.next(started);
        await flush();
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.discovered', request_id: discovery, payload: {conversation_id: 'group-1', room: started.payload}});
        expect(send.mock.calls.filter(([event]) => event.type === 'group.call.join')).toHaveLength(1);
    });

    it('does not join itself when a room started during discovery already contains self', async () => {
        facade.discoverAndStart('group-1', 'self-1');
        events.next(room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'self-1', device_id: 'device-1'}]));
        await Promise.resolve();
        expect(send.mock.calls.filter(([event]) => event.type === 'group.call.join')).toHaveLength(0);
    });

    it.each(['addTrack', 'addTransceiver'] as const)('closes a partially constructed peer when %s throws', async method => {
        const self = {user_id: 'self-1', device_id: 'device-1'};
        const peer = {user_id: 'peer-a', device_id: 'device-a'};
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [self]));
        const close = vi.fn();
        Object.defineProperty(window, 'RTCPeerConnection', {configurable: true, value: class {
            close = close;
            addTrack(): RTCRtpSender { if (method === 'addTrack') throw new Error('failed'); return {} as RTCRtpSender; }
            addTransceiver(): RTCRtpTransceiver { throw new Error('failed'); }
        }});
        const joined = room('group.call.participant.joined', 'active', 'group-1', 1, 2, [self, peer]);
        events.next({...joined, payload: {...joined.payload, presenter: peer}});
        expect(close).toHaveBeenCalledOnce();
        expect(facade.state.phase).toBe('error');
    });

    it('ignores unrelated and stale full terminal snapshots without changing the active room or support reference', async () => {
        await facade.start('group-1', 'self-1');
        const started = room('group.call.started', 'active', 'group-1', 1, 5);
        acceptStarted({...started, payload: {...started.payload, support_ref: 'current-ref'}});
        const ended = room('group.call.ended', 'ended', 'group-1', 1, 6);
        events.next({...ended, payload: {...ended.payload, room_id: 'old-room', support_ref: 'old-ref'}});
        events.next({...ended, payload: {...ended.payload, state_revision: 5, support_ref: 'stale-ref'}});
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.ended', payload: {room_id: 'old-room', generation: 1, status: 'ended', state_revision: 6, support_ref: 'old-minimal-ref'}});
        expect(facade.state.phase).toBe('active');
        expect(facade.state.room?.room_id).toBe('room-1');
        expect(facade.state.supportRef).toBe('current-ref');
        expect(track.stop).not.toHaveBeenCalled();
        events.next({...ended, payload: {...ended.payload, support_ref: 'terminal-ref'}});
        expect(facade.state.phase).toBe('ended');
        expect(facade.state.supportRef).toBe('terminal-ref');
        expect(track.stop).toHaveBeenCalled();
    });

    it('ignores a microphone rejection from an aborted start after a newer call becomes active', async () => {
        let rejectOld: (reason: unknown) => void = () => undefined;
        const getUserMedia = vi.fn().mockImplementationOnce(() => new Promise<MediaStream>((_, reject) => rejectOld = reject))
            .mockResolvedValue({ getTracks: () => [track], getAudioTracks: () => [track] });
        Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
        const oldStart = facade.start('group-1', 'self-1');
        await Promise.resolve();
        facade.abort('group-1');
        const cancellation = send.mock.calls.find(([event]) => event.type === 'group.call.cancel_start')?.[0];
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.start_cancelled', request_id: cancellation.request_id, payload: {...cancellation.payload, outcome: 'confirmed'}});
        await facade.start('group-2', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-2'));
        rejectOld(new DOMException('denied', 'NotAllowedError'));
        await oldStart;
        expect(facade.state.phase).toBe('active');
        expect(facade.state.room?.conversation_id).toBe('group-2');
        expect(track.stop).not.toHaveBeenCalled();
    });
    it.each(['start', 'join'] as const)('invalidates pending %s capture across disconnect and reconnect', async operation => {
        let resolveCapture: (stream: MediaStream) => void = () => undefined;
        vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementationOnce(() => new Promise(resolve => resolveCapture = resolve));
        const pending = operation === 'start' ? facade.start('group-1', 'self-1') : facade.join(room('group.call.started', 'active').payload, 'self-1');
        await Promise.resolve();
        ready.next(false);
        ready.next(true);
        resolveCapture({getTracks: () => [track], getAudioTracks: () => [track]} as unknown as MediaStream);
        await pending;
        expect(track.stop).toHaveBeenCalled();
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type: operation === 'start' ? 'group.call.start' : 'group.call.join'}));
        expect(facade.state.phase).not.toBe('joining');
        expect(facade.state.phase).not.toBe('ringing');
    });

    it('keeps the conversation on the terminal confirmation after ending locally', async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1));
        facade.end();
        events.next(room('group.call.ended', 'ended', 'group-1', 1, 2));
        expect(facade.state.phase).toBe('ended');
        expect(facade.state.conversationID).toBe('group-1');
    });

    it('serializes concurrent microphone changes and releases pending capture on teardown', async () => {
        const participants = [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-a', device_id: 'device-a'}];
        await facade.join(room('group.call.started', 'active', 'group-1', 1, 1, participants).payload, 'self-1');
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 2, participants));
        const firstTrack = {kind: 'audio', stop: vi.fn(), enabled: true};
        const secondTrack = {kind: 'audio', stop: vi.fn(), enabled: true};
        const stream = (item: typeof firstTrack): MediaStream => ({getTracks: () => [item], getAudioTracks: () => [item]} as unknown as MediaStream);
        vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValueOnce(stream(firstTrack)).mockResolvedValueOnce(stream(secondTrack));
        let finishReplace: () => void = () => undefined;
        senders[0].replaceTrack.mockImplementationOnce(() => new Promise<void>(resolve => finishReplace = resolve));
        const first = facade.selectInputDevice('first');
        await flush();
        const second = facade.selectInputDevice('second');
        await flush();
        expect(senders[0].replaceTrack).toHaveBeenCalledTimes(1);
        finishReplace();
        await Promise.all([first, second]);
        expect(facade.state.selectedInputID).toBe('second');
        expect(firstTrack.stop).toHaveBeenCalled();
        expect(secondTrack.stop).not.toHaveBeenCalled();
        facade.end();
        expect(secondTrack.stop).toHaveBeenCalled();
    });

    it('discards an in-flight microphone replacement and queued selection when the call ends', async () => {
        const participants = [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-a', device_id: 'device-a'}];
        await facade.join(room('group.call.started', 'active', 'group-1', 1, 1, participants).payload, 'self-1');
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 2, participants));
        const replacementTrack = {kind: 'audio', stop: vi.fn(), enabled: true};
        vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValueOnce({getTracks: () => [replacementTrack], getAudioTracks: () => [replacementTrack]} as unknown as MediaStream);
        let finishReplace: () => void = () => undefined;
        senders[0].replaceTrack.mockImplementationOnce(() => new Promise<void>(resolve => finishReplace = resolve));
        const first = facade.selectInputDevice('first');
        await flush();
        const second = facade.selectInputDevice('second');
        facade.end();
        expect(replacementTrack.stop).toHaveBeenCalled();
        finishReplace();
        await Promise.all([first, second]);
        expect(replacementTrack.stop).toHaveBeenCalled();
        expect(track.stop).toHaveBeenCalled();
        expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
        expect(facade.state.phase).toBe('ended');
    });
    afterEach(() => { facade.close(); if (mediaDevices)
        Object.defineProperty(navigator, 'mediaDevices', mediaDevices); if (peerConnectionDescriptor)
        Object.defineProperty(window, 'RTCPeerConnection', peerConnectionDescriptor); });

    it('requests media before starting and cleans it up on the terminal room event', async () => {
        await facade.start('group-1', 'self-1');
        expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'group.call.start', payload: expect.objectContaining({ conversation_id: 'group-1' }) }));

        acceptStarted(room('group.call.started', 'active'));
        events.next(room('group.call.ended', 'ended'));

        expect(track.stop).toHaveBeenCalled();
        expect(facade.state.statusLabel).toBe('Group call ended.');
    });

    it('discovers the selected conversation before requesting media and joins the correlated active room', async () => {
        const roomPayload = room('group.call.started', 'active', 'group-1', 4, 6, [{ user_id: 'peer-1', device_id: 'peer-device' }]).payload;
        facade.discoverAndStart('group-1', 'self-1');
        const discoveryCall = vi.mocked(send).mock.lastCall;
        if (!discoveryCall) throw new Error('Expected a discovery request.');
        const discovery = discoveryCall[0] as {
            type: string;
            request_id: string;
        };
        expect(discovery.type).toBe('group.call.discover');
        expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();

        events.next({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.discovered', request_id: 'unrelated', payload: { conversation_id: 'group-1', room: roomPayload } });
        expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
        events.next({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.discovered', request_id: discovery.request_id, payload: { conversation_id: 'group-1', room: roomPayload } });
        await flush();

        expect(vi.mocked(send).mock.calls.map(([event]) => event.type)).toEqual(['group.call.discover', 'group.call.join']);
        const joinCall = vi.mocked(send).mock.lastCall;
        if (!joinCall) throw new Error('Expected a join request.');
        expect((joinCall[0] as {
            payload: {
                room_id: string;
            };
        }).payload.room_id).toBe('room-1');
        expect(facade.state.phase).toBe('joining');
    });

    it.each(['empty', 'same room'] as const)('preserves an incoming room when a %s discovery response arrives later', async result => {
        facade.discoverAndStart('group-1', 'self-1');
        const discovery = send.mock.lastCall?.[0] as {request_id: string};
        const started = room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'peer-1', device_id: 'peer-device'}]);
        events.next(started);
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.discovered', request_id: discovery.request_id, payload: {conversation_id: 'group-1', room: result === 'empty' ? null : started.payload}});
        await flush();
        expect(facade.state.phase).toBe('joining');
        expect(facade.state.room?.room_id).toBe('room-1');
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.start'}));
        expect(send.mock.calls.filter(([event]) => event.type === 'group.call.join')).toHaveLength(1);
        expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    });

    it('does not join a stale discovery room after that room ends while discovery is pending', async () => {
        facade.discoverAndStart('group-1', 'self-1');
        const discovery = send.mock.lastCall?.[0] as {request_id: string};
        const started = room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'peer-1', device_id: 'peer-device'}]);
        events.next(started);
        events.next(room('group.call.ended', 'ended', 'group-1', 1, 2));
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.discovered', request_id: discovery.request_id, payload: {conversation_id: 'group-1', room: started.payload}});
        await flush();
        expect(facade.state.phase).toBe('ended');
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.join'}));
        expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    });

    it('stops late microphone capture when the started room ends before discovery returns', async () => {
        let resolveCapture: (stream: MediaStream) => void = () => { throw new Error('Capture was not requested.'); };
        vi.mocked(navigator.mediaDevices.getUserMedia).mockReturnValueOnce(new Promise<MediaStream>(resolve => { resolveCapture = resolve; }));
        facade.discoverAndStart('group-1', 'self-1');
        const discovery = send.mock.lastCall?.[0] as {request_id: string};
        const started = room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'peer-1', device_id: 'peer-device'}]);
        events.next(started);
        events.next(room('group.call.ended', 'ended', 'group-1', 1, 2));
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.discovered', request_id: discovery.request_id, payload: {conversation_id: 'group-1', room: started.payload}});
        resolveCapture({getTracks: () => [track], getAudioTracks: () => [track]} as unknown as MediaStream);
        await flush();
        expect(track.stop).toHaveBeenCalled();
        expect(facade.state.phase).toBe('ended');
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.join'}));
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.start'}));
    });

    it.each(['full', 'minimal'] as const)('does not join discovery snapshot preceded by an unseen %s terminal event', async shape => {
        facade.discoverAndStart('group-1', 'self-1');
        const discovery = send.mock.lastCall?.[0] as {request_id: string};
        const started = room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'peer-1', device_id: 'peer-device'}]);
        const ended = room('group.call.ended', 'ended', 'group-1', 1, 2);
        events.next(shape === 'full' ? ended : {version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.ended', payload: {room_id: 'room-1', generation: 1, status: 'ended', state_revision: 2}});
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.discovered', request_id: discovery.request_id, payload: {conversation_id: 'group-1', room: started.payload}});
        await flush();
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.join'}));
        expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    });

    it('rolls back earlier peer microphone replacements when a later peer rejects the device', async () => {
        const participants: GroupCallParticipant[] = [
            {user_id: 'self-1', device_id: 'device-1'},
            {user_id: 'peer-a', device_id: 'device-a'},
            {user_id: 'peer-b', device_id: 'device-b'},
        ];
        await facade.join(room('group.call.started', 'active', 'group-1', 1, 1, participants).payload, 'self-1');
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 2, participants));
        const originalTrack = track as unknown as MediaStreamTrack;
        const replacementTrack = {kind: 'audio', readyState: 'live', stop: vi.fn().mockName('replacement-stop')} as unknown as MediaStreamTrack;
        const replacement = {getTracks: () => [replacementTrack], getAudioTracks: () => [replacementTrack]} as unknown as MediaStream;
        vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(replacement);
        senders[1].replaceTrack.mockRejectedValue(new Error('peer replacement failed'));

        await facade.selectInputDevice('microphone-2');

        expect(senders[0].replaceTrack).toHaveBeenNthCalledWith(1, replacementTrack);
        expect(senders[0].replaceTrack).toHaveBeenNthCalledWith(2, originalTrack);
        expect(replacementTrack.stop).toHaveBeenCalled();
        expect(track.stop).not.toHaveBeenCalled();
        expect(peerConnections[0].connectionState).not.toBe('closed');
        expect(peerConnections[1].connectionState).toBe('closed');
        expect(facade.state.localStream).not.toBe(replacement);
        expect(facade.state.phase).toBe('active');
    });

    it('keeps a muted group call muted before attaching a replacement microphone to every peer', async () => {
        const participants: GroupCallParticipant[] = [
            {user_id: 'self-1', device_id: 'device-1'},
            {user_id: 'peer-a', device_id: 'device-a'},
            {user_id: 'peer-b', device_id: 'device-b'},
        ];
        await facade.join(room('group.call.started', 'active', 'group-1', 1, 1, participants).payload, 'self-1');
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 2, participants));
        facade.toggleMute();
        const replacementTrack = {kind: 'audio', enabled: true, readyState: 'live', stop: vi.fn().mockName('replacement-stop')} as unknown as MediaStreamTrack;
        const replacement = {getTracks: () => [replacementTrack], getAudioTracks: () => [replacementTrack]} as unknown as MediaStream;
        vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(replacement);
        for (const sender of senders) sender.replaceTrack.mockImplementation((next: MediaStreamTrack | null) => {
            if (next === replacementTrack) expect(replacementTrack.enabled).toBe(false);
            return Promise.resolve();
        });

        await facade.selectInputDevice('microphone-2');

        expect(facade.state.muted).toBe(true);
        expect(replacementTrack.enabled).toBe(false);
        expect(senders).toHaveLength(2);
        for (const sender of senders) expect(sender.replaceTrack).toHaveBeenCalledWith(replacementTrack);
    });

    it('applies mute changes to both microphones throughout multi-peer replacement and rollback', async () => {
        const participants = [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-a', device_id: 'device-a'}, {user_id: 'peer-b', device_id: 'device-b'}];
        await facade.join(room('group.call.started', 'active', 'group-1', 1, 1, participants).payload, 'self-1');
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 2, participants));
        const replacement = {kind: 'audio', enabled: true, readyState: 'live', stop: vi.fn()};
        vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValueOnce({getTracks: () => [replacement], getAudioTracks: () => [replacement]} as unknown as MediaStream);
        let finish: () => void = () => undefined;
        senders[0].replaceTrack.mockImplementationOnce(() => new Promise<void>(resolve => finish = resolve));
        let finishRollback: () => void = () => undefined;
        let rollbackStarted: () => void = () => undefined;
        const rollback = new Promise<void>(resolve => rollbackStarted = resolve);
        senders[0].replaceTrack.mockImplementationOnce(() => new Promise<void>(resolve => { finishRollback = resolve; rollbackStarted(); }));
        senders[1].replaceTrack.mockRejectedValueOnce(new Error('failed'));
        const switching = facade.selectInputDevice('new');
        await flush();
        facade.toggleMute();
        expect(track.enabled).toBe(false);
        expect(replacement.enabled).toBe(false);
        facade.toggleMute();
        expect(track.enabled).toBe(true);
        expect(replacement.enabled).toBe(true);
        facade.toggleMute();
        finish();
        await rollback;
        expect(senders[0].replaceTrack).toHaveBeenLastCalledWith(track);
        facade.toggleMute();
        expect(track.enabled).toBe(true);
        expect(replacement.enabled).toBe(true);
        facade.toggleMute();
        expect(track.enabled).toBe(false);
        expect(replacement.enabled).toBe(false);
        finishRollback();
        await switching;
        expect(track.enabled).toBe(false);
        expect(replacement.enabled).toBe(false);
        expect(senders[0].replaceTrack).toHaveBeenLastCalledWith(track);
    });

    it('starts only after correlated discovery reports no room', async () => {
        facade.discoverAndStart('group-1', 'self-1');
        const discoveryCall = vi.mocked(send).mock.lastCall;
        if (!discoveryCall) throw new Error('Expected a discovery request.');
        const discovery = discoveryCall[0] as {
            request_id: string;
        };
        events.next({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.discovered', request_id: discovery.request_id, payload: { conversation_id: 'group-1', room: null } });
        await flush();
        expect(vi.mocked(send).mock.calls.map(([event]) => event.type)).toEqual(['group.call.discover', 'group.call.prepare_start', 'group.call.start']);
    });

    it('rings for a fresh room started by another member immediately after the previous call ends', fakeAsync(async () => {
        void facade.start('group-1', 'self-1');
        await tick();
        acceptStarted(room('group.call.started', 'ringing', 'group-1', 1, 1));
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 2, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        events.next(room('group.call.ended', 'ended', 'group-1', 1, 3));
        expect(facade.state.phase).toBe('ended');

        const newCall = room('group.call.started', 'ringing', 'group-1', 1, 1, [{ user_id: 'peer-1', device_id: 'peer-device' }]);
        events.next({ ...newCall, payload: { ...newCall.payload, room_id: 'room-2' } });
        expect(facade.state.phase).toBe('ringing');
        expect(facade.state.room?.room_id).toBe('room-2');
        expect(facade.state.localStream).toBeUndefined();

        // The old terminal timer and delayed old-room frames cannot dismiss or
        // replace the newly offered room while the recipient decides to join.
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 4));
        await tick(5000);
        expect(facade.state.room?.room_id).toBe('room-2');
        expect(facade.state.phase).toBe('ringing');
    }));

    it('allows a departed participant to rejoin the same active room without starting another call', async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        facade.leave();

        expect(sentEvent('group.call.leave')?.payload.generation).toBe(1);
        expect(facade.state.phase).toBe('left');
        expect(facade.state.localStream).toBeUndefined();
        expect(track.stop).toHaveBeenCalled();
        events.next(room('group.call.participant.left', 'active', 'group-1', 1, 2, [{ user_id: 'peer-1', device_id: 'peer-device' }]));
        expect(track.stop).toHaveBeenCalled();
        expect(facade.state.phase).toBe('left');
        expect(facade.state.localStream).toBeUndefined();
        expect(facade.canRejoin('group-1')).toBe(true);
        expect(facade.canRejoin('another-group')).toBe(false);
        facade.rejoin('self-1');
        confirmRejoinDiscovery(2);
        await flush();
        const joinRequest = sentGroupRequest('group.call.join');
        expect(vi.mocked(send).mock.calls.filter(([event]) => event.type === 'group.call.start')).toHaveLength(1);
        expect(vi.mocked(send).mock.calls.filter(([event]) => event.type === 'group.call.join')).toHaveLength(1);
        expect(sentEvent('group.call.join')?.payload.generation).toBe(1);
        expect(facade.state.phase).toBe('joining');
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 3, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        expect(facade.state.phase).toBe('active');
        expect(facade.canRejoin('group-1')).toBe(false);
        events.next(rejected(joinRequest, 'late rejection'));
        expect(facade.state.phase).toBe('active');
    });

    it('dismisses the leave notice after five seconds while retaining the room rejoin metadata', fakeAsync(async () => {
        void facade.start('group-1', 'self-1');
        await tick();
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        facade.leave();
        expect(facade.state.phase).toBe('left');
        await tick(4999);
        expect(facade.state.phase).toBe('left');
        await tick(1);
        expect(facade.state.phase).toBe('idle');
        expect(facade.canRejoin('group-1')).toBe(true);
        expect(facade.canRejoin('another-group')).toBe(false);
    }));

    it('dismisses the leave notice five seconds after leaving even when the socket disconnects, retaining rejoin metadata', fakeAsync(async () => {
        void facade.start('group-1', 'self-1');
        await tick();
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        facade.leave();

        await tick(2000);
        ready.next(false);
        expect(facade.state.phase).toBe('left');
        expect(facade.state.statusLabel).toContain('Realtime connection lost');
        expect(facade.canRejoin('group-1')).toBe(true);

        await tick(2999);
        expect(facade.state.phase).toBe('left');
        await tick(1);
        expect(facade.state.phase).toBe('idle');
        expect(facade.canRejoin('group-1')).toBe(true);
        expect(facade.canRejoin('another-group')).toBe(false);
    }));

    it('checks ownership before rejoining after the leave command is queued', async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        facade.leave();
        expect(facade.state.phase).toBe('left');
        expect(facade.canRejoin('group-1')).toBe(true);
        facade.rejoin('self-1');
        expect(sentEvent('group.call.join')).toBeUndefined();
        confirmRejoinDiscovery(1);
        await flush();
        expect(facade.state.phase).toBe('joining');
        expect(vi.mocked(send).mock.calls.filter(([event]) => event.type === 'group.call.join')).toHaveLength(1);
    });

    it('clears a departed room on conversation removal or a newer incoming room', async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        facade.leave();
        expect(facade.abort('another-group')).toBe(false);
        expect(facade.abort('group-1')).toBe(true);
        expect(facade.canRejoin('group-1')).toBe(false);

        await facade.start('group-1', 'self-1');
        const secondRoom = room('group.call.started', 'ringing', 'group-1', 1, 1, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]);
        acceptStarted({ ...secondRoom, payload: { ...secondRoom.payload, room_id: 'room-2' } });
        facade.leave();
        const newRoom = room('group.call.started', 'ringing', 'group-1', 1, 1, [{ user_id: 'peer-1', device_id: 'peer-device' }]);
        events.next({ ...newRoom, payload: { ...newRoom.payload, room_id: 'room-3' } });
        expect(facade.state.phase).toBe('ringing');
        expect(facade.state.room?.room_id).toBe('room-3');
        expect(facade.canRejoin('group-1')).toBe(false);
    });

    it('keeps a departed room retryable when microphone permission fails during rejoin', async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        facade.leave();
        Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) } });

        facade.rejoin('self-1');
        confirmRejoinDiscovery(1);
        await flush();

        expect(facade.state.phase).toBe('left');
        expect(facade.state.errorLabel).toContain('Microphone permission was denied');
        expect(facade.canRejoin('group-1')).toBe(true);
        expect(vi.mocked(send).mock.calls.filter(([event]) => event.type === 'group.call.join')).toHaveLength(0);
    });

    it('clears retained room credentials on a minimal terminal event while locally left', async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        facade.leave();
        events.next({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.ended', payload: {
                room_id: 'room-1', generation: 1, status: 'ended', state_revision: 2,
            } });

        expect(facade.state.phase).toBe('ended');
        expect(facade.canRejoin('group-1')).toBe(false);
    });

    it('preserves the rejoin room through realtime disconnect and can retry after reconnection', async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        facade.leave();
        ready.next(false);

        expect(facade.state.phase).toBe('left');
        expect(facade.canRejoin('group-1')).toBe(true);
        ready.next(true);
        facade.rejoin('self-1');
        await flush();

        expect(facade.state.phase).toBe('joining');
        expect(sentEvent('group.call.join')?.payload).toEqual(expect.objectContaining({ room_id: 'room-1' }));
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 3, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        expect(facade.state.phase).toBe('active');
        expect(facade.canRejoin('group-1')).toBe(false);
    });

    it('ignores stale updates to a departed room while accepting its newer terminal event', async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 5, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        facade.leave();
        events.next(room('group.call.started', 'active', 'group-1', 1, 4, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        expect(facade.state.phase).toBe('left');
        expect(facade.canRejoin('group-1')).toBe(true);

        events.next(room('group.call.ended', 'ended', 'group-1', 1, 6));

        expect(facade.state.phase).toBe('ended');
        expect(facade.canRejoin('group-1')).toBe(false);
    });

    it('fences stale roster revisions during rejoin and delayed start events after terminal events', async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 5, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        facade.leave();
        facade.rejoin('self-1');
        confirmRejoinDiscovery(5);
        await flush();
        events.next(room('group.call.participant.left', 'active', 'group-1', 1, 4, [{ user_id: 'peer-1', device_id: 'peer-device' }]));
        expect(facade.state.phase).toBe('joining');
        expect(facade.state.room?.participants).toHaveLength(1);

        events.next(room('group.call.ended', 'ended', 'group-1', 1, 6));
        events.next(room('group.call.started', 'active', 'group-1', 1, 7));

        expect(facade.state.phase).toBe('ended');
        expect(facade.state.room).toBeUndefined();
        expect(facade.canRejoin('group-1')).toBe(false);
    });

    it('retires a departed room on its minimal terminal projection before delayed room updates', async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 5, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        facade.leave();
        events.next(room('group.call.participant.left', 'active', 'group-1', 1, 6, [{ user_id: 'peer-1', device_id: 'peer-device' }]));
        expect(facade.state.phase).toBe('left');
        events.next({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.ended', payload: {
                room_id: 'room-1', generation: 1, status: 'ended', state_revision: 7,
            } });
        events.next(room('group.call.started', 'active', 'group-1', 1, 7));

        expect(facade.state.phase).toBe('ended');
        expect(facade.state.room).toBeUndefined();
        expect(facade.canRejoin('group-1')).toBe(false);
    });

    it.each(['leave', 'end'] as const)('retries rejected %s only after own active sync and confirms absence before deferred discovery', async action => {
        const participants = [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-device'}];
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 5, participants));
        facade[action]();
        events.next(rejected(sentGroupRequest(`group.call.${action}`), 'unavailable'));
        facade.discoverAndStart('group-2', 'self-1');
        const syncID = sentRequestID('group.call.sync');
        events.next(synced(syncID, {ownership_status: 'active', state_revision: 5, participants}));
        expect(send.mock.calls.filter(([command]) => command.type === `group.call.${action}`)).toHaveLength(2);
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.discover'}));
        const verification = sentRequestID('group.call.sync', 1);
        events.next(absentSync(syncID));
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.discover'}));
        events.next(absentSync(verification));
        expect(send).toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.discover', payload: {conversation_id: 'group-2'}}));
    });

    it.each(['leave', 'end'] as const)('retains a deferred start when terminal precedes %s ownership sync', async action => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 5, [
            {user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-device'},
        ]));
        facade[action]();
        events.next(rejected(sentGroupRequest(`group.call.${action}`), 'unavailable'));
        facade.discoverAndStart('group-2', 'self-1');
        const syncID = sentRequestID('group.call.sync');
        events.next(room('group.call.ended', 'ended', 'group-1', 1, 6));
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.discover'}));
        events.next(absentSync(syncID));
        expect(send).toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.discover', payload: {conversation_id: 'group-2'}}));
    });

    it('does not take over after terminal and owned elsewhere, and ignores the stale sync', async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 5, [
            {user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-device'},
        ]));
        facade.leave();
        events.next(rejected(sentGroupRequest('group.call.leave'), 'unavailable'));
        facade.discoverAndStart('group-2', 'self-1');
        const oldSync = sentRequestID('group.call.sync');
        events.next(room('group.call.ended', 'ended', 'group-1', 1, 6));
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', request_id: oldSync, payload: {room_id: 'room-1', generation: 1, status: 'ended', ownership_status: 'owned_elsewhere'}});
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.discover'}));
        facade.discoverAndStart('group-2', 'self-1');
        const retry = sentRequestID('group.call.sync', 1);
        events.next(absentSync(oldSync));
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.discover'}));
        events.next(absentSync(retry));
        expect(send).toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.discover', payload: {conversation_id: 'group-2'}}));
        expect(send.mock.calls.filter(([command]) => command.type === 'group.call.leave')).toHaveLength(1);
    });

    it.each(['leave', 'end'] as const)('preserves deferred intent after %s verification timeout and reconnect, ignoring stale replies', action => fakeAsync(async () => {
        const participants = [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-device'}];
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 5, participants));
        facade[action]();
        events.next(rejected(sentGroupRequest(`group.call.${action}`), 'unavailable'));
        facade.discoverAndStart('group-2', 'self-1');
        events.next(synced(sentRequestID('group.call.sync'), {ownership_status: 'active', state_revision: 5, participants}));
        const verification = sentRequestID('group.call.sync', 1);
        await tick(8000);
        ready.next(false);
        ready.next(true);
        const reconnectSync = sentRequestID('group.call.sync', 2);
        expect(reconnectSync).not.toBe('');
        events.next(absentSync(verification));
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.discover'}));
        events.next(absentSync(reconnectSync));
        expect(send).toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.discover', payload: {conversation_id: 'group-2'}}));
    })());

    it.each(['leave', 'end'] as const)('bounds %s retry when verification still reports own active reservation', async action => {
        const participants = [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-device'}];
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 5, participants));
        facade[action]();
        events.next(rejected(sentGroupRequest(`group.call.${action}`), 'unavailable'));
        facade.discoverAndStart('group-2', 'self-1');
        events.next(synced(sentRequestID('group.call.sync'), {ownership_status: 'active', state_revision: 5, participants}));
        events.next(synced(sentRequestID('group.call.sync', 1), {ownership_status: 'active', state_revision: 5, participants}));
        expect(send.mock.calls.filter(([command]) => command.type === `group.call.${action}`)).toHaveLength(2);
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.discover'}));
        expect(facade.canRejoin('group-1')).toBe(false);
    });

    it('keeps rejoin blocked while retrying a rejected leave and verifying absence', async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 5, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        facade.leave();
        const leaveID = sentGroupRequest('group.call.leave');
        events.next(rejected(leaveID, 'call unavailable'));

        const syncID = sentRequestID('group.call.sync');
        expect(facade.state.phase).toBe('left');
        expect(facade.canRejoin('group-1')).toBe(false);
        events.next(synced(syncID, { ownership_status: 'active', state_revision: 5, participants: [{ user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' }] }));

        expect(facade.state.phase).toBe('left');
        expect(facade.state.errorLabel).toContain('Could not leave');
        expect(facade.canRejoin('group-1')).toBe(false);
        expect(sentGroupRequest('group.call.leave', 1)).not.toBe('');
        expect(facade.state.localStream).toBeUndefined();
    });

    it.each([['leave', 'owned_elsewhere'], ['end', 'owned_elsewhere'], ['leave', 'legacy'], ['end', 'legacy'], ['leave', 'room_unavailable'], ['end', 'room_unavailable']] as const)('keeps rejected %s uncertain for %s ownership', async (action, ownership) => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 5, [
            {user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-device'},
        ]));
        facade[action]();
        events.next(rejected(sentGroupRequest(`group.call.${action}`), 'unavailable'));
        const syncID = sentRequestID('group.call.sync');
        expect(send).toHaveBeenLastCalledWith(expect.objectContaining({type: 'group.call.sync', payload: expect.objectContaining({ownership_status: true})}));
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', request_id: syncID, payload: {room_id: 'room-1', generation: 1, status: 'ended', ...(ownership === 'legacy' ? {} : {ownership_status: ownership})}} as never);
        expect(facade.state.errorLabel).toContain('could not be verified');
        expect(facade.canRejoin('group-1')).toBe(false);
    });

    it.each(['leave', 'end'] as const)('correlates rejected %s after dismissal and retains its error', action => fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 5, [
            {user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-device'},
        ]));
        facade[action]();
        const requestID = sentGroupRequest(`group.call.${action}`);
        await tick(5000);
        expect(facade.state.phase).toBe('idle');
        events.next(rejected(requestID, 'unavailable'));
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', request_id: sentRequestID('group.call.sync'), payload: {room_id: 'room-1', generation: 1, status: 'ended', ownership_status: 'owned_elsewhere'}});
        await tick(5000);
        expect(facade.state.errorLabel).toContain('could not be verified');
        expect(facade.canRejoin('group-1')).toBe(false);
    })());

    it.each(['leave', 'end'] as const)('retains rejected %s error when the original dismissal timer expires', action => fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 5, [
            {user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-device'},
        ]));
        facade[action]();
        events.next(rejected(sentGroupRequest(`group.call.${action}`), 'unavailable'));
        events.next(absentSync(sentRequestID('group.call.sync')));
        await tick(5000);
        expect(facade.state.errorLabel).toContain('Could not');
    })());

    it('keeps an ended result after a rejected end is authoritatively reconciled as ended', async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 5, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        facade.end();
        const endID = sentGroupRequest('group.call.end');
        events.next(rejected(endID, 'call unavailable'));
        const syncID = sentRequestID('group.call.sync', 1);
        events.next(endedSync(syncID));

        expect(facade.state.phase).toBe('ended');
        expect(facade.canRejoin('group-1')).toBe(false);
    });

    it('ignores an uncorrelated rejection and never overwrites a newer terminal room event', async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 5, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        facade.end();
        events.next({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'call.rejected', payload: { error: 'call unavailable' } });
        events.next(room('group.call.ended', 'ended', 'group-1', 1, 6, [{ user_id: 'peer-1', device_id: 'peer-device' }]));
        events.next(rejected(sentGroupRequest('group.call.end'), 'late rejection'));

        expect(facade.state.phase).toBe('ended');
        expect(facade.state.errorLabel).toBeUndefined();
        expect(facade.state.room).toBeUndefined();
    });

    it('ignores terminal projections at or below baseline while rejected-control reconciliation is pending', async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 5, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        facade.leave();
        events.next(rejected(sentGroupRequest('group.call.leave'), 'call unavailable'));
        const syncID = sentRequestID('group.call.sync');
        events.next({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.ended', payload: { room_id: 'room-1', generation: 1, status: 'ended', state_revision: 5 } });
        events.next(room('group.call.ended', 'ended', 'group-1', 1, 5));

        expect(facade.state.phase).toBe('left');
        expect(facade.canRejoin('group-1')).toBe(false);
        events.next(synced(syncID, { ownership_status: 'active', state_revision: 5, participants: [{ user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' }] }));
        expect(facade.state.phase).toBe('left');
        expect(facade.canRejoin('group-1')).toBe(false);
        expect(sentGroupRequest('group.call.leave', 1)).not.toBe('');
    });

    it('keeps rejoin disabled when control room sync is sent unsuccessfully or rejected', async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 5, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        facade.leave();
        const leaveID = sentGroupRequest('group.call.leave');
        send.mockReturnValue(false);
        events.next(rejected(leaveID, 'call unavailable'));
        expect(facade.canRejoin('group-1')).toBe(false);
        expect(facade.state.errorLabel).toContain('could not be verified');

        const unavailableSyncID = sentRequestID('group.call.sync');
        events.next(rejected(unavailableSyncID, 'sync unavailable'));
        expect(facade.canRejoin('group-1')).toBe(false);
        expect(facade.state.errorLabel).toContain('could not be verified');
    });

    it('does not retire a ringing room when a recipient leaves and may rejoin until it ends', async () => {
        const incomingRoom = room('group.call.started', 'ringing', 'group-1', 1, 1, [{ user_id: 'peer-1', device_id: 'peer-device' }]).payload;
        events.next({ ...room('group.call.started', 'ringing', 'group-1', 1, 1, incomingRoom.participants), payload: incomingRoom });
        await facade.join(incomingRoom, 'self-1');
        const pendingJoin = sentGroupRequest('group.call.join');
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 2, [
            { user_id: 'peer-1', device_id: 'peer-device' }, { user_id: 'self-1', device_id: 'device-1' },
        ]));
        facade.leave();

        expect(facade.state.phase).toBe('left');
        expect(facade.canRejoin('group-1')).toBe(true);
        events.next(rejected(pendingJoin, 'leave accepted'));
        expect(facade.state.phase).toBe('left');
        expect(facade.canRejoin('group-1')).toBe(true);

        const ended = room('group.call.ended', 'ended', 'group-1', 1, 3);
        events.next({ ...ended, payload: { ...ended.payload, room_id: incomingRoom.room_id } });
        expect(facade.state.phase).toBe('ended');
        expect(facade.canRejoin('group-1')).toBe(false);
    });

    it('sends one sync per interval and reconciles an active snapshot without new TURN credentials', fakeAsync(async () => {
        void facade.start('group-1', 'self-1');
        await tick();
        acceptStarted(room('group.call.started', 'active'));
        const baseline = vi.mocked(send).mock.calls.length;

        await tick(10000);
        expect(vi.mocked(send).mock.calls.length).toBe(baseline + 1);
        const sync = vi.mocked(send).mock.calls.map(([event]) => event).find(event => event.type === 'group.call.sync');
        expect(sync).toBeDefined();
        expect(sync).toMatchObject({payload: {ownership_status: true}});
        await tick(7999);
        expect(vi.mocked(send).mock.calls.filter(([event]) => event.type === 'group.call.sync')).toHaveLength(1);

        const originalRequest = sync as {
            request_id: string;
        };
        events.next(synced(originalRequest.request_id, { state_revision: 4, participants: [{ user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' }], presenter: { user_id: 'peer-1', device_id: 'peer-device' } }));
        expect(facade.state.peers.map(peer => peer.userID)).toEqual(['peer-1']);
        expect(facade.state.room?.presenter?.user_id).toBe('peer-1');

        await tick(2001);
        expect(vi.mocked(send).mock.calls.filter(([event]) => event.type === 'group.call.sync')).toHaveLength(2);
    }));

    it('ignores stale and out-of-order snapshots and converges a correlated terminal snapshot', fakeAsync(async () => {
        void facade.start('group-1', 'self-1');
        await tick();
        acceptStarted(room('group.call.started', 'active'));
        await tick(10000);
        const first = vi.mocked(send).mock.calls.map(([event]) => event).find(event => event.type === 'group.call.sync') as {
            request_id: string;
        };
        events.next(synced(first.request_id, { state_revision: 8, participants: [{ user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' }] }));
        await tick(10000);
        const second = vi.mocked(send).mock.calls.map(([event]) => event).filter(event => event.type === 'group.call.sync')[1] as {
            request_id: string;
        };

        events.next(endedSync(first.request_id));
        events.next(synced(second.request_id, { state_revision: 7, status: 'active', participants: [{ user_id: 'self-1', device_id: 'device-1' }] }));
        expect(facade.state.phase).toBe('active');
        await tick(10000);
        const third = vi.mocked(send).mock.calls.map(([event]) => event).filter(event => event.type === 'group.call.sync')[2] as {
            request_id: string;
        };
        events.next(endedSync(third.request_id));
        expect(facade.state.phase).toBe('ended');
        expect(track.stop).toHaveBeenCalled();
        await tick(30000);
        expect(vi.mocked(send).mock.calls.filter(([event]) => event.type === 'group.call.sync')).toHaveLength(3);
    }));

    it('clears the sync timer when the socket goes offline', fakeAsync(async () => {
        void facade.start('group-1', 'self-1');
        await tick();
        acceptStarted(room('group.call.started', 'active'));
        ready.next(false);
        expect(facade.state.phase).toBe('error');
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.leave'}));
        await tick(30000);
        expect(vi.mocked(send).mock.calls.some(([event]) => event.type === 'group.call.sync')).toBe(false);
    }));

    it('does not overlap a pending request and retries after a lost response at the next interval', fakeAsync(async () => {
        void facade.start('group-1', 'self-1');
        await tick();
        acceptStarted(room('group.call.started', 'active'));
        await tick(10000);
        expect(syncCount()).toBe(1);
        await tick(7999);
        expect(syncCount()).toBe(1);
        await tick(2001);
        expect(syncCount()).toBe(2);
    }));

    it.each(['active', 'joining'] as const)('stops %s media when ownership reconciliation confirms absence', phase => fakeAsync(async () => {
        if (phase === 'active') {
            void facade.start('group-1', 'self-1');
            await tick();
            acceptStarted(room('group.call.started', 'active'));
        } else {
            void facade.join(room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'peer-1', device_id: 'peer-device'}]).payload, 'self-1');
            await tick();
        }
        await tick(10000);
        events.next(absentSync(sentRequestID('group.call.sync')));
        expect(facade.state.phase).toBe(phase === 'active' ? 'ended' : 'error');
        expect(track.stop).toHaveBeenCalled();
        await tick(30000);
        expect(syncCount()).toBe(1);
    })());

    it.each(['room_unavailable', 'rejection', 'timeout'] as const)('keeps active media on transient sync %s and retries', outcome => fakeAsync(async () => {
        void facade.start('group-1', 'self-1');
        await tick();
        acceptStarted(room('group.call.started', 'active'));
        await tick(10000);
        const first = sentRequestID('group.call.sync');
        if (outcome === 'room_unavailable') events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', request_id: first, payload: {room_id: 'room-1', generation: 1, status: 'ended', ownership_status: 'room_unavailable'}});
        if (outcome === 'rejection') events.next(rejected(first, 'unavailable'));
        await tick(10000);
        expect(facade.state.phase).toBe('active');
        expect(track.stop).not.toHaveBeenCalled();
        expect(syncCount()).toBe(2);
        events.next(absentSync(first));
        expect(facade.state.phase).toBe('active');
        events.next(absentSync(sentRequestID('group.call.sync', 1)));
        expect(facade.state.phase).toBe('ended');
    })());

    it.each(['room_unavailable', 'rejection', 'timeout'] as const)('stops all media after repeated %s ownership checks without assuming absence', outcome => fakeAsync(async () => {
        void facade.start('group-1', 'self-1');
        await tick();
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-device'}]));
        const video = {kind: 'video', readyState: 'live', stop: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn()};
        const audio = {kind: 'audio', readyState: 'live', stop: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn()};
        Object.defineProperty(navigator, 'mediaDevices', {configurable: true, value: {getDisplayMedia: vi.fn().mockResolvedValue({getTracks: () => [video, audio], getVideoTracks: () => [video], getAudioTracks: () => [audio]})}});
        facade.setScreenShareAudioEnabled(true);
        await facade.startPresentation('720p');
        expect(facade.state.presentation).toBeDefined();
        for (let index = 0; index < 3; index++) {
            await tick(10000);
            const id = sentRequestID('group.call.sync', index);
            if (outcome === 'rejection') events.next(rejected(id, 'unavailable'));
            if (outcome === 'room_unavailable') events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', request_id: id, payload: {room_id: 'room-1', generation: 1, status: 'ended', ownership_status: 'room_unavailable'}});
            if (outcome === 'timeout') await tick(8000);
        }
        expect(track.stop).toHaveBeenCalled();
        expect(video.stop).toHaveBeenCalled();
        expect(audio.stop).toHaveBeenCalled();
        expect(peerConnections.every(connection => connection.connectionState === 'closed')).toBe(true);
        expect(facade.state.phase).toBe('error');
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.leave'}));
        await facade.start('group-2', 'self-1');
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.start', payload: {conversation_id: 'group-2'}}));
    })());

    it('resets the verification failure budget only for a current healthy snapshot', fakeAsync(async () => {
        void facade.start('group-1', 'self-1');
        await tick();
        acceptStarted(room('group.call.started', 'active'));
        await tick(10000);
        const old = sentRequestID('group.call.sync');
        events.next(rejected(old, 'unavailable'));
        await tick(10000);
        events.next(synced(sentRequestID('group.call.sync', 1), {}));
        events.next(synced(old, {}));
        for (let index = 2; index < 4; index++) {
            await tick(10000);
            events.next(rejected(sentRequestID('group.call.sync', index), 'unavailable'));
        }
        expect(facade.state.phase).toBe('active');
        events.next(synced(old, {}));
        await tick(10000);
        events.next(rejected(sentRequestID('group.call.sync', 4), 'unavailable'));
        expect(facade.state.phase).toBe('error');
        expect(track.stop).toHaveBeenCalled();
    }));

    it('stops media without sending leave when a sibling socket owns the reservation', fakeAsync(async () => {
        void facade.start('group-1', 'self-1');
        await tick();
        acceptStarted(room('group.call.started', 'active'));
        await tick(10000);
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', request_id: sentRequestID('group.call.sync'), payload: {room_id: 'room-1', generation: 1, status: 'ended', ownership_status: 'owned_elsewhere'}});
        expect(facade.state.phase).toBe('error');
        expect(track.stop).toHaveBeenCalled();
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.leave'}));
    }));

    it('ignores mismatched owner snapshots and a late response after disconnect', fakeAsync(async () => {
        void facade.start('group-1', 'self-1');
        await tick();
        acceptStarted(room('group.call.started', 'active'));
        await tick(10000);
        const first = sentRequestID('group.call.sync');
        events.next(synced(first, {state_revision: 2, participants: [{user_id: 'self-1', device_id: 'other-device'}]}));
        expect(facade.state.room?.participants[0].device_id).toBe('device-1');
        await tick(10000);
        const second = sentRequestID('group.call.sync', 1);
        ready.next(false);
        events.next(absentSync(second));
        expect(facade.state.phase).toBe('error');
        ready.next(true);
        await tick(20000);
        expect(syncCount()).toBe(2);
    }));

    it('applies newer room-event revisions and ignores stale events and sync snapshots', fakeAsync(async () => {
        void facade.start('group-1', 'self-1');
        await tick();
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 5));
        await tick(10000);
        const request = vi.mocked(send).mock.calls.map(([event]) => event).find(event => event.type === 'group.call.sync') as {
            request_id: string;
        };

        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 7, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        events.next(room('group.call.participant.left', 'active', 'group-1', 1, 6));
        events.next(synced(request.request_id, { state_revision: 6, participants: [{ user_id: 'self-1', device_id: 'device-1' }] }));

        expect(facade.state.room?.participants.map(participant => participant.user_id)).toEqual(['self-1', 'peer-1']);
        expect(facade.state.peers.map(peer => peer.userID)).toEqual(['peer-1']);
        await tick(10000);
        expect(syncCount()).toBe(2);
    }));

    it('accepts a newer minimal membership-projection end without applying roster data', async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 5, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        const payload = { room_id: 'room-1', generation: 1, status: 'ended' as const, state_revision: 6 };
        expect(Object.keys(payload).sort()).toEqual(['generation', 'room_id', 'state_revision', 'status']);

        events.next({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.ended', payload });

        expect(facade.state.phase).toBe('ended');
        expect(facade.state.room).toBeUndefined();
        expect(facade.state.peers).toEqual([]);
        expect(track.stop).toHaveBeenCalled();
    });

    it('rejects a minimal end for another room or with a stale revision', async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 5));

        events.next({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.ended', payload: { room_id: 'another-room', generation: 1, status: 'ended', state_revision: 6 } });
        events.next({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.ended', payload: { room_id: 'room-1', generation: 1, status: 'ended', state_revision: 5 } });

        expect(facade.state.phase).toBe('active');
        expect(facade.state.room?.room_id).toBe('room-1');
        expect(track.stop).not.toHaveBeenCalled();
    });

    it('publishes the initiator call card state before the server room snapshot arrives', async () => {
        await facade.start('group-1', 'self-1');

        expect(facade.state.phase).toBe('ringing');
        expect(facade.state.localStream).toBeDefined();
        expect(facade.state.room).toBeUndefined();
        expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'group.call.start' }));
    });

    it('cleans up a rejected start only for its matching request and exposes a retryable error', async () => {
        await facade.start('group-1', 'self-1');
        const requestID = sentGroupRequest('group.call.start');

        events.next(rejected('unrelated-request', 'room is busy'));
        expect(facade.state.phase).toBe('ringing');
        expect(track.stop).not.toHaveBeenCalled();

        events.next(rejected(requestID, 'room is busy'));

        expect(facade.state.phase).toBe('error');
        expect(facade.state.errorLabel).toBe('Group call unavailable: room is busy');
        expect(facade.state.localStream).toBeUndefined();
        expect(facade.state.peers).toEqual([]);
        expect(track.stop).toHaveBeenCalledTimes(1);
        expect(facade.isOngoing).toBe(false);
    });

    it('cleans up a rejected join and ignores a rejection arriving after its generation ended', async () => {
        await facade.join(room('group.call.started', 'active').payload, 'self-1');
        const requestID = sentGroupRequest('group.call.join');

        events.next(rejected(requestID, 'membership required'));
        expect(facade.state.phase).toBe('error');
        expect(facade.state.errorLabel).toBe('Group call unavailable: membership required');
        expect(facade.state.localStream).toBeUndefined();
        expect(track.stop).toHaveBeenCalledTimes(1);
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.leave'}));

        await facade.join(room('group.call.started', 'active').payload, 'self-1');
        const secondRequestID = sentGroupRequest('group.call.join', 1);
        facade.leave();
        events.next(rejected(secondRequestID, 'late rejection'));

        expect(facade.state.phase).toBe('ended');
    });

    it('shows the explicit room participant limit when an active group call is full', async () => {
        await facade.join(room('group.call.started', 'active').payload, 'self-1');
        events.next(rejected(sentGroupRequest('group.call.join'), 'group call is full (maximum 4 participants)'));

        expect(facade.state.phase).toBe('error');
        expect(facade.state.errorLabel).toBe('Group call unavailable: group call is full (maximum 4 participants)');
        expect(facade.state.localStream).toBeUndefined();
        expect(track.stop).toHaveBeenCalledTimes(1);
    });

    it('keeps local media when the started event arrives synchronously', async () => {
        send.mockImplementation(event => {
            if (event.type === 'group.call.prepare_start') events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.start_prepared', request_id: event.request_id, payload: {conversation_id: event.payload.conversation_id, attempt_id: 'f9ad4b72-67a1-40fb-b307-428aa956d762', expires_at: '2099-01-01T00:00:00Z'}});
            if (event.type === 'group.call.start') {
                events.next(room('group.call.started', 'ringing'));
                events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.start_accepted', request_id: event.request_id, payload: {conversation_id: event.payload.conversation_id, room_id: 'room-1', generation: 1}});
            }
            return true;
        });

        await facade.start('group-1', 'self-1');

        expect(facade.state.localStream).toBeDefined();
        expect(facade.state.room?.room_id).toBe('room-1');
    });

    it('creates the initial peer offer only when its stable user/device identity sorts first', async () => {
        await facade.start('group-1', 'z-self');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [
            { user_id: 'z-self', device_id: 'z-device' },
        ]));
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 2, [
            { user_id: 'z-self', device_id: 'z-device' },
            { user_id: 'a-peer', device_id: 'a-device' },
        ]));
        await flush();

        expect(signalCount('offer')).toBe(0);
    });

    it('creates an initial peer offer when this device sorts first', async () => {
        await facade.start('group-1', 'a-self');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [
            { user_id: 'a-self', device_id: 'z-device' },
        ]));
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 2, [
            { user_id: 'a-self', device_id: 'z-device' },
            { user_id: 'z-peer', device_id: 'a-device' },
        ]));
        await flush();

        expect(signalCount('offer')).toBe(1);
    });

    it('attaches the active presentation to a late peer before only the deterministic offerer sends its initial offer', async () => {
        await facade.start('group-1', 'a-self');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [
            { user_id: 'a-self', device_id: 'a-device' },
            { user_id: 'z-member', device_id: 'member-device' },
        ]));
        await flush();

        const videoTrack = { kind: 'video', readyState: 'live', stop: vi.fn().mockName('stop'), addEventListener: vi.fn().mockName('addEventListener') };
        const audioTrack = { kind: 'audio', readyState: 'live', stop: vi.fn().mockName('stop'), addEventListener: vi.fn().mockName('addEventListener') };
        Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
                getUserMedia: vi.fn().mockName('getUserMedia'),
                getDisplayMedia: vi.fn().mockName('getDisplayMedia').mockResolvedValue({ getTracks: () => [videoTrack, audioTrack], getVideoTracks: () => [videoTrack], getAudioTracks: () => [audioTrack] }),
            } });
        facade.setScreenShareAudioEnabled(true);
        await facade.startPresentation('720p');
        expect(facade.state.presentation).toBeDefined();
        expect(facade.state.screenShareAudioActive).toBe(true);
        expect(facade.state.statusLabel).toBe('You are presenting.');
        expect(addedTrackKinds.filter(kind => kind === 'audio')).toHaveLength(2);

        const offersBeforeLateJoin = signalCount('offer');
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 2, [
            { user_id: 'a-self', device_id: 'a-device' },
            { user_id: 'z-member', device_id: 'member-device' },
            { user_id: 'm-observer', device_id: 'observer-device' },
        ]));
        await flush();

        expect(addedTrackKinds.filter(kind => kind === 'video')).toHaveLength(2);
        expect(signalCount('offer')).toBe(offersBeforeLateJoin + 1);
    });

    it('restores the same live remote receiver after presenter stop/start without another ontrack and fences its cleanup', async () => {
        const participants: GroupCallParticipant[] = [
            {user_id: 'self-1', device_id: 'device-1'},
            {user_id: 'peer-1', device_id: 'peer-device'},
        ];
        const initial = room('group.call.started', 'active', 'group-1', 1, 1, participants).payload;
        await facade.join({...initial, presenter: {user_id: 'peer-1', device_id: 'peer-device'}}, 'self-1');
        events.next({...room('group.call.participant.joined', 'active', 'group-1', 1, 2, participants), payload: {
            ...room('group.call.participant.joined', 'active', 'group-1', 1, 2, participants).payload,
            presenter: {user_id: 'peer-1', device_id: 'peer-device'},
        }});

        let unmuteListener: (() => void) | undefined;
        let muteListener: (() => void) | undefined;
        let endedListener: (() => void) | undefined;
        let muted = false;
        const remoteTrack = {
            kind: 'video', get muted() { return muted; }, readyState: 'live',
            addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
                if (type === 'unmute') unmuteListener = typeof listener === 'function' ? listener as () => void : () => listener.handleEvent(new Event(type));
                if (type === 'mute') muteListener = typeof listener === 'function' ? listener as () => void : () => listener.handleEvent(new Event(type));
                if (type === 'ended') endedListener = typeof listener === 'function' ? listener as () => void : () => listener.handleEvent(new Event(type));
            }),
        } as unknown as MediaStreamTrack;
        const remoteStream = {active: true, getVideoTracks: () => [remoteTrack]} as unknown as MediaStream;
        const peerConnection = peerConnections[0];
        if (!peerConnection.ontrack) throw new Error('Peer connection track handler was not installed.');
        peerConnection.ontrack({track: remoteTrack, streams: [remoteStream]} as unknown as RTCTrackEvent);
        expect(facade.state.remotePresentation).toBe(remoteStream);

        const stopped = room('group.call.presenter.stop', 'active', 'group-1', 1, 3, participants);
        events.next({...stopped, payload: {...stopped.payload, presenter: undefined}});
        expect(facade.state.remotePresentation).toBeUndefined();
        expect(facade.state.peers[0]?.presentation).toBeUndefined();

        const restarted = room('group.call.presenter.start', 'active', 'group-1', 1, 4, participants);
        events.next({...restarted, payload: {...restarted.payload, presenter: {user_id: 'peer-1', device_id: 'peer-device'}}});
        expect(facade.state.remotePresentation).toBe(remoteStream);
        expect(facade.state.peers[0]?.presentation).toBe(remoteStream);

        muted = true;
        muteListener?.();
        expect(facade.state.remotePresentation).toBeUndefined();
        muted = false;
        unmuteListener?.();
        expect(facade.state.remotePresentation).toBe(remoteStream);

        const removed = room('group.call.participant.left', 'active', 'group-1', 1, 5, [participants[0]]);
        events.next({...removed, payload: {...removed.payload, presenter: undefined}});
        expect(facade.state.remotePresentation).toBeUndefined();
        unmuteListener?.();
        expect(facade.state.remotePresentation).toBeUndefined();
        endedListener?.();
        expect(facade.state.remotePresentation).toBeUndefined();
    });

    it('clears the previous presenter projection when a newer presenter starts before their receiver is ready', async () => {
        const participants: GroupCallParticipant[] = [
            {user_id: 'self-1', device_id: 'device-1'},
            {user_id: 'peer-1', device_id: 'peer-device-a'},
            {user_id: 'peer-2', device_id: 'peer-device-b'},
        ];
        const initial = room('group.call.started', 'active', 'group-1', 1, 1, participants).payload;
        await facade.join({...initial, presenter: {user_id: 'peer-1', device_id: 'peer-device-a'}}, 'self-1');
        const joined = room('group.call.participant.joined', 'active', 'group-1', 1, 2, participants);
        events.next({...joined, payload: {...joined.payload, presenter: {user_id: 'peer-1', device_id: 'peer-device-a'}}});

        const remoteTrack = {kind: 'video', muted: false, readyState: 'live', addEventListener: vi.fn()} as unknown as MediaStreamTrack;
        const remoteStream = {active: true, getVideoTracks: () => [remoteTrack]} as unknown as MediaStream;
        const handler = peerConnections[0]?.ontrack;
        if (!handler) throw new Error('Peer connection track handler was not installed.');
        handler.call(peerConnections[0], {track: remoteTrack, streams: [remoteStream]} as unknown as RTCTrackEvent);
        expect(facade.state.remotePresentation).toBe(remoteStream);
        expect(facade.state.peers.find(peer => peer.userID === 'peer-1')?.presentation).toBe(remoteStream);

        const switched = room('group.call.presenter.start', 'active', 'group-1', 1, 3, participants);
        events.next({...switched, payload: {...switched.payload, presenter: {user_id: 'peer-2', device_id: 'peer-device-b'}}});

        expect(facade.state.room?.presenter).toEqual({user_id: 'peer-2', device_id: 'peer-device-b'});
        expect(facade.state.remotePresentation).toBeUndefined();
        expect(facade.state.peers.every(peer => peer.presentation === undefined)).toBe(true);
    });

    it('does not restore a retained remote receiver after its room becomes terminal', async () => {
        const participants: GroupCallParticipant[] = [
            {user_id: 'self-1', device_id: 'device-1'},
            {user_id: 'peer-1', device_id: 'peer-device'},
        ];
        const initial = room('group.call.started', 'active', 'group-1', 1, 1, participants).payload;
        await facade.join({...initial, presenter: {user_id: 'peer-1', device_id: 'peer-device'}}, 'self-1');
        const active = room('group.call.participant.joined', 'active', 'group-1', 1, 2, participants);
        events.next({...active, payload: {...active.payload, presenter: {user_id: 'peer-1', device_id: 'peer-device'}}});
        let unmuteListener: (() => void) | undefined;
        const remoteTrack = {kind: 'video', muted: false, readyState: 'live', addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
            if (type === 'unmute') unmuteListener = typeof listener === 'function' ? listener as () => void : () => listener.handleEvent(new Event(type));
        }} as unknown as MediaStreamTrack;
        const remoteStream = {active: true, getVideoTracks: () => [remoteTrack]} as unknown as MediaStream;
        const handler = peerConnections[0].ontrack;
        if (!handler) throw new Error('Peer connection track handler was not installed.');
        handler.call(peerConnections[0], {track: remoteTrack, streams: [remoteStream]} as unknown as RTCTrackEvent);

        events.next(room('group.call.ended', 'ended', 'group-1', 1, 3, participants));
        unmuteListener?.();
        expect(facade.state.remotePresentation).toBeUndefined();
        expect(facade.state.peers).toEqual([]);
    });

    it('restores the retained presenter receiver when an active sync snapshot restores presenter identity', fakeAsync(async () => {
        const participants: GroupCallParticipant[] = [
            {user_id: 'self-1', device_id: 'device-1'},
            {user_id: 'peer-1', device_id: 'peer-device'},
        ];
        void facade.start('group-1', 'self-1');
        await tick();
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, participants));
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 2, participants));
        let unmuteListener: (() => void) | undefined;
        const remoteTrack = {kind: 'video', muted: false, readyState: 'live', addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
            if (type === 'unmute') unmuteListener = typeof listener === 'function' ? listener as () => void : () => listener.handleEvent(new Event(type));
        }} as unknown as MediaStreamTrack;
        const remoteStream = {active: true, getVideoTracks: () => [remoteTrack]} as unknown as MediaStream;
        const handler = peerConnections[0]?.ontrack;
        if (!handler) throw new Error('Peer connection track handler was not installed.');
        handler.call(peerConnections[0], {track: remoteTrack, streams: [remoteStream]} as unknown as RTCTrackEvent);
        const stopped = room('group.call.presenter.stop', 'active', 'group-1', 1, 3, participants);
        events.next({...stopped, payload: {...stopped.payload, presenter: undefined}});

        await tick(10_000);
        const sync = sentRequestID('group.call.sync');
        expect(sync).not.toBe('');
        events.next(synced(sync, {state_revision: 4, participants, presenter: {user_id: 'peer-1', device_id: 'peer-device'}}));

        expect(facade.state.remotePresentation).toBe(remoteStream);
        unmuteListener?.();
        expect(facade.state.remotePresentation).toBe(remoteStream);
    }));

    it('keeps video presentation usable when opted-in display capture has no audio track', async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active'));
        const videoTrack = { kind: 'video', readyState: 'live', stop: vi.fn().mockName('stop'), addEventListener: vi.fn().mockName('addEventListener') };
        const getDisplayMedia = vi.fn().mockName('getDisplayMedia').mockResolvedValue({
            getTracks: () => [videoTrack], getVideoTracks: () => [videoTrack], getAudioTracks: () => [],
        });
        Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia } });
        facade.setScreenShareAudioEnabled(true);

        await facade.startPresentation('720p');

        expect(getDisplayMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: true }));
        expect(facade.state.presentation).toBeDefined();
        expect(facade.state.sharing).toBe(true);
        expect(facade.state.screenShareAudioActive).toBe(false);
        expect(facade.state.statusLabel).toBe('You are presenting. System audio was not available.');
    });

    it('removes only ended system audio, stops both senders on share stop, then reuses senders on restart', async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [
            { user_id: 'self-1', device_id: 'self-device' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        const firstVideo = testDisplayTrack('video');
        const firstAudio = testDisplayTrack('audio');
        const secondVideo = testDisplayTrack('video');
        const secondAudio = testDisplayTrack('audio');
        const thirdVideo = testDisplayTrack('video');
        const thirdAudio = testDisplayTrack('audio');
        const fourthVideo = testDisplayTrack('video');
        const fourthAudio = testDisplayTrack('audio');
        const streams = [
            testDisplayStream(firstVideo.track, firstAudio.track),
            testDisplayStream(secondVideo.track, secondAudio.track),
            testDisplayStream(thirdVideo.track, thirdAudio.track),
            testDisplayStream(fourthVideo.track, fourthAudio.track),
        ];
        const getDisplayMedia = vi.fn().mockName('getDisplayMedia').mockReturnValueOnce(Promise.resolve(streams[0])).mockReturnValueOnce(Promise.resolve(streams[1])).mockReturnValueOnce(Promise.resolve(streams[2])).mockReturnValueOnce(Promise.resolve(streams[3]));
        Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia } });
        facade.setScreenShareAudioEnabled(true);

        await facade.startPresentation('720p');
        const videoSender = senders.find(sender => sender.kind === 'video');
        const audioSenders = senders.filter(sender => sender.kind === 'audio');
        expect(videoSender).toBeDefined();
        expect(audioSenders).toHaveLength(2); // microphone and independent presentation audio
        const presentationAudioSender = audioSenders[1];
        expect(facade.state.screenShareAudioActive).toBe(true);

        firstAudio.end();
        for (let attempt = 0; attempt < 8 && facade.state.screenShareAudioActive; attempt += 1)
            await flush();
        expect(facade.state.presentation).toBe(streams[0]);
        expect(facade.state.sharing).toBe(true);
        expect(facade.state.screenShareAudioActive).toBe(false);
        expect(presentationAudioSender.replaceTrack).toHaveBeenCalledWith(null);
        expect(videoSender?.replaceTrack).toHaveBeenCalledWith(firstVideo.track);

        await facade.stopPresentation();
        expect(facade.state.presentation).toBeUndefined();
        expect(videoSender?.replaceTrack).toHaveBeenCalledWith(null);
        expect(presentationAudioSender.replaceTrack).toHaveBeenCalledWith(null);

        await facade.startPresentation('720p');
        expect(getDisplayMedia).toHaveBeenCalledTimes(2);
        expect(senders.filter(sender => sender.kind === 'video')).toHaveLength(1);
        expect(senders.filter(sender => sender.kind === 'audio')).toHaveLength(2);
        expect(videoSender?.replaceTrack).toHaveBeenCalledWith(secondVideo.track);
        expect(presentationAudioSender.replaceTrack).toHaveBeenCalledWith(secondAudio.track);
        expect(facade.state.presentation).toBe(streams[1]);
        expect(facade.state.screenShareAudioActive).toBe(true);

        await facade.stopPresentation();
        expect(facade.state.presentation).toBeUndefined();
        expect(facade.state.screenShareAudioActive).toBe(false);
        expect(videoSender?.replaceTrack).toHaveBeenCalledWith(null);
        expect(presentationAudioSender.replaceTrack).toHaveBeenCalledWith(null);

        await facade.startPresentation('720p');
        expect(facade.state.presentation).toBe(streams[2]);
        expect(facade.state.screenShareAudioActive).toBe(true);

        // Browser audio/video-ended events and a user stop can land in the same
        // task. The shared lifecycle queue must serialize their renegotiations.
        thirdAudio.end();
        thirdVideo.end();
        const overlappingUserStop = facade.stopPresentation();
        await overlappingUserStop;
        await flush();
        await flush();
        expect(facade.state.presentation).toBeUndefined();
        expect(facade.state.screenShareAudioActive).toBe(false);
        expect(facade.state.shareTransitioning).toBe(false);
        expect(facade.state.peers.map(peer => peer.userID)).toContain('peer-1');
        expect(peerConnections.every(connection => connection.connectionState !== 'closed')).toBe(true);
        expect(videoSender?.replaceTrack).toHaveBeenCalledWith(null);
        expect(presentationAudioSender.replaceTrack).toHaveBeenCalledWith(null);

        await facade.startPresentation('720p');
        expect(getDisplayMedia).toHaveBeenCalledTimes(4);
        expect(senders.filter(sender => sender.kind === 'video')).toHaveLength(1);
        expect(senders.filter(sender => sender.kind === 'audio')).toHaveLength(2);
        expect(videoSender?.replaceTrack).toHaveBeenCalledWith(fourthVideo.track);
        expect(presentationAudioSender.replaceTrack).toHaveBeenCalledWith(fourthAudio.track);
        expect(facade.state.presentation).toBe(streams[3]);
        expect(facade.state.sharing).toBe(true);
        expect(facade.state.screenShareAudioActive).toBe(true);
    });

    it('never activates a display capture whose video track ended before startup continuation', async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active'));
        const video = testDisplayTrack('video');
        Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
                getDisplayMedia: vi.fn().mockName('getDisplayMedia').mockResolvedValue(testDisplayStream(video.track, testDisplayTrack('audio').track)),
            } });

        const startup = facade.startPresentation('720p');
        video.end();
        await startup;

        expect(facade.state.presentation).toBeUndefined();
        expect(facade.state.sharing).toBe(false);
        expect(facade.state.shareTransitioning).toBe(false);
        expect(facade.state.statusLabel).toContain('No live screen');
    });

    it('times out a stalled presenter sender, releases its tracks and peer, then allows a new share', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 1, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        const display = testDisplayTrack('video');
        const displayAudio = testDisplayTrack('audio');
        const nextDisplay = testDisplayTrack('video');
        const captures = [testDisplayStream(display.track, displayAudio.track), testDisplayStream(nextDisplay.track, testDisplayTrack('audio').track)];
        Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
                getDisplayMedia: vi.fn().mockName('getDisplayMedia').mockResolvedValueOnce(captures[0]).mockResolvedValueOnce(captures[1]),
            } });
        const replaceTrack = vi.fn().mockName('replaceTrack').mockReturnValue(new Promise<void>(() => undefined));
        vi.spyOn(peerConnections[0], 'addTrack').mockImplementation(mediaTrack => {
            const sender = {replaceTrack} as unknown as RTCRtpSender;
            senders.push({ kind: mediaTrack.kind, replaceTrack, sender });
            return sender;
        });

        const starting = facade.startPresentation('720p');
        await tick();
        await tick(1_501);
        await starting;

        expect(facade.state.presentation).toBeUndefined();
        expect(facade.state.sharing).toBe(false);
        expect(facade.state.shareTransitioning).toBe(false);
        expect(facade.state.errorLabel).toBe('A peer connection was closed because media could not be replaced.');
        expect(display.track.stop).toHaveBeenCalled();
        expect(displayAudio.track.stop).toHaveBeenCalled();
        expect(peerConnections[0].connectionState).toBe('closed');
        expect(facade.state.peers).toEqual([]);

        await facade.startPresentation('720p');
        expect(facade.state.presentation).toBe(captures[1]);
        expect(facade.state.sharing).toBe(true);
        expect(facade.state.shareTransitioning).toBe(false);
    }));

    it('reserves a receive-only video transceiver when a late joiner negotiates with an existing presenter', async () => {
        const activeRoom = room('group.call.started', 'active', 'group-1', 1, 1, [
            { user_id: 'm-observer', device_id: 'observer-device' },
            { user_id: 'z-member', device_id: 'member-device' },
        ]).payload;
        await facade.join({ ...activeRoom, presenter: { user_id: 'z-member', device_id: 'member-device' } }, 'm-observer');
        const joined = room('group.call.participant.joined', 'active', 'group-1', 1, 2, activeRoom.participants);
        events.next({ ...joined, payload: { ...joined.payload, presenter: { user_id: 'z-member', device_id: 'member-device' } } });
        await flush();

        expect(addedTransceivers).toContainEqual({kind: 'video', direction: 'recvonly'});
        expect(signalCount('offer')).toBe(1);
    });

    it('only adopts the matching first room snapshot and rejects stale room generations', async () => {
        await facade.start('group-1', 'self-1');
        events.next(room('group.call.started', 'active', 'other-group', 1));

        expect(facade.state.room).toBeUndefined();

        acceptStarted(room('group.call.started', 'active', 'group-1', 2));
        events.next(room('group.call.participant.left', 'active', 'group-1', 1));

        expect(facade.state.room?.conversation_id).toBe('group-1');
        expect(facade.state.room?.generation).toBe(2);

        facade.end();
        expect(facade.state.phase).toBe('ended');
        events.next(room('group.call.started', 'active', 'group-1', 3));

        expect(facade.state.phase).toBe('ended');
    });

    it('does not start when microphone access is denied', async () => {
        Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) } });
        await facade.start('group-1', 'self-1');
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.start'}));
        expect(send).toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.cancel_start'}));
        expect(facade.state.errorLabel).toContain('Microphone permission was denied');
        const cancellation = vi.mocked(send).mock.calls.map(([event]) => event).find(event => event.type === 'group.call.cancel_start');
        if (!cancellation || cancellation.type !== 'group.call.cancel_start') throw new Error('Expected cancellation');
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.start_cancelled', request_id: cancellation.request_id, payload: {...cancellation.payload, outcome: 'confirmed'}});
        expect(facade.state.statusLabel).toContain('Microphone permission was denied');
    });

    it('locally aborts only a matching pending start, fences its microphone promise, and never ends the room', async () => {
        let resolveMedia: ((stream: MediaStream) => void) | undefined;
        Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => new Promise<MediaStream>(resolve => resolveMedia = resolve) } });

        const starting = facade.start('group-1', 'self-1');
        await Promise.resolve();
        facade.abort('another-group');
        facade.abort('group-1');
        facade.abort('group-1');
        resolveMedia?.({ getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream);
        await starting;

        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.start'}));
        expect(send).toHaveBeenCalledWith(expect.objectContaining({type: 'group.call.cancel_start'}));
        expect(track.stop).toHaveBeenCalledTimes(1);
        expect(facade.state.phase).toBe('idle');
    });

    it('clears the local call presentation when an authorized conversation removal aborts an active room', async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active'));

        expect(facade.abort('group-1')).toBe(true);
        expect(facade.state.phase).toBe('idle');
        expect(facade.state.room).toBeUndefined();
        expect(vi.mocked(send).mock.calls.some(([event]) => event.type === 'group.call.end')).toBe(false);
    });

    it('does not resurrect media or UI from delayed active sync and room events after local end', fakeAsync(async () => {
        void facade.start('group-1', 'self-1');
        await tick();
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 5));
        await tick(10000);
        const sync = vi.mocked(send).mock.calls.map(([event]) => event).find(event => event.type === 'group.call.sync') as {
            request_id: string;
        };

        facade.end();
        const ended = room('group.call.ended', 'ended', 'group-1', 1, 6);
        events.next(ended);
        events.next(synced(sync.request_id, { state_revision: 5, status: 'active', participants: [{ user_id: 'self-1', device_id: 'device-1' }] }));
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 5, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        events.next(room('group.call.started', 'active', 'group-1', 1, 7));

        expect(facade.state.phase).toBe('ended');
        expect(facade.state.room).toBeUndefined();
        expect(facade.state.localStream).toBeUndefined();
        expect(facade.state.peers).toEqual([]);
        expect(track.stop).toHaveBeenCalled();
        await tick(30000);
        expect(facade.state.phase).toBe('idle');
        expect(facade.state.room).toBeUndefined();
    }));

    it('keeps a group leave send failure visible instead of reporting a successful leave', async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active'));
        send.mockClear();
        send.mockReturnValue(false);

        facade.leave();

        expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'group.call.leave' }));
        expect(facade.state.phase).toBe('error');
        expect(facade.state.errorLabel).toBe('The secure connection is unavailable.');
        expect(facade.state.statusLabel).not.toBe('You left the group call.');
        expect(track.stop).toHaveBeenCalled();
    });

    it('sends group-call end and retires the local call immediately', () => {
        void facade.start('group-1', 'self-1');
        events.next(room('group.call.started', 'active'));
        facade.end();
        expect(vi.mocked(send).mock.calls.some(([event]) => event.type === 'group.call.end')).toBe(true);
        expect(facade.state.phase).toBe('ended');
        events.next(room('group.call.ended', 'ended', 'group-1', 1, 2));
        expect(facade.state.phase).toBe('ended');
        expect(facade.state.room).toBeUndefined();
    });

    it('ends a room on a newer full-room terminal update after local departure', async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active', 'group-1', 1, 5, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        facade.leave();
        events.next(room('group.call.participant.left', 'active', 'group-1', 1, 6, [{ user_id: 'peer-1', device_id: 'peer-device' }]));
        expect(facade.state.phase).toBe('left');

        events.next(room('group.call.ended', 'ended', 'group-1', 1, 7, [{ user_id: 'peer-1', device_id: 'peer-device' }]));

        expect(facade.state.phase).toBe('ended');
        expect(facade.canRejoin('group-1')).toBe(false);
    });

    it('fences a pending join for the removed conversation without sending group.call.join', async () => {
        let resolveMedia: ((stream: MediaStream) => void) | undefined;
        Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => new Promise<MediaStream>(resolve => resolveMedia = resolve) } });
        const joining = facade.join(room('group.call.started', 'active').payload, 'self-1');

        expect(facade.abort('group-1')).toBe(true);
        resolveMedia?.({ getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream);
        await joining;

        expect(vi.mocked(send).mock.calls.some(([event]) => event.type === 'group.call.join')).toBe(false);
        expect(track.stop).toHaveBeenCalledTimes(1);
    });

    it('includes the server room generation in join, leave, and end commands', async () => {
        const activeRoom = room('group.call.started', 'active').payload;
        await facade.join({ ...activeRoom, participants: [{ user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' }] }, 'self-1');
        expect(sentEvent('group.call.join')?.payload.generation).toBe(activeRoom.generation);

        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 2));
        facade.end();
        expect(sentEvent('group.call.end')?.payload.generation).toBe(activeRoom.generation);
        expect(facade.state.phase).toBe('ended');

        await facade.join(activeRoom, 'self-1');
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', request_id: sentRequestID('group.call.sync'), payload: {room_id: 'room-1', generation: 1, status: 'ended', ownership_status: 'participant_absent'}});
        await facade.join(activeRoom, 'self-1');
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 2));
        facade.leave();
        expect(sentEvent('group.call.leave')?.payload.generation).toBe(activeRoom.generation);
        expect(facade.state.phase).toBe('ended');
    });

    it('includes the current room generation in presenter lifecycle and signal commands', async () => {
        await facade.start('group-1', 'self-1');
        acceptStarted(room('group.call.started', 'active'));
        const displayTrack = { kind: 'video', readyState: 'live', stop: vi.fn().mockName('stop'), addEventListener: vi.fn().mockName('addEventListener') };
        Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
                getUserMedia: vi.fn().mockName('getUserMedia').mockResolvedValue({ getTracks: () => [track], getAudioTracks: () => [track] }),
                getDisplayMedia: vi.fn().mockName('getDisplayMedia').mockResolvedValue({ getTracks: () => [displayTrack], getVideoTracks: () => [displayTrack], getAudioTracks: () => [] }),
            } });

        await facade.startPresentation('720p');
        expect(sentEvent('group.call.presenter.start')?.payload.generation).toBe(1);
        await facade.stopPresentation();
        expect(sentEvent('group.call.presenter.stop')?.payload.generation).toBe(1);

        const sendSignal = (facade as unknown as {
            sendSignal: (target: GroupCallParticipant, signal: CallSignal, generation: number) => void;
        }).sendSignal;
        sendSignal.call(facade, { user_id: 'peer-1', device_id: 'peer-device' }, { type: 'candidate', candidate: { candidate: 'candidate' } }, 1);
        expect(sentEvent('group.call.signal')?.payload.generation).toBe(1);
    });

    it('does not send a join for a room with a missing or non-positive generation', async () => {
        const invalidRoom = room('group.call.started', 'active').payload;
        await facade.join({ ...invalidRoom, generation: 0 }, 'self-1');
        await facade.join({ ...invalidRoom, generation: Number.NaN }, 'self-1');
        expect(vi.mocked(send).mock.calls.some(([event]) => event.type === 'group.call.join')).toBe(false);
    });

    it('keeps the group call active and exposes sound recovery when autoplay is blocked', async () => {
        await facade.start('group-1', 'self-1');
        const audio = { autoplay: false, muted: true, volume: 0, pause: vi.fn().mockName('pause'), play: vi.fn().mockName('play').mockRejectedValue(new DOMException('blocked', 'NotAllowedError')) } as unknown as HTMLAudioElement;

        facade.playRemoteAudio(audio);
        await flush();

        expect(facade.state.phase).toBe('ringing');
        expect(facade.state.audioPlaybackBlocked).toBe(true);
        expect(facade.state.statusLabel).toBe('Group audio connected. Enable sound to hear the call.');
        audio.play = vi.fn().mockName('play').mockResolvedValue(undefined);
        facade.enableRemoteAudio();
        await flush();

        expect(facade.state.audioPlaybackBlocked).toBe(false);
        expect(vi.mocked(send).mock.calls.some(([event]) => event.type === 'group.call.end')).toBe(false);
    });

    it('applies a selected speaker to every rendered remote peer audio element', async () => {
        const firstPeerAudio = remoteAudio();
        const secondPeerAudio = remoteAudio();

        facade.playRemoteAudio(firstPeerAudio);
        facade.playRemoteAudio(secondPeerAudio);
        await facade.selectOutputDevice('speaker-2');

        expect(firstPeerAudio.setSinkId).toHaveBeenCalledTimes(1);

        expect(firstPeerAudio.setSinkId).toHaveBeenCalledWith('speaker-2');
        expect(secondPeerAudio.setSinkId).toHaveBeenCalledTimes(1);
        expect(secondPeerAudio.setSinkId).toHaveBeenCalledWith('speaker-2');
        expect(facade.state.selectedOutputID).toBe('speaker-2');
        expect(facade.state.statusLabel).toBe('Speaker changed.');

        await facade.selectOutputDevice('');

        expect(firstPeerAudio.setSinkId).toHaveBeenCalledWith('');
        expect(secondPeerAudio.setSinkId).toHaveBeenCalledWith('');
        expect(facade.state.selectedOutputID).toBe('');
    });

    it('registers each rendered audio once and releases it when its view is destroyed', async () => {
        const audio = remoteAudio();
        audio.srcObject = new MediaStream();

        facade.playRemoteAudio(audio);
        facade.playRemoteAudio(audio);
        await flush();
        expect(audio.play).toHaveBeenCalledTimes(1);

        facade.unregisterRemoteAudio(audio);
        expect(audio.pause).toHaveBeenCalledTimes(1);
        expect(audio.srcObject).toBeNull();

        await facade.selectOutputDevice('speaker-2');
        expect(audio.setSinkId).not.toHaveBeenCalled();
        facade.enableRemoteAudio();
        await flush();
        expect(audio.play).toHaveBeenCalledTimes(1);
    });

    it('retries playback when a recreated view registers after readiness events', async () => {
        const audio = remoteAudio();
        audio.srcObject = new MediaStream();

        // A canplay/loadedmetadata event may be delivered before Angular's
        // directive has registered the newly recreated audio element.
        facade.playRemoteAudio(audio);
        await flush();
        expect(audio.play).toHaveBeenCalledTimes(1);

        facade.registerRemoteAudio(audio);
        await flush();

        expect(audio.play).toHaveBeenCalledTimes(2);
        expect(facade.state.audioPlaybackBlocked).toBe(false);
    });

    function sentEvent(type: string): {
        type: string;
        payload: {
            generation?: number;
        };
    } | undefined {
        return vi.mocked(send).mock.calls.map(([event]) => event as {
            type: string;
            payload: {
                generation?: number;
            };
        }).find(event => event.type === type);
    }
    function sentRequestID(type: string, occurrence = 0): string {
        return vi.mocked(send).mock.calls.map(([event]) => event as {
            type: string;
            request_id: string;
        }).filter(event => event.type === type)[occurrence]?.request_id || '';
    }
    function confirmRejoinDiscovery(revision: number): void {
        events.next(absentSync(sentRequestID('group.call.sync')));
        const discovered = room('group.call.started', 'active', 'group-1', 1, revision, [{user_id: 'peer-1', device_id: 'peer-device'}]);
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.discovered', request_id: sentRequestID('group.call.discover'), payload: {conversation_id: 'group-1', room: discovered.payload}});
    }
    function sentGroupRequest(type: 'group.call.start' | 'group.call.join' | 'group.call.leave' | 'group.call.end', occurrence = 0): string {
        const requests = vi.mocked(send).mock.calls.map(([event]) => event as {
            type: string;
            request_id: string;
        }).filter(event => event.type === type);
        return requests[occurrence]?.request_id ?? '';
    }
    function syncCount(): number { return vi.mocked(send).mock.calls.filter(([event]) => event.type === 'group.call.sync').length; }
    function signalCount(type: CallSignal['type']): number { return vi.mocked(send).mock.calls.filter(([event]) => event.type === 'group.call.signal' && event.payload.signal.type === type).length; }
    function lastOfferID(peerID: string): string {
        const command = [...send.mock.calls].reverse().map(([event]) => event).find(event => event.type === 'group.call.signal' && event.payload.target_user_id === peerID && event.payload.signal.type === 'offer');
        if (!command) throw new Error('Expected an offer for peer');
        return command.payload.signal.negotiation_id;
    }
});

async function flush(): Promise<void> { await Promise.resolve(); await Promise.resolve(); }

function testDisplayTrack(kind: 'video' | 'audio'): {
    track: MediaStreamTrack;
    end: () => void;
} {
    let endedListener: ((event: Event) => void) | undefined;
    const state = {
        kind,
        readyState: 'live' as MediaStreamTrackState,
        stop: vi.fn().mockName('stop'),
        addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
            if (type === 'ended')
                endedListener = typeof listener === 'function' ? listener : event => listener.handleEvent(event);
        },
    };
    state.stop.mockImplementation(() => { state.readyState = 'ended'; });
    return {
        track: state as unknown as MediaStreamTrack,
        end: () => {
            state.readyState = 'ended';
            endedListener?.(new Event('ended'));
        },
    };
}

function testDisplayStream(video: MediaStreamTrack, audio: MediaStreamTrack): MediaStream {
    const tracks = [video, audio];
    return {
        getTracks: () => [...tracks],
        getVideoTracks: () => tracks.filter(track => track.kind === 'video'),
        getAudioTracks: () => tracks.filter(track => track.kind === 'audio'),
        removeTrack: (track: MediaStreamTrack) => { const index = tracks.indexOf(track); if (index >= 0)
            tracks.splice(index, 1); },
    } as unknown as MediaStream;
}

function remoteAudio(): HTMLAudioElement & {
    setSinkId: Mock;
} {
    return {
        autoplay: false,
        muted: true,
        volume: 0,
        pause: vi.fn().mockName('pause'),
        play: vi.fn().mockName('play').mockResolvedValue(undefined),
        setSinkId: vi.fn().mockName('setSinkId').mockResolvedValue(undefined),
    } as unknown as HTMLAudioElement & {
        setSinkId: Mock;
    };
}

function iceSDP(ufrag: string): string {
    return `v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=ice-ufrag:${ufrag}\r\na=ice-pwd:abcdefghijklmnopqrstuv\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:audio\r\n`;
}

function room(type: GroupCallRoomSocketEvent['type'], status: GroupCallRoomPayload['status'], conversationID = 'group-1', generation = 1, stateRevision = type === 'group.call.ended' ? 2 : 1, participants: GroupCallParticipant[] = [{ user_id: 'self-1', device_id: 'device-1' }]): GroupCallRoomSocketEvent & {
    payload: GroupCallRoomEventPayload;
} {
    const payload: GroupCallRoomEventPayload = { room_id: 'room-1', conversation_id: conversationID, membership_revision: 1, generation, state_revision: stateRevision, status, expires_at: '2026-01-01T00:00:00Z', participants, ice_expires_at: '2099-01-01T00:00:00Z', ice_servers: [{ urls: ['turn:turn.example.test:3478'], username: 'opaque', credential: 'opaque' }] };
    return { version: WEBSOCKET_PROTOCOL_VERSION, type, payload };
}

function synced(requestID: string, override: Partial<GroupCallActiveSyncPayload>): GroupCallSyncedSocketEvent {
    const base = room('group.call.started', 'active').payload;
    const { ice_servers: _iceServers, ice_expires_at: _iceExpiresAt, ...snapshot } = base;
    return { version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', request_id: requestID, payload: { ...snapshot, status: 'active', ownership_status: 'active', ...override } };
}

function endedSync(requestID: string): GroupCallSyncedSocketEvent {
    return absentSync(requestID);
}

function absentSync(requestID: string): GroupCallSyncedSocketEvent {
    return { version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', request_id: requestID, payload: {room_id: 'room-1', generation: 1, status: 'ended', ownership_status: 'participant_absent'} };
}

function rejected(requestID: string, error: string): MessageSocketEvent {
    return { version: WEBSOCKET_PROTOCOL_VERSION, type: 'call.rejected', request_id: requestID, payload: { error } };
}
